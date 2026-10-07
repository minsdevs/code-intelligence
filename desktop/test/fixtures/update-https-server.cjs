'use strict';
// Loopback HTTPS fixture for the updater tests. The CA, the server key and every Ed25519 key are
// generated in memory per test process and never written to disk. The fictitious update host is
// resolved only by this fixture's request adapter, which always connects to 127.0.0.1.
require('reflect-metadata');
const crypto = require('node:crypto');
const https = require('node:https');
const x509 = require('@peculiar/x509');

const HOST = 'updates.example.invalid';

async function certificate() {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const now = Date.now(), notBefore = new Date(now - 60000), notAfter = new Date(now + 86400000);
  const caKeys = await crypto.webcrypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
  const authority = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: '01', name: 'CN=Update fixture CA',
    notBefore, notAfter, signingAlgorithm: algorithm, keys: caKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)] },
  crypto.webcrypto);
  const keys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const leaf = await x509.X509CertificateGenerator.create({ serialNumber: '02', subject: `CN=${HOST}`, issuer: authority.subject,
    notBefore, notAfter, publicKey: keys.publicKey, signingKey: caKeys.privateKey, signingAlgorithm: algorithm,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: HOST }])] }, crypto.webcrypto);
  const der = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { ca: authority.toString('pem'), cert: leaf.toString('pem'),
    key: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }) };
}

// routes: path -> { status?, headers?, body: Buffer } or a function(request, response).
async function startUpdateServer(t) {
  const tls = await certificate(), routes = new Map(), requests = [];
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    requests.push(request.url);
    const route = routes.get(request.url);
    if (typeof route === 'function') return route(request, response);
    if (!route) { response.writeHead(404); return response.end(); }
    response.writeHead(route.status || 200, { 'content-type': 'application/octet-stream', ...(route.headers || {}) });
    response.end(route.body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const port = server.address().port;
  // Same shape as electronRequest(net): status, headers, async-iterable body and abort.
  const request = url => new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== HOST) return reject(new Error('fixture host only'));
    const outgoing = https.get({ host: '127.0.0.1', port, servername: HOST, path: target.pathname + target.search,
      headers: { host: HOST }, ca: tls.ca, agent: false }, response => resolve({ statusCode: response.statusCode,
      headers: response.headers, body: response, abort: () => outgoing.destroy() }));
    outgoing.once('error', reject);
  });
  return { host: HOST, routes, requests, request, base: `https://${HOST}` };
}

module.exports = { startUpdateServer, HOST };
