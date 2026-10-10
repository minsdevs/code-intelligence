'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readProcessTable, readOwnerMemory, parseProcessTable, discoveryRows } = require('../process-memory.cjs');

// Discovery frames come from the native helper ("<pid> <ppid> <source> <executable>"); the targeted
// RSS frame follows. No /bin/ps runs on the per-frame path.
function recorder(responses) {
  const calls = [], targets = []; let discoveries = 0;
  const next = () => { const value = responses.shift(); if (value instanceof Error) throw value; return value; };
  return {
    calls, targets, discoveries: () => discoveries,
    execute: async (command, args) => { calls.push({ command, args }); return { stdout: next() }; },
    discover: async () => { discoveries++; return next(); },
    readSelected: async pids => { targets.push([...pids]); return next(); },
  };
}



test('readOwnerMemory never requests whole-host RSS and targets only the observed owner closure', async () => {
  const h = recorder([
    '10 1 P /bin/owner\n11 10 P /bin/child\n12 11 P /bin/child\n90 1 P /bin/foreign\n91 90 P /bin/foreign\n',
    '10 1 100 /bin/owner\n11 10 20 /bin/child\n12 11 30 /bin/child\n',
  ]);
  assert.deepEqual(await readOwnerMemory(10, h), [
    { pid: 10, ppid: 1, rssKiB: 100 }, { pid: 11, ppid: 10, rssKiB: 20 }, { pid: 12, ppid: 11, rssKiB: 30 },
  ]);
  assert.deepEqual(new Set(h.targets[0]), new Set([10, 11, 12]));
  assert.equal(h.discoveries(), 1);
  assert.equal(h.calls.length, 0);
});

test('discovery and targeted readers are both required', async () => {
  const h = recorder([]);
  await assert.rejects(readOwnerMemory(10, { readSelected: h.readSelected }), /MEMORY_DISCOVERY_REQUIRED/);
  await assert.rejects(readOwnerMemory(10, { discover: h.discover }), /MEMORY_READER_REQUIRED/);
  await assert.rejects(readOwnerMemory(10, { execute: h.execute, readSelected: h.readSelected }), /MEMORY_DISCOVERY_REQUIRED/);
});

test('owner absence rejects before any targeted RSS query', async () => {
  const h = recorder(['20 1 P /bin/foreign\n21 20 P /bin/foreign\n']);
  await assert.rejects(readOwnerMemory(10, h), /OWNED_PROCESS_NOT_OBSERVED/);
  assert.equal(h.targets.length, 0);
});

test('second query rejects duplicate, unsafe and unexpected pids', async () => {
  for (const rss of [
    '10 1 1 /bin/owner\n10 1 2 /bin/owner\n',
    '9007199254740992 1 1 /bin/owner\n',
    '99 1 1 /bin/owner\n',
  ]) {
    const h = recorder(['10 1 P /bin/owner\n11 10 P /bin/child\n', rss]);
    await assert.rejects(readOwnerMemory(10, h));
  }
});

test('partial exit rows remain valid when the owner is still observed', async () => {
  const h = recorder(['10 1 P /bin/owner\n11 10 P /bin/child\n12 11 P /bin/child\n', '10 1 100 /bin/owner\n11 10 20 /bin/child\n']);
  assert.deepEqual(await readOwnerMemory(10, h), [
    { pid: 10, ppid: 1, rssKiB: 100 }, { pid: 11, ppid: 10, rssKiB: 20 },
  ]);
});

test('a changed ppid in the targeted query is filtered by the final owner closure', async () => {
  const h = recorder(['10 1 P /bin/owner\n11 10 P /bin/child\n12 11 P /bin/child\n', '10 1 100 /bin/owner\n11 99 20 /bin/child\n12 11 30 /bin/child\n']);
  assert.deepEqual(await readOwnerMemory(10, h), [{ pid: 10, ppid: 1, rssKiB: 100 }]);
});

test('query errors propagate without transformation or logging side effects', async () => {
  const expected = new Error('synthetic-query-failure');
  const first = recorder([expected]);
  await assert.rejects(readProcessTable({ execute: first.execute }), error => error === expected);
  const discoveryError = new Error('synthetic-discovery-failure');
  await assert.rejects(readOwnerMemory(10, recorder([discoveryError])), error => error === discoveryError);
  const secondError = new Error('synthetic-targeted-failure');
  const second = recorder(['10 1 P /bin/owner\n11 10 P /bin/child\n', secondError]);
  await assert.rejects(readOwnerMemory(10, second), error => error === secondError);
});

test('process table parser rejects duplicate, unsafe, malformed and oversized rows', () => {
  for (const text of ['1 1', '0 1', '-1 1', '1 -1', '1 0 extra', '1 0\n1 0', '9007199254740992 1']) {
    assert.throws(() => parseProcessTable(text));
  }
  assert.throws(() => parseProcessTable('1 0\n'.repeat(50001)));
});

test('discovery parser keeps executable sources apart and rejects malformed frames', () => {
  assert.deepEqual(discoveryRows('10 1 P /bin/owner\n11 1 A /tmp/replaced binary\n12 1 C short name\n'), [
    { pid: 10, ppid: 1, executable: '/bin/owner', pathKnown: true },
    { pid: 11, ppid: 1, executable: '/tmp/replaced binary', pathKnown: true },
    { pid: 12, ppid: 1, executable: 'short name', pathKnown: false },
  ]);
  assert.deepEqual(discoveryRows(''), []);
  for (const text of ['10 1 /bin/owner', '10 1 X /bin/owner', '10 1 P relative', '10 10 P /bin/owner', '0 1 P /bin/owner',
    '10 1 P /bin/a\n10 1 P /bin/b', '10 1 P /bin/\x01', '10 1 C ']) {
    assert.throws(() => discoveryRows(text), /PROCESS_TABLE_INVALID/);
  }
  assert.throws(() => discoveryRows('1 0 P /x\n'.repeat(50001)), /PROCESS_TABLE_LIMIT/);
});

test('a short-name row traces ownership but never attributes a bundle, and the owner needs a path', async () => {
  const app = '/tmp/Validation App.app/Contents';
  const main = app + '/MacOS/App';
  const service = app + '/XPCServices/Parser.xpc/Contents/MacOS/Parser';
  // 30 is another user's process we only know by short name; 31 is a child of the owner reported the same way.
  const h = recorder([
    ['10 1 P ' + main, '11 10 A /tmp/replaced', '31 10 C short', '20 1 P ' + service, '30 1 C ' + main].join('\n'),
    ['10 1 100 ' + main, '11 10 20 /tmp/replaced', '31 10 7 /bin/short', '20 1 30 ' + service].join('\n'),
  ]);
  const rows = await readOwnerMemory(10, h);
  assert.deepEqual(rows, [
    { pid: 10, ppid: 1, rssKiB: 100 }, { pid: 11, ppid: 10, rssKiB: 20 }, { pid: 31, ppid: 10, rssKiB: 7 },
    { pid: 20, ppid: 1, rssKiB: 30, scopeOwnerPid: 10 },
  ]);
  assert.deepEqual(new Set(h.targets[0]), new Set([10, 11, 31, 20]));
  const unknownOwner = recorder(['10 1 C owner\n11 10 P /bin/child\n']);
  await assert.rejects(readOwnerMemory(10, unknownOwner), /MEMORY_OWNER_PATH_UNAVAILABLE/);
  assert.equal(unknownOwner.targets.length, 0);
});

test('packaged RSS includes launchd-owned XPC processes without rewriting their parent IDs', async () => {
  const app = '/tmp/Validation App.app/Contents';
  const main = app + '/MacOS/App';
  const service = app + '/XPCServices/Parser.xpc/Contents/MacOS/Parser';
  const worker = app + '/XPCServices/Parser.xpc/Contents/MacOS/worker';
  const h = recorder([
    ['10 1 P '+main, '11 10 P /usr/bin/child', '20 1 P '+service, '21 20 P '+worker, '90 1 P /tmp/Other.app/Contents/XPCServices/Parser.xpc/Contents/MacOS/Parser'].join('\n'),
    ['10 1 100 '+main, '11 10 20 /usr/bin/child', '20 1 30 '+service, '21 20 50 '+worker].join('\n'),
  ]);
  const rows = await readOwnerMemory(10, h);
  const { memoryForOwner } = require('../startup-metrics.cjs');
  assert.equal(memoryForOwner(rows, 10).rssKiB, 200);
  assert.deepEqual(rows.filter(row => row.scopeOwnerPid), [
    { pid: 20, ppid: 1, rssKiB: 30, scopeOwnerPid: 10 },
    { pid: 21, ppid: 20, rssKiB: 50, scopeOwnerPid: 10 },
  ]);
  assert.equal(h.calls.length, 0);
  assert(!h.targets[0].includes(90));
});

test('an explicit XPC sampling scope survives summing but cannot adopt a foreign owner', () => {
  const { memoryForOwner } = require('../startup-metrics.cjs');
  const rows = [{ pid: 10, ppid: 1, rssKiB: 5 }, { pid: 20, ppid: 1, rssKiB: 7, scopeOwnerPid: 10 }];
  assert.equal(memoryForOwner(rows, 10).rssKiB, 12);
  assert.throws(() => memoryForOwner([{ ...rows[1], scopeOwnerPid: 99 }, rows[0]], 10), /MEMORY_SCOPE_OWNER_MISMATCH/);
});

test('two instances of the same packaged executable refuse RSS attribution before memory is read', async () => {
  const main = '/tmp/App.app/Contents/MacOS/App';
  const h = recorder(['10 1 P '+main+'\n30 1 P '+main+'\n']);
  await assert.rejects(readOwnerMemory(10, h), /MEMORY_SCOPE_AMBIGUOUS/);
  assert.equal(h.targets.length, 0);
});

test('a replaced owner executable is rejected', async () => {
  const h = recorder(['10 1 P /bin/owner\n11 10 P /bin/child\n', '10 1 5 /bin/replacement\n11 10 6 /bin/child\n']);
  await assert.rejects(readOwnerMemory(10, h), /MEMORY_PROCESS_IDENTITY_CHANGED/);
});

test('a child may exec while current ownership, not the stale executable, defines RSS scope', async () => {
  const h = recorder(['10 1 P /bin/owner\n11 10 P /bin/child\n12 10 P /bin/child\n',
    '10 1 5 /bin/owner\n11 10 6 /bin/replacement\n12 99 50 /bin/foreign\n']);
  const rows = await readOwnerMemory(10, h);
  assert.deepEqual(rows, [{ pid: 10, ppid: 1, rssKiB: 5 }, { pid: 11, ppid: 10, rssKiB: 6 }]);
});

test('XPC scope does not keep a non-bundle child after it leaves that process tree', async () => {
  const main = '/tmp/App.app/Contents/MacOS/App';
  const service = '/tmp/App.app/Contents/XPCServices/Parser.xpc/Contents/MacOS/Parser';
  const h = recorder(['10 1 P '+main+'\n20 1 P '+service+'\n21 20 P /bin/helper\n',
    '10 1 5 '+main+'\n20 1 7 '+service+'\n21 99 11 /bin/helper\n']);
  const rows = await readOwnerMemory(10, h);
  assert.deepEqual(rows.map(row => row.pid), [10,20]);
});

test('a privileged child (U row) is read through one ps call, and a vanished one needs a second discovery', async () => {
  // 31 is the owner's setuid /bin/ps run: the helper reports it as U, ps supplies its RSS.
  const h = recorder(['10 1 P /bin/owner\n31 10 P /bin/ps\n11 10 P /bin/child\n', '10 1 100 /bin/owner\n31 10 U /bin/ps\n11 10 20 /bin/child\n', '31 10 2048\n']);
  assert.deepEqual(await readOwnerMemory(10, h), [
    { pid: 10, ppid: 1, rssKiB: 100 }, { pid: 31, ppid: 10, rssKiB: 2048 }, { pid: 11, ppid: 10, rssKiB: 20 },
  ]);
  assert.deepEqual(h.calls, [{ command: '/bin/ps', args: ['-o', 'pid=,ppid=,rss=', '-p', '31'] }]);
  assert.equal(h.discoveries(), 1);
  // ps no longer lists it and neither does a fresh discovery: it exited between the two reads.
  const gone = recorder(['10 1 P /bin/owner\n31 10 P /bin/ps\n', '10 1 100 /bin/owner\n31 10 U /bin/ps\n', '', '10 1 P /bin/owner\n']);
  assert.deepEqual(await readOwnerMemory(10, gone), [{ pid: 10, ppid: 1, rssKiB: 100 }]);
  assert.equal(gone.discoveries(), 2);
  // ps omits it but discovery still lists it: the frame must not pass with a silently dropped process.
  const stuck = recorder(['10 1 P /bin/owner\n31 10 P /bin/ps\n', '10 1 100 /bin/owner\n31 10 U /bin/ps\n', '', '10 1 P /bin/owner\n31 10 P /bin/ps\n']);
  await assert.rejects(readOwnerMemory(10, stuck), /MEMORY_PRIVILEGED_UNREADABLE/);
  // ps rows must agree on the parent, and the owner itself can never be privileged.
  const parent = recorder(['10 1 P /bin/owner\n31 10 P /bin/ps\n', '10 1 100 /bin/owner\n31 10 U /bin/ps\n', '31 99 2048\n']);
  await assert.rejects(readOwnerMemory(10, parent), /MEMORY_TABLE_INVALID/);
  const owner = recorder(['10 1 P /bin/owner\n', '10 1 U /bin/owner\n']);
  await assert.rejects(readOwnerMemory(10, owner), /MEMORY_OWNER_PRIVILEGED/);
  // A ps exit of 1 (nothing matched) is not an error; other ps failures propagate.
  const nothing = recorder(['10 1 P /bin/owner\n31 10 P /bin/ps\n', '10 1 100 /bin/owner\n31 10 U /bin/ps\n', Object.assign(new Error('ps'), { code: 1 }), '10 1 P /bin/owner\n']);
  assert.deepEqual(await readOwnerMemory(10, nothing), [{ pid: 10, ppid: 1, rssKiB: 100 }]);
  const broken = recorder(['10 1 P /bin/owner\n31 10 P /bin/ps\n', '10 1 100 /bin/owner\n31 10 U /bin/ps\n', Object.assign(new Error('ps'), { code: 'ENOENT' })]);
  await assert.rejects(readOwnerMemory(10, broken), { code: 'ENOENT' });
});
