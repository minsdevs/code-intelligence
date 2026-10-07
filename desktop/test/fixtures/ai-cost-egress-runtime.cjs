'use strict';

// C13 cost-egress fixture for the Java Testcontainers matrix. All product modules are real:
// safety lifecycle/keyring/journal, ai-desktop-gateway, ai-egress core, private UDS bridge, the
// production model catalog and the psql projection adapter. Only these are synthetic:
// - OS safeStorage wrapping (fixture key) and the source vault wrapper;
// - the final provider transport, a call-counting fake that never opens a socket;
// - three documented test seams selected by control.json: the core's injected `clock` option
//   (wall offset), the journal's existing `fault` hook, and a catalog wrapper that can return a
//   stale or price-changed copy of the production contract.
// No Electron, Keychain, provider connection, inherited credential or production userData is used.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

// Install the clock seam before ai-desktop-gateway destructures createAiEgress.
const egressPath = require.resolve('../../src/ai-egress.cjs');
const realEgress = require(egressPath);
let controlFile = null;
function controlSync() {
  try { return JSON.parse(syncFs.readFileSync(controlFile, 'utf8')); } catch { return {}; }
}
const monotonic = () => Number(process.hrtime.bigint() / 1000000n);
const mainClock = Object.freeze({ wall: () => Date.now() + (Number(controlSync().wallOffsetMs) || 0), monotonic });
require.cache[egressPath].exports = Object.freeze({ ...realEgress,
  createAiEgress: options => realEgress.createAiEgress({ ...options, clock: mainClock }) });

const { createAiEgressPostgres } = require('../../src/ai-egress-postgres.cjs');
const { openDesktopAiGateway } = require('../../src/ai-desktop-gateway.cjs');
const { contractCatalog, SUPPORTED_MODEL } = require('../../src/ai-model-contracts.cjs');
const { createSourceVault } = require('../../src/source-vault.cjs');
const { createSourceBroker } = require('../../src/source-broker.cjs');

const PUBLIC_SYNTHETIC_KEY = 'sk-publicSyntheticDesktopCostKey0123456789';
const DAY = 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lifecycle, adapter, root, sourceVault, sourceBroker, authority, providerServer, stopping = false;

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

function lifecycleModule() {
  const filename = path.resolve(__dirname, '../../src/safety-lifecycle.cjs');
  const context = vm.createContext({ module: { exports: {} }, Buffer,
    process: { platform: 'darwin', getuid: process.getuid.bind(process) },
    require(name) { return require(name.startsWith('./') ? path.resolve(path.dirname(filename), name) : name); },
  });
  vm.runInContext(syncFs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

async function control() { return JSON.parse(await fs.readFile(controlFile, 'utf8')); }
async function record(file, value) { await fs.appendFile(path.join(root, file), `${JSON.stringify(value)}\n`, { mode: 0o600 }); }

// The production contract object is returned unchanged unless a test selects a catalog mode.
function catalog(input) {
  const contract = contractCatalog(input);
  const mode = controlSync().catalog;
  if (!contract || mode === undefined || mode === 'production') return contract;
  if (mode === 'stale') return Object.freeze({ ...contract, verifiedAtEpochMs: Date.now() - 30 * DAY - 60000 });
  if (mode === 'changed-price') return Object.freeze({ ...contract,
    rates: Object.freeze({ ...contract.rates, outputMicroUsdPerMillion: String(BigInt(contract.rates.outputMicroUsdPerMillion) + 1n) }) });
  return null;
}

function providerResponse(mode, requestId) {
  const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 40 } };
  if (mode === 'overbill') Object.assign(usage, { prompt_tokens: 128000, completion_tokens: 16384, total_tokens: 144384,
    prompt_tokens_details: { cached_tokens: 0 } });
  const response = { id: `chatcmpl-fixture-${requestId}`, model: SUPPORTED_MODEL, service_tier: 'default',
    choices: [{ message: { role: 'assistant', content: JSON.stringify({ explanation: 'Synthetic desktop answer',
      claims: [{ text: 'The approved file contains the fixture.', confidence: 'HIGH', evidence: [] }],
      alternatives: [] }) }, finish_reason: 'stop' }], usage };
  if (mode === 'no-usage') delete response.usage;
  if (mode === 'invalid-usage') delete response.usage.prompt_tokens_details;
  if (mode === 'reasoning-usage') usage.completion_tokens_details = { reasoning_tokens: 10 };
  if (mode === 'total-mismatch') usage.total_tokens = 151;
  if (mode === 'wrong-model') response.model = 'gpt-4o-2024-08-06';
  if (mode === 'status-500' || mode === 'status-429') {
    return { statusCode: mode === 'status-500' ? 500 : 429, providerRequestId: `fixture-${requestId}`,
      body: Buffer.from(JSON.stringify({ error: { message: 'synthetic provider error' }, usage })) };
  }
  if (mode === 'malformed') return { statusCode: 200, providerRequestId: `fixture-${requestId}`, body: Buffer.from('{"choices":[') };
  return { statusCode: 200, providerRequestId: `fixture-${requestId}`, body: Buffer.from(JSON.stringify(response)) };
}

// Call-counting fake provider. Every invocation is recorded before any mode-specific outcome.
async function transport(request) {
  const admitted = await adapter.readCommittedRequest(request.requestId);
  const journal = authority.readJournal();
  const initial = await control();
  const received = initial.mode !== 'throw-before-send';
  const event = { requestId: request.requestId, mode: initial.mode, received, method: request.method,
    origin: request.origin, path: request.path, redirects: request.redirects, retries: request.retries,
    timeoutMs: request.timeoutMs, maxResponseBytes: request.maxResponseBytes,
    headerNames: Object.keys(request.headers).sort(),
    credentialMatched: request.headers.Authorization === `Bearer ${PUBLIC_SYNTHETIC_KEY}`,
    ledgerStatusAtSend: admitted.request.status,
    evidenceCountAtSend: admitted.projection.evidence.filter(e => e.requestId === request.requestId).length,
    journalIntentAtSend: authority.readDispatch(request.requestId) !== null,
    journalStatusAtSend: journal.obligations.find(row => row.requestId === request.requestId)?.status ?? null,
    journalSequenceAtSend: journal.position.sequence };
  // A timeout before the request leaves the client: the body is never observed by the provider.
  if (received) Object.assign(event, { bodyBase64: request.body.toString('base64'),
    wireSha256: crypto.createHash('sha256').update(request.body).digest('hex') });
  await record('transports.jsonl', event);
  let mode = initial.mode;
  if (mode === 'hold') {
    const deadline = Date.now() + 15000;
    let current = initial;
    while (!current.release) {
      if (Date.now() >= deadline) throw new Error('Synthetic transport barrier timed out');
      await sleep(10); current = await control();
    }
    mode = current.then || 'success';
  }
  if (mode === 'throw-before-send') throw new Error('AI provider response unavailable');
  if (mode === 'throw-after-send') { await sleep(20); throw new Error('AI provider response unavailable'); }
  return providerResponse(mode, request.requestId);
}

// PK-08 seam-free mode: a real loopback HTTP fake provider behind the production transport composition
// (gateway default -> createProviderTransport(validation build metadata) -> node:http). It records what
// arrived on the wire; it cannot see request IDs, so it writes its own file. Anything that is not the
// provider call (for example a stray local port probe on this shared host) is answered 404 and recorded
// separately, never counted as a provider request.
async function startHttpProvider() {
  let count = 0;
  const server = http.createServer((incoming, response) => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') {
        record('http-stray.jsonl', { method: incoming.method, path: incoming.url, bytes: body.length,
          authorizationPresent: incoming.headers.authorization !== undefined })
          .finally(() => { response.writeHead(404); response.end(); });
        return;
      }
      count++;
      record('http-provider.jsonl', { method: incoming.method, path: incoming.url,
        remoteAddress: incoming.socket.remoteAddress, contentType: incoming.headers['content-type'] ?? null,
        credentialMatched: incoming.headers.authorization === `Bearer ${PUBLIC_SYNTHETIC_KEY}`,
        bodyBase64: body.toString('base64'), wireSha256: crypto.createHash('sha256').update(body).digest('hex') })
        .then(() => {
          const answer = providerResponse('success', `http-${count}`);
          response.writeHead(answer.statusCode, { 'Content-Type': 'application/json', 'x-request-id': answer.providerRequestId });
          response.end(answer.body);
        }, () => { response.destroy(); });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  providerServer = server;
  return { origin: `http://127.0.0.1:${server.address().port}` };
}

// Arms the journal's own fault hook only for the selected append after the core's verification.
function journalHooks(callbacks) {
  let armed = null;
  const fault = async stage => {
    const selected = controlSync().journalFault;
    if (!armed || !selected) return;
    if (stage === 'log.beforeFsync') armed.fsyncs++;
    const hit = (selected === 'reserved-fsync' && armed.phase === 'reserve' && stage === 'log.beforeFsync' && armed.fsyncs === 1)
      || (selected === 'intent-fsync' && armed.phase === 'reserve' && stage === 'log.beforeFsync' && armed.fsyncs === 2)
      || (selected === 'permit-return' && armed.phase === 'reserve' && stage === 'permit.beforeReturn')
      || (selected === 'settle-write' && armed.phase === 'settle' && stage === 'log.beforeWrite');
    if (hit) {
      const fired = { fault: selected, stage, phase: armed.phase };
      armed = null;
      await record('faults.jsonl', fired);
      throw new Error('Synthetic journal I/O failure');
    }
  };
  return { ...callbacks, fault,
    verifyCommittedReservation: async value => {
      const ack = await callbacks.verifyCommittedReservation(value);
      armed = { phase: 'reserve', fsyncs: 0 }; return ack;
    },
    verifySettlement: async value => {
      const ack = await callbacks.verifySettlement(value);
      armed = { phase: 'settle', fsyncs: 0 }; return ack;
    } };
}

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
  if (providerServer) { providerServer.closeAllConnections(); await new Promise(resolve => providerServer.close(() => resolve())); }
  if (root) await fs.writeFile(path.join(root, 'closed.json'), JSON.stringify({ closed: !failed }), { mode: 0o600 });
  if (failed) process.exitCode = 1;
}

async function main() {
  const configFile = await fs.realpath(process.argv[2]);
  root = await fs.realpath(path.dirname(configFile));
  controlFile = path.join(root, 'control.json');
  const bytes = await fs.readFile(configFile);
  let config;
  try { config = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
  await fs.unlink(configFile);
  const real = await createAiEgressPostgres({ psqlPath: await fs.realpath(config.psqlPath),
    installationId: config.installationId, connection: config.connection,
    env: { PGPASSWORD: config.databasePassword, PGSSLMODE: 'verify-full', PGSSLROOTCERT: config.postgresRootCert } });
  delete config.databasePassword;
  // Same adapter; only the private authority binding is observed so the fake can read B at send time.
  adapter = Object.freeze({ ...real, bindAuthority(value) { authority = value; return real.bindAuthority(value); } });
  const userData = path.join(root, 'u');
  const temporaryRoot = path.join(root, 't');
  await fs.mkdir(userData, { mode: 0o700 });
  await fs.mkdir(temporaryRoot, { mode: 0o700 });
  let gateway;
  const httpProvider = config.validationProvider === true ? await startHttpProvider() : null;
  const providerOptions = httpProvider
    ? { buildMetadata: { name: 'code-intelligence-validation', validationAiProviderOrigin: httpProvider.origin } }
    : { transport };
  lifecycle = await lifecycleModule().openSafetyLifecycle({ userData, safeStorage: syntheticStorage(),
    installationId: config.installationId, runningBuild: '100',
    createGateway: async ({ openJournal, freshEnrollmentAllowed }) => {
      gateway = await openDesktopAiGateway({ installationId: config.installationId, runningBuild: '100', temporaryRoot,
        tokenEncryptionKey: config.tokenEncryptionKey, freshEnrollmentAllowed, adapter, catalog, ...providerOptions,
        openJournal: callbacks => openJournal(journalHooks(callbacks)) });
      return gateway;
    } });
  delete config.tokenEncryptionKey;
  const sourceStorage = syntheticStorage();
  sourceVault = await createSourceVault({ safetyRoot: path.join(userData, 'source-safety'),
    sourceRoot: path.join(userData, 'source-blobs'), installationId: config.installationId,
    wrapper: { isAvailable: sourceStorage.isEncryptionAvailable,
      wrap: value => sourceStorage.encryptString(value.toString('base64')),
      unwrap: value => Buffer.from(sourceStorage.decryptString(value), 'base64') } });
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
  process.stderr.write('Synthetic cost-egress runtime startup failed\n');
  await stop().catch(() => {});
  process.exitCode = 1;
});
