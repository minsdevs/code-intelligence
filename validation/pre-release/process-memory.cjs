'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { descendants } = require('../backup-compatibility/owned-crash.cjs');


const runExecFile = promisify(execFile);
const MAX_BUFFER = 2 * 1024 * 1024;
const FIXED_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });

function parseProcessTable(text) {
  assert.equal(typeof text, 'string', 'PROCESS_TABLE_INVALID');
  assert(Buffer.byteLength(text) <= MAX_BUFFER, 'PROCESS_TABLE_LIMIT');
  if (!text.trim()) return [];
  const rows = text.trim().split('\n').map(line => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/.exec(line);
    assert(match, 'PROCESS_TABLE_INVALID');
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    assert(Number.isSafeInteger(pid) && pid > 0, 'PROCESS_TABLE_INVALID');
    assert(Number.isSafeInteger(ppid) && ppid >= 0 && pid !== ppid, 'PROCESS_TABLE_INVALID');
    return { pid, ppid };
  });
  assert(rows.length <= 50000, 'PROCESS_TABLE_LIMIT');
  assert.equal(new Set(rows.map(row => row.pid)).size, rows.length, 'PROCESS_TABLE_INVALID');
  return rows;
}

// Liveness/tree checks between phases (not the per-frame RSS path): one fixed /bin/ps.
async function readProcessTable({ execute = runExecFile } = {}) {
  assert.equal(typeof execute, 'function', 'PROCESS_EXEC_INVALID');
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid='], {
    timeout: 5000, maxBuffer: MAX_BUFFER, env: FIXED_ENV,
  });
  return parseProcessTable(stdout);
}

// Discovery frame from the native helper (native-rss.c protocol 2): "<pid> <ppid> <source> <executable>".
// P/A carry an executable path; C carries only the kernel's short command name of another user's
// process, which can take part in PID/PPID tracing but never in path-based bundle attribution.
function discoveryRows(text) {
  assert.equal(typeof text, 'string', 'PROCESS_TABLE_INVALID');
  assert(Buffer.byteLength(text) <= MAX_BUFFER, 'PROCESS_TABLE_LIMIT');
  if (!text.trim()) return [];
  const rows = text.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+([PAC])\s+(.+)$/.exec(line); assert(match, 'PROCESS_TABLE_INVALID');
    const pid = Number(match[1]), ppid = Number(match[2]);
    assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 && pid !== ppid, 'PROCESS_TABLE_INVALID');
    const executable = match[4].trim();
    assert(executable && !/[\x00-\x1f\x7f]/.test(executable), 'PROCESS_TABLE_INVALID');
    const pathKnown = match[3] !== 'C';
    assert(!pathKnown || path.isAbsolute(executable), 'PROCESS_TABLE_INVALID');
    return { pid, ppid, executable, pathKnown };
  });
  assert(rows.length <= 50000, 'PROCESS_TABLE_LIMIT');
  assert.equal(new Set(rows.map(row => row.pid)).size, rows.length, 'PROCESS_TABLE_INVALID');
  return rows;
}

// Selected frame: "<pid> <ppid> <rssKiB> <executable>", or "<pid> <ppid> U <executable>" for a privileged
// process whose task the helper may not read (rssKiB null until /bin/ps supplies it).
function executableRows(text) {
  assert.equal(typeof text, 'string', 'MEMORY_TABLE_INVALID');
  assert(Buffer.byteLength(text) <= MAX_BUFFER, 'MEMORY_TABLE_LIMIT');
  if (!text.trim()) return [];
  const rows = text.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+|U)\s+(.+)$/.exec(line); assert(match, 'MEMORY_TABLE_INVALID');
    const pid = Number(match[1]), ppid = Number(match[2]);
    assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 && pid !== ppid, 'MEMORY_TABLE_INVALID');
    const executable = match[4].trim();
    assert(executable && !/[\x00-\x1f\x7f]/.test(executable), 'MEMORY_TABLE_INVALID');
    if (match[3] === 'U') return { pid, ppid, executable, pathKnown: true, rssKiB: null, privileged: true };
    const rssKiB = Number(match[3]);
    assert(Number.isSafeInteger(rssKiB) && rssKiB >= 0, 'MEMORY_TABLE_INVALID');
    return { pid, ppid, executable, pathKnown: true, rssKiB };
  });
  assert(rows.length <= 50000, 'MEMORY_TABLE_LIMIT');
  assert.equal(new Set(rows.map(row => row.pid)).size, rows.length, 'MEMORY_TABLE_INVALID');
  return rows;
}

// "<pid> <ppid> <rssKiB>" rows from /bin/ps for the privileged subset only.
function psMemoryRows(text) {
  assert.equal(typeof text, 'string', 'MEMORY_TABLE_INVALID');
  assert(Buffer.byteLength(text) <= MAX_BUFFER, 'MEMORY_TABLE_LIMIT');
  if (!text.trim()) return [];
  const rows = text.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line); assert(match, 'MEMORY_TABLE_INVALID');
    const [pid, ppid, rssKiB] = [match[1], match[2], match[3]].map(Number);
    assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 && pid !== ppid && Number.isSafeInteger(rssKiB) && rssKiB >= 0, 'MEMORY_TABLE_INVALID');
    return { pid, ppid, rssKiB };
  });
  assert(rows.length <= 1024, 'MEMORY_TABLE_LIMIT');
  assert.equal(new Set(rows.map(row => row.pid)).size, rows.length, 'MEMORY_TABLE_INVALID');
  return rows;
}

// Read-only RSS attribution, never a process-termination or authorization boundary.
function samplingScope(rows, ownerPid) {
  const owner = rows.find(row => row.pid === ownerPid);
  if (!owner) throw new Error('OWNED_PROCESS_NOT_OBSERVED');
  if (!owner.pathKnown) throw new Error('MEMORY_OWNER_PATH_UNAVAILABLE');
  const owned = new Set(descendants(rows, ownerPid).map(row => row.pid));
  const xpc = new Set();
  const main = /^(\/.*\.app\/Contents)\/MacOS\/[^/]+$/.exec(owner.executable);
  if (main) {
    if (rows.filter(row => row.pathKnown && row.executable === owner.executable).length !== 1) throw new Error('MEMORY_SCOPE_AMBIGUOUS');
    const prefix = main[1] + '/XPCServices/';
    for (const row of rows) {
      if (row.pathKnown && row.executable.startsWith(prefix) && path.normalize(row.executable) === row.executable
        && /^[^/]+\.xpc\//.test(row.executable.slice(prefix.length))) xpc.add(row.pid);
    }
    let previous = -1;
    while (previous !== xpc.size) {
      previous = xpc.size;
      for (const row of rows) if (xpc.has(row.ppid)) xpc.add(row.pid);
      assert(xpc.size <= 1024, 'OBSERVED_TREE_LIMIT');
    }
  }
  const selected = rows.filter(row => owned.has(row.pid) || xpc.has(row.pid));
  assert(selected.length > 0 && selected.length <= 1024, 'OBSERVED_TREE_LIMIT');
  return { owned, xpc, selected };
}

// Global discovery has no RSS or arguments and spawns nothing per frame; memory is read only for
// this sampling scope. The /bin/ps table used before cost ~45-50 ms per frame on a 1,100-process
// host (also with -p for a few PIDs), which is why discovery lives in the native helper.
async function readOwnerMemory(ownerPid, { discover, readSelected, execute = runExecFile } = {}) {
  assert(Number.isSafeInteger(ownerPid) && ownerPid > 1, 'MEMORY_OWNER_INVALID');
  assert.equal(typeof discover, 'function', 'MEMORY_DISCOVERY_REQUIRED');
  assert.equal(typeof readSelected, 'function', 'MEMORY_READER_REQUIRED');
  assert.equal(typeof execute, 'function', 'PROCESS_EXEC_INVALID');
  const initial = samplingScope(discoveryRows(await discover()), ownerPid).selected;
  const identities = new Map(initial.map(row => [row.pid, row.executable]));
  const stdout = await readSelected([...identities.keys()]);
  let rows = executableRows(stdout);
  for (const row of rows) {
    assert(identities.has(row.pid), 'MEMORY_TABLE_UNEXPECTED_PID');
    // Children may legitimately exec; current PPID/bundle scope is revalidated below.
    if (row.pid === ownerPid && row.executable !== identities.get(row.pid)) throw new Error('MEMORY_PROCESS_IDENTITY_CHANGED');
  }
  if (rows.some(row => row.privileged && row.pid === ownerPid)) throw new Error('MEMORY_OWNER_PRIVILEGED');
  const privileged = rows.filter(row => row.privileged);
  if (privileged.length) {
    // Only the privileged subset (an other-UID child such as the app's own setuid /bin/ps) is read through
    // ps; it runs just in the frames where such a process exists. A PID ps no longer lists is treated as
    // exited only when a fresh discovery no longer lists it either.
    const { stdout: table } = await execute('/bin/ps', ['-o', 'pid=,ppid=,rss=', '-p', privileged.map(row => row.pid).join(',')],
      { timeout: 5000, maxBuffer: MAX_BUFFER, env: FIXED_ENV }).catch(error => { if (error?.code === 1) return { stdout: '' }; throw error; });
    const memory = new Map(psMemoryRows(table).map(row => [row.pid, row]));
    for (const row of privileged) assert(!memory.has(row.pid) || memory.get(row.pid).ppid === row.ppid, 'MEMORY_TABLE_INVALID');
    const missing = privileged.filter(row => !memory.has(row.pid)).map(row => row.pid);
    if (missing.length) {
      const live = new Set(discoveryRows(await discover()).map(row => row.pid));
      if (missing.some(pid => live.has(pid))) throw new Error('MEMORY_PRIVILEGED_UNREADABLE');
    }
    rows = rows.flatMap(row => !row.privileged ? [row] : memory.has(row.pid) ? [{ pid: row.pid, ppid: row.ppid, executable: row.executable, pathKnown: true, rssKiB: memory.get(row.pid).rssKiB }] : []);
  }
  const current = samplingScope(rows, ownerPid);
  return current.selected.map(row => ({ pid: row.pid, ppid: row.ppid, rssKiB: row.rssKiB,
    ...(!current.owned.has(row.pid) && current.xpc.has(row.pid) ? { scopeOwnerPid: ownerPid } : {}) }));
}

module.exports = Object.freeze({ readProcessTable, readOwnerMemory, parseProcessTable, discoveryRows });
