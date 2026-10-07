'use strict';

// ADR-01 adapter isolation boundary in main. Production parsers run behind a signed XPC supervisor
// with App Sandbox and speak length-prefixed bounded stdio. When that cannot be established the
// result is ADAPTER_ISOLATION_UNAVAILABLE; there is no fallback to an ordinary child or to the
// loopback HTTP sidecar, which stays as the development harness (build flag `legacy-http`).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ADAPTER_ISOLATION_MODES = Object.freeze(['legacy-http', 'xpc-required']);
const ADAPTER_STDIO_PROTOCOL = 'code-intelligence.adapter.stdio';
const ADAPTER_STDIO_VERSION = 1;
// Same request bound as the analyzers (03 §6: 10 MiB until the T05 session protocol passes).
const MAX_REQUEST_FRAME_BYTES = 10 * 1024 * 1024 + 4096;
const MAX_RESPONSE_FRAME_BYTES = 64 * 1024 * 1024;
// Fixed packaged location below the runtime root; its hash comes from the verified runtime manifest.
const SUPERVISOR_EXECUTABLE = Object.freeze(['adapter-supervisor', 'AdapterSupervisor.xpc', 'Contents', 'MacOS', 'AdapterSupervisor']);
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

/** Verifies the fixed packaged supervisor: manifest entry, regular file, hash, sandbox-only entitlements. */
async function attestSupervisor({ platform = process.platform, runtimeRoot, manifest, readEntitlements = codesignEntitlements }) {
  if (platform !== 'darwin') throw unavailable('PLATFORM_UNSUPPORTED');
  const relative = SUPERVISOR_EXECUTABLE.join('/');
  const expected = manifest?.files?.[relative];
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) throw unavailable('SUPERVISOR_NOT_IN_MANIFEST');
  const file = path.join(runtimeRoot, ...SUPERVISOR_EXECUTABLE);
  let actual;
  try {
    if (!(await fs.promises.lstat(file)).isFile()) throw new Error('not a regular file');
    actual = crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
  } catch { throw unavailable('SUPERVISOR_MISSING'); }
  if (actual !== expected) throw unavailable('SUPERVISOR_HASH_MISMATCH');
  let xml;
  try { xml = await readEntitlements(file); } catch { throw unavailable('SUPERVISOR_UNSIGNED'); }
  const keys = entitlementKeys(xml);
  const sandboxed = keys.some(entry => entry.key === 'com.apple.security.app-sandbox' && entry.value === true);
  if (!sandboxed || keys.some(entry => FORBIDDEN_ENTITLEMENT.test(entry.key))) throw unavailable('SUPERVISOR_ENTITLEMENTS_REJECTED');
  return { path: file, sha256: actual };
}

/**
 * Opens the adapter boundary for the build's mode. `xpc-required` returns only an isolated session
 * from launchSupervisor (the native XPC bridge); every failure is ADAPTER_ISOLATION_UNAVAILABLE.
 */
async function openAdapterIsolation({ mode, platform, runtimeRoot, manifest, readEntitlements, launchSupervisor }) {
  if (mode === 'legacy-http') return { mode, isolated: false };
  if (mode !== 'xpc-required') throw unavailable('MODE_INVALID');
  const attested = await attestSupervisor({ platform, runtimeRoot, manifest, readEntitlements });
  if (typeof launchSupervisor !== 'function') throw unavailable('SUPERVISOR_BRIDGE_UNAVAILABLE');
  let session;
  try { session = await launchSupervisor(attested); } catch { throw unavailable('SUPERVISOR_LAUNCH_FAILED'); }
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
  ADAPTER_ISOLATION_MODES, ADAPTER_STDIO_PROTOCOL, ADAPTER_STDIO_VERSION, MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES, SUPERVISOR_EXECUTABLE, AdapterIsolationError, adapterIsolationMode,
  attestSupervisor, createFrameDecoder, createStdioAdapterClient, encodeFrame, openAdapterIsolation
};
