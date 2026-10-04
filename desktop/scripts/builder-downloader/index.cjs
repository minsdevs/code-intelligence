'use strict';

// Only app-builder-lib's @electron/get dependency is replaced. Electron itself keeps upstream get.
// Keep upstream's artifact naming, checksum verification and disk cache; adapt the stable builder's
// Got-shaped request options at the documented Downloader boundary, not by patching global fetch.
// Upstream interprets this legacy opt-in by replacing the process-global dispatcher on import.
// This adapter uses only explicit, request-owned builder proxy agents; fail closed instead.
if (process.env.ELECTRON_GET_USE_PROXY) unsupported('ELECTRON_GET_USE_PROXY; use builder HTTP_PROXY/HTTPS_PROXY');
const upstream = require('electron-get-upstream');
const { Agent, ProxyAgent } = require('undici');
const fetchDownloader = new upstream.FetchDownloader();
const supportedOptions = new Set(['timeout', 'agent', 'https', 'quiet', 'getProgressCallback', 'signal']);

function unsupported(option) {
  // Never include option values: proxy URLs may contain credentials.
  throw Object.assign(new TypeError(`Unsupported stable-builder download option: ${option}`), {
    code: 'ERR_BUILDER_DOWNLOAD_OPTION',
  });
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsupported(label);
  return value;
}

function onlyKeys(value, allowed, label) {
  for (const key of Object.keys(record(value, label))) {
    if (!allowed.has(key)) unsupported(label);
  }
}

function proxyURL(agent, protocol) {
  if (agent === undefined) return undefined;
  const expectedClass = protocol === 'https' ? 'HttpsProxyAgent' : 'HttpProxyAgent';
  if (agent?.constructor?.name !== expectedClass || !(agent.proxy instanceof URL)) unsupported(`agent.${protocol}`);
  if (!['http:', 'https:'].includes(agent.proxy.protocol)) unsupported(`agent.${protocol}.protocol`);
  // builder-util creates these agents from a URL alone. Refuse customized TLS/headers instead of
  // silently dropping them during translation. Custom transports are not this package's contract.
  if (typeof agent.proxyHeaders !== 'object' || !agent.proxyHeaders || Object.keys(agent.proxyHeaders).length) {
    unsupported(`agent.${protocol}.headers`);
  }
  const expectedConnect = {
    ...(protocol === 'https' ? { ALPNProtocols: ['http/1.1'] } : {}),
    host: agent.proxy.hostname.replace(/^\[|\]$/g, ''),
    port: Number(agent.proxy.port || (agent.proxy.protocol === 'https:' ? 443 : 80)),
  };
  const actualConnect = record(agent.connectOpts, `agent.${protocol}.connectOpts`);
  if (Object.keys(actualConnect).length !== Object.keys(expectedConnect).length ||
      Object.entries(expectedConnect).some(([key, value]) => JSON.stringify(actualConnect[key]) !== JSON.stringify(value))) {
    unsupported(`agent.${protocol}.connectOpts`);
  }
  return agent.proxy.href;
}

function normalizeOptions(options = {}) {
  onlyKeys(options, supportedOptions, 'downloadOptions');
  let timeout;
  if (options.timeout !== undefined) {
    onlyKeys(options.timeout, new Set(['request']), 'timeout');
    timeout = options.timeout.request;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) unsupported('timeout.request');
  }
  if (options.https !== undefined) {
    onlyKeys(options.https, new Set(['rejectUnauthorized']), 'https');
    if (options.https.rejectUnauthorized !== undefined && options.https.rejectUnauthorized !== true) unsupported('https.rejectUnauthorized');
  }
  if (options.quiet !== undefined && typeof options.quiet !== 'boolean') unsupported('quiet');
  if (options.getProgressCallback !== undefined && typeof options.getProgressCallback !== 'function') unsupported('getProgressCallback');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) unsupported('signal');
  if (options.agent !== undefined) onlyKeys(options.agent, new Set(['http', 'https']), 'agent');
  return {
    timeout, signal: options.signal, quiet: options.quiet, getProgressCallback: options.getProgressCallback,
    httpProxy: proxyURL(options.agent?.http, 'http'), httpsProxy: proxyURL(options.agent?.https, 'https'),
  };
}

function requestDispatcher(options) {
  const dispatchers = new Map();
  return {
    dispatch(request, handler) {
      const protocol = new URL(request.origin).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') unsupported('request.protocol');
      if (!dispatchers.has(protocol)) {
        const proxy = protocol === 'https:' ? options.httpsProxy : options.httpProxy;
        dispatchers.set(protocol, proxy
          ? new ProxyAgent({ uri: proxy, proxyTunnel: false, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } })
          : new Agent({ connect: { rejectUnauthorized: true } }));
      }
      // Select per dispatch, including redirects: an HTTPS redirect must not reuse an HTTP-only
      // proxy. This preserves builder-util's independent HTTP_PROXY / HTTPS_PROXY selection.
      return dispatchers.get(protocol).dispatch(request, handler);
    },
    async destroy() {
      await Promise.all([...dispatchers.values()].map(dispatcher => dispatcher.destroy()));
    },
  };
}

const downloader = {
  async download(url, destination, rawOptions) {
    const options = normalizeOptions(rawOptions);
    const dispatcher = requestDispatcher(options);
    const controller = new AbortController();
    let timer;
    if (options.timeout !== undefined) {
      timer = setTimeout(() => controller.abort(Object.assign(new Error('Electron artifact request timed out'), {
        name: 'TimeoutError', code: 'ETIMEDOUT',
      })), options.timeout);
      timer.unref();
    }
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      await fetchDownloader.download(url, destination, {
        dispatcher, signal, quiet: options.quiet, getProgressCallback: options.getProgressCallback,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // v26's existing retry policy consumes Got's response.statusCode / error.code. Preserve that
      // policy while leaving the response status and original cause available to the caller.
      if (error instanceof upstream.HTTPError) {
        error.response.statusCode = error.response.status;
      } else if (error && typeof error === 'object' && error.code === undefined && typeof error.cause?.code === 'string') {
        error.code = error.cause.code;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      // Destroy, not graceful-close: failures may leave an unread response or an aborted stream.
      // Every request (including the SHASUMS request) owns its dispatchers and timeout.
      await dispatcher.destroy();
    }
  },
};

async function downloadArtifact(details) {
  record(details, 'artifactDetails');
  if (details.downloader !== undefined) unsupported('downloader');
  // Validate even on a cache hit so unsupported options never work only by accident offline.
  normalizeOptions(details.downloadOptions);
  return upstream.downloadArtifact({ ...details, downloader });
}

module.exports = { downloadArtifact, ElectronDownloadCacheMode: upstream.ElectronDownloadCacheMode };
