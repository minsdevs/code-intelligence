'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { planBackupCapacity, createBackupCapacity, measureBackupTree, BackupCapacityError } = require('../src/backup-capacity.cjs');
const input = (patch = {}) => ({ kind: 'BACKUP', liveDatabaseBytes: '100', liveSourceBytes: '200', previousBundleBytes: '300',
  checkpointPayloadLimitBytes: '400', incomingArchiveBytes: '0', incomingPayloadBytes: '0', stagedDatabaseLimitBytes: '0',
  stagedSourceLimitBytes: '0', ...patch });
const reject = (promise, suffix) => assert.rejects(promise, e => e instanceof BackupCapacityError && e.code === `BACKUP_CAPACITY_${suffix}`);
async function fixture(t, destination = true) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-resume-space-capacity-'));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = {};
  for (const name of ['postgres', 'recovery', 'source', 'bundle', 'destination']) {
    roots[name] = name === 'destination' && !destination ? null : path.join(root, name);
    if (roots[name]) await fs.mkdir(roots[name], { mode: 0o700 });
  }
  const controls = { available: 10n ** 15n, calls: 0, hook: null };
  const capacity = await createBackupCapacity({ roots, statfs: async () => {
    controls.calls++; await controls.hook?.(); return { bavail: controls.available, bsize: 1n };
  } });
  t.after(() => capacity.close()); return { root, roots, controls, capacity };
}
test('plan includes every simultaneous recovery copy, exact AEAD upper bound and ceil twenty percent', () => {
  const plan = planBackupCapacity(input()); const archive = 400n + 4108n + 36n;
  assert.equal(plan.components.checkpointArchive.limitBytes, String(archive));
  assert.equal(plan.components.externalOutput.limitBytes, String(archive));
  assert.equal(plan.totalBytes, String(600n + 400n + archive * 2n));
  assert.equal(plan.headroomBytes, String((BigInt(plan.totalBytes) + 4n) / 5n));
  assert.equal(plan.requiredBytes, String(BigInt(plan.totalBytes) + BigInt(plan.headroomBytes)));
  assert(Object.isFrozen(plan.components.checkpointArchive));
});
test('restore accounts decoded input, staged PostgreSQL and staged sources separately', () => {
  const plan = planBackupCapacity(input({ kind: 'RESTORE', incomingArchiveBytes: '700', incomingPayloadBytes: '600',
    stagedDatabaseLimitBytes: '900', stagedSourceLimitBytes: '800' }));
  assert.equal(plan.components.stagedDatabase.root, 'postgres'); assert.equal(plan.components.stagedSource.root, 'recovery');
  assert.equal(plan.components.externalOutput.limitBytes, '0');
  assert.equal(plan.totalBytes, String(600 + 400 + 4544 + 700 + 600 + 900 + 800));
});
for (const bad of [0, 1n, '-1', '01', '1.5', '1e6', ' 1', '1\n', '9223372036854775808', null]) {
  test(`noncanonical or unbounded bytes rejected (${String(bad).replaceAll('\n', 'LF')})`, () => {
    assert.throws(() => planBackupCapacity(input({ liveDatabaseBytes: bad })), BackupCapacityError);
  });
}
test('large integers preserve precision in planning', () => {
  const plan = planBackupCapacity(input({ liveDatabaseBytes: '9007199254740993' }));
  assert.equal(plan.baseline.postgres, '9007199254740993'); assert.equal(BigInt(plan.totalBytes), 9007199254740993n + 9988n);
});
test('backup disallows restore allowances, staging quota and archive payload caps are hard limits', () => {
  for (const patch of [{ kind: 'IMPORT' }, { incomingArchiveBytes: '1' }, { checkpointPayloadLimitBytes: '10737418241' },
    { kind: 'RESTORE', stagedDatabaseLimitBytes: '10737418240', stagedSourceLimitBytes: '1' },
    { kind: 'RESTORE', incomingPayloadBytes: '10737418241' }, { kind: 'RESTORE', incomingArchiveBytes: '10738466817' }]) {
    assert.throws(() => planBackupCapacity(input(patch)), BackupCapacityError);
  }
});
test('getters, extra fields and proxies cannot supply plan metadata', () => {
  let invoked = 0; const value = input(); Object.defineProperty(value, 'liveDatabaseBytes', { enumerable: true, get() { invoked++; return '1'; } });
  assert.throws(() => planBackupCapacity(value), BackupCapacityError); assert.equal(invoked, 0);
  assert.throws(() => planBackupCapacity({ ...input(), arbitrary: '1' }), BackupCapacityError);
  assert.throws(() => planBackupCapacity(new Proxy(input(), {})), BackupCapacityError);
});
test('same-device roots use one aggregated free-space test and accept exact boundary', async t => {
  const f = await fixture(t), plan = planBackupCapacity(input()); f.controls.available = BigInt(plan.requiredBytes);
  const lease = await f.capacity.begin(plan); assert.equal(f.controls.calls, 1);
  const checked = await lease.check(); assert.equal(checked.volumes.length, 1);
  assert.equal(checked.volumes[0].remainingBytes, plan.requiredBytes); await lease.close();
  f.controls.available--; await reject(f.capacity.begin(plan), 'SPACE');
});
test('streaming allowance is cumulative, failed consume never grants bytes, and headroom remains', async t => {
  const f = await fixture(t), plan = planBackupCapacity(input()), lease = await f.capacity.begin(plan);
  assert.equal(await lease.consume('checkpointPayload', '300'), '300');
  await reject(lease.consume('checkpointPayload', '101'), 'LIMIT');
  assert.equal(await lease.consume('checkpointPayload', '100'), '400');
  await reject(lease.consume('checkpointPayload', '1'), 'LIMIT'); await reject(lease.consume('arbitrary', '0'), 'INVALID');
  f.controls.available = BigInt(plan.requiredBytes) - 400n;
  assert.equal((await lease.check()).volumes[0].remainingBytes, String(f.controls.available));
  f.controls.available--; await reject(lease.check(), 'SPACE'); await lease.close();
});
test('disk consumption by another writer aborts the next phase', async t => {
  const f = await fixture(t), lease = await f.capacity.begin(planBackupCapacity(input())); f.controls.available = 0n;
  await reject(lease.consume('checkpointPayload', '1'), 'SPACE'); f.controls.available = 10n ** 15n;
  assert.equal(await lease.consume('checkpointPayload', '400'), '400'); await lease.close();
});
test('only one active lease and one operation, closed leases cannot be reused', async t => {
  const f = await fixture(t), plan = planBackupCapacity(input()), lease = await f.capacity.begin(plan);
  await reject(f.capacity.begin(plan), 'BUSY'); await reject(f.capacity.begin({ ...plan }), 'BUSY');
  let release; f.controls.hook = () => new Promise(resolve => { release = resolve; });
  const pending = lease.check(); while (!release) await new Promise(resolve => setImmediate(resolve));
  await reject(lease.consume('checkpointPayload', '1'), 'BUSY'); await reject(lease.close(), 'BUSY'); release(); await pending;
  f.controls.hook = null; await lease.close(); await reject(lease.check(), 'CLOSED'); await reject(f.capacity.begin({ ...plan }), 'INVALID');
});
test('destination presence must match the operation', async t => {
  const backup = await fixture(t), restore = await fixture(t, false);
  await reject(backup.capacity.begin(planBackupCapacity(input({ kind: 'RESTORE' }))), 'INVALID');
  await reject(restore.capacity.begin(planBackupCapacity(input())), 'INVALID');
  const lease = await restore.capacity.begin(planBackupCapacity(input({ kind: 'RESTORE' }))); await lease.close();
});
test('root inode replacement and symlink substitution fail before new writes', async t => {
  const f = await fixture(t), lease = await f.capacity.begin(planBackupCapacity(input()));
  await fs.rename(f.roots.recovery, `${f.roots.recovery}-old`); await fs.mkdir(f.roots.recovery, { mode: 0o700 });
  await reject(lease.check(), 'CHANGED'); await lease.close();
});
test('a root changed while statfs is pending is rejected on final readback', async t => {
  const f = await fixture(t); let once = false;
  f.controls.hook = async () => {
    if (once) return; once = true; await fs.rename(f.roots.recovery, `${f.roots.recovery}-old`);
    await fs.mkdir(f.roots.recovery, { mode: 0o700 });
  };
  await reject(f.capacity.begin(planBackupCapacity(input())), 'CHANGED');
});
test('space probes must return bounded integer filesystem quantities', async t => {
  const f = await fixture(t); const capacity = await createBackupCapacity({ roots: f.roots, statfs: async () => ({ bavail: 1, bsize: 4096 }) });
  await reject(capacity.begin(planBackupCapacity(input())), 'INVALID'); await capacity.close();
});
test('measurement counts actual file bytes, allocated blocks and root inode', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.roots.source, 'nested'), { mode: 0o755 });
  await fs.writeFile(path.join(f.roots.source, 'nested', 'x'), Buffer.alloc(123), { mode: 0o644 });
  const result = await measureBackupTree({ root: f.roots.source });
  assert.equal(result.logicalBytes, '123'); assert.equal(result.entries, 3); assert(BigInt(result.allocatedBytes) >= 123n);
  assert(Object.isFrozen(result.root));
});
test('measurement rejects symlinks, hardlinks, unsafe permissions and exact byte overflow', async t => {
  const f = await fixture(t), file = path.join(f.roots.source, 'x');
  await fs.writeFile(file, 'synthetic', { mode: 0o600 }); await fs.symlink(file, path.join(f.roots.source, 'alias'));
  await reject(measureBackupTree({ root: f.roots.source }), 'UNSAFE'); await fs.unlink(path.join(f.roots.source, 'alias'));
  await fs.link(file, path.join(f.roots.source, 'alias')); await reject(measureBackupTree({ root: f.roots.source }), 'UNSAFE');
  await fs.unlink(path.join(f.roots.source, 'alias')); await fs.chmod(file, 0o666);
  await reject(measureBackupTree({ root: f.roots.source }), 'UNSAFE'); await fs.chmod(file, 0o600);
  await reject(measureBackupTree({ root: f.roots.source, maxBytes: '1' }), 'LIMIT');
});
test('measurement bounds entry count and recursion depth', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.roots.source, 'a', 'b'), { recursive: true, mode: 0o700 });
  await reject(measureBackupTree({ root: f.roots.source, maxEntries: 1 }), 'LIMIT');
  await reject(measureBackupTree({ root: f.roots.source, maxDepth: 1 }), 'LIMIT');
});
