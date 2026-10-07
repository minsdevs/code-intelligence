'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

function publicAddress(address, family) {
  if (typeof address !== 'string' || address.includes('%') || net.isIP(address) !== family) return false;
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168
        || (b === 31 && c === 196) || (b === 52 && c === 193) || (b === 175 && c === 48)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('.')) return false;
  const pieces = address.toLowerCase().split('::');
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const words = (pieces.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left)
    .map(value => parseInt(value, 16));
  const [a, b, c] = words;
  // Conservatively exclude special-purpose assignments inside global unicast as well as all
  // mapped, translation, tunnel, local, multicast, documentation and unspecified ranges.
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002
    && !(a === 0x2001 && (b <= 0x01ff || b === 0x0db8))
    && !(a === 0x3fff && b <= 0x0fff) && !(a === 0x2620 && b === 0x004f && c === 0x8000);
}

function restrictedLookup(resolve, hostname, options, callback) {
  if (hostname !== 'api.openai.com') { callback(unavailable()); return; }
  try {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error || !Array.isArray(addresses) || !addresses.length || addresses.length > 64
          || addresses.some(value => !value || !publicAddress(value.address, value.family))) { callback(unavailable()); return; }
      const family = typeof options === 'number' ? options : options?.family;
      const selected = family === 4 || family === 6 ? addresses.filter(value => value.family === family) : addresses;
      if (!selected.length) { callback(unavailable()); return; }
      if (options?.all) callback(null, selected.map(({ address, family: af }) => ({ address, family: af })));
      else callback(null, selected[0].address, selected[0].family);
    });
  } catch { callback(unavailable()); }
}

function unavailable() { return new Error('AI provider response unavailable'); }

// Validation candidates only (PK-08): a build-time loopback origin for a local fake provider replaces the
// fixed provider host. It is read from the packaged package.json (inside the integrity-checked app.asar), so
// no environment variable, renderer, file or user setting can supply it, and any other build refuses it.
const VALIDATION_PACKAGE_NAME = 'code-intelligence-validation';
const VALIDATION_PROVIDER_KEY = 'validationAiProviderOrigin';
function validationProviderTarget(metadata) {
  if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, VALIDATION_PROVIDER_KEY)) return null;
  const value = metadata[VALIDATION_PROVIDER_KEY];
  const match = metadata.name === VALIDATION_PACKAGE_NAME && typeof value === 'string'
    && /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{3,4})$/.exec(value);
  if (!match || Number(match[2]) > 65535) throw new Error('AI provider build variant refused');
  return Object.freeze({ hostname: match[1] === '[::1]' ? '::1' : '127.0.0.1', family: match[1] === '[::1]' ? 6 : 4,
    port: Number(match[2]) });
}

function createProviderTransport(metadata) {
  const target = validationProviderTarget(metadata);
  if (!target) return createHttpsTransport();
  return createTransport((headers, onResponse) => http.request({ protocol: 'http:', hostname: target.hostname,
    family: target.family, port: target.port, path: '/v1/chat/completions', method: 'POST', agent: false,
    lookup: (hostname, options, callback) => callback(unavailable()), headers }, onResponse));
}

function createHttpsTransport(requestImpl = https.request, lookupImpl = dns.lookup) {
  return createTransport((headers, onResponse) => requestImpl({ protocol: 'https:', hostname: 'api.openai.com', port: 443,
    path: '/v1/chat/completions', method: 'POST', agent: false, rejectUnauthorized: true,
    servername: 'api.openai.com', lookup: (hostname, options, callback) => restrictedLookup(lookupImpl, hostname, options, callback),
    minVersion: 'TLSv1.2', headers }, onResponse));
}

function createTransport(open) {
  return function transport(request) {
    const headers = request?.headers;
    // Defense in depth: this transport has no caller-selected host, TLS settings, proxy, or redirects.
    if (request?.origin !== 'https://api.openai.com' || request.path !== '/v1/chat/completions'
        || request.method !== 'POST' || request.retries !== 0 || request.redirects !== 0
        || request.timeoutMs !== 60000 || request.maxResponseBytes !== 2 * 1024 * 1024
        || !Buffer.isBuffer(request.body) || !request.body.length || request.body.length > 1024 * 1024
        || !headers || Object.keys(headers).sort().join(',') !== 'Accept,Authorization,Content-Type'
        || headers.Accept !== 'application/json' || headers['Content-Type'] !== 'application/json'
        || typeof headers.Authorization !== 'string' || !/^Bearer [^\x00-\x20\x7f]{1,4096}$/.test(headers.Authorization))
      return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      let client; let response; let done = false; let received = 0;
      const chunks = []; const body = Buffer.from(request.body);
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(timer); body.fill(0);
        for (const chunk of chunks) chunk.fill(0);
        if (error) { response?.destroy(); client?.destroy(); reject(unavailable()); }
        else resolve(value);
      };
      // Total deadline includes DNS, TLS, upload, headers and body; socket idle timeout is insufficient.
      const timer = setTimeout(() => finish(unavailable()), request.timeoutMs);
      try {
        client = open({ ...headers, 'Content-Length': String(body.length), 'Accept-Encoding': 'identity' }, incoming => {
          response = incoming;
          if (done) { incoming.destroy(); return; }
          const encoding = incoming.headers['content-encoding'];
          if (!Number.isInteger(incoming.statusCode) || incoming.statusCode < 200 || incoming.statusCode > 299
              || (encoding && encoding !== 'identity')
              || typeof incoming.headers['content-type'] !== 'string'
              || !/^application\/json(?:\s*;.*)?$/i.test(incoming.headers['content-type'])) { finish(unavailable()); return; }
          incoming.on('error', () => finish(unavailable()));
          incoming.on('aborted', () => finish(unavailable()));
          incoming.on('data', chunk => {
            if (done) return;
            received += chunk.length;
            if (received > request.maxResponseBytes) { finish(unavailable()); return; }
            chunks.push(Buffer.from(chunk));
          });
          incoming.on('end', () => {
            if (done) return;
            if (!incoming.complete || !received) { finish(unavailable()); return; }
            const id = incoming.headers['x-request-id'];
            if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) {
              finish(unavailable()); return;
            }
            finish(null, { statusCode: incoming.statusCode, body: Buffer.concat(chunks), providerRequestId: id ?? null });
          });
        });
        client.on('error', () => finish(unavailable()));
        client.end(body);
      } catch { finish(unavailable()); }
    });
  };
}
module.exports = Object.freeze({ createHttpsTransport, createProviderTransport, validationProviderTarget });
