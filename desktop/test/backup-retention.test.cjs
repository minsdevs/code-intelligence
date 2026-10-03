'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createBackupRetention, validateRetentionManifest, validateRetentionAuthority, retentionManifestSha256,
  retentionCandidate, isRetentionTopLevelName, BackupRetentionError } = require('../src/backup-retention.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const ident = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const reject = (promise, suffix) => assert.rejects(promise, e => e instanceof BackupRetentionError && e.code === `BACKUP_RETENTION_${suffix}`);
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function fixture(t, count = 4) {
  const recoveryRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-resume-space-retention-'));
  await fs.chmod(recoveryRoot, 0o700); t.after(() => fs.rm(recoveryRoot, { recursive: true, force: true }));
  const authority = { active: null, pendingMaintenance: null, completed: [], tombstones: [] };
  for (let sequence = 1; sequence <= count; sequence++) {
    const transactionId = crypto.randomUUID(), root = path.join(recoveryRoot, transactionId);
    await fs.mkdir(root, { mode: 0o700 });
    const payload = Buffer.alloc(32 + sequence, sequence), file = path.join(root, 'checkpoint.cibackup');
    await fs.writeFile(file, payload, { mode: 0o600 }); await fs.mkdir(path.join(root, 'checkpoint'), { mode: 0o700 });
    await fs.mkdir(path.join(root, 'previous-repos'), { mode: 0o755 });
    await fs.writeFile(path.join(root, 'previous-repos', 'object'), 'synthetic source', { mode: 0o644 });
    const topLevel = await Promise.all(['checkpoint.cibackup', 'checkpoint', 'previous-repos'].map(async name => {
      const stat = await fs.lstat(path.join(root, name), { bigint: true });
      return { name, type: stat.isDirectory() ? 'directory' : 'file', ...ident(stat) };
    }));
    authority.completed.push({ transactionId, sequence, manifest: { root: ident(await fs.lstat(root, { bigint: true })),
      checkpoint: { bytes: String(payload.length), sha256: crypto.createHash('sha256').update(payload).digest('hex') },
      databases: [], topLevel } });
  }
  const calls = [], controls = { fault: null, begin: null, end: null, authority: null, drop: null };
  const options = { recoveryRoot, readAuthority: async () => { await controls.authority?.(); return copy(authority); },
    beginCollection: async value => {
      calls.push(['begin', value]); if (controls.begin) return controls.begin(value);
      authority.tombstones.push({ ...value, state: 'BEGUN' });
    }, finishCollection: async value => {
      calls.push(['end', value]); if (controls.end) return controls.end(value);
      authority.tombstones.find(row => row.transactionId === value.transactionId).state = 'COMPLETED';
    }, dropDatabase: async value => { calls.push(['drop', value]); await controls.drop?.(value); },
    fault: async (point, value) => controls.fault?.(point, value) };
  let current = await createBackupRetention(options); t.after(() => current.close());
  return { recoveryRoot, authority, calls, controls, options, get retention() { return current; },
    async reopen() { await current.close(); current = await createBackupRetention(options); return current; },
    root(index) { return path.join(recoveryRoot, authority.completed[index].transactionId); } };
}
test('keeps the newest two authenticated checkpoints and removes only older completed roots', async t => {
  const f = await fixture(t), result = await f.retention.collect();
  assert.deepEqual(result.kept, [f.authority.completed[3].transactionId, f.authority.completed[2].transactionId]);
  assert.deepEqual(result.collected, [f.authority.completed[0].transactionId, f.authority.completed[1].transactionId]);
  for (const i of [0, 1]) assert.equal(await exists(f.root(i)), false);
  for (const i of [2, 3]) assert.equal(await exists(f.root(i)), true);
  assert.deepEqual(f.calls.map(([operation]) => operation), ['begin', 'end', 'begin', 'end']);
  const retry = await f.retention.collect(); assert.deepEqual(retry.collected, []); assert.equal(f.calls.length, 4);
});
test('two or fewer completed transactions are always retained', async t => {
  const f = await fixture(t, 2); assert.deepEqual((await f.retention.collect()).collected, []); assert.equal(f.calls.length, 0);
});
test('a damaged retained checkpoint prevents any older deletion', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root(3), 'checkpoint.cibackup'), Buffer.alloc(36, 7));
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(f.calls.length, 0); assert.equal(await exists(f.root(0)), true);
});
test('missing newest checkpoint does not turn the third one into disposable data', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.root(3), 'checkpoint.cibackup'));
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(f.calls.length, 0);
});
for (const key of ['active', 'pendingMaintenance']) test(`${key} blocks all collection`, async t => {
  const f = await fixture(t); f.authority[key] = crypto.randomUUID(); await reject(f.retention.collect(), 'ACTIVE'); assert.equal(f.calls.length, 0);
});
test('an incomplete unlisted root, safety sibling and external output are never traversed', async t => {
  const f = await fixture(t); const unknown = path.join(f.recoveryRoot, crypto.randomUUID());
  await fs.mkdir(unknown, { mode: 0o700 }); await fs.writeFile(path.join(unknown, 'evidence'), 'unfinished', { mode: 0o600 });
  const sibling = path.join(f.recoveryRoot, 'safety'); await fs.mkdir(sibling, { mode: 0o700 });
  await fs.writeFile(path.join(sibling, 'journal'), 'preserve', { mode: 0o600 });
  await fs.writeFile(path.join(f.recoveryRoot, 'selected.cibackup'), 'external', { mode: 0o600 });
  await f.retention.collect(); assert.equal(await fs.readFile(path.join(unknown, 'evidence'), 'utf8'), 'unfinished');
  assert.equal(await fs.readFile(path.join(sibling, 'journal'), 'utf8'), 'preserve');
  assert.equal(await fs.readFile(path.join(f.recoveryRoot, 'selected.cibackup'), 'utf8'), 'external');
});
test('unknown top-level content prevents begin instead of recursively deleting it', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root(0), 'unrecognized'), 'keep', { mode: 0o600 });
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(f.calls.length, 0);
});
test('fixed verification root retains immutable manifest identity while repeated recovery adds UUID scratch children', async t => {
  const f = await fixture(t), verification = path.join(f.root(0), 'verification');
  await fs.mkdir(verification, { mode: 0o700 });
  const manifest = f.authority.completed[0].manifest;
  manifest.topLevel.push({ name: 'verification', type: 'directory', ...ident(await fs.lstat(verification, { bigint: true })) });
  const originalHash = retentionManifestSha256(manifest);
  for (let i = 0; i < 3; i++) {
    const scratch = path.join(verification, crypto.randomUUID()); await fs.mkdir(scratch, { mode: 0o700 });
    await fs.writeFile(path.join(scratch, 'proof'), 'synthetic verification', { mode: 0o600 });
  }
  assert.equal(retentionManifestSha256(manifest), originalHash);
  assert.equal(isRetentionTopLevelName('verification'), true);
  await f.retention.collect(); assert.equal(await exists(f.root(0)), false);
  assert.equal(f.calls[0][1].manifestSha256, originalHash);
});
test('fixed verification name without a recorded inode grants no collection authority', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root(0), 'verification'), { mode: 0o700 });
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(f.calls.length, 0);
});
test('fixed verification directory inode replacement fails against the original manifest', async t => {
  const f = await fixture(t), verification = path.join(f.root(0), 'verification');
  await fs.mkdir(verification, { mode: 0o700 });
  f.authority.completed[0].manifest.topLevel.push({ name: 'verification', type: 'directory', ...ident(await fs.lstat(verification, { bigint: true })) });
  await fs.rename(verification, path.join(f.recoveryRoot, `preserved-${crypto.randomUUID()}`));
  await fs.mkdir(verification, { mode: 0o700 });
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(f.calls.length, 0);
});
test('main-generated verification and session scratch directories require exact names and recorded inodes', async t => {
  const f = await fixture(t);
  for (const prefix of ['verify-checkpoint', 'verify-incoming', 'verify-product', 'recovery-sessions']) {
    const name = `${prefix}-${crypto.randomUUID()}`, file = path.join(f.root(0), name); await fs.mkdir(file, { mode: 0o700 });
    f.authority.completed[0].manifest.topLevel.push({ name, type: 'directory', ...ident(await fs.lstat(file, { bigint: true })) });
  }
  await f.retention.collect(); assert.equal(await exists(f.root(0)), false);
});
test('a valid generated scratch name is preserved when its inode was not in RETENTION_READY', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root(0), `verify-product-${crypto.randomUUID()}`), { mode: 0o700 });
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(f.calls.length, 0);
});
test('generated scratch names reject malformed, uppercase, path and terminator variants', () => {
  const id = '11111111-2222-4333-8444-aaaaaaaaaaaa';
  assert.equal(isRetentionTopLevelName(`verify-product-${id}`), true);
  for (const value of [`verify-other-${id}`, `verify-product-${id.toUpperCase()}`, `verify-product-${id}\n`,
    `recovery-sessions-${id}/outside`, `../verify-product-${id}`, 'verify-product-x']) assert.equal(isRetentionTopLevelName(value), false);
});
test('retention manifests bound generated scratch roots to 256 entries', async t => {
  const f = await fixture(t), manifest = copy(f.authority.completed[0].manifest);
  while (manifest.topLevel.length < 256) manifest.topLevel.push({ name: `verify-product-${crypto.randomUUID()}`, type: 'directory',
    dev: manifest.root.dev, ino: String(1000000000000 + manifest.topLevel.length) });
  assert.equal(validateRetentionManifest(manifest).topLevel.length, 256);
  manifest.topLevel.push({ name: `recovery-sessions-${crypto.randomUUID()}`, type: 'directory', dev: manifest.root.dev, ino: '2000000000000' });
  assert.throws(() => validateRetentionManifest(manifest), BackupRetentionError);
});
test('root replacement and top-level inode replacement are rejected before begin', async t => {
  const f = await fixture(t); await fs.rename(f.root(0), `${f.root(0)}-old`); await fs.mkdir(f.root(0), { mode: 0o700 });
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(f.calls.length, 0);
});
test('symlink and hardlink trees cannot become collection targets', async t => {
  const f = await fixture(t), target = path.join(f.root(0), 'previous-repos', 'object');
  await fs.symlink(f.root(3), path.join(f.root(0), 'previous-repos', 'outside'));
  await reject(f.retention.collect(), 'UNSAFE'); assert.equal(f.calls.length, 0);
  await fs.unlink(path.join(f.root(0), 'previous-repos', 'outside'));
  await fs.link(target, path.join(f.root(0), 'previous-repos', 'hard'));
  await reject(f.retention.collect(), 'UNSAFE'); assert.equal(f.calls.length, 0);
});
test('begin callback acknowledgement without authenticated tombstone grants no delete authority', async t => {
  const f = await fixture(t); f.controls.begin = async () => true;
  await reject(f.retention.collect(), 'AUTHORITY'); assert.equal(await exists(f.root(0)), true); assert.equal(f.calls.length, 1);
});
test('manifest replacement while begin is in flight fails without deleting any file', async t => {
  const f = await fixture(t); f.controls.begin = async value => {
    f.authority.completed[0].manifest.checkpoint.sha256 = 'a'.repeat(64); f.authority.tombstones.push({ ...value, state: 'BEGUN' });
  };
  await reject(f.retention.collect(), 'AUTHORITY'); assert.equal(await exists(path.join(f.root(0), 'checkpoint.cibackup')), true);
});
test('file inode substitution at the final fault boundary is rejected', async t => {
  const f = await fixture(t); let changed = false;
  f.controls.fault = async (point, value) => {
    if (point === 'before-entry' && !changed && value.name === 'previous-repos/object') {
      changed = true; const file = path.join(f.root(0), value.name); await fs.rename(file, `${file}.preserved`);
      await fs.writeFile(file, 'replacement', { mode: 0o600 });
    }
  };
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(await fs.readFile(path.join(f.root(0), 'previous-repos', 'object'), 'utf8'), 'replacement');
  assert.equal(f.authority.tombstones[0].state, 'BEGUN');
});
test('database callbacks require authenticated begin and precede filesystem deletion', async t => {
  const f = await fixture(t); f.authority.completed[0].manifest.databases = [{ slot: 'previous', oid: '12345' }];
  f.controls.drop = async value => {
    assert.equal(value.databaseOid, '12345'); assert.equal(f.authority.tombstones[0].state, 'BEGUN');
    assert.equal(await exists(path.join(f.root(0), 'checkpoint.cibackup')), true);
  };
  await f.retention.collect(); assert.deepEqual(f.calls.slice(0, 3).map(([operation]) => operation), ['begin', 'drop', 'end']);
});
test('failed database collection preserves all filesystem evidence for retry', async t => {
  const f = await fixture(t); f.authority.completed[0].manifest.databases = [{ slot: 'failed', oid: '12345' }];
  f.controls.drop = async () => { throw new Error('private-sentinel'); };
  await reject(f.retention.collect(), 'IO'); assert.equal(await exists(path.join(f.root(0), 'checkpoint.cibackup')), true);
  assert.equal(f.authority.tombstones[0].state, 'BEGUN'); f.controls.drop = null;
  await f.reopen(); await f.retention.collect(); assert.equal(await exists(f.root(0)), false);
});
test('missing DB callback fails before writing GC_BEGIN', async t => {
  const f = await fixture(t); f.authority.completed[0].manifest.databases = [{ slot: 'previous', oid: '1' }];
  await f.retention.close(); const options = { ...f.options }; delete options.dropDatabase;
  const retention = await createBackupRetention(options); t.after(() => retention.close());
  await reject(retention.collect(), 'DATABASE'); assert.equal(f.calls.length, 0);
});
test('crash between file removals resumes only beneath the original authenticated root', async t => {
  const f = await fixture(t); let count = 0;
  f.controls.fault = async point => { if (point === 'before-entry' && ++count === 2) throw new Error('injected crash'); };
  await reject(f.retention.collect(), 'IO'); assert.equal(f.authority.tombstones[0].state, 'BEGUN');
  assert.equal(await exists(f.root(0)), true); f.controls.fault = null;
  await f.reopen(); await f.retention.collect(); assert.equal(await exists(f.root(0)), false);
});
test('crash after removing root but before GC_END is idempotently finished after restart', async t => {
  const f = await fixture(t); let failed = false;
  f.controls.fault = async point => { if (point === 'before-end' && !failed) { failed = true; throw new Error('injected'); } };
  await reject(f.retention.collect(), 'IO'); assert.equal(await exists(f.root(0)), false); assert.equal(f.authority.tombstones[0].state, 'BEGUN');
  await f.reopen(); await f.retention.collect(); assert.equal(f.authority.tombstones[0].state, 'COMPLETED');
});
test('missing old root without GC_BEGIN is an integrity failure', async t => {
  const f = await fixture(t); await fs.rm(f.root(0), { recursive: true });
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(f.calls.length, 0);
});
test('a new unknown entry or replaced top-level directory after partial collection stops resume', async t => {
  const f = await fixture(t); const first = f.authority.completed[0];
  f.authority.tombstones.push({ transactionId: first.transactionId, manifestSha256: retentionManifestSha256(first.manifest), state: 'BEGUN' });
  await fs.rename(path.join(f.root(0), 'previous-repos'), path.join(f.root(0), 'old'));
  await fs.mkdir(path.join(f.root(0), 'previous-repos'), { mode: 0o700 });
  await reject(f.retention.collect(), 'CHANGED'); assert.equal(f.calls.length, 0);
});
test('GC_END acknowledgement must also be present in authenticated readback', async t => {
  const f = await fixture(t); f.controls.end = async () => true;
  await reject(f.retention.collect(), 'AUTHORITY'); assert.equal(await exists(f.root(0)), false);
  assert.equal(f.authority.tombstones[0].state, 'BEGUN'); f.controls.end = null; await f.retention.collect();
});
test('activity introduced after begin prevents subsequent deletion', async t => {
  const f = await fixture(t); f.controls.fault = async point => { if (point === 'before-entry') f.authority.active = crypto.randomUUID(); };
  await reject(f.retention.collect(), 'ACTIVE'); assert.equal(await exists(path.join(f.root(0), 'checkpoint.cibackup')), true);
});
test('one module per recovery inode and one operation at a time', async t => {
  const f = await fixture(t); await reject(createBackupRetention(f.options), 'BUSY');
  let release; f.controls.authority = () => new Promise(resolve => { release = resolve; }); const pending = f.retention.collect();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await reject(f.retention.collect(), 'BUSY'); await reject(f.retention.close(), 'BUSY'); f.controls.authority = null; release(); await pending;
  await f.retention.close(); await reject(f.retention.collect(), 'CLOSED');
});
test('closing an already closed instance cannot release a newer instance ownership lock', async t => {
  const f = await fixture(t); const old = f.retention; await old.close();
  const current = await createBackupRetention(f.options); t.after(() => current.close());
  await old.close(); await reject(createBackupRetention(f.options), 'BUSY');
});
test('premature GC_END is not accepted as authority for remaining file deletions', async t => {
  const f = await fixture(t);
  f.controls.fault = async point => { if (point === 'before-entry') f.authority.tombstones[0].state = 'COMPLETED'; };
  await reject(f.retention.collect(), 'AUTHORITY'); assert.equal(await exists(path.join(f.root(0), 'checkpoint.cibackup')), true);
});
test('manifest canonical hash ignores object insertion order but preserves array order', async t => {
  const f = await fixture(t), original = f.authority.completed[0].manifest;
  const reordered = { topLevel: original.topLevel, databases: original.databases, checkpoint: { sha256: original.checkpoint.sha256,
    bytes: original.checkpoint.bytes }, root: { ino: original.root.ino, dev: original.root.dev } };
  assert.equal(retentionManifestSha256(original), retentionManifestSha256(reordered));
  const changed = copy(original); changed.topLevel.reverse(); assert.notEqual(retentionManifestSha256(original), retentionManifestSha256(changed));
});
test('manifest rejects arbitrary paths, bad OIDs, shared identities, numbers and accessors', async t => {
  const f = await fixture(t), manifest = f.authority.completed[0].manifest;
  for (const mutate of [m => { m.topLevel[0].name = '../safety'; }, m => { m.databases = [{ slot: 'live', oid: '1' }]; },
    m => { m.databases = [{ slot: 'previous', oid: '4294967296' }]; }, m => { m.root.dev = 1; },
    m => { m.topLevel[1].ino = m.topLevel[0].ino; }, m => { m.topLevel[0].dev = '0'; }, m => { m.checkpoint.bytes = '01'; }]) {
    const value = copy(manifest); mutate(value); assert.throws(() => validateRetentionManifest(value), BackupRetentionError);
  }
  let invoked = 0; const value = copy(manifest); Object.defineProperty(value, 'root', { enumerable: true, get() { invoked++; return manifest.root; } });
  assert.throws(() => validateRetentionManifest(value), BackupRetentionError); assert.equal(invoked, 0);
});
test('authority rejects ambiguous sequences, forged tombstones and attempted newest-two authorization', async t => {
  const f = await fixture(t);
  for (const mutate of [a => { a.completed[0].sequence = a.completed[1].sequence; }, a => { a.completed[0].transactionId = '../bad'; },
    a => { a.tombstones = [{ transactionId: a.completed[0].transactionId, manifestSha256: '0'.repeat(64), state: 'BEGUN' }]; },
    a => { a.tombstones = [{ transactionId: a.completed[3].transactionId, manifestSha256: retentionManifestSha256(a.completed[3].manifest), state: 'BEGUN' }]; }]) {
    const value = copy(f.authority); mutate(value); assert.throws(() => validateRetentionAuthority(value), BackupRetentionError);
  }
  assert.throws(() => retentionCandidate(f.authority, f.authority.completed[3].transactionId), BackupRetentionError);
  assert.throws(() => retentionCandidate(f.authority, f.authority.completed[0].transactionId), BackupRetentionError);
});
