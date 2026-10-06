'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseMemoryTable, memoryForOwner } = require('./startup-metrics.cjs');
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

async function readOwnerMemory(ownerPid, { execute = runExecFile } = {}) {
  assert(Number.isSafeInteger(ownerPid) && ownerPid > 1, 'MEMORY_OWNER_INVALID');
  assert.equal(typeof execute, 'function', 'PROCESS_EXEC_INVALID');
  const processes = await readProcessTable({ execute });
  let owned;
  try { owned = descendants(processes, ownerPid); }
  catch (error) {
    if (error?.message === 'OWNED_PROCESS_NOT_OBSERVED') throw new Error('OWNED_PROCESS_NOT_OBSERVED');
    throw error;
  }
  const pids = owned.map(row => row.pid);
  assert(pids.length > 0 && pids.length <= 1024, 'OBSERVED_TREE_LIMIT');
  const { stdout } = await execute('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,rss='], {
    timeout: 5000, maxBuffer: MAX_BUFFER, env: FIXED_ENV,
  });
  const rows = parseMemoryTable(stdout);
  const selected = new Set(pids);
  for (const row of rows) assert(selected.has(row.pid), 'MEMORY_TABLE_UNEXPECTED_PID');
  const current = memoryForOwner(rows, ownerPid);
  if (!current) throw new Error('OWNED_PROCESS_NOT_OBSERVED');
  return current.processes;
}

module.exports = Object.freeze({ readProcessTable, readOwnerMemory, parseProcessTable });
