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

async function readProcessTable({ execute = runExecFile } = {}) {
  assert.equal(typeof execute, 'function', 'PROCESS_EXEC_INVALID');
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid='], {
    timeout: 5000, maxBuffer: MAX_BUFFER, env: FIXED_ENV,
  });
  return parseProcessTable(stdout);
}

function executableRows(text, withMemory = false) {
  assert.equal(typeof text, 'string', 'MEMORY_TABLE_INVALID');
  assert(Buffer.byteLength(text) <= MAX_BUFFER, 'MEMORY_TABLE_LIMIT');
  if (!text.trim()) return [];
  const pattern = withMemory ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/ : /^\s*(\d+)\s+(\d+)\s+(.+)$/;
  const rows = text.trim().split('\n').map(line => {
    const match = pattern.exec(line); assert(match, 'MEMORY_TABLE_INVALID');
    const pid = Number(match[1]), ppid = Number(match[2]);
    assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 && pid !== ppid, 'MEMORY_TABLE_INVALID');
    const executable = match[withMemory ? 4 : 3].trim();
    assert(executable && !/[\x00-\x1f\x7f]/.test(executable), 'MEMORY_TABLE_INVALID');
    const row = { pid, ppid, executable };
    if (withMemory) {
      row.rssKiB = Number(match[3]);
      assert(Number.isSafeInteger(row.rssKiB) && row.rssKiB >= 0, 'MEMORY_TABLE_INVALID');
    }
    return row;
  });
  assert(rows.length <= 50000, 'MEMORY_TABLE_LIMIT');
  assert.equal(new Set(rows.map(row => row.pid)).size, rows.length, 'MEMORY_TABLE_INVALID');
  return rows;
}

// Read-only RSS attribution, never a process-termination or authorization boundary.
function samplingScope(rows, ownerPid) {
  const owner = rows.find(row => row.pid === ownerPid);
  if (!owner) throw new Error('OWNED_PROCESS_NOT_OBSERVED');
  const owned = new Set(descendants(rows, ownerPid).map(row => row.pid));
  const xpc = new Set();
  const main = /^(\/.*\.app\/Contents)\/MacOS\/[^/]+$/.exec(owner.executable);
  if (main) {
    if (rows.filter(row => row.executable === owner.executable).length !== 1) throw new Error('MEMORY_SCOPE_AMBIGUOUS');
    const prefix = main[1] + '/XPCServices/';
    for (const row of rows) {
      if (row.executable.startsWith(prefix) && path.normalize(row.executable) === row.executable
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

async function readOwnerMemory(ownerPid, { execute = runExecFile } = {}) {
  assert(Number.isSafeInteger(ownerPid) && ownerPid > 1, 'MEMORY_OWNER_INVALID');
  assert.equal(typeof execute, 'function', 'PROCESS_EXEC_INVALID');
  const options = { timeout: 5000, maxBuffer: MAX_BUFFER, env: FIXED_ENV };
  // Global discovery has no RSS or arguments. Memory is read only for this sampling scope.
  const table = await execute('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,comm='], options);
  const initial = samplingScope(executableRows(table.stdout), ownerPid).selected;
  const identities = new Map(initial.map(row => [row.pid, row.executable]));
  const { stdout } = await execute('/bin/ps', ['-ww', '-p', [...identities.keys()].join(','), '-o', 'pid=,ppid=,rss=,comm='], options);
  const rows = executableRows(stdout, true);
  for (const row of rows) {
    assert(identities.has(row.pid), 'MEMORY_TABLE_UNEXPECTED_PID');
    // Children may legitimately exec; current PPID/bundle scope is revalidated below.
    if (row.pid === ownerPid && row.executable !== identities.get(row.pid)) throw new Error('MEMORY_PROCESS_IDENTITY_CHANGED');
  }
  const current = samplingScope(rows, ownerPid);
  return current.selected.map(row => ({ pid: row.pid, ppid: row.ppid, rssKiB: row.rssKiB,
    ...(!current.owned.has(row.pid) && current.xpc.has(row.pid) ? { scopeOwnerPid: ownerPid } : {}) }));
}

module.exports = Object.freeze({ readProcessTable, readOwnerMemory, parseProcessTable });
