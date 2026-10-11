'use strict';

// G-UPDATE packaged acceptance fixture (2026-10-11): generates the loopback update feed material for one
// Validation candidate build and the matching private material for update-acceptance-packaged.cjs.
//   node validation/pre-release/update-acceptance-fixture.cjs --output <new directory> [--port 47621]
// Writes <output>/feed.json (public: host, port, CA certificate, Ed25519 public key, fixture Team ID,
// manifest path; passed to build-candidate.cjs --update-feed) and <output>/private/{ca-key,server-key}.pem,
// <output>/private/server-cert.pem, <output>/private/manifest-signing-key.pem (0600, harness only).
// Everything is fixture material for a loopback server; nothing here is release signing material.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const HOST = 'updates.validation.invalid';
const TEAM_ID = 'VALIDATN00';
const KEY_ID = 'validation-fixture';
const MANIFEST_PATH = '/stable/manifest.json';

async function generate({ host = HOST, port = 47621, days = 7 } = {}) {
  const repo = path.resolve(__dirname, '../..');
  require(path.join(repo, 'desktop/node_modules/reflect-metadata'));
  const x509 = createRequire(path.join(repo, 'desktop/package.json'))('@peculiar/x509');
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const now = Date.now(), notBefore = new Date(now - 60000), notAfter = new Date(now + days * 86400000);
  const caKeys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const authority = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: '01', name: 'CN=Code Intelligence update acceptance fixture CA',
    notBefore, notAfter, signingAlgorithm: algorithm, keys: caKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)] }, crypto.webcrypto);
  const serverKeys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const leaf = await x509.X509CertificateGenerator.create({ serialNumber: '02', subject: `CN=${host}`, issuer: authority.subject,
    notBefore, notAfter, publicKey: serverKeys.publicKey, signingKey: caKeys.privateKey, signingAlgorithm: algorithm,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: host }])] }, crypto.webcrypto);
  const pem = async key => crypto.createPrivateKey({ key: Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', key)), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' });
  const manifestKeys = crypto.generateKeyPairSync('ed25519');
  return {
    feed: { host, port, caPem: authority.toString('pem').replace(/\r\n/g, '\n').replace(/\n?$/, '\n'), keyId: KEY_ID,
      publicKey: manifestKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), teamId: TEAM_ID, manifestPath: MANIFEST_PATH },
    private: { caKeyPem: await pem(caKeys.privateKey), serverKeyPem: await pem(serverKeys.privateKey),
      serverCertPem: leaf.toString('pem').replace(/\r\n/g, '\n').replace(/\n?$/, '\n'),
      manifestSigningKeyPem: manifestKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }) },
  };
}

async function main(argv = process.argv.slice(2)) {
  assert(argv.length === 2 || argv.length === 4); assert.equal(argv[0], '--output');
  const output = path.resolve(argv[1]);
  let port = 47621;
  if (argv.length === 4) { assert.equal(argv[2], '--port'); port = Number(argv[3]); assert(Number.isInteger(port) && port >= 1024 && port <= 65535); }
  process.umask(0o077);
  fs.mkdirSync(output, { mode: 0o700 }); // refuses an existing directory: fixtures are never overwritten
  const material = await generate({ port });
  // The product reader must accept the public part exactly as the build will see it.
  const { validationUpdateFeed } = require('../../desktop/src/update-validation-feed.cjs');
  validationUpdateFeed({ name: 'code-intelligence-validation', validationUpdateFeed: material.feed });
  fs.writeFileSync(path.join(output, 'feed.json'), JSON.stringify(material.feed, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.mkdirSync(path.join(output, 'private'), { mode: 0o700 });
  for (const [name, file] of [['caKeyPem', 'ca-key.pem'], ['serverKeyPem', 'server-key.pem'], ['serverCertPem', 'server-cert.pem'],
    ['manifestSigningKeyPem', 'manifest-signing-key.pem']]) {
    fs.writeFileSync(path.join(output, 'private', file), material.private[name], { mode: 0o600, flag: 'wx' });
  }
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ format: 1, purpose: 'G-UPDATE packaged acceptance loopback feed fixture',
    createdAt: new Date().toISOString(), host: material.feed.host, port, teamId: TEAM_ID, keyId: KEY_ID,
    caSha256: sha(material.feed.caPem), publicKeySha256: sha(material.feed.publicKey),
    note: 'Fixture CA, server certificate, Ed25519 manifest key and Team ID for a loopback feed; not release material. Private files are 0600 and stay under validation/local.' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: 'FIXTURE_WRITTEN', output, feed: path.join(output, 'feed.json') }));
}

module.exports = { generate, HOST, TEAM_ID, KEY_ID, MANIFEST_PATH };
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
