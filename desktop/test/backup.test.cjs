const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBackup, restoreBackup, validateBackup } = require('../src/backup.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-backup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositories = path.join(root, 'data', 'repos');
  await fs.mkdir(repositories, { recursive: true });
  await fs.writeFile(path.join(repositories, 'old.ts'), 'current source');
  const state = { database: 'current database' };
  const options = {
    repositories, installationId: 'fixture-installation',
    dumpDatabase: (dump) => fs.writeFile(dump, state.database),
    restoreDatabase: async (dump) => { state.database = await fs.readFile(dump, 'utf8'); },
  };
  const sourceRepos = path.join(root, 'source-repos');
  await fs.mkdir(sourceRepos);
  await fs.writeFile(path.join(sourceRepos, 'new.ts'), 'restored source');
  const source = path.join(root, 'source.backup');
  await createBackup({ ...options, repositories: sourceRepos, destination: source, dumpDatabase: (dump) => fs.writeFile(dump, 'restored database') });
  return { root, options, source, recovery: path.join(root, 'recovery.backup'), state };
}

test('validates new backup files and installation; rejects tampering and extra paths', async (t) => {
  const f = await fixture(t);
  assert.equal((await validateBackup(f.source, f.options.installationId)).format, 2);
  await assert.rejects(validateBackup(f.source, 'different-installation'), /different installation/);
  await fs.writeFile(path.join(f.source, 'repositories', 'new.ts'), 'tampered');
  await assert.rejects(validateBackup(f.source, f.options.installationId), /integrity/);
  await fs.writeFile(path.join(f.source, 'repositories', 'new.ts'), 'restored source');
  await fs.writeFile(path.join(f.source, 'extra.txt'), 'unexpected');
  await assert.rejects(validateBackup(f.source, f.options.installationId), /integrity/);
});

test('restores database and repositories together and keeps a complete recovery backup', async (t) => {
  const f = await fixture(t);
  await restoreBackup({ ...f.options, source: f.source, recovery: f.recovery });
  assert.equal(f.state.database, 'restored database');
  assert.deepEqual(await fs.readdir(f.options.repositories), ['new.ts']);
  await validateBackup(f.recovery, f.options.installationId);
  assert.equal(await fs.readFile(path.join(f.recovery, 'database.dump'), 'utf8'), 'current database');
  assert.equal(await fs.readFile(path.join(f.recovery, 'repositories', 'old.ts'), 'utf8'), 'current source');
});

test('legacy backup with no repository directory replaces stale files with an empty repository tree', async (t) => {
  const f = await fixture(t);
  await fs.rm(path.join(f.source, 'repositories'), { recursive: true });
  await fs.writeFile(path.join(f.source, 'manifest.json'), JSON.stringify({
    format: 1, databaseSha256: crypto.createHash('sha256').update('restored database').digest('hex'),
  }));
  await restoreBackup({ ...f.options, source: f.source, recovery: f.recovery });
  assert.deepEqual(await fs.readdir(f.options.repositories), []);
  assert.equal(f.state.database, 'restored database');
});

test('SQL client failure after commit rolls both database and repositories back', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const restoreDatabase = async (dump) => {
    await f.options.restoreDatabase(dump);
    if (++calls === 1) throw new Error('connection lost after commit');
  };
  await assert.rejects(restoreBackup({ ...f.options, restoreDatabase, source: f.source, recovery: f.recovery }), /previous database and repositories recovered/);
  assert.equal(calls, 2);
  assert.equal(f.state.database, 'current database');
  assert.deepEqual(await fs.readdir(f.options.repositories), ['old.ts']);
  assert.equal((await fs.readdir(path.dirname(f.options.repositories))).some((name) => name.startsWith('.restore-')), false);
});

test('failed directory swap restores the original tree without touching the database', async (t) => {
  const f = await fixture(t);
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (from.endsWith(path.join('incoming', 'repositories'))) throw new Error('injected rename failure');
    return rename(from, to);
  };
  try {
    await assert.rejects(restoreBackup({ ...f.options, source: f.source, recovery: f.recovery }), /previous database and repositories recovered/);
  } finally { fs.rename = rename; }
  assert.equal(f.state.database, 'current database');
  assert.deepEqual(await fs.readdir(f.options.repositories), ['old.ts']);
});

test('failed rollback retains recovery data and signals that the backend must remain stopped', async (t) => {
  const f = await fixture(t);
  await assert.rejects(restoreBackup({ ...f.options, source: f.source, recovery: f.recovery,
    restoreDatabase: async () => { throw new Error('database unavailable'); },
  }), (error) => error.recoveryRequired === true && /Runtime remains stopped/.test(error.message));
  await validateBackup(f.recovery, f.options.installationId);
  assert.deepEqual(await fs.readdir(f.options.repositories), ['old.ts']);
  assert.equal((await fs.readdir(path.dirname(f.options.repositories))).some((name) => name.startsWith('.restore-')), true);
});

test('symbolic links are refused before any restore mutation', async (t) => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.root, 'data'), path.join(f.source, 'repositories', 'escape'));
  await assert.rejects(restoreBackup({ ...f.options, source: f.source, recovery: f.recovery }), /Symbolic links/);
  assert.equal(f.state.database, 'current database');
  assert.deepEqual(await fs.readdir(f.options.repositories), ['old.ts']);
});

test('recovery export failure leaves current state intact and removes incomplete exports', async (t) => {
  const f = await fixture(t);
  await assert.rejects(restoreBackup({ ...f.options, source: f.source, recovery: f.recovery,
    dumpDatabase: async () => { throw new Error('disk full'); },
  }), /disk full/);
  assert.equal(f.state.database, 'current database');
  assert.deepEqual(await fs.readdir(f.options.repositories), ['old.ts']);
  await assert.rejects(fs.stat(f.recovery), { code: 'ENOENT' });
});

test('creating a backup never overwrites a pre-existing destination', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createBackup({ ...f.options, destination: f.source }), { code: 'EEXIST' });
  await validateBackup(f.source, f.options.installationId);
});

test('a backup destination inside the repositories cannot recursively copy itself', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createBackup({ ...f.options, destination: path.join(f.options.repositories, 'nested.backup') }), /outside repository storage/);
  assert.deepEqual(await fs.readdir(f.options.repositories), ['old.ts']);
});

test('an interrupted restore marker is preserved and prevents another restore', async (t) => {
  const f = await fixture(t);
  const marker = path.join(path.dirname(f.options.repositories), '.restore-recovery-required.json');
  await fs.writeFile(marker, 'previous recovery instructions');
  await assert.rejects(restoreBackup({ ...f.options, source: f.source, recovery: f.recovery }), /earlier interrupted restore/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'previous recovery instructions');
  assert.equal(f.state.database, 'current database');
});
