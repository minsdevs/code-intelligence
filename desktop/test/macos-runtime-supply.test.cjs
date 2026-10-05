'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const helper = require('../scripts/macos-runtime-supply.cjs');
const supply = require('../scripts/macos-runtime-supply.json');
const copy = () => JSON.parse(JSON.stringify(supply));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-source-supply-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('all four reviewed sources are fixed and match the existing macOS 13 arm64 contract', () => {
  assert.equal(helper.validateSupply(supply), supply);
  assert.deepEqual(supply.sources.map(item => [item.id, item.version]), [
    ['openssl', '3.5.8'], ['postgres', '16.15'], ['redis', '8.10.2'], ['pgvector', '0.8.7'],
  ]);
  assert.match(supply.sources[3].checksumSource, /not a maintainer-signed checksum/);
});

for (const mutation of [
  value => { value.minimumSystemVersion = '26.0'; },
  value => { value.architecture = 'x64'; },
  value => { value.sources.pop(); },
  value => { value.sources[1] = value.sources[0]; },
  value => { value.sources[0] = null; },
  value => { value.sources[0].sha256 = 'unverified'; },
  value => { value.sources[0].maxArchiveBytes = 1024 ** 4; },
  value => { value.sources[0].licenseFile = '../../outside'; },
  value => { value.sources[3].revision = 'latest'; },
  value => { value.sources[1].version = '17.1'; },
]) {
  test(`invalid source lock is refused: ${mutation.toString()}`, () => {
    const value = copy(); mutation(value);
    assert.throws(() => helper.validateSupply(value), { code: 'MAC_SOURCE_LOCK_INVALID' });
  });
}

for (const url of ['http://download.redis.io/releases/redis-8.10.2.tar.gz',
  'https://attacker.invalid/redis-8.10.2.tar.gz',
  'https://download.redis.io/releases/redis-8.10.2.tar.gz?token=secret',
  'https://user:secret@download.redis.io/releases/redis-8.10.2.tar.gz']) {
  test(`source URL must exactly match the known project release endpoint: ${new URL(url).hostname}`, () => {
    const value = copy(); value.sources[2].url = url;
    assert.throws(() => helper.validateSupply(value), { code: 'MAC_SOURCE_LOCK_INVALID' });
  });
}

test('capacity uses available blocks for this user, refuses before writes and distinguishes preflight from acceptance', t => {
  const root = fixture(t);
  const report = helper.checkCapacity(root, { statfs: () => ({ bavail: 1n, bfree: 999999999n, bsize: 4096n }) });
  assert.equal(report.code, 'MAC_BUILD_DISK_SPACE');
  assert.equal(report.availableBytes, '4096');
  assert.equal(report.launchAllowed, false);
  assert.equal(report.nativeRuntimeVerified, false);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => helper.requireCapacity(root, { statfs: () => ({ bavail: 0n, bsize: 4096n }) }), { code: 'MAC_BUILD_DISK_SPACE' });
});

test('capacity boundary passes exactly at the conservative eight-GiB floor', t => {
  const root = fixture(t);
  const report = helper.requireCapacity(root, { statfs: () => ({ bavail: 8n * 1024n ** 3n, bsize: 1n }) });
  assert.equal(report.status, 'READY_FOR_PROVISIONING');
  assert.equal(report.sourceBuildPerformed, false);
  assert.equal(report.launchAllowed, false);
});

for (const stats of [{ bavail: -1n, bsize: 4096n }, { bavail: 999n, bsize: 0n }, { bavail: 12, bsize: 4096 }]) {
  test(`invalid capacity metadata cannot admit a build: ${String(stats.bavail)}/${String(stats.bsize)}`, t => {
    assert.throws(() => helper.checkCapacity(fixture(t), { statfs: () => stats }), { code: 'MAC_BUILD_CAPACITY_UNAVAILABLE' });
  });
}

test('failed filesystem inspection blocks rather than guessing free space', t => {
  assert.throws(() => helper.checkCapacity(fixture(t), { statfs: () => { throw new Error('unreadable'); } }), { code: 'MAC_BUILD_CAPACITY_UNAVAILABLE' });
});

test('archive checksum and bounded regular-file readback are required', t => {
  const file = path.join(fixture(t), 'source.tar.gz'), bytes = Buffer.from('synthetic archive bytes');
  fs.writeFileSync(file, bytes);
  assert.deepEqual(helper.verifyArchive(file, { sha256: hash(bytes), maxArchiveBytes: 100 }), { bytes: bytes.length, sha256: hash(bytes) });
  assert.throws(() => helper.verifyArchive(file, { sha256: hash('different'), maxArchiveBytes: 100 }), { code: 'MAC_SOURCE_CHECKSUM_MISMATCH' });
  assert.throws(() => helper.verifyArchive(file, { sha256: hash(bytes), maxArchiveBytes: 1 }), { code: 'MAC_SOURCE_ARCHIVE_INVALID' });
});

test('linked archives are not accepted as independently owned source inputs', t => {
  const root = fixture(t), file = path.join(root, 'archive'); fs.writeFileSync(file, 'fixture');
  fs.linkSync(file, path.join(root, 'hardlink'));
  assert.throws(() => helper.verifyArchive(file, { sha256: hash('fixture'), maxArchiveBytes: 100 }), { code: 'MAC_SOURCE_ARCHIVE_INVALID' });
  fs.symlinkSync(file, path.join(root, 'symlink'));
  assert.throws(() => helper.verifyArchive(path.join(root, 'symlink'), { sha256: hash('fixture'), maxArchiveBytes: 100 }));
});

test('low disk blocks before download, archive creation or receipt creation', t => {
  const root = fixture(t); let runs = 0;
  assert.throws(() => helper.downloadSource('postgres', root, {
    capacity: () => { throw Object.assign(new Error('full'), { code: 'MAC_BUILD_DISK_SPACE' }); },
    run: () => { runs++; },
  }), { code: 'MAC_BUILD_DISK_SPACE' });
  assert.equal(runs, 0); assert.deepEqual(fs.readdirSync(root), []);
});

test('checksum rejection retains failed bytes and never replays into the existing archive', t => {
  const root = fixture(t); let runs = 0;
  const options = { capacity: () => {}, run: (command, args, config) => {
    if (args.includes('--version')) return { status: 0, stdout: 'curl 8.4.0 (synthetic)\n' };
    runs++;
    assert.equal(command, '/usr/bin/curl'); assert.equal(args[0], '--disable');
    assert.equal(args[args.indexOf('--proto-redir') + 1], '=https');
    assert.equal(args[args.indexOf('--max-filesize') + 1], String(supply.sources[1].maxArchiveBytes));
    assert.deepEqual(config.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' });
    assert.equal(config.shell, undefined);
    fs.writeFileSync(config.stdio[1], 'not the reviewed archive');
    return { status: 0, signal: null };
  } };
  assert.throws(() => helper.downloadSource('postgres', root, options), { code: 'MAC_SOURCE_CHECKSUM_MISMATCH' });
  const archive = path.join(root, 'postgres-16.15.tar.bz2');
  assert.equal(fs.readFileSync(archive, 'utf8'), 'not the reviewed archive');
  assert.equal(fs.existsSync(path.join(root, 'postgres-source.json')), false);
  assert.throws(() => helper.downloadSource('postgres', root, options), { code: 'EEXIST' });
  assert.equal(runs, 1);
});

test('private destination and known source identity are mandatory', t => {
  const root = fixture(t);
  assert.throws(() => helper.downloadSource('unknown', root), { code: 'MAC_SOURCE_UNKNOWN' });
  fs.chmodSync(root, 0o755);
  assert.throws(() => helper.downloadSource('postgres', root), { code: 'MAC_SOURCE_DESTINATION' });
});

test('existing hosted context accepts a private direct work child of a 0755 runner temp without changing that parent', t => {
  const root = fixture(t); fs.chmodSync(root, 0o755);
  const work = path.join(root, 'native-compatible-runtime.fixture'); fs.mkdirSync(work, { mode: 0o700 });
  const context = { kind: 'github-hosted', tempRoot: root };
  helper.checkSourceWorkDirectory(context, work);
  assert.equal(fs.statSync(root).mode & 0o777, 0o755);
  fs.chmodSync(work, 0o755);
  assert.throws(() => helper.checkSourceWorkDirectory(context, work));
  assert.throws(() => helper.checkSourceWorkDirectory(context, fixture(t)), { code: 'MAC_SOURCE_DESTINATION' });
});

test('local context still requires every work ancestor to be private, and refuses links', t => {
  const root = fixture(t), work = path.join(root, 'work'); fs.mkdirSync(work, { mode: 0o700 });
  const context = { kind: 'isolated-macos-host', tempRoot: root };
  helper.checkSourceWorkDirectory(context, work);
  fs.chmodSync(root, 0o755);
  assert.throws(() => helper.checkSourceWorkDirectory(context, work));
  fs.chmodSync(root, 0o700);
  const link = path.join(root, 'linked'); fs.symlinkSync(work, link);
  assert.throws(() => helper.checkSourceWorkDirectory({ kind: 'github-hosted', tempRoot: root }, link));
});

test('actual host entrypoint refuses low disk before allocating a run or invoking a subprocess', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/native-acceptance-host.cjs'), 'utf8');
  let created = 0, spawned = 0;
  const moduleObject = { exports: {} };
  const context = vm.createContext({
    module: moduleObject, __dirname: '/fixture/desktop/scripts', console,
    process: { platform: 'darwin', arch: 'arm64', getuid: () => 501, umask() {} },
    require: name => {
      if (name === 'node:fs') return { realpathSync: p => p, mkdtempSync() { created++; } };
      if (name === 'node:child_process') return { spawnSync() { spawned++; }, execFileSync() { spawned++; } };
      if (name === './macos-runtime-supply.cjs') return { requireCapacity() { throw Object.assign(new Error('full'), { code: 'MAC_BUILD_DISK_SPACE' }); } };
      return require(name);
    },
  });
  vm.runInContext(source, context);
  // The real entrypoint validates its argument array; construct it in the same realm.
  assert.throws(() => vm.runInContext('module.exports.main([])', context), { code: 'MAC_BUILD_DISK_SPACE' });
  assert.equal(created, 0); assert.equal(spawned, 0);
});

test('verified source writes a bounded receipt only after hash readback', t => {
  const root = fixture(t), bytes = Buffer.from('synthetic reviewed source'), locked = copy();
  locked.sources[1].sha256 = hash(bytes);
  const source = fs.readFileSync(path.join(__dirname, '../scripts/macos-runtime-supply.cjs'), 'utf8');
  const moduleObject = { exports: {} };
  vm.runInNewContext(source, {
    module: moduleObject, Buffer, process, console,
    require: name => name === './macos-runtime-supply.json' ? locked : require(name),
  });
  const archive = moduleObject.exports.downloadSource('postgres', root, {
    capacity: () => {},
    run: (_command, _args, options) => {
      if (_args.includes('--version')) return { status: 0, stdout: 'curl 8.4.0 (synthetic)\n' };
      assert.equal(fs.existsSync(path.join(root, 'postgres-source.json')), false);
      fs.writeFileSync(options.stdio[1], bytes);
      return { status: 0, signal: null };
    },
  });
  assert.deepEqual(fs.readFileSync(archive), bytes);
  const receiptFile = path.join(root, 'postgres-source.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.sourceSha256, hash(bytes));
  assert.equal(receipt.bytes, bytes.length);
  assert.equal(receipt.version, '16.15');
  assert.equal(receipt.curlVersion, '8.4.0');
  assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(root).length, 2, 'download does not extract or compile source');
});

test('old or unrecognized curl is rejected before any archive write or network request', t => {
  const root = fixture(t);
  for (const version of ['7.88.1', '8.1.2', '8.3.0', 'not-a-version']) {
    let calls = 0;
    assert.throws(() => helper.downloadSource('postgres', root, { capacity: () => {}, run: (command, args) => {
      calls++;
      assert.equal(command, '/usr/bin/curl');
      assert.deepEqual(args, ['--disable', '--version']);
      return { status: 0, stdout: 'curl ' + version + ' (synthetic)\n' };
    } }), { code: 'MAC_SOURCE_CURL_8_4_REQUIRED' });
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test('curl 8.4 and later support a transfer-time size ceiling', () => {
  for (const version of ['8.4.0', '8.7.1', '9.0.0']) {
    assert.equal(helper.requireBoundedCurl(() => ({ status: 0, stdout: 'curl ' + version + ' (synthetic)\n' })), version);
  }
  assert.throws(() => helper.requireBoundedCurl(() => ({ status: 1, stdout: 'curl 8.4.0\n' })), { code: 'MAC_SOURCE_CURL_8_4_REQUIRED' });
});

test('the existing source builder keeps TLS, portable vector flags and relocation, without floating Homebrew fetches', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/native-acceptance-macos.sh'), 'utf8');
  assert.ok(source.indexOf('requireCapacity(context.tempRoot)') < source.indexOf("helper.claimExecution(context, 'provision')"));
  assert.ok(!/brew (info|fetch|install)/.test(source));
  assert.match(source, /--fetch "\$name" "\$work"/);
  assert.match(source, /MACOSX_DEPLOYMENT_TARGET=13\.0/);
  assert.match(source, /--with-openssl/);
  assert.match(source, /BUILD_TLS=yes/);
  assert.match(source, /PG_CONFIG="\$pg_config" OPTFLAGS= -j2/);
  assert.match(source, /relocateMacLibraries/);
  assert.match(source, /code-intelligence-notices/);
});

test('macOS acceptance cannot overlay the locked pgvector with an inherited developer prefix', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/native-acceptance.cjs'), 'utf8');
  const start = source.indexOf('    const env = { ...process.env, CODE_INTELLIGENCE_BUILD_SEQUENCE:');
  const end = source.indexOf("    report.phase = 'fresh-dependencies'", start);
  assert.ok(start >= 0 && end > start);
  const original = { PGVECTOR_ROOT: '/previous/unreviewed/vector', PG_CONFIG: '/owned/postgres/bin/pg_config',
    REDIS_SERVER: '/owned/redis/bin/redis-server' };
  const filtered = vm.runInNewContext(source.slice(start, end) + '\nenv', {
    process: { env: original }, context: { buildSequence: '1' }, owned: '/owned/build', target: 'macos', path,
  });
  assert.equal(filtered.PGVECTOR_ROOT, undefined);
  assert.equal(filtered.PG_CONFIG, original.PG_CONFIG);
  assert.equal(filtered.REDIS_SERVER, original.REDIS_SERVER);
  assert.equal(original.PGVECTOR_ROOT, '/previous/unreviewed/vector', 'parent environment remains unchanged');
});
