'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createWindowsBoundary } = require('../src/windows-native-boundary.cjs');
const { writeStorageFile, readStorageFile } = require('../src/windows-storage-files.cjs');
const { createBackupRecoveryRecords } = require('../src/backup-recovery-records.cjs');
const { encryptFile, decryptFile } = require('../src/backup-archive.cjs');
const { createBackupPayload, inspectBackupPayload } = require('../src/backup-payload.cjs');
const { REVIEWED_SCHEMA, createBackupExportPolicy } = require('../src/backup-export-policy.cjs');
const { measureBackupTree } = require('../src/backup-capacity.cjs');
const { createBackupSourceSwap } = require('../src/backup-source-swap.cjs');
const { createBackupRetention } = require('../src/backup-retention.cjs');
const { identity } = require('../src/backup-windows-io.cjs');
const { createBackupPlatformIO } = require('../src/backup-platform-io.cjs');
// Test-only staged inventory selection; production receives a verified main-owned capability.
const runtime = process.env.CI_WINDOWS_BOUNDARY_TEST_RUNTIME;
const enabled = process.platform === 'win32' && !!runtime;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
async function fixture(t) {
  const windowsBoundary = createWindowsBoundary(runtime);
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-backup-native-'));
  const root = path.join(container, 'private space 한글'); windowsBoundary.createDirectory(root, { inherit: true });
  const resources = [];
  t.after(async () => { for (const resource of resources.reverse()) await resource.close().catch(() => {}); await fs.rm(container, { recursive: true, force: true }); });
  const storage = await windowsBoundary.openStorage(root, { mode: 'workspace' }); resources.push(storage);
  const keyProvider = { currentKeyId: async () => 'a'.repeat(32), getBackupKey: async () => Buffer.alloc(32, 53) };
  return { root, windowsBoundary, storage, keyProvider, resources, installationId: 'windows-backup-test' };
}
test('native recovery chain has authenticated inactive slots, exact scratch retry, and no older-slot fallback', { skip: !enabled }, async t => {
  const f = await fixture(t); const root = path.join(f.root, 'records');
  const options = { root, windowsBoundary: f.windowsBoundary, installationId: f.installationId, runningBuild: '3', keyProvider: f.keyProvider, verifyCompletion: async () => true };
  let records = await createBackupRecoveryRecords({ ...options, initialize: true }); f.resources.push(records);
  const transactionId = crypto.randomUUID(); await records.begin({ transactionId, kind: 'RESTORE', input: { liability: '9007199254740993', off: true } });
  const scratch = { transactionId, relativeDirectory: `verification/verify-product-${crypto.randomUUID()}`, directoryIdentity: 'WI1:1:2:3', payloadIdentity: 'WI1:1:2:4', payloadSha256: sha('payload') };
  const first = await records.registerScratch(scratch); const retry = await records.registerScratch(scratch); assert.deepEqual(retry.head, first.head);
  await records.complete({ transactionId, receipt: { transactionId, off: true, liability: '9007199254740993' } });
  assert.equal((await records.read()).active, null); await records.close();
  const names = await fs.readdir(root); assert.ok(names.includes('active.0') && names.includes('active.1')); assert.ok(!names.includes('active.enc'));
  records = await createBackupRecoveryRecords(options); f.resources.push(records); assert.equal((await records.read()).completed.length, 1); await records.close();
  await fs.truncate(path.join(root, 'active.0'), 7);
  await assert.rejects(createBackupRecoveryRecords(options));
  assert.ok((await fs.readdir(root)).includes('active.1'));
});
test('native recovery preserves and refuses a torn immutable tail', { skip: !enabled }, async t => {
  const f = await fixture(t); const root = path.join(f.root, 'records');
  const options = { root, windowsBoundary: f.windowsBoundary, installationId: f.installationId, runningBuild: '3', keyProvider: f.keyProvider };
  const records = await createBackupRecoveryRecords({ ...options, initialize: true }); f.resources.push(records);
  await records.begin({ transactionId: crypto.randomUUID(), kind: 'BACKUP', input: { off: true } }); await records.close();
  await fs.truncate(path.join(root, 'record-00000001.enc'), 12);
  await assert.rejects(createBackupRecoveryRecords(options));
  assert.equal((await fs.stat(path.join(root, 'record-00000001.enc'))).size, 12);
});
test('native archive streams beyond32MiB, meters complete output and preserves uncertain-write evidence', { skip: !enabled, timeout: 120000 }, async t => {
  const f = await fixture(t);
  for (const dir of ['input', 'archives', 'restored', 'failed']) await f.storage.mkdir(dir, { inherit: true });
  const writer = await f.storage.openWrite('input/payload.bin', { maxBytes: 34 * 1024 * 1024 });
  const chunk = Buffer.alloc(1024 * 1024, 91), digest = crypto.createHash('sha256');
  for (let i = 0; i < 34; i++) { await writer.write(chunk); digest.update(chunk); } await writer.commit();
  let metered = 0;
  const sourceRoot = path.join(f.root, 'input'), archiveRoot = path.join(f.root, 'archives');
  const common = { installationId: f.installationId, keyProvider: f.keyProvider, windowsBoundary: f.windowsBoundary };
  const encrypted = await encryptFile({ ...common, sourceRoot, sourcePath: path.join(sourceRoot, 'payload.bin'), destinationRoot: archiveRoot, destinationPath: path.join(archiveRoot, 'backup.cibackup'), beforeWrite: n => { metered += Number(n); } });
  assert.equal(encrypted.payloadSha256, digest.digest('hex')); assert.equal(metered, Number((await f.storage.stat('archives/backup.cibackup')).size));
  const result = await decryptFile({ ...common, sourceRoot: archiveRoot, sourcePath: path.join(archiveRoot, 'backup.cibackup'), destinationRoot: path.join(f.root, 'restored'), destinationPath: path.join(f.root, 'restored', 'payload.bin') });
  assert.equal(result.payloadSha256, encrypted.payloadSha256);
  const failed = path.join(f.root, 'failed');
  await assert.rejects(encryptFile({ ...common, sourceRoot, sourcePath: path.join(sourceRoot, 'payload.bin'), destinationRoot: failed, destinationPath: path.join(failed, 'backup.cibackup'), fault: point => { if (point === 'encrypt:chunk-written') throw new Error('interrupted'); } }));
  assert.ok((await f.storage.stat('failed/backup.cibackup')).size !== '0');
  await assert.rejects(encryptFile({ ...common, sourceRoot, sourcePath: path.join(sourceRoot, 'payload.bin'), destinationRoot: failed, destinationPath: path.join(failed, 'backup.cibackup') }));
});
test('native typed payload verifies complete persisted frames and source-free schema summary', { skip: !enabled }, async t => {
  const f = await fixture(t); await f.storage.mkdir('payload', { inherit: true });
  const root = path.join(f.root, 'payload'), policy = createBackupExportPolicy(REVIEWED_SCHEMA);
  const row = policy.projectRow('users', { id: '1', github_id: null, login: 'local', name: null, avatar_url: null,
    created_at: '2026-10-03T12:00:00Z', updated_at: '2026-10-03T12:00:00Z', identity_type: 'LOCAL' });
  const summary = { version: 1, schema: REVIEWED_SCHEMA, ownerUserId: '1', catalogSha256: sha('catalog'),
    sequenceHighWater: Object.fromEntries(REVIEWED_SCHEMA.tables.flatMap(table => table.columns.filter(column => column.generation !== 'none').map(column => [`${table.name}.${column.name}`, table.name === 'users' ? '1' : '0']))),
    preferenceRevisionHighWater: {}, tableCounts: Object.fromEntries(REVIEWED_SCHEMA.tables.map(table => [table.name, table.name === 'users' ? '1' : '0'])),
    tableSha256: Object.fromEntries(REVIEWED_SCHEMA.tables.map(table => [table.name, sha(table.name === 'users' ? `${canonical(row)}\n` : '')])), rowCount: '1' };
  const writer = await createBackupPayload({ root, installationId: f.installationId, minimumVersion: '3', windowsBoundary: f.windowsBoundary }); f.resources.push(writer);
  await writer.writeRow(row); await writer.writeDatabase(summary); const receipt = await writer.finish();
  const read = await inspectBackupPayload({ root, installationId: f.installationId, runningBuild: '3', windowsBoundary: f.windowsBoundary });
  assert.equal(read.summary.rowCount, '1'); assert.ok(receipt.payloadBytes > 0);
});
test('native source swap resumes from authenticated identities and retains both rollback images', { skip: !enabled }, async t => {
  const f = await fixture(t), transactionId = crypto.randomUUID();
  for (const dir of ['data', 'recovery', `recovery/${transactionId}`, 'data/repos', 'data/sources', `recovery/${transactionId}/repos`, `recovery/${transactionId}/sources`]) await f.storage.mkdir(dir, { inherit: true });
  const transitions = [], options = { dataRoot: path.join(f.root, 'data'), stageRoot: path.join(f.root, 'recovery', transactionId), transactionId, windowsBoundary: f.windowsBoundary, onTransition: async value => transitions.push(value) };
  let swap = await createBackupSourceSwap(options); f.resources.push(swap); const plan = swap.plan(); assert.equal(plan.roots.data.platform, 'win32');
  assert.equal((await swap.publish()).phase, 'PUBLISHED'); await swap.close();
  swap = await createBackupSourceSwap({ ...options, resumePlan: plan }); f.resources.push(swap);
  assert.equal((await swap.rollback()).phase, 'ROLLED_BACK'); assert.ok(transitions.length >= 8);
  assert.equal((await f.storage.stat('data/repos', { directory: true })).identity, plan.entries[0].previous.identity);
  assert.equal((await f.storage.stat(`recovery/${transactionId}/failed-repos`, { directory: true })).identity, plan.entries[0].incoming.identity);
});
test('native capacity uses real allocated bytes; retention removes only authenticated older identities', { skip: !enabled }, async t => {
  const f = await fixture(t); await f.storage.mkdir('recovery', { inherit: true });
  const authority = { active: null, pendingMaintenance: null, completed: [], tombstones: [] };
  for (let sequence = 1; sequence <= 3; sequence++) {
    const transactionId = crypto.randomUUID(), relative = `recovery/${transactionId}`; await f.storage.mkdir(relative, { inherit: true });
    const bytes = Buffer.alloc(40, sequence), state = await writeStorageFile(f.storage, `${relative}/checkpoint.cibackup`, bytes);
    authority.completed.push({ transactionId, sequence, manifest: { root: identity(await f.storage.stat(relative, { directory: true })), checkpoint: { bytes: '40', sha256: sha(bytes) }, databases: [], topLevel: [{ name: 'checkpoint.cibackup', type: 'file', ...identity(state) }] } });
  }
  const recoveryRoot = path.join(f.root, 'recovery');
  const measurement = await measureBackupTree({ root: recoveryRoot, windowsBoundary: f.windowsBoundary }); assert.equal(measurement.logicalBytes, '120'); assert.equal(measurement.root.platform, 'win32'); assert.ok(BigInt(measurement.allocatedBytes) >= 120n);
  const retention = await createBackupRetention({ recoveryRoot, windowsBoundary: f.windowsBoundary, readAuthority: async () => structuredClone(authority),
    beginCollection: async value => authority.tombstones.push({ ...value, state: 'BEGUN' }),
    finishCollection: async value => { authority.tombstones.find(row => row.transactionId === value.transactionId).state = 'COMPLETED'; } }); f.resources.push(retention);
  assert.deepEqual((await retention.collect()).collected, [authority.completed[0].transactionId]); assert.deepEqual((await retention.collect()).collected, []);
});
test('native platform writer creates fresh file and namespace cleanup requires caller-observed state', { skip: !enabled }, async t => {
  const f = await fixture(t); const io = await createBackupPlatformIO(f.windowsBoundary, f.root); f.resources.push(io);
  const file = path.join(f.root, 'copy.bin'); const writer = await io.open(file, require('node:fs').constants.O_CREAT | require('node:fs').constants.O_EXCL | require('node:fs').constants.O_WRONLY);
  assert.match((await writer.stat()).identity, /^WI1:/); await writer.write(Buffer.from('copied')); await writer.sync(); await writer.close();
  const { bytes } = await readStorageFile(f.storage, 'copy.bin', 32); assert.equal(bytes.toString(), 'copied'); bytes.fill(0);
  await io.lstat(file); await io.unlink(file); assert.equal(await f.storage.stat('copy.bin', { missing: true }), null);
});
test('native destination bridge pins an inherited parent only for one output operation', { skip: !enabled }, async t => {
  const f = await fixture(t), selected = path.join(path.dirname(f.root), 'chosen inherited destination');
  await fs.mkdir(selected); await fs.writeFile(path.join(selected, 'unrelated.txt'), 'preserved');
  await assert.rejects(f.windowsBoundary.openStorage(selected, { mode: 'workspace' }));
  const io = await createBackupPlatformIO(f.windowsBoundary, f.root); f.resources.push(io);
  await assert.rejects(io.prepareBackupDestination(f.root.toUpperCase(), `CodeIntelligence-${crypto.randomUUID()}`));
  const first = await io.prepareBackupDestination(selected, `CodeIntelligence-${crypto.randomUUID()}`); f.resources.push(first);
  assert.match(f.windowsBoundary.inspect(first.root, { directory: true }), /^\d+:\d+:\d+$/);
  await assert.rejects(fs.rename(selected, selected + '-moved'));
  await io.rmdir(first.root); await first.close();
  await assert.rejects(fs.stat(first.root), { code: 'ENOENT' });
  const second = await io.prepareBackupDestination(selected, `CodeIntelligence-${crypto.randomUUID()}`); f.resources.push(second);
  await second.close(); await second.close();
  await fs.rename(selected, selected + '-moved');
  assert.equal(await fs.readFile(path.join(selected + '-moved', 'unrelated.txt'), 'utf8'), 'preserved');
  assert.ok((await fs.stat(path.join(selected + '-moved', path.basename(second.root)))).isDirectory());
});
test('native marker requires both enrolled slots even when the remaining slot authenticates', { skip: !enabled }, async t => {
  const f = await fixture(t), root = path.join(f.root, 'records');
  const options = { root, windowsBoundary: f.windowsBoundary, installationId: f.installationId, runningBuild: '3', keyProvider: f.keyProvider };
  const records = await createBackupRecoveryRecords({ ...options, initialize: true }); f.resources.push(records); await records.close();
  await fs.unlink(path.join(root, 'active.0'));
  await assert.rejects(createBackupRecoveryRecords(options));
  assert.ok((await fs.stat(path.join(root, 'active.1'))).size > 0);
});
test('native tree measurement preserves the depth64 limit without exhausting directory handles', { skip: !enabled, timeout: 120000 }, async t => {
  const f = await fixture(t); let current = '';
  for (let depth = 1; depth <= 64; depth++) { current += (current ? '/' : '') + 'depth'; await f.storage.mkdir(current, { inherit: true }); }
  assert.ok(path.join(f.root, current).length > 260);
  const parent = path.posix.dirname(current); await writeStorageFile(f.storage, parent + '/value', Buffer.from('deep'));
  const original = await f.storage.stat(current, { directory: true });
  const renamed = await f.storage.rename(current, parent + '/renamed', original.identity, { directory: true });
  assert.equal(renamed.identity, original.identity);
  const measured = await measureBackupTree({ root: f.root, windowsBoundary: f.windowsBoundary });
  assert.equal(measured.logicalBytes, '4'); assert.equal(measured.entries, 66);
  await assert.rejects(measureBackupTree({ root: f.root, windowsBoundary: f.windowsBoundary, maxDepth: 63 }));
});
test('tagged backup identities reject POSIX impostors, mixed schemas and accessor evaluation', () => {
  const { checkedIdentity } = require('../src/backup-windows-io.cjs');
  const valid = { version: 1, platform: 'win32', identity: 'WI1:1:2:18446744073709551615' };
  assert.deepEqual(checkedIdentity(valid), valid);
  for (const value of [{ ...valid, dev: '1' }, { ...valid, platform: 'posix' }, { ...valid, identity: 'WI1:1:2:18446744073709551616' },
    { ...valid, identity: 'WI1:01:2:3' }, { ...valid, identity: 'WI1:1:2:3\n' }, { ...valid, version: 2 }, { dev: '1', ino: '2' }]) assert.throws(() => checkedIdentity(value));
  let accessed = false; const hostile = { version: 1, identity: 'WI1:1:2:3' };
  Object.defineProperty(hostile, 'platform', { enumerable: true, get() { accessed = true; return 'win32'; } });
  assert.throws(() => checkedIdentity(hostile)); assert.equal(accessed, false);
});

// Bridge protocol model only; ACLs, native deletion, and pinned handles are tested above/on Windows.
async function destinationModel(t, options = {}) {
  const win = path.win32, root = 'C:\\Profile\\Private', selected = 'C:\\Chosen';
  const states = new Map(), sessions = [], events = []; let nextId = 0;
  const makeState = file => {
    const id = ++nextId;
    return { format: 1, platform: 'win32', kind: 'directory', volume: '1', fileId: `0:${id}`,
      owner: 'S-1-5-21-123', identity: `WI1:1:0:${id}`, token: `WS1:1:0:${id}:0:0:0:0`, size: '0' };
  };
  states.set(root, makeState(root)); states.set(selected, makeState(selected));
  const same = (a, b) => a?.identity === b?.identity && a?.volume === b?.volume && a?.owner === b?.owner;
  const boundary = { async openStorage(base, { mode }) {
    assert.ok(states.has(base));
    if (base === selected) assert.equal(mode, 'backup-output');
    else assert.equal(mode, 'workspace');
    if (base !== root && base !== selected && options.openFailure) throw new Error('synthetic child open failed');
    if (base !== root && base !== selected && options.replace) {
      const before = states.get(base), replacement = { ...before, ...options.replace };
      states.set(base, replacement);
    }
    const capability = { root: base, mode, rootState: states.get(base), closed: false, created: null,
      async stat(file = '', { directory }) {
        assert.equal(this.closed, false); assert.equal(directory, true);
        const target = file ? win.resolve(base, file) : base;
        if (mode === 'backup-output') assert.equal(target, base);
        assert.ok(states.has(target)); return states.get(target);
      },
      async mkdir(file, { inherit } = {}) {
        assert.equal(this.closed, false); assert.equal(inherit, true);
        const target = win.resolve(base, file); assert.ok(!states.has(target), 'fresh child required');
        if (mode === 'backup-output') { assert.equal(this.created, null); assert.equal(win.dirname(target), base); }
        const created = makeState(target); states.set(target, created);
        events.push(['mkdir', mode, target]);
        if (mode === 'backup-output') this.created = { target, state: created };
        return created;
      },
      async remove(file, expected) {
        assert.equal(mode, 'workspace'); assert.equal(this.closed, false);
        const target = win.resolve(base, file); assert.notEqual(target, base);
        assert.equal(states.get(target)?.identity, expected); states.delete(target);
      },
      async discardOutput(expected) {
        assert.equal(mode, 'backup-output'); assert.equal(this.closed, false);
        assert.ok(this.created); assert.ok(same(expected, this.created.state));
        assert.ok(same(states.get(this.created.target), this.created.state), 'changed output preserved');
        assert.ok(sessions.filter(s => s.root === this.created.target).every(s => s.closed), 'child pin must close first');
        assert.ok(![...states.keys()].some(file => file.startsWith(this.created.target + '\\')), 'nonempty output preserved');
        events.push(['discard', mode, this.created.target]); states.delete(this.created.target);
      },
      async capacity() { assert.equal(this.closed, false); return { available: 1000000000n, total: 2000000000n }; },
      async close() { this.closed = true; events.push(['close', mode, base]); },
    };
    sessions.push(capability); return capability;
  } };
  const module = { exports: {} }, filename = path.join(__dirname, '../src/backup-platform-io.cjs');
  const execute = vm.compileFunction(await fs.readFile(filename, 'utf8'), ['require', 'module'], { filename });
  execute(id => id === 'node:path' ? win : id === 'node:fs/promises' ? {
    async lstat(file) {
      if (!states.has(file)) throw Object.assign(new Error('synthetic missing'), { code: 'ENOENT' });
      return { isDirectory: () => true };
    },
  } : require(id.startsWith('./') ? path.resolve(path.dirname(filename), id) : id), module);
  const io = await module.exports.createBackupPlatformIO(boundary, root); t.after(() => io.close());
  return { io, root, selected, states, sessions, events };
}
const outputName = suffix => `CodeIntelligence-00000000-0000-0000-0000-${suffix.padStart(12, '0')}`;
test('destination bridge retains selected parent separately and releases both scopes between backups', async t => {
  const f = await destinationModel(t), lease = await f.io.prepareBackupDestination(f.selected, outputName('1'));
  assert.equal(f.sessions[1].mode, 'backup-output'); assert.equal(f.sessions[2].mode, 'workspace');
  const nested = path.win32.join(lease.root, 'inside'); await f.io.mkdir(nested); await f.io.rmdir(nested);
  assert.equal(f.events.find(row => row[2] === nested)[1], 'workspace');
  await lease.close(); await lease.close(); assert.ok(f.sessions.slice(1).every(s => s.closed));
  assert.ok(f.states.has(lease.root), 'successful encrypted output directory remains');
  const next = await f.io.prepareBackupDestination(f.selected, outputName('2'));
  assert.equal(f.sessions.length, 5); await next.close();
});
test('destination bridge discards only its empty child after releasing the child workspace', async t => {
  const f = await destinationModel(t), lease = await f.io.prepareBackupDestination(f.selected, outputName('1'));
  await f.io.rmdir(lease.root); assert.equal(f.states.has(lease.root), false);
  assert.ok(f.events.findIndex(row => row[0] === 'close' && row[2] === lease.root)
    < f.events.findIndex(row => row[0] === 'discard'));
  assert.equal(f.sessions[1].closed, false); await f.io.syncNamespace(f.selected);
  await lease.close(); assert.ok(f.sessions.slice(1).every(s => s.closed));
});
test('destination bridge refuses profile aliases and unscoped names before acquiring output authority', async t => {
  const f = await destinationModel(t);
  for (const selected of [f.root, f.root.toLowerCase(), 'c:\\PROFILE\\private\\recovery', 'C:\\', 'C:\\Chosen\\..\\Chosen'])
    await assert.rejects(f.io.prepareBackupDestination(selected, outputName('1')));
  for (const name of ['..', 'arbitrary', outputName('1') + '\\nested', outputName('1').toUpperCase(), null])
    await assert.rejects(f.io.prepareBackupDestination(f.selected, name));
  assert.equal(f.sessions.length, 1);
});
for (const replacement of [{ identity: 'WI1:1:0:999' }, { volume: '2' }, { owner: 'S-1-5-21-456' }])
  test(`destination bridge preserves a child whose ${Object.keys(replacement)[0]} changes during handoff`, async t => {
    const f = await destinationModel(t, { replace: replacement });
    await assert.rejects(f.io.prepareBackupDestination(f.selected, outputName('1')));
    assert.ok(f.states.has(path.win32.join(f.selected, outputName('1'))));
    assert.ok(f.sessions.slice(1).every(s => s.closed));
  });
test('destination bridge removes only the fresh empty child when opening its workspace fails', async t => {
  const f = await destinationModel(t, { openFailure: true });
  await assert.rejects(f.io.prepareBackupDestination(f.selected, outputName('1')));
  assert.equal(f.states.has(path.win32.join(f.selected, outputName('1'))), false);
  assert.ok(f.sessions.slice(1).every(s => s.closed));
});
test('destination bridge preserves nonempty output on failed cleanup and still releases the parent', async t => {
  const f = await destinationModel(t), lease = await f.io.prepareBackupDestination(f.selected, outputName('1'));
  const nested = path.win32.join(lease.root, 'preserved'); await f.io.mkdir(nested);
  await assert.rejects(f.io.rmdir(lease.root)); await lease.close();
  assert.ok(f.states.has(nested)); assert.ok(f.sessions.slice(1).every(s => s.closed));
});
