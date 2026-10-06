'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readProcessTable, readOwnerMemory, parseProcessTable } = require('../process-memory.cjs');

function recorder(responses) {
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options, env: { ...options.env } } });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { stdout: next };
  };
  return { calls, execute };
}

test('readProcessTable requests only pid and ppid with fixed safe execution options', async () => {
  const h = recorder(['10 1\n11 10\n']);
  assert.deepEqual(await readProcessTable({ execute: h.execute }), [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }]);
  assert.deepEqual(h.calls, [{
    command: '/bin/ps', args: ['-axo', 'pid=,ppid='],
    options: { timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } },
  }]);
});

test('readOwnerMemory never requests whole-host RSS and targets only the observed owner closure', async () => {
  const h = recorder([
    '10 1\n11 10\n12 11\n90 1\n91 90\n',
    '10 1 100\n11 10 20\n12 11 30\n',
  ]);
  assert.deepEqual(await readOwnerMemory(10, { execute: h.execute }), [
    { pid: 10, ppid: 1, rssKiB: 100 }, { pid: 11, ppid: 10, rssKiB: 20 }, { pid: 12, ppid: 11, rssKiB: 30 },
  ]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].args, ['-axo', 'pid=,ppid=']);
  assert.deepEqual(h.calls[1].args, ['-p', '10,11,12', '-o', 'pid=,ppid=,rss=']);
  assert.equal(h.calls.some(call => call.args.includes('pid=,ppid=,rss=') && call.args.includes('-axo')), false);
});

test('foreign descendants are not selected for the targeted RSS query', async () => {
  const h = recorder(['10 1\n11 10\n50 1\n51 50\n', '10 1 8\n11 10 9\n']);
  await readOwnerMemory(10, { execute: h.execute });
  assert.equal(h.calls[1].args[1], '10,11');
  assert.doesNotMatch(h.calls[1].args[1], /50|51/);
});

test('owner absence rejects before any targeted RSS query', async () => {
  const h = recorder(['20 1\n21 20\n']);
  await assert.rejects(readOwnerMemory(10, { execute: h.execute }), /OWNED_PROCESS_NOT_OBSERVED/);
  assert.equal(h.calls.length, 1);
});

test('second query rejects duplicate, unsafe and unexpected pids', async () => {
  for (const rss of [
    '10 1 1\n10 1 2\n',
    '9007199254740992 1 1\n',
    '99 1 1\n',
  ]) {
    const h = recorder(['10 1\n11 10\n', rss]);
    await assert.rejects(readOwnerMemory(10, { execute: h.execute }));
  }
});

test('partial exit rows remain valid when the owner is still observed', async () => {
  const h = recorder(['10 1\n11 10\n12 11\n', '10 1 100\n11 10 20\n']);
  assert.deepEqual(await readOwnerMemory(10, { execute: h.execute }), [
    { pid: 10, ppid: 1, rssKiB: 100 }, { pid: 11, ppid: 10, rssKiB: 20 },
  ]);
});

test('a changed ppid in the targeted query is filtered by the final owner closure', async () => {
  const h = recorder(['10 1\n11 10\n12 11\n', '10 1 100\n11 99 20\n12 11 30\n']);
  assert.deepEqual(await readOwnerMemory(10, { execute: h.execute }), [{ pid: 10, ppid: 1, rssKiB: 100 }]);
});

test('query errors propagate without transformation or logging side effects', async () => {
  const expected = new Error('synthetic-query-failure');
  const first = recorder([expected]);
  await assert.rejects(readProcessTable({ execute: first.execute }), error => error === expected);
  const secondError = new Error('synthetic-targeted-failure');
  const second = recorder(['10 1\n11 10\n', secondError]);
  await assert.rejects(readOwnerMemory(10, { execute: second.execute }), error => error === secondError);
});

test('process table parser rejects duplicate, unsafe, malformed and oversized rows', () => {
  for (const text of ['1 1', '0 1', '-1 1', '1 -1', '1 0 extra', '1 0\n1 0', '9007199254740992 1']) {
    assert.throws(() => parseProcessTable(text));
  }
  assert.throws(() => parseProcessTable('1 0\n'.repeat(50001)));
});
