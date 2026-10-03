'use strict';

// Trusted Electron main only. A helper lease is NOT a substitute for the same-userData singleton.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');
const providers = new WeakMap();
const ROLES = Object.freeze({ 'purpose-keyring': 'owner.lock', 'ai-journal': 'writer.lock', 'source-vault': 'owner.lock' });
const SYSTEM_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME'];
class NativeOwnerLockError extends Error {
  constructor(code) { super(`Native owner lock: ${code}`); this.name = 'NativeOwnerLockError'; this.code = `NATIVE_OWNER_${code}`; }
}
const failure = code => new NativeOwnerLockError(code);
function fail(code) { throw failure(code); }
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || value.includes('\0') || Buffer.byteLength(value) > 4096 || value === path.parse(value).root) fail('INVALID');
  return value;
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a, b) { return same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
async function directory(value, expected) {
  let part = path.parse(value).root;
  for (const segment of value.slice(part.length).split(path.sep)) {
    part = path.join(part, segment);
    const stat = await fs.lstat(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH');
  }
  if (await fs.realpath(value) !== value) fail('UNSAFE_PATH');
  const stat = await fs.lstat(value, { bigint: true });
  if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o700n
      || expected && !same(stat, expected)) fail('UNSAFE_PATH');
  return stat;
}
async function binary(value) {
  const canonical = await fs.realpath(absolute(value));
  const stat = await fs.lstat(canonical, { bigint: true });
  if (!stat.isFile() || (stat.mode & 0o022n) !== 0n) fail('BINARY_CHANGED');
  return { path: canonical, stat };
}
async function lockStat(file, expected) {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o7777n) !== 0o600n || stat.size > 256n
      || expected && !unchanged(stat, expected)) fail('LOST');
  return stat;
}

async function createNativeOwnerLocks(options) {
  if (!options || typeof options !== 'object' || isProxy(options)
      || Object.values(Object.getOwnPropertyDescriptors(options)).some(d => !Object.hasOwn(d, 'value'))
      || typeof process.getuid !== 'function') fail('INVALID');
  const { installationId, assertMainOwnership, onLost } = options;
  const safetyRoot = absolute(options.safetyRoot);
  const timeoutMs = options.timeoutMs ?? 10000;
  if (typeof installationId !== 'string' || installationId.match(/^[A-Za-z0-9_-]{1,128}$/)?.[0] !== installationId
      || typeof assertMainOwnership !== 'function' || typeof onLost !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000
      || options.spawnImpl !== undefined && typeof options.spawnImpl !== 'function') fail('INVALID');
  const assertOwner = () => {
    let owned;
    try { owned = assertMainOwnership(); } catch { fail('MAIN_OWNERSHIP'); }
    if (owned !== true) fail('MAIN_OWNERSHIP');
  };
  assertOwner();
  await directory(path.dirname(safetyRoot));
  const [java, jar] = await Promise.all([binary(options.javaPath), binary(options.jarPath)]);
  const state = { safetyRoot, installationId, java, jar, timeoutMs, assertOwner, onLost,
    spawn: options.spawnImpl || childProcess.spawn, active: new Map(), closed: false, lost: false, rootStat: null };
  const facade = Object.freeze({ async close() {
    if (state.active.size) fail('BUSY');
    state.closed = true;
  } });
  providers.set(facade, state);
  return facade;
}

// Internal main-module capability. Arbitrary lookalike objects never grant lock ownership.
async function acquireNativeOwnerLock(provider, { safetyRoot, kind, installationId }) {
  const state = providers.get(provider);
  if (!state || state.safetyRoot !== safetyRoot || state.installationId !== installationId
      || !Object.hasOwn(ROLES, kind)) fail('INVALID');
  if (state.closed || state.lost) fail('CLOSED');
  if (state.active.has(kind)) fail('BUSY');
  state.assertOwner();
  const reservation = {}; state.active.set(kind, reservation);
  let child; let failed; let ready = false; let expectedExit = false;
  let closed = false; let closeCode; let closeSignal; let releasePromise;
  let pending; let sequence = 0; let buffered = ''; let bytes = 0; let closeResolve;
  const closePromise = new Promise(resolve => { closeResolve = resolve; });
  const lose = code => {
    if (failed) return;
    failed = failure(code);
    if (pending) { clearTimeout(pending.timer); pending.reject(failed); pending = null; }
    if (ready && !state.lost) {
      state.lost = true;
      // Only a static reason crosses this trusted callback, never an OS error or path.
      try { Promise.resolve(state.onLost(failure('LOST'))).catch(() => {}); } catch { /* remain poisoned */ }
    }
    if (child && !closed) { child.stdin.destroy(); child.kill('SIGKILL'); }
  };
  const assertLive = () => {
    if (failed) throw failed;
    if (state.closed || state.lost || closed) fail('LOST');
    try { state.assertOwner(); } catch { lose('MAIN_OWNERSHIP'); throw failed; }
  };
  const exchange = (command, expected) => {
    assertLive();
    if (pending) fail('BUSY');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => lose('TIMEOUT'), state.timeoutMs);
      pending = { expected, resolve, reject, timer };
      child.stdin.write(`${command}\n`, error => { if (error) lose('PROCESS'); });
    });
  };
  const finish = async () => {
    if (!closed && child) {
      child.stdin.destroy(); child.kill('SIGKILL');
      let timer;
      await Promise.race([closePromise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('TERMINATION')), state.timeoutMs);
      })]).finally(() => clearTimeout(timer));
    }
    if (pending) { clearTimeout(pending.timer); pending.reject(failed || failure('CLOSED')); pending = null; }
    state.active.delete(kind);
  };
  try {
    const rootStat = await directory(safetyRoot, state.rootStat); state.rootStat ||= rootStat;
    const dir = path.join(safetyRoot, kind); const dirStat = await directory(dir);
    for (const known of [state.java, state.jar]) {
      const now = await binary(known.path);
      if (now.path !== known.path || !unchanged(now.stat, known.stat)) fail('BINARY_CHANGED');
    }
    state.assertOwner();
    const env = Object.fromEntries(SYSTEM_ENV.filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
    child = state.spawn(state.java.path, ['-jar', state.jar.path, '--ci-desktop-lease'],
      { env, cwd: path.dirname(state.jar.path), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    child.on('error', () => lose('PROCESS'));
    child.stdin.on('error', () => lose('PROCESS'));
    child.stdout.on('error', () => lose('PROCESS'));
    child.stderr.on('error', () => lose('PROCESS'));
    child.stderr.on('data', () => lose('PROTOCOL'));
    child.on('exit', (code, signal) => { if (!expectedExit || code !== 0 || signal) lose('LOST'); });
    child.on('close', (code, signal) => {
      closed = true; closeCode = code; closeSignal = signal; closeResolve();
      if (!expectedExit || pending || code !== 0 || signal) lose('LOST');
    });
    child.stdout.on('end', () => { if (!expectedExit || pending) lose('LOST'); });
    child.stdout.on('data', chunk => {
      // Bounded per response; no key, credential, path, or user payload crosses this protocol.
      bytes += chunk.length;
      if (bytes > 256 || !/^[\x20-\x7e\t\n]*$/.test(chunk.toString('ascii')) || chunk.some(byte => byte > 127)) { lose('PROTOCOL'); return; }
      buffered += chunk.toString('ascii');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      if (newline !== buffered.length - 1 || !pending || buffered.slice(0, -1) !== pending.expected) { lose('PROTOCOL'); return; }
      const waiter = pending; pending = null; clearTimeout(waiter.timer); buffered = ''; bytes = 0;
      waiter.resolve();
    });
    const nonce = crypto.randomBytes(16).toString('hex');
    await exchange(`ACQUIRE\t${Buffer.from(safetyRoot).toString('base64url')}\t${installationId}\t${kind}\t${nonce}`, `READY\t${nonce}`);
    assertLive(); ready = true;
    const file = path.join(dir, ROLES[kind]); const markerStat = await lockStat(file);
    const verifyPath = async () => {
      assertLive(); await directory(safetyRoot, rootStat); await directory(dir, dirStat);
      await lockStat(file, markerStat); assertLive();
    };
    let queue = Promise.resolve(); let releasing = false;
    const lease = Object.freeze({
      isHeld() { try { assertLive(); return !releasing; } catch { return false; } },
      check() {
        if (releasing) return Promise.reject(failure('CLOSED'));
        const result = queue.then(async () => {
          try { await verifyPath(); await exchange(`CHECK\t${++sequence}`, `HELD\t${sequence}`); await verifyPath(); }
          catch (error) { lose('LOST'); throw failed || error; }
        });
        queue = result.catch(() => {}); return result;
      },
      release() {
        if (releasePromise) return releasePromise;
        releasing = true;
        releasePromise = queue.then(async () => {
          try {
            await verifyPath(); expectedExit = true;
            await exchange(`RELEASE\t${++sequence}`, `RELEASED\t${sequence}`);
            child.stdin.end();
            let timer;
            await Promise.race([closePromise, new Promise((_, reject) => {
              timer = setTimeout(() => { lose('TIMEOUT'); reject(failed); }, state.timeoutMs);
            })]).finally(() => clearTimeout(timer));
            if (failed || closeCode !== 0 || closeSignal) throw failed || failure('LOST');
          } finally { await finish(); }
        });
        return releasePromise;
      },
    });
    await lease.check();
    return lease;
  } catch (error) {
    await finish();
    throw error instanceof NativeOwnerLockError ? error : failure('PROCESS');
  }
}

module.exports = Object.freeze({ createNativeOwnerLocks, acquireNativeOwnerLock, NativeOwnerLockError });
