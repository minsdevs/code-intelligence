'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Protocol model only: these tests exercise the real JS client without pretending
// to execute NTFS or its ACL policy on the current host.
function protocolFixture() {
  const root = 'C:\\Users\\Synthetic\\chosen';
  const name = 'CodeIntelligence-01234567-89ab-4cde-8f01-23456789abcd';
  const snapshot = id => ({ format: 1, platform: 'win32', kind: 'directory', volume: '7', fileId: `0:${id}`,
    owner: 'S-1-5-21-1234', size: '0', allocationSize: '0', modified: '1', changed: '1',
    identity: `WI1:7:0:${id}`, token: `WS1:7:0:${id}:0:0:1:1` });
  const rootState = snapshot(2), created = snapshot(3), requests = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  let started = false, scheduled = false, chunks = [];
  const reply = value => {
    const bytes = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
    child.stdout.emit('data', Buffer.concat([header, bytes]));
  };
  child.stdin.write = bytes => {
    chunks.push(Buffer.from(bytes));
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false; const bytes = Buffer.concat(chunks); chunks = []; let offset = 0;
      const uint = () => { const value = bytes.readUInt32BE(offset); offset += 4; return value; };
      const field = () => { const length = uint(); const value = bytes.subarray(offset, offset + length).toString('utf8'); offset += length; return value; };
      try {
        if (!started) {
          assert.equal(field(), root); assert.equal(field(), 'backup-output'); assert.equal(offset, bytes.length);
          started = true; reply({ seq: 0, state: rootState }); return;
        }
        const operation = field(), seq = uint(), request = { operation };
        const result = { seq };
        if (operation === 'stat') { request.file = field(); request.directory = uint(); request.missing = uint(); result.state = rootState; }
        else if (operation === 'mkdir') { request.file = field(); request.inherit = uint(); result.state = created; }
        else if (operation === 'discard-output') request.identity = field();
        else if (operation === 'capacity') { result.available = '123'; result.total = '456'; }
        else assert.equal(operation, 'close');
        assert.equal(offset, bytes.length); requests.push(request); reply(result);
      } catch (error) { child.emit('error', error); }
    });
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('close', 0, null));
  child.kill = () => queueMicrotask(() => child.emit('close', 1, null));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/windows-storage.cjs'), 'utf8'), {
    module, exports: module.exports, require: name => name === './runtime-platform.cjs' ? require('../src/runtime-platform.cjs') : require(name),
    process: { platform: 'win32' }, Buffer, setTimeout, clearTimeout,
  });
  return { root, name, created, requests, open: () => module.exports.openWindowsStorage({ launch: () => child }, root, { mode: 'backup-output' }) };
}

test('backup-output JS client permits only one fresh child and path-free identity cleanup', async () => {
  const f = protocolFixture(), storage = await f.open();
  assert.equal((await storage.stat('', { directory: true })).identity, storage.rootState.identity);
  assert.equal((await storage.stat(f.root, { directory: true })).identity, storage.rootState.identity);
  const capacity = await storage.capacity(); assert.equal(capacity.available, 123n); assert.equal(capacity.total, 456n);
  const created = await storage.mkdir(path.win32.join(f.root, f.name), { inherit: true });
  assert.equal(created.identity, f.created.identity);
  await assert.rejects(storage.mkdir(f.name, { inherit: true }), { code: 'WINDOWS_STORAGE_REFUSED' });
  await assert.rejects(storage.discardOutput({ ...created, owner: 'S-1-5-21-9999' }), { code: 'WINDOWS_STORAGE_REFUSED' });
  await storage.discardOutput(created);
  await assert.rejects(storage.discardOutput(created), { code: 'WINDOWS_STORAGE_REFUSED' });
  await assert.rejects(storage.mkdir(f.name, { inherit: true }), { code: 'WINDOWS_STORAGE_REFUSED' });
  await storage.close();
  assert.deepEqual(f.requests, [
    { operation: 'stat', file: '', directory: 1, missing: 0 }, { operation: 'stat', file: '', directory: 1, missing: 0 },
    { operation: 'capacity' }, { operation: 'mkdir', file: f.name, inherit: 1 },
    { operation: 'discard-output', identity: created.identity }, { operation: 'close' },
  ]);
});

test('backup-output JS rejects generic access, aliases and malformed child names before any request', async () => {
  const f = protocolFixture(), storage = await f.open();
  const rejected = [
    () => storage.stat(), () => storage.stat('sentinel', { directory: true }), () => storage.stat('', { directory: true, missing: true }),
    () => storage.openRead('sentinel'), () => storage.openWrite('sentinel'), () => storage.entries().next(),
    () => storage.lock('owner.lock', Buffer.from('marker')), () => storage.remove('sentinel', f.created),
    () => storage.rename('sentinel', 'other', f.created), () => storage.discardOutput(f.created),
    () => storage.mkdir(f.name), () => storage.mkdir(f.name, { inherit: 1 }),
    ...['arbitrary', f.name.toUpperCase(), `${f.name}\\nested`, `..\\${f.name}`, `${f.name}.`,
      path.win32.join(f.root, 'outside') + '\\..\\' + f.name].map(name => () => storage.mkdir(name, { inherit: true })),
  ];
  for (const operation of rejected) await assert.rejects(operation(), error => error.code === 'WINDOWS_STORAGE_REFUSED'
    || error.message === 'Bundled runtime manifest has an unsafe protected storage member.');
  assert.deepEqual(f.requests, []);
  await storage.close(); assert.deepEqual(f.requests, [{ operation: 'close' }]);
});
