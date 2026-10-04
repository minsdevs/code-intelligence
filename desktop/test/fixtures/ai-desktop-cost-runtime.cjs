'use strict';

// Disposable integration fixture: real lifecycle/keyring/journal, UDS gateway, catalog and psql.
// Only OS safeStorage and the final HTTPS transport are synthetic. No Electron, Keychain,
// provider connection, inherited credentials, production userData or existing database is used.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');
const { createAiEgressPostgres } = require('../../src/ai-egress-postgres.cjs');
const { openDesktopAiGateway } = require('../../src/ai-desktop-gateway.cjs');
const { SUPPORTED_MODEL } = require('../../src/ai-model-contracts.cjs');
const { createSourceVault } = require('../../src/source-vault.cjs');
const { createSourceBroker } = require('../../src/source-broker.cjs');

const PUBLIC_SYNTHETIC_KEY = 'sk-publicSyntheticDesktopCostKey0123456789';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lifecycle, adapter, root, sourceVault, sourceBroker, stopping = false;

function syntheticStorage() {
  const key = Buffer.alloc(32, 53);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}

// Model the supported macOS wrapper contract on CI as well. All imported implementations are real;
// this process never loads Electron or calls a real OS wrapping service.
function lifecycleModule() {
  const filename = path.resolve(__dirname, '../../src/safety-lifecycle.cjs');
  const context = vm.createContext({ module: { exports: {} }, Buffer,
    process: { platform: 'darwin', getuid: process.getuid.bind(process) },
    require(name) { return require(name.startsWith('./') ? path.resolve(path.dirname(filename), name) : name); },
  });
  vm.runInContext(syncFs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

async function control() { return JSON.parse(await fs.readFile(path.join(root, 'control.json'), 'utf8')); }

async function stop() {
  if (stopping) return;
  stopping = true;
  let failed = false;
  try {
    if (sourceBroker) await sourceBroker.close();
    if (sourceVault) await sourceVault.close();
  } catch { failed = true; }
  try { if (lifecycle) await lifecycle.close(); } catch { failed = true; }
  try { if (adapter) await adapter.close(); } catch { failed = true; }
  if (root) await fs.writeFile(path.join(root, 'closed.json'), JSON.stringify({ closed: !failed }), { mode: 0o600 });
  if (failed) process.exitCode = 1;
}

async function main() {
  const configFile = await fs.realpath(process.argv[2]);
  root = await fs.realpath(path.dirname(configFile));
  const bytes = await fs.readFile(configFile);
  let config;
  try { config = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
  await fs.unlink(configFile);
  // The Java owner only supplies its just-started Testcontainers PostgreSQL endpoint.
  adapter = await createAiEgressPostgres({ psqlPath: await fs.realpath(config.psqlPath),
    installationId: config.installationId, connection: config.connection,
    env: { PGPASSWORD: config.databasePassword, PGSSLMODE: 'verify-full', PGSSLROOTCERT: config.postgresRootCert } });
  delete config.databasePassword;
  const userData = path.join(root, 'u');
  const temporaryRoot = path.join(root, 't');
  await fs.mkdir(userData, { mode: 0o700 });
  await fs.mkdir(temporaryRoot, { mode: 0o700 });
  let gateway;
  lifecycle = await lifecycleModule().openSafetyLifecycle({ userData, safeStorage: syntheticStorage(),
    installationId: config.installationId, runningBuild: '100',
    createGateway: async ({ openJournal, freshEnrollmentAllowed }) => {
      gateway = await openDesktopAiGateway({ installationId: config.installationId, runningBuild: '100', temporaryRoot,
        tokenEncryptionKey: config.tokenEncryptionKey, openJournal, freshEnrollmentAllowed, adapter,
        // Do not inject a catalog: these tests intentionally exercise the production pinned contract.
        transport: async request => {
          const admitted = await adapter.readCommittedRequest(request.requestId);
          const event = { requestId: request.requestId, method: request.method, origin: request.origin,
            path: request.path, redirects: request.redirects, retries: request.retries,
            credentialMatched: request.headers.Authorization === `Bearer ${PUBLIC_SYNTHETIC_KEY}`,
            bodyBase64: request.body.toString('base64'), wireSha256: crypto.createHash('sha256').update(request.body).digest('hex'),
            ledgerStatusAtSend: admitted.request.status,
            evidenceCountAtSend: admitted.projection.evidence.filter(e => e.requestId === request.requestId).length };
          await fs.appendFile(path.join(root, 'transports.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
          const initial = await control();
          if (initial.mode === 'hold') {
            const deadline = Date.now() + 15000;
            while (!(await control()).release) {
              if (Date.now() >= deadline) throw new Error('Synthetic transport barrier timed out');
              await sleep(10);
            }
          }
          if (initial.mode === 'throw') throw new Error(`Synthetic provider failure: ${PUBLIC_SYNTHETIC_KEY}`);
          const response = { id: `chatcmpl-fixture-${request.requestId}`, model: SUPPORTED_MODEL, service_tier: 'default',
            choices: [{ message: { role: 'assistant', content: JSON.stringify({ explanation: 'Synthetic desktop answer',
              claims: [{ text: 'The approved file contains the fixture.', confidence: 'HIGH', evidence: ['file:src/App.java:1'] }],
              alternatives: [] }) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 40 } } };
          if (initial.mode === 'invalid-usage') delete response.usage.prompt_tokens_details;
          return { statusCode: 200, providerRequestId: `fixture-${request.requestId}`, body: Buffer.from(JSON.stringify(response)) };
        } });
      return gateway;
    } });
  delete config.tokenEncryptionKey;
  const sourceStorage = syntheticStorage();
  sourceVault = await createSourceVault({ safetyRoot: path.join(userData, 'source-safety'),
    sourceRoot: path.join(userData, 'source-blobs'), installationId: config.installationId,
    wrapper: { isAvailable: sourceStorage.isEncryptionAvailable,
      wrap: bytes => sourceStorage.encryptString(bytes.toString('base64')),
      unwrap: bytes => Buffer.from(sourceStorage.decryptString(bytes), 'base64') } });
  const sourceCapability = crypto.randomBytes(32).toString('hex');
  const sourceSocket = path.join(temporaryRoot, 'source.sock');
  sourceBroker = await createSourceBroker({ socketPath: sourceSocket, authToken: sourceCapability, vault: sourceVault });
  const aiBytes = gateway.bootstrap();
  let bootstrap;
  try {
    const { version, ...ai } = JSON.parse(aiBytes.toString('utf8'));
    bootstrap = Buffer.from(JSON.stringify({ version: 2, ai,
      source: { socketPath: sourceSocket, capability: sourceCapability } }));
  } finally { aiBytes.fill(0); }
  try { syncFs.writeFileSync(1, bootstrap); } finally { bootstrap.fill(0); syncFs.closeSync(1); }
  process.stdin.resume();
  process.stdin.once('end', () => { stop().catch(() => { process.exitCode = 1; }); });
}

main().catch(async () => {
  // Never echo adapter SQL, credentials, bootstrap, source text or raw exception details.
  process.stderr.write('Synthetic desktop cost runtime startup failed\n');
  await stop().catch(() => {});
  process.exitCode = 1;
});
