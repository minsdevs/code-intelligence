'use strict';

// Test supervisor only. The one signal target is the already captured Electron
// ChildProcess. PID/PPID tables are bounded, read-only observations; a PID from
// those tables can never become authority to signal or adopt a process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const execute = promisify(execFile);

function parseProcessTable(text) {
  assert.equal(typeof text, 'string');
  assert(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'PROCESS_TABLE_LIMIT');
  const rows = text.trim() ? text.trim().split('\n').map(line => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/.exec(line);
    assert(match, 'PROCESS_TABLE_INVALID');
    const pid = Number(match[1]), ppid = Number(match[2]);
    assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 && pid !== ppid);
    return { pid, ppid };
  }) : [];
  assert(rows.length <= 50000 && new Set(rows.map(row => row.pid)).size === rows.length, 'PROCESS_TABLE_INVALID');
  return rows;
}

async function processTable() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid='], {
    timeout: 5000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  return parseProcessTable(stdout);
}

function descendants(rows, ownerPid) {
  assert(Number.isSafeInteger(ownerPid) && ownerPid > 1);
  assert(rows.some(row => row.pid === ownerPid), 'OWNED_PROCESS_NOT_OBSERVED');
  const included = new Set([ownerPid]);
  for (let previous = -1; previous !== included.size;) {
    previous = included.size;
    for (const row of rows) if (included.has(row.ppid)) included.add(row.pid);
    assert(included.size <= 1024, 'OBSERVED_TREE_LIMIT');
  }
  return rows.filter(row => included.has(row.pid));
}

function ensureNativeParent(repo) {
  // A short path is necessary for macOS Unix sockets. Keep it inside the
  // approved original repository; each invocation still gets a fresh claim.
  assert.equal(fs.realpathSync(repo), repo);
  const base = fs.lstatSync(repo);
  assert(base.isDirectory() && !base.isSymbolicLink() && base.uid === process.getuid() && !(base.mode & 0o7022));
  const parent = path.join(repo, '.nr');
  try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(parent);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o7777) === 0o700 && fs.realpathSync(parent) === parent, 'NATIVE_PARENT_UNSAFE');
  return parent;
}

async function killCapturedApplication(owner, proof, {
  readProcesses = processTable, timeoutMs = 30000, intervalMs = 100,
} = {}) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  assert(Number.isSafeInteger(intervalMs) && intervalMs > 0 && intervalMs <= 1000);
  const child = owner.process();
  assert(child && Number.isSafeInteger(child.pid) && child.pid > 1 && typeof child.once === 'function'
    && typeof child.kill === 'function', 'OWNED_PROCESS_MISSING');
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  let onExit, onClose;
  const exited = new Promise(resolve => { onExit = (code, signal) => resolve({ code, signal }); child.once('exit', onExit); });
  const closed = new Promise(resolve => { onClose = resolve; child.once('close', onClose); });
  try {
    proof.observedBefore = descendants(await readProcesses(), child.pid);
    assert(proof.observedBefore.length > 1, 'DESCENDANTS_NOT_OBSERVED');
    // The read-only table call yields. Recheck the retained handle before the
    // signal so an early normal exit is never reinterpreted as our crash.
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    proof.signalRequested = 'SIGKILL'; proof.normalQuitRequested = false;
    assert.equal(child.kill('SIGKILL'), true, 'OWNED_SIGNAL_NOT_SENT');
    proof.exit = await bounded(() => exited, timeoutMs, 'OWNED_CRASH_EXIT_TIMEOUT');
    assert.equal(proof.exit.code, null); assert.equal(proof.exit.signal, 'SIGKILL');
    const observed = new Set(proof.observedBefore.map(row => row.pid));
    const started = performance.now();
    for (;;) {
      proof.remainingObservedPids = (await readProcesses()).filter(row => observed.has(row.pid)).map(row => row.pid);
      if (proof.remainingObservedPids.length === 0) break;
      if (performance.now() - started >= timeoutMs) throw new Error('OBSERVED_DESCENDANTS_REMAIN');
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    await bounded(() => closed, timeoutMs, 'OWNED_CRASH_PIPE_TIMEOUT');
    proof.observedTreeGone = true;
    proof.observationScope = 'PID/PPID snapshot before SIGKILL absent afterward; no proof of unsampled descendants or hostile daemonization';
    proof.cleanupObservationMs = Math.round(performance.now() - started);
  } finally {
    child.removeListener('exit', onExit); child.removeListener('close', onClose);
  }
}

module.exports = { parseProcessTable, descendants, ensureNativeParent, killCapturedApplication };
