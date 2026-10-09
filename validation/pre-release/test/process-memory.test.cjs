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



test('readOwnerMemory never requests whole-host RSS and targets only the observed owner closure', async () => {
  const h = recorder([
    '10 1 /bin/owner\n11 10 /bin/child\n12 11 /bin/child\n90 1 /bin/foreign\n91 90 /bin/foreign\n',
    '10 1 100 /bin/owner\n11 10 20 /bin/child\n12 11 30 /bin/child\n',
  ]);
  assert.deepEqual(await readOwnerMemory(10, { execute: h.execute }), [
    { pid: 10, ppid: 1, rssKiB: 100 }, { pid: 11, ppid: 10, rssKiB: 20 }, { pid: 12, ppid: 11, rssKiB: 30 },
  ]);
  const rss = h.calls.find(call => call.args.includes('-p'));
  assert.deepEqual(new Set(rss.args[rss.args.indexOf('-p') + 1].split(',')), new Set(['10','11','12']));
  assert(!h.calls.some(call => call.args.includes('-axo') && call.args.some(arg => arg.includes('rss'))));
});

test('foreign descendants are not selected for the targeted RSS query', async () => {
  const h = recorder(['10 1 /bin/owner\n11 10 /bin/child\n50 1 /bin/foreign\n51 50 /bin/foreign\n', '10 1 8 /bin/owner\n11 10 9 /bin/child\n']);
  await readOwnerMemory(10, { execute: h.execute });
  const targets = h.calls[1].args[h.calls[1].args.indexOf('-p') + 1].split(',');
  assert(!targets.includes('50') && !targets.includes('51'));
});

test('owner absence rejects before any targeted RSS query', async () => {
  const h = recorder(['20 1 /bin/foreign\n21 20 /bin/foreign\n']);
  await assert.rejects(readOwnerMemory(10, { execute: h.execute }), /OWNED_PROCESS_NOT_OBSERVED/);
  assert.equal(h.calls.length, 1);
});

test('second query rejects duplicate, unsafe and unexpected pids', async () => {
  for (const rss of [
    '10 1 1 /bin/owner\n10 1 2 /bin/owner\n',
    '9007199254740992 1 1 /bin/owner\n',
    '99 1 1 /bin/owner\n',
  ]) {
    const h = recorder(['10 1 /bin/owner\n11 10 /bin/child\n', rss]);
    await assert.rejects(readOwnerMemory(10, { execute: h.execute }));
  }
});

test('partial exit rows remain valid when the owner is still observed', async () => {
  const h = recorder(['10 1 /bin/owner\n11 10 /bin/child\n12 11 /bin/child\n', '10 1 100 /bin/owner\n11 10 20 /bin/child\n']);
  assert.deepEqual(await readOwnerMemory(10, { execute: h.execute }), [
    { pid: 10, ppid: 1, rssKiB: 100 }, { pid: 11, ppid: 10, rssKiB: 20 },
  ]);
});

test('a changed ppid in the targeted query is filtered by the final owner closure', async () => {
  const h = recorder(['10 1 /bin/owner\n11 10 /bin/child\n12 11 /bin/child\n', '10 1 100 /bin/owner\n11 99 20 /bin/child\n12 11 30 /bin/child\n']);
  assert.deepEqual(await readOwnerMemory(10, { execute: h.execute }), [{ pid: 10, ppid: 1, rssKiB: 100 }]);
});

test('query errors propagate without transformation or logging side effects', async () => {
  const expected = new Error('synthetic-query-failure');
  const first = recorder([expected]);
  await assert.rejects(readProcessTable({ execute: first.execute }), error => error === expected);
  const secondError = new Error('synthetic-targeted-failure');
  const second = recorder(['10 1 /bin/owner\n11 10 /bin/child\n', secondError]);
  await assert.rejects(readOwnerMemory(10, { execute: second.execute }), error => error === secondError);
});

test('process table parser rejects duplicate, unsafe, malformed and oversized rows', () => {
  for (const text of ['1 1', '0 1', '-1 1', '1 -1', '1 0 extra', '1 0\n1 0', '9007199254740992 1']) {
    assert.throws(() => parseProcessTable(text));
  }
  assert.throws(() => parseProcessTable('1 0\n'.repeat(50001)));
});

test('packaged RSS includes launchd-owned XPC processes without rewriting their parent IDs', async () => {
  const app = '/tmp/Validation App.app/Contents';
  const main = app + '/MacOS/App';
  const service = app + '/XPCServices/Parser.xpc/Contents/MacOS/Parser';
  const worker = app + '/XPCServices/Parser.xpc/Contents/MacOS/worker';
  const h = recorder([
    ['10 1 '+main, '11 10 /usr/bin/child', '20 1 '+service, '21 20 '+worker, '90 1 /tmp/Other.app/Contents/XPCServices/Parser.xpc/Contents/MacOS/Parser'].join('\n'),
    ['10 1 100 '+main, '11 10 20 /usr/bin/child', '20 1 30 '+service, '21 20 50 '+worker].join('\n'),
  ]);
  const rows = await readOwnerMemory(10, { execute: h.execute });
  const { memoryForOwner } = require('../startup-metrics.cjs');
  assert.equal(memoryForOwner(rows, 10).rssKiB, 200);
  assert.deepEqual(rows.filter(row => row.scopeOwnerPid), [
    { pid: 20, ppid: 1, rssKiB: 30, scopeOwnerPid: 10 },
    { pid: 21, ppid: 20, rssKiB: 50, scopeOwnerPid: 10 },
  ]);
  assert(!h.calls[0].args.some(arg => arg.includes('rss')));
  assert(!h.calls[1].args.includes('-axo'));
  assert(!h.calls[1].args.join(',').split(',').includes('90'));
});

test('an explicit XPC sampling scope survives summing but cannot adopt a foreign owner', () => {
  const { memoryForOwner } = require('../startup-metrics.cjs');
  const rows = [{ pid: 10, ppid: 1, rssKiB: 5 }, { pid: 20, ppid: 1, rssKiB: 7, scopeOwnerPid: 10 }];
  assert.equal(memoryForOwner(rows, 10).rssKiB, 12);
  assert.throws(() => memoryForOwner([{ ...rows[1], scopeOwnerPid: 99 }, rows[0]], 10), /MEMORY_SCOPE_OWNER_MISMATCH/);
});

test('two instances of the same packaged executable refuse RSS attribution before memory is read', async () => {
  const main = '/tmp/App.app/Contents/MacOS/App';
  const h = recorder(['10 1 '+main+'\n30 1 '+main+'\n']);
  await assert.rejects(readOwnerMemory(10, { execute: h.execute }), /MEMORY_SCOPE_AMBIGUOUS/);
  assert.equal(h.calls.length, 1);
});

test('a replaced owner executable is rejected', async () => {
  const h = recorder(['10 1 /bin/owner\n11 10 /bin/child\n', '10 1 5 /bin/replacement\n11 10 6 /bin/child\n']);
  await assert.rejects(readOwnerMemory(10, { execute: h.execute }), /MEMORY_PROCESS_IDENTITY_CHANGED/);
});

test('a child may exec while current ownership, not the stale executable, defines RSS scope', async () => {
  const h = recorder(['10 1 /bin/owner\n11 10 /bin/child\n12 10 /bin/child\n',
    '10 1 5 /bin/owner\n11 10 6 /bin/replacement\n12 99 50 /bin/foreign\n']);
  const rows = await readOwnerMemory(10, { execute: h.execute });
  assert.deepEqual(rows, [{ pid: 10, ppid: 1, rssKiB: 5 }, { pid: 11, ppid: 10, rssKiB: 6 }]);
});

test('XPC scope does not keep a non-bundle child after it leaves that process tree', async () => {
  const main = '/tmp/App.app/Contents/MacOS/App';
  const service = '/tmp/App.app/Contents/XPCServices/Parser.xpc/Contents/MacOS/Parser';
  const h = recorder(['10 1 '+main+'\n20 1 '+service+'\n21 20 /bin/helper\n',
    '10 1 5 '+main+'\n20 1 7 '+service+'\n21 99 11 /bin/helper\n']);
  const rows = await readOwnerMemory(10, { execute: h.execute });
  assert.deepEqual(rows.map(row => row.pid), [10,20]);
});
