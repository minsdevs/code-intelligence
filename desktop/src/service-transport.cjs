'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const tls = require('node:tls');
const { pathToFileURL } = require('node:url');
const HOST = '127.0.0.1';
const CALLBACK_PATH = '/api/auth/github/native/callback';
const fail = () => { throw new Error('DESKTOP_TRANSPORT_REFUSED'); };

function privateDirectory(directory) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function'
      || !path.isAbsolute(directory) || fs.realpathSync(directory) !== directory) fail();
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o7777) !== 0o700) fail();
  return stat;
}
function sameDirectory(directory, expected) {
  const actual = privateDirectory(directory);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail();
}
function writePrivate(directory, identity, name, content) {
  sameDirectory(directory, identity);
  const file = path.join(directory, name);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600) fail();
    fs.writeFileSync(fd, content); fs.fsyncSync(fd);
    sameDirectory(directory, identity);
    const current = fs.lstatSync(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1) fail();
  } finally { fs.closeSync(fd); }
  return file;
}
function matchesCertificate(pem, pin, host = HOST) {
  try {
    const cert = new crypto.X509Certificate(pem);
    const digest = crypto.createHash('sha256').update(cert.raw).digest('hex');
    return host === HOST && digest === pin && cert.checkIP(HOST) === HOST
      && Date.parse(cert.validFrom) <= Date.now() && Date.now() < Date.parse(cert.validTo);
  } catch { return false; }
}
function peerCheck(material) {
  return (host, cert) => {
    const error = tls.checkServerIdentity(host, cert);
    return error || (matchesCertificate(cert.raw, material.pin, host) ? undefined : new Error('DESKTOP_PEER_REFUSED'));
  };
}
function fixedUrl(origin, raw) {
  const url = new URL(raw);
  if (url.origin !== origin || url.protocol !== 'https:' || url.hostname !== HOST
      || url.username || url.password || url.hash) fail();
  return url;
}
function createPinnedClient(material, port, headers = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail();
  const origin = `https://${HOST}:${port}`;
  const agent = new https.Agent({ ca: material.pem, rejectUnauthorized: true,
    checkServerIdentity: peerCheck(material), maxCachedSessions: 0 });
  return Object.freeze({
    origin,
    request(raw, options = {}) {
      const url = fixedUrl(origin, raw);
      return new Promise((resolve, reject) => {
        const request = https.request(url, { agent, method: options.method || 'GET',
          headers: { ...options.headers, ...(typeof headers === 'function' ? headers() : headers) }, signal: options.signal,
          timeout: 10000 }, response => {
          const chunks = []; let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 1024 * 1024) { response.destroy(); reject(new Error('DESKTOP_RESPONSE_TOO_LARGE')); }
            else chunks.push(chunk);
          });
          response.on('error', () => reject(new Error('DESKTOP_TRANSPORT_FAILED')));
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({ ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode, json: async () => JSON.parse(body), text: async () => body });
          });
        });
        request.on('timeout', () => request.destroy(new Error('DESKTOP_TRANSPORT_TIMEOUT')));
        request.on('error', () => reject(new Error('DESKTOP_TRANSPORT_FAILED')));
        request.end(options.body);
      });
    },
    close() { agent.destroy(); }
  });
}
async function redisPing(material, port, password) {
  return new Promise(resolve => {
    const socket = tls.connect({ host: HOST, port, ca: material.pem, rejectUnauthorized: true,
      checkServerIdentity: peerCheck(material), minVersion: 'TLSv1.2' });
    let response = '', finished = false;
    const finish = result => { if (finished) return; finished = true; socket.destroy(); resolve(result); };
    socket.setTimeout(3000, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('end', () => finish(false));
    socket.on('secureConnect', () => {
      socket.write(`*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(password)}\r\n${password}\r\n*1\r\n$4\r\nPING\r\n`);
    });
    socket.on('data', chunk => {
      response += chunk.toString('ascii');
      if (response.length > 128 || response.startsWith('-')) finish(false);
      else if (response === '+OK\r\n+PONG\r\n') finish(true);
    });
  });
}
async function openCallback(client) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const reject = () => { response.writeHead(400); response.end('Invalid sign-in callback.'); };
    try {
      if (request.method !== 'GET' || request.url.length > 8192
          || request.headers.host !== `${HOST}:${server.address().port}`
          || request.headers['content-length'] || request.headers['transfer-encoding']) return reject();
      const url = new URL(request.url, `http://${HOST}`);
      const allowed = new Set(['code', 'state', 'error', 'error_description', 'error_uri']);
      if (url.pathname !== CALLBACK_PATH || url.hash || !url.searchParams.get('state')
          || [...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)
          || Boolean(url.searchParams.get('code')) === Boolean(url.searchParams.get('error'))) return reject();
      const result = await client.request(`${client.origin}${CALLBACK_PATH}${url.search}`);
      // Never relay credentials, redirect headers or arbitrary backend HTML to the external browser.
      response.writeHead(result.ok ? 200 : 400);
      response.end(result.ok ? 'Sign-in completed. Return to Code Intelligence.' : 'Sign-in failed. Return to Code Intelligence and try again.');
    } catch { response.writeHead(502); response.end('Sign-in callback unavailable.'); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return { url: `http://${HOST}:${server.address().port}${CALLBACK_PATH}`,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

async function createServiceTransport({ userData, ports, getApiToken }) {
  const parent = privateDirectory(userData);
  const directory = fs.mkdtempSync(path.join(userData, 'transport-'));
  fs.chmodSync(directory, 0o700);
  sameDirectory(userData, parent);
  const identity = privateDirectory(directory);
  const write = (name, content) => writePrivate(directory, identity, name, content);
  require('reflect-metadata');
  const x509 = require('@peculiar/x509');
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const materials = {};
  // Separate keys prevent one sidecar from impersonating another service.
  for (const name of ['postgres', 'redis', 'analyzer', 'backend']) {
    const keys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: `01${crypto.randomBytes(15).toString('hex')}`, name: `CN=Code Intelligence ${name}`,
      notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 365 * 86400000),
      signingAlgorithm: algorithm, keys, extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
        new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
        new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: HOST }])
      ]
    }, crypto.webcrypto);
    const pem = certificate.toString('pem');
    const der = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
    const keyPem = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
    const cert = write(`${name}.crt`, pem), key = write(`${name}.key`, keyPem); der.fill(0);
    const pin = crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex');
    if (!matchesCertificate(pem, pin)) fail();
    materials[name] = Object.freeze({ cert, key, pem, pin });
  }
  const analyzerToken = crypto.randomBytes(32).toString('hex');
  const redisPassword = crypto.randomBytes(32).toString('hex');
  const hba = write('pg_hba.conf', 'local all all reject\nhostssl all codeintel 127.0.0.1/32 scram-sha-256\nhostnossl all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n');
  const redisConfig = write('redis.conf', `bind ${HOST}\nprotected-mode yes\nport 0\ntls-port ${ports.redis}\ntls-cert-file ${JSON.stringify(materials.redis.cert)}\ntls-key-file ${JSON.stringify(materials.redis.key)}\ntls-ca-cert-file ${JSON.stringify(materials.redis.cert)}\ntls-auth-clients no\nrequirepass ${redisPassword}\n`);
  const backend = createPinnedClient(materials.backend, ports.backend, () => ({ 'X-Code-Intelligence-Token': getApiToken() }));
  const analyzer = createPinnedClient(materials.analyzer, ports.analyzer, { Authorization: `Bearer ${analyzerToken}` });
  const values = {
    'server.ssl.enabled': 'true', 'server.ssl.bundle': 'desktopbackend',
    'spring.ssl.bundle.pem.desktopbackend.options.enabled-protocols': 'TLSv1.2,TLSv1.3',
    'spring.ssl.bundle.pem.desktopbackend.keystore.certificate': pathToFileURL(materials.backend.cert).href,
    'spring.ssl.bundle.pem.desktopbackend.keystore.private-key': pathToFileURL(materials.backend.key).href,
    'spring.data.redis.ssl.enabled': 'true', 'spring.data.redis.ssl.bundle': 'desktopredis',
    'spring.ssl.bundle.pem.desktopredis.truststore.certificate': pathToFileURL(materials.redis.cert).href,
    'server.servlet.session.cookie.secure': 'true'
  };
  const backendConfig = write('backend.properties', Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  let callback;
  try { callback = await openCallback(backend); }
  catch (error) { backend.close(); analyzer.close(); throw error; }
  let closed = false;
  return Object.freeze({ directory, materials, hba, redisConfig, redisPassword, backendConfig,
    backendConfigUrl: pathToFileURL(backendConfig).href, analyzerToken, callbackUrl: callback.url, backend, analyzer,
    jdbcUrl: `jdbc:postgresql://${HOST}:${ports.postgres}/codeintel?sslmode=verify-full&sslrootcert=${encodeURIComponent(materials.postgres.cert)}`,
    postgresEnvironment: Object.freeze({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: materials.postgres.cert }),
    redisReady: () => redisPing(materials.redis, ports.redis, redisPassword),
    verifyBackendCertificate: (pem, hostname) => matchesCertificate(pem, materials.backend.pin, hostname),
    async close() {
      if (closed) return; closed = true;
      backend.close(); analyzer.close(); await callback.close();
      // Retain failed or interrupted runs for diagnosis; remove only this owned run after all children stop.
      sameDirectory(directory, identity); sameDirectory(userData, parent);
      fs.rmSync(directory, { recursive: true });
    }
  });
}
module.exports = { createServiceTransport, createPinnedClient, matchesCertificate, redisPing };
