'use strict';

// ADR-01 adapter isolation boundary in main. Production parsers run behind a signed XPC supervisor
// with App Sandbox and speak length-prefixed bounded stdio. Main reaches the supervisor only through
// the app's signed bridge helper (Electron has no XPC binding), one bridge and worker per analysis.
// When that cannot be established the result is ADAPTER_ISOLATION_UNAVAILABLE; there is no fallback
// to an ordinary child or to the loopback HTTP sidecar, which stays as the development harness
// (build flag `legacy-http`). The only unsandboxed stdio worker is the TEST_ONLY mode of an
// unpackaged development app, which analyzes declared synthetic fixtures only.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn: spawnProcess } = require('node:child_process');

const ADAPTER_ISOLATION_MODES = Object.freeze(['legacy-http', 'xpc-required']);
const ADAPTER_STDIO_PROTOCOL = 'code-intelligence.adapter.stdio';
const ADAPTER_STDIO_VERSION = 1;
// Same request bound as the analyzers (03 §6: 10 MiB until the T05 session protocol passes).
const MAX_REQUEST_FRAME_BYTES = 10 * 1024 * 1024 + 4096;
const MAX_RESPONSE_FRAME_BYTES = 64 * 1024 * 1024;
// Fixed packaged locations below the app's Contents (an XPC service must sit in Contents/XPCServices
// to be found, and its framework symlinks cannot live in the symlink-free runtime tree). Their hashes
// come from the `adapterSupervisor` section of the verified runtime manifest.
const SUPERVISOR_EXECUTABLE = Object.freeze(['XPCServices', 'AdapterSupervisor.xpc', 'Contents', 'MacOS', 'AdapterSupervisor']);
const BRIDGE_EXECUTABLE = Object.freeze(['MacOS', 'adapter-bridge']);
const TS_ANALYZER_WORKER = 'ts-analyzer';
// Bridge exit status (desktop/native/adapter-supervisor/protocol.h).
const BRIDGE_EXIT_REASONS = Object.freeze({ 64: 'SUPERVISOR_LAUNCH_FAILED', 69: 'SUPERVISOR_LAUNCH_FAILED', 70: 'WORKER_REJECTED' });
const TEST_ONLY_MODE = 'test-only-unsigned';
const TEST_ONLY_ENVIRONMENT = 'CODE_INTELLIGENCE_ADAPTER_TEST_ONLY';
const SYNTHETIC_FIXTURE_MARKER = 'codeIntelligenceSyntheticFixture';
const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000;
// The supervisor holds app-sandbox only (ADR-01): no network, user files, Keychain, automation or code-signing relaxations.
const FORBIDDEN_ENTITLEMENT = /^(com\.apple\.security\.(network|files|temporary-exception|automation|personal-information|device|application-groups|cs|get-task-allow)\b|keychain-access-groups$)/;

class AdapterIsolationError extends Error {
  constructor(reason) {
    super(`ADAPTER_ISOLATION_UNAVAILABLE: ${reason}`);
    this.name = 'AdapterIsolationError';
    this.code = 'ADAPTER_ISOLATION_UNAVAILABLE';
    this.reason = reason;
  }
}
const unavailable = reason => new AdapterIsolationError(reason);

class FrameError extends Error {
  constructor(code) { super(code); this.name = 'FrameError'; this.code = code; }
}

/** Absent means the current sidecar; any other unknown value fails closed to the isolated mode. */
function adapterIsolationMode(metadata) {
  if (!metadata || !Object.hasOwn(metadata, 'adapterIsolation')) return 'legacy-http';
  return ADAPTER_ISOLATION_MODES.includes(metadata.adapterIsolation) ? metadata.adapterIsolation : 'xpc-required';
}

/**
 * TEST_ONLY unsigned analysis exists only in an unpackaged development app started with
 * CODE_INTELLIGENCE_ADAPTER_TEST_ONLY=synthetic-fixtures. A packaged app ignores the variable and
 * nothing in the renderer can set it.
 */
function adapterIsolationRuntimeMode({ metadata, isPackaged, env = {} }) {
  if (isPackaged === false && env[TEST_ONLY_ENVIRONMENT] === 'synthetic-fixtures') return TEST_ONLY_MODE;
  return adapterIsolationMode(metadata);
}

/** A synthetic fixture declares itself in its root package.json; anything else is refused. */
function isSyntheticFixtureRequest(body) {
  const files = Array.isArray(body?.files) ? body.files : [];
  const root = files.find(file => file?.path === 'package.json');
  if (!root || typeof root.content !== 'string' || root.content.length > 65536) return false;
  try { return JSON.parse(root.content)?.[SYNTHETIC_FIXTURE_MARKER] === 'TEST_ONLY'; } catch { return false; }
}

function encodeFrame(value, maxBytes) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > maxBytes) throw new FrameError('FRAME_TOO_LARGE');
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

function parseFrame(body) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new FrameError('FRAME_INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FrameError('FRAME_NOT_OBJECT');
  return value;
}

/** Buffers at most one frame of maxBytes; the length is checked before any body byte is kept. */
function createFrameDecoder(maxBytes) {
  let pending = [], pendingBytes = 0, expected = null, failed = false;
  const take = bytes => { if (bytes.length) { pending.push(bytes); pendingBytes += bytes.length; } };
  const consume = chunk => {
    const frames = [];
    let rest = chunk;
    while (rest.length > 0) {
      if (expected === null) {
        const need = 4 - pendingBytes;
        take(rest.subarray(0, need)); rest = rest.subarray(need);
        if (pendingBytes < 4) break;
        const length = Buffer.concat(pending).readUInt32BE(0);
        pending = []; pendingBytes = 0;
        if (length === 0) throw new FrameError('FRAME_EMPTY');
        if (length > maxBytes) throw new FrameError('FRAME_TOO_LARGE');
        expected = length;
      }
      const need = expected - pendingBytes;
      take(rest.subarray(0, need)); rest = rest.subarray(need);
      if (pendingBytes < expected) break;
      const body = Buffer.concat(pending);
      pending = []; pendingBytes = 0; expected = null;
      frames.push(parseFrame(body));
    }
    return frames;
  };
  return {
    push(chunk) {
      if (failed) throw new FrameError('FRAME_STREAM_FAILED');
      try { return consume(chunk); } catch (error) { failed = true; pending = []; throw error; }
    },
    end() {
      if (failed) throw new FrameError('FRAME_STREAM_FAILED');
      if (pendingBytes > 0 || expected !== null) { failed = true; throw new FrameError('FRAME_TRUNCATED'); }
    }
  };
}

const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function entitlementKeys(xml) {
  return [...String(xml).matchAll(/<key>([^<]+)<\/key>\s*(<true\s*\/>|<false\s*\/>|<array>|<string>|<dict>|<integer>)/g)]
    .map(match => ({ key: match[1], value: match[2].startsWith('<true') ? true : match[2].startsWith('<false') ? false : 'other' }));
}

function codesignEntitlements(file) {
  const run = args => new Promise((resolve, reject) => execFile('/usr/bin/codesign', args,
    { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } },
    (error, stdout, stderr) => error ? reject(error) : resolve(stdout + stderr)));
  return run(['--verify', '--strict', file]).then(() => run(['-d', '--entitlements', '-', '--xml', file]));
}

async function fileSha256(file) {
  if (!(await fs.promises.lstat(file)).isFile()) throw new Error('not a regular file');
  return crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
}

/**
 * Verifies the fixed packaged supervisor and bridge: manifest hashes, regular files, valid
 * signatures (codesign --verify --strict also checks the service's sealed resources and Info.plist,
 * which carries the worker table and the bridge requirement), a sandbox-only supervisor and a bridge
 * without any entitlement.
 */
async function attestSupervisor({ platform = process.platform, appContents, manifest, readEntitlements = codesignEntitlements }) {
  if (platform !== 'darwin') throw unavailable('PLATFORM_UNSUPPORTED');
  const section = manifest?.adapterSupervisor;
  const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!section || section.format !== 1 || !digest(section.supervisorSha256) || !digest(section.bridgeSha256)) {
    throw unavailable('SUPERVISOR_NOT_IN_MANIFEST');
  }
  const file = path.join(appContents, ...SUPERVISOR_EXECUTABLE), bridge = path.join(appContents, ...BRIDGE_EXECUTABLE);
  let actual;
  try { actual = await fileSha256(file); } catch { throw unavailable('SUPERVISOR_MISSING'); }
  if (actual !== section.supervisorSha256) throw unavailable('SUPERVISOR_HASH_MISMATCH');
  let bridgeSha256;
  try { bridgeSha256 = await fileSha256(bridge); } catch { throw unavailable('BRIDGE_MISSING'); }
  if (bridgeSha256 !== section.bridgeSha256) throw unavailable('BRIDGE_HASH_MISMATCH');
  let xml;
  try { xml = await readEntitlements(file); } catch { throw unavailable('SUPERVISOR_UNSIGNED'); }
  const keys = entitlementKeys(xml);
  const sandboxed = keys.some(entry => entry.key === 'com.apple.security.app-sandbox' && entry.value === true);
  if (!sandboxed || keys.some(entry => FORBIDDEN_ENTITLEMENT.test(entry.key))) throw unavailable('SUPERVISOR_ENTITLEMENTS_REJECTED');
  let bridgeXml;
  try { bridgeXml = await readEntitlements(bridge); } catch { throw unavailable('BRIDGE_UNSIGNED'); }
  if (entitlementKeys(bridgeXml).length) throw unavailable('BRIDGE_ENTITLEMENTS_REJECTED');
  return { path: file, sha256: actual, bridge, bridgeSha256 };
}

function exitOf(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else { child.once('exit', code => resolve(code)); child.once('error', () => resolve(null)); }
  });
}

/**
 * One isolated analysis: a fresh run token, a bridge process, the supervisor's ts-analyzer worker and
 * the framed handshake. The token reaches the supervisor on the bridge's stdin, never in argv or the
 * environment. Closing the bridge ends the XPC connection, and the supervisor kills the worker.
 */
function createWorkerSession({ command, args = [], env, preamble, spawn = spawnProcess, signal, timeoutMs = ANALYSIS_TIMEOUT_MS, runToken }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env, detached: false });
  const exited = exitOf(child);
  child.stdin.on('error', () => {});
  if (preamble) child.stdin.write(preamble);
  const client = createStdioAdapterClient({ input: child.stdout, output: child.stdin, runToken });
  const stop = () => { try { child.stdin.end(); } catch {} if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  const timer = setTimeout(stop, timeoutMs);
  const onAbort = () => stop();
  signal?.addEventListener('abort', onAbort, { once: true });
  const close = async () => {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    try { child.stdin.end(); } catch {}
    const settled = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]);
    if (settled === 'timeout') { child.kill('SIGKILL'); await exited; }
  };
  // A bridge that ends before the handshake tells why through its exit status.
  const refine = async error => {
    if (error?.code !== 'ADAPTER_ISOLATION_UNAVAILABLE' || error.reason !== 'ADAPTER_CLOSED') return error;
    const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 2000))]);
    return BRIDGE_EXIT_REASONS[code] ? unavailable(BRIDGE_EXIT_REASONS[code]) : error;
  };
  return { client, close, refine };
}

/** Production adapter: every analysis runs in its own bridge -> supervisor -> worker session. */
function createBridgeAdapter({ bridge, spawn, timeoutMs, randomBytes = crypto.randomBytes }) {
  const run = async (action, { signal } = {}) => {
    const runToken = randomBytes(32).toString('hex');
    const session = createWorkerSession({ command: bridge, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      preamble: `open ${TS_ANALYZER_WORKER} ${runToken}\n`, spawn, signal, timeoutMs, runToken });
    try {
      try { await session.client.ready; } catch (error) { throw await session.refine(error); }
      return await action(session.client);
    } finally { await session.close(); }
  };
  let verified;
  return {
    isolated: true,
    /** Proves sandbox start, worker hash checks and the handshake once per runtime start. */
    verify() { verified ??= run(async () => {}).catch(error => { verified = undefined; throw error; }); return verified; },
    analyze: (body, options) => run(client => client.analyze(body), options),
  };
}

/** TEST_ONLY: an unsandboxed stdio worker of an unpackaged app, for declared synthetic fixtures only. */
function createTestOnlyAdapter({ execPath, script, spawn, timeoutMs, randomBytes = crypto.randomBytes }) {
  const run = async (action, { signal } = {}) => {
    const runToken = randomBytes(32).toString('hex');
    const session = createWorkerSession({ command: execPath, args: [script], spawn, signal, timeoutMs, runToken,
      env: { ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ADAPTER_RUN_TOKEN: runToken } });
    try {
      try { await session.client.ready; } catch (error) { throw await session.refine(error); }
      return await action(session.client);
    } finally { await session.close(); }
  };
  return {
    isolated: false,
    testOnly: true,
    verify: () => run(async () => {}),
    analyze(body, options) {
      if (!isSyntheticFixtureRequest(body)) return Promise.reject(unavailable('TEST_ONLY_FIXTURE_REQUIRED'));
      return run(client => client.analyze(body), options);
    },
  };
}

/**
 * Opens the adapter boundary for the mode. `xpc-required` returns only the attested bridge adapter;
 * every failure is ADAPTER_ISOLATION_UNAVAILABLE.
 */
async function openAdapterIsolation({ mode, platform, appContents, manifest, readEntitlements, launchSupervisor, testOnly }) {
  if (mode === 'legacy-http') return { mode, isolated: false };
  if (mode === TEST_ONLY_MODE) {
    if (!testOnly) throw unavailable('MODE_INVALID');
    return { mode, isolated: false, session: createTestOnlyAdapter(testOnly) };
  }
  if (mode !== 'xpc-required') throw unavailable('MODE_INVALID');
  const attested = await attestSupervisor({ platform, appContents, manifest, readEntitlements });
  const launch = launchSupervisor ?? (verified => createBridgeAdapter({ bridge: verified.bridge }));
  let session;
  try { session = await launch(attested); } catch { throw unavailable('SUPERVISOR_LAUNCH_FAILED'); }
  if (!session || typeof session.analyze !== 'function') throw unavailable('SUPERVISOR_LAUNCH_FAILED');
  return { mode, isolated: true, session };
}

/** Host side of one framed adapter session (supervisor stdio). Violations close the session for good. */
function createStdioAdapterClient({ input, output, runToken }) {
  if (typeof runToken !== 'string' || !/^[0-9a-f]{64}$/.test(runToken)) throw new Error('Invalid adapter run token');
  const decoder = createFrameDecoder(MAX_RESPONSE_FRAME_BYTES);
  const pending = [];
  let greeted = false, failure = null, nextId = 1, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const fail = reason => {
    if (failure) return;
    failure = unavailable(reason);
    rejectReady(failure);
    for (const request of pending.splice(0)) request.reject(failure);
    input.removeAllListeners('data');
    try { output.end(); } catch {}
  };
  const receive = frame => {
    if (!greeted) {
      if (!exactKeys(frame, ['protocol', 'version', 'ready']) || frame.protocol !== ADAPTER_STDIO_PROTOCOL
          || frame.version !== ADAPTER_STDIO_VERSION || frame.ready !== true) return fail('PROTOCOL_MISMATCH');
      greeted = true; resolveReady(); return;
    }
    const request = pending[0];
    if (!request || frame.id !== request.id) return fail('PROTOCOL_MISMATCH');
    if (frame.ok === true && exactKeys(frame, ['id', 'ok', 'result'])) { pending.shift(); request.resolve(frame.result); return; }
    if (frame.ok === false && exactKeys(frame, ['id', 'ok', 'error']) && frame.error && typeof frame.error === 'object') {
      pending.shift();
      const error = new Error('Adapter rejected the analysis request');
      error.code = 'ADAPTER_REQUEST_REJECTED';
      error.status = Number.isInteger(frame.error.status) ? frame.error.status : 500;
      error.response = frame.error.response;
      request.reject(error);
      return;
    }
    fail('PROTOCOL_MISMATCH');
  };
  input.on('data', chunk => {
    let frames;
    try { frames = decoder.push(chunk); } catch (error) { return fail(error.code ?? 'PROTOCOL_MISMATCH'); }
    for (const frame of frames) { if (failure) return; receive(frame); }
  });
  input.once('end', () => fail('ADAPTER_CLOSED'));
  input.once('close', () => fail('ADAPTER_CLOSED'));
  input.once('error', () => fail('ADAPTER_CLOSED'));
  output.write(encodeFrame({ protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, runToken }, 1024));
  return {
    ready,
    analyze(body) {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      let bytes;
      try { bytes = encodeFrame({ id, op: 'analyze', body }, MAX_REQUEST_FRAME_BYTES); }
      catch {
        const error = new Error('Analysis request exceeds the adapter frame limit');
        error.code = 'ANALYSIS_LIMIT';
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => { pending.push({ id, resolve, reject }); output.write(bytes); });
    }
  };
}

module.exports = {
  ADAPTER_ISOLATION_MODES, ADAPTER_STDIO_PROTOCOL, ADAPTER_STDIO_VERSION, BRIDGE_EXECUTABLE, MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES, SUPERVISOR_EXECUTABLE, TEST_ONLY_ENVIRONMENT, TEST_ONLY_MODE, AdapterIsolationError,
  adapterIsolationMode, adapterIsolationRuntimeMode, attestSupervisor, createBridgeAdapter, createFrameDecoder,
  createStdioAdapterClient, createTestOnlyAdapter, encodeFrame, isSyntheticFixtureRequest, openAdapterIsolation
};
