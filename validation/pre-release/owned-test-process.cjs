'use strict';
const { spawn } = require('node:child_process');

async function waitFor(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise.then(value => ({ completed: true, value })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ completed: false }), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function stopOwned(child, closed, graceMs = 10000) {
  // The caller supplies its actual ChildProcess and close promise, never a PID.
  const errors = [];
  let result = await waitFor(closed, 0);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (result.completed) break;
    try { child.kill(signal); } catch { errors.push('OWNED_SIGNAL_FAILED'); }
    result = await waitFor(closed, graceMs);
  }
  if (!result.completed) {
    child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
  }
  return { closed: result.completed, exit: result.completed ? result.value : null, errors };
}
async function runOwnedCommand(executable, args, options, { timeoutMs = 900000, graceMs = 10000, spawnProcess = spawn } = {}) {
  const child = spawnProcess(executable, args, { ...options, shell: false });
  let spawnError = null;
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'SPAWN_FAILED'; });
    child.once('close', (code, signal) => resolve({ status: code, signal, errorCode: spawnError }));
  });
  const initial = await waitFor(closed, timeoutMs);
  if (initial.completed) return { ...initial.value, timedOut: false, directExitObserved: true };
  const stopped = await stopOwned(child, closed, graceMs);
  return { status: stopped.exit?.status ?? null, signal: stopped.exit?.signal ?? null,
    errorCode: 'COMMAND_TIMEOUT', timedOut: true, directExitObserved: stopped.closed,
    processTreeTerminationVerified: false, stopErrors: stopped.errors };
}
module.exports = { runOwnedCommand, stopOwned, waitFor };
