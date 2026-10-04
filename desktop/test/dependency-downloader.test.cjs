'use strict';

// Real builder/downloader calls against synthetic loopback servers, never Electron execution.
// Run from a fresh npm-ci copy: shared node_modules and user download caches are not modified.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { crc32 } = require('node:zlib');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-downloader-'));
fs.chmodSync(root, 0o700);
const previousEnvironment = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (/proxy|electron|^npm_config_|^node_(extra_ca_certs|tls_reject_unauthorized|options|use_env_proxy)$/i.test(key)) delete process.env[key];
}
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'TMPDIR', 'TEMP', 'TMP', 'ELECTRON_BUILDER_CACHE']) {
  const directory = path.join(root, key.toLowerCase());
  fs.mkdirSync(directory, { mode: 0o700 });
  process.env[key] = directory;
}
process.env.ELECTRON_GET_NO_PROGRESS = '1';
test.after(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
  Object.assign(process.env, previousEnvironment);
  fs.rmSync(root, { recursive: true, force: true });
});

const builderRequire = createRequire(require.resolve('app-builder-lib'));
const builder = builderRequire('./util/electronGet.js');
const binaryDownload = builderRequire('./binDownload.js');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let sequence = 0;

async function serve(t, handler, tls, configure = () => {}) {
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  configure(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  return `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}

function artifact(url, bytes, downloadOptions = {}) {
  const version = `44.4.${100 + sequence++}`;
  const filename = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  return {
    version, arch: process.arch, platformName: process.platform, artifactName: 'electron',
    cacheDir: path.join(root, `electron-${sequence}`),
    electronDownload: {
      mirrorOptions: { resolveAssetURL: async () => url },
      checksums: { [filename]: digest(bytes) },
      downloadOptions,
    },
  };
}

// A stored ZIP with a single file, including the central directory used by the real extractor.
function zip(filename, content) {
  const name = Buffer.from(filename), bytes = Buffer.from(content), crc = crc32(bytes);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}

async function syntheticCertificate() {
  require('reflect-metadata');
  const x509 = require('@peculiar/x509');
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const keys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: `01${crypto.randomBytes(15).toString('hex')}`, name: 'CN=Synthetic downloader fixture',
    notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 3600000),
    signingAlgorithm: algorithm, keys,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: '127.0.0.1' }])],
  }, crypto.webcrypto);
  return {
    cert: certificate.toString('pem'),
    key: crypto.KeyObject.from(keys.privateKey).export({ type: 'pkcs8', format: 'pem' }),
  };
}

test('installed builder and Electron downloaders cannot resolve the vulnerable HTTP cache runtime', () => {
  for (const consumer of ['app-builder-lib', 'electron']) {
    const consumerRequire = createRequire(require.resolve(consumer));
    const downloaderRequire = createRequire(consumerRequire.resolve('@electron/get'));
    for (const dependency of ['http-cache-semantics', 'cacheable-request', 'got']) {
      assert.throws(() => downloaderRequire.resolve(dependency), { code: 'MODULE_NOT_FOUND' }, `${consumer} still resolves ${dependency}`);
    }
  }
});

test('actual Electron artifact caller downloads, validates, and reuses only verified bytes', async t => {
  const bytes = zip('payload.txt', 'synthetic electron artifact');
  let requests = 0;
  const origin = await serve(t, (_req, res) => { requests++; res.end(bytes); });
  const options = artifact(`${origin}/artifact.zip`, bytes);
  const file = await builder.downloadElectronArtifactZip(options);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(await builder.downloadElectronArtifactZip(options), file);
  assert.equal(requests, 1);
  fs.writeFileSync(file, 'tampered private cache');
  assert.deepEqual(fs.readFileSync(await builder.downloadElectronArtifactZip(options)), bytes);
  assert.equal(requests, 2, 'tampered cache must be re-downloaded and validated');
});

test('actual generic binary caller rejects wrong hashes without publishing output', async t => {
  const bytes = Buffer.from('synthetic tool');
  const origin = await serve(t, (_req, res) => res.end(bytes));
  const output = path.join(root, 'generic-output');
  await assert.rejects(binaryDownload.download(`${origin}/tool.bin`, output, digest(Buffer.from('different tool'))), /checksum/i);
  assert.equal(fs.existsSync(output), false);
  await binaryDownload.download(`${origin}/tool.bin`, output, digest(bytes));
  assert.deepEqual(fs.readFileSync(output), bytes);
});

test('actual builder toolset caller downloads and extracts a hash-verified archive', async t => {
  const bytes = zip('payload.txt', 'synthetic toolset');
  const origin = await serve(t, (_req, res) => res.end(bytes));
  const directory = await builder.downloadBuilderToolset({
    releaseName: 'synthetic-good-toolset', filenameWithExt: 'tool.zip',
    checksums: { 'tool.zip': digest(bytes) }, overrideUrl: origin,
  });
  assert.equal(fs.readFileSync(path.join(directory, 'payload.txt'), 'utf8'), 'synthetic toolset');
});

test('actual builder toolset extraction refuses an archive path traversal', async t => {
  const bytes = zip('../outside.txt', 'must not escape');
  const origin = await serve(t, (_req, res) => res.end(bytes));
  await assert.rejects(builder.downloadBuilderToolset({
    releaseName: 'synthetic-traversal-toolset', filenameWithExt: 'tool.zip',
    checksums: { 'tool.zip': digest(bytes) }, overrideUrl: origin,
  }), /traversal|escapes|outside/i);
  const release = path.join(process.env.ELECTRON_BUILDER_CACHE, 'synthetic-traversal-toolset');
  assert.equal(fs.existsSync(path.join(release, 'outside.txt')), false);
});

test('actual builder Electron caller refuses an untrusted TLS certificate', async t => {
  let requests = 0;
  const bytes = Buffer.from('never trusted');
  const origin = await serve(t, (_req, res) => { requests++; res.end(bytes); }, await syntheticCertificate());
  await assert.rejects(builder.downloadElectronArtifactZip(artifact(`${origin}/artifact.zip`, bytes)), error => {
    const chain = [error, error.cause, error.cause?.cause];
    return chain.some(item => /SELF_SIGNED|CERT_|certificate/i.test(`${item?.code} ${item?.message}`));
  });
  assert.equal(requests, 0, 'TLS must fail before any HTTP request');
});

test('actual builder request timeout is not silently ignored by the replacement downloader', { timeout: 30000 }, async t => {
  const bytes = Buffer.from('too late');
  let requests = 0;
  const origin = await serve(t, (_req, res) => {
    requests++;
    res.writeHead(200, { "Content-Length": bytes.length });
    res.flushHeaders();
    const timer = setTimeout(() => res.end(bytes), 250);
    res.once('close', () => clearTimeout(timer));
  });
  await assert.rejects(builder.downloadElectronArtifactZip(artifact(`${origin}/artifact.zip`, bytes, { timeout: { request: 30 } })), error => {
    return /timeout|timed out/i.test(`${error.name} ${error.code} ${error.message}`);
  });
  assert.ok(requests > 0);
});

test('actual builder environment proxy remains active for artifact downloads', async t => {
  const bytes = Buffer.from('served by synthetic proxy');
  const requests = [];
  const proxy = await serve(t, (req, res) => {
    requests.push({ url: req.url, authorization: req.headers['proxy-authorization'] }); res.end(bytes);
  });
  const authenticatedProxy = new URL(proxy);
  authenticatedProxy.username = 'synthetic-user'; authenticatedProxy.password = 'synthetic-password';
  process.env.HTTP_PROXY = authenticatedProxy.href;
  t.after(() => { delete process.env.HTTP_PROXY; });
  const url = 'http://downloader-fixture.invalid/artifact.zip';
  const file = await builder.downloadElectronArtifactZip(artifact(url, bytes));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(requests, [{ url, authorization: 'Basic ' + Buffer.from('synthetic-user:synthetic-password').toString('base64') }],
    'must authenticate only to the explicit proxy rather than resolve the synthetic origin');
});


test('HTTPS proxy selection preserves end-to-end TLS verification', async t => {
  const bytes = Buffer.from('untrusted proxy destination');
  let targetRequests = 0;
  const target = await serve(t, (_req, res) => { targetRequests++; res.end(bytes); }, await syntheticCertificate());
  const tunnels = [];
  const proxy = await serve(t, (_req, res) => res.writeHead(500).end(), undefined, server => {
    server.on('connect', (request, client, head) => {
      tunnels.push(request.url);
      if (request.url !== new URL(target).host) { client.destroy(); return; }
      const upstream = require('node:net').connect(Number(new URL(target).port), '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
  });
  process.env.HTTPS_PROXY = proxy;
  t.after(() => { delete process.env.HTTPS_PROXY; });
  await assert.rejects(builder.downloadElectronArtifactZip(artifact(target + '/artifact.zip', bytes)), error => {
    return [error, error.cause, error.cause?.cause].some(item => /SELF_SIGNED|CERT_|certificate/i.test(
      String(item?.code) + ' ' + String(item?.message)));
  });
  assert.deepEqual(tunnels, [new URL(target).host]);
  assert.equal(targetRequests, 0);
});

test('upstream HTTP failures retain the stable builder server-error retry behavior', async t => {
  const bytes = Buffer.from('successful retry');
  let requests = 0;
  const origin = await serve(t, (_req, res) => {
    requests++;
    if (requests === 1) res.writeHead(503).end('synthetic retryable failure');
    else res.end(bytes);
  });
  const file = await builder.downloadElectronArtifactZip(artifact(origin + '/artifact.zip', bytes));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(requests, 2);
});

test('unsupported options and TLS disabling fail before network I/O without disclosing values', async t => {
  let requests = 0;
  const bytes = Buffer.from('must not be requested');
  const origin = await serve(t, (_req, res) => { requests++; res.end(bytes); });
  for (const downloadOptions of [
    { headers: { Cookie: 'synthetic-private-value' } },
    { timeout: { connect: 10 } },
    { timeout: { request: 0 } },
    { https: { rejectUnauthorized: false } },
    { agent: { https: { proxy: 'synthetic-private-value' } } },
  ]) {
    await assert.rejects(builder.downloadElectronArtifactZip(artifact(origin + '/artifact.zip', bytes, downloadOptions)), error => {
      assert.equal(error.code, 'ERR_BUILDER_DOWNLOAD_OPTION');
      assert.equal(error.message.includes('synthetic-private-value'), false);
      return true;
    });
  }
  assert.equal(requests, 0);
});

test('cancellation preserves its reason, removes partial files, and closes the request', async t => {
  const bytes = Buffer.from('never completed');
  const controller = new AbortController();
  const reason = new Error('synthetic cancellation');
  let closed;
  const connectionClosed = new Promise(resolve => { closed = resolve; });
  const origin = await serve(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.flushHeaders();
    res.once('close', closed);
    controller.abort(reason);
  });
  const file = artifact(origin + '/artifact.zip', bytes, { signal: controller.signal });
  await assert.rejects(builder.downloadElectronArtifactZip(file), error => error === reason);
  await connectionClosed;
  assert.equal(fs.existsSync(file.cacheDir), false);
  assert.deepEqual(fs.readdirSync(process.env.TMPDIR), []);
});

test('upstream artifact progress and uncached responses do not acquire an HTTP cookie cache', async t => {
  const get = builderRequire('@electron/get');
  const cookies = [], progress = [];
  const replies = [Buffer.from('first synthetic user'), Buffer.from('second synthetic user')];
  let requests = 0;
  const origin = await serve(t, (req, res) => {
    cookies.push(req.headers.cookie);
    const bytes = replies[requests++];
    res.writeHead(200, { 'Content-Length': bytes.length, 'Set-Cookie': 'synthetic=user-one', 'Cache-Control': 'max-age=0' });
    res.end(bytes);
  });
  for (const bytes of replies) {
    const output = await get.downloadArtifact({
      version: '44.4.5', artifactName: 'tool.bin', isGeneric: true,
      cacheMode: get.ElectronDownloadCacheMode.Bypass, cacheRoot: path.join(root, 'no-http-cache'),
      tempDirectory: process.env.TMPDIR,
      mirrorOptions: { resolveAssetURL: async () => origin + '/same-url' },
      checksums: { 'tool.bin': digest(bytes) },
      downloadOptions: { quiet: true, getProgressCallback: info => { progress.push(info); } },
    });
    assert.deepEqual(fs.readFileSync(output), bytes);
    fs.rmSync(path.dirname(output), { recursive: true });
  }
  assert.equal(requests, 2);
  assert.deepEqual(cookies, [undefined, undefined]);
  assert.equal(progress.at(-1).transferred, replies[1].length);
  assert.equal(progress.at(-1).percent, 1);
});

