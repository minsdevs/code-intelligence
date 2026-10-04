'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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
  for (let depth = 1; depth <= 64; depth++) { current += (current ? '/' : '') + 'd'; await f.storage.mkdir(current, { inherit: true }); }
  const parent = current.slice(0, -2); await writeStorageFile(f.storage, parent + '/value', Buffer.from('deep'));
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
