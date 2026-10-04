'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const api = require('../src/isolated-run.cjs');
const invalid = { code: 'ISOLATED_RUN_INVALID' };

function fixture(t) {
  const base = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'ciur-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentDirectory = path.join(root, 'runs');
  const runtimeDirectory = path.join(root, 'runtime');
  fs.mkdirSync(parentDirectory, { mode: 0o700 });
  fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
  const sentinel = path.join(runtimeDirectory, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged synthetic runtime', { mode: 0o600 });
  return { root, parentDirectory, runtimeDirectory, sentinel,
    options: { parentDirectory, runtimeDirectory } };
}

function modeledApi(processOverrides = {}, disk = fs) {
  const context = vm.createContext({ module: { exports: {} }, Buffer,
    process: { platform: process.platform, getuid: process.getuid.bind(process), ...processOverrides },
    require: name => name === 'node:fs' ? disk : require(name) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/isolated-run.cjs'), 'utf8'), context);
  return context.module.exports;
}

test('argument opt-in separates claim launches from claim preparation', () => {
  assert.equal(api.parseIsolatedRunArguments(['electron', '.', '--other=value']), null);
  assert.deepEqual(api.parseIsolatedRunArguments([
    '--isolated-run-parent', '/private/runs', '--isolated-runtime-root=/private/runtime',
    '--isolated-run-purpose', 'automation',
  ]), { parentDirectory: '/private/runs', runtimeDirectory: '/private/runtime', purpose: 'automation' });
  assert.deepEqual(api.parseIsolatedRunArguments(['--isolated-run-claim=/private/run/.isolated-run.json']), {
    claimFile: '/private/run/.isolated-run.json'
  });
});

for (const args of [
  ['--isolated-run'], ['--isolated-run-parent'], ['--isolated-run-parent='],
  ['--isolated-run-parent=/runs'], ['--isolated-runtime-root=/runtime'],
  ['--isolated-run-parent', '--isolated-runtime-root=/runtime'],
  ['--isolated-run-parent=/runs', '--isolated-runtime-root=/runtime', '--isolated-run-parent', '/other'],
  ['--isolated-run-parent=/runs', '--isolated-runtime-root=/runtime', '--isolated-run-claim=/claim'],
  ['--isolated-run-claim=/claim', '--isolated-run-purpose=validation'],
  ['--isolated-run-parent=/runs', '--isolated-runtime-root=/runtime', '--isolated-run-purpose=production'],
  ['--isolated-run-claim=/claim', '--isolated-verified=true'],
  [42], Array(1),
]) {
  test(`argument parser refuses malformed or ambiguous options ${JSON.stringify(args)}`, () => {
    assert.throws(() => api.parseIsolatedRunArguments(args), invalid);
  });
}

test('accessor and proxy inputs are rejected without invoking user code or filesystem APIs', () => {
  let invoked = 0;
  const getter = () => { invoked++; throw new Error('must not execute'); };
  const disk = new Proxy({}, { get: getter });
  const modeled = modeledApi({}, disk);
  const accessor = Object.defineProperty({}, 'parentDirectory', { get: getter });
  const args = Object.defineProperty([], '0', { get: getter });
  for (const config of [accessor, new Proxy({}, { get: getter }),
    { parentDirectory: '/runs', runtimeDirectory: '/runtime', extra: true },
    Object.create({ parentDirectory: '/runs', runtimeDirectory: '/runtime' })]) {
    assert.throws(() => modeled.prepareIsolatedRun(config), invalid);
  }
  assert.throws(() => api.prepareIsolatedRun({ parentDirectory: '/runs', runtimeDirectory: '/runtime',
    forbiddenRoots: new Proxy([], { get: getter }) }), invalid);
  assert.throws(() => modeled.parseIsolatedRunArguments(args), invalid);
  assert.throws(() => api.parseIsolatedRunArguments(new Proxy([], { get: getter })), invalid);
  assert.equal(invoked, 0);
});

test('unsupported platforms refuse before any filesystem access', () => {
  let touched = 0;
  const disk = new Proxy({}, { get() { touched++; throw new Error('filesystem must remain untouched'); } });
  for (const processOverrides of [{ platform: 'win32' }, { getuid: undefined }]) {
    assert.throws(() => modeledApi(processOverrides, disk).prepareIsolatedRun({
      parentDirectory: '/private/runs', runtimeDirectory: '/private/runtime'
    }), { code: 'ISOLATED_RUN_UNSUPPORTED_PLATFORM' });
  }
  assert.equal(touched, 0);
});

test('fresh plans create private paths and an exclusive fixed-identity claim without modifying runtime', t => {
  const f = fixture(t);
  const before = fs.statSync(f.sentinel);
  const plan = api.prepareIsolatedRun(f.options);
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.paths), true);
  assert.equal(path.dirname(plan.root), f.parentDirectory);
  assert.equal(plan.runtimeRoot, f.runtimeDirectory);
  assert.equal(plan.purpose, 'validation');
  assert.deepEqual(plan.appIdentity, api.VALIDATION_IDENTITIES.validation);
  assert.equal(plan.claimFile, path.join(plan.root, api.CLAIM_FILE));
  assert.deepEqual(Object.keys(plan.paths).sort(), ['crashDumps', 'home', 'logs', 'output', 'sessionData', 'temp', 'userData']);
  for (const directory of [plan.root, ...Object.values(plan.paths)]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(directory === plan.root || path.dirname(directory) === plan.root, true);
  }
  const claim = path.join(plan.root, api.CLAIM_FILE);
  assert.equal(fs.statSync(claim).mode & 0o777, 0o600);
  const record = JSON.parse(fs.readFileSync(claim, 'utf8'));
  assert.equal(record.version, 2); assert.equal(record.launchAllowed, true);
  assert.equal(record.root, plan.root); assert.deepEqual(record.appIdentity, api.VALIDATION_IDENTITIES.validation);
  assert.doesNotThrow(plan.assertIdentity);
  assert.equal(fs.statSync(f.sentinel).mtimeMs, before.mtimeMs);
  const second = api.prepareIsolatedRun(f.options);
  assert.notEqual(second.root, plan.root);
  assert.throws(() => api.prepareIsolatedRun({ ...f.options, parentDirectory: plan.root }), invalid);
  assert.throws(() => api.prepareIsolatedRun({ ...f.options, parentDirectory: plan.paths.output }), invalid);
  assert.throws(() => api.prepareIsolatedRun({ ...f.options, runtimeDirectory: plan.root }), invalid);
  assert.throws(() => api.prepareIsolatedRun({ ...f.options, runtimeDirectory: plan.paths.output }), invalid);
});

test('macOS validation claims refuse a private temp root that cannot fit the real gateway socket', {
  skip: process.platform !== 'darwin',
}, t => {
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/cisb-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentDirectory = path.join(root, 'p'.repeat(72)), runtimeDirectory = path.join(root, 'runtime');
  fs.mkdirSync(parentDirectory, { mode: 0o700 }); fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
  assert.throws(() => api.prepareIsolatedRun({ parentDirectory, runtimeDirectory }), invalid);
  assert.deepEqual(fs.readdirSync(parentDirectory), []);
});

test('claim creation is exclusive and claim reads cannot block on a replaced special file', t => {
  const f = fixture(t); const reads = [];
  const modeled = modeledApi({}, { ...fs, openSync(file, flags, mode) {
    if (path.basename(file) === api.CLAIM_FILE && !(flags & fs.constants.O_CREAT)) reads.push(flags);
    return fs.openSync(file, flags, mode);
  } });
  const plan = modeled.prepareIsolatedRun(f.options); plan.assertIdentity();
  assert.ok(reads.length >= 2);
  for (const flags of reads) {
    assert.equal(flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
    assert.equal(flags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK);
  }
  let racedClaim;
  const racing = modeledApi({}, { ...fs, openSync(file, flags, mode) {
    if (path.basename(file) === api.CLAIM_FILE && flags & fs.constants.O_CREAT) {
      racedClaim = file; fs.writeFileSync(file, 'synthetic concurrent claim', { mode: 0o600 });
    }
    return fs.openSync(file, flags, mode);
  } });
  assert.throws(() => racing.prepareIsolatedRun(f.options), invalid);
  assert.equal(fs.readFileSync(racedClaim, 'utf8'), 'synthetic concurrent claim');
});

test('prepared and reopened claims authorize only fixed validation identities', t => {
  const plan = api.prepareIsolatedRun({ ...fixture(t).options, purpose: 'automation' });
  assert.doesNotThrow(() => api.assertIsolatedLaunchReady(plan));
  const reopened = api.openIsolatedRun({ claimFile: plan.claimFile });
  assert.equal(reopened.root, plan.root);
  assert.equal(reopened.runtimeRoot, plan.runtimeRoot);
  assert.deepEqual(reopened.appIdentity, api.VALIDATION_IDENTITIES.automation);
  assert.doesNotThrow(() => api.assertIsolatedLaunchReady(reopened));
  for (const forged of [{ ...plan }, { ...plan, purpose: 'validation' }, new Proxy(plan, {})]) {
    assert.throws(() => api.assertIsolatedLaunchReady(forged), invalid);
    assert.throws(() => api.isolatedChildEnvironment(forged), invalid);
  }
  assert.deepEqual(api.isolatedChildEnvironment(reopened), {
    HOME: plan.paths.home, TMPDIR: plan.paths.temp, TMP: plan.paths.temp, TEMP: plan.paths.temp
  });
});

for (const field of ['parentDirectory', 'runtimeDirectory']) {
  for (const value of ['relative/path', '', '/tmp/../runs', '/tmp/runs/', '/tmp/line\nbreak']) {
    test(`${field} rejects noncanonical path ${JSON.stringify(value)} before creating a run`, t => {
      const f = fixture(t);
      assert.throws(() => api.prepareIsolatedRun({ ...f.options, [field]: value }), invalid);
      assert.deepEqual(fs.readdirSync(f.parentDirectory), []);
    });
  }
}

for (const kind of ['same', 'runtime-inside-parent', 'parent-inside-runtime', 'forbidden-parent', 'forbidden-runtime', 'forbidden-missing-descendant']) {
  test(`overlapping roots are refused: ${kind}`, t => {
    const f = fixture(t); const options = { ...f.options };
    if (kind === 'same') options.runtimeDirectory = f.parentDirectory;
    if (kind === 'runtime-inside-parent') options.runtimeDirectory = path.join(f.parentDirectory, 'nested');
    if (kind === 'parent-inside-runtime') options.parentDirectory = path.join(f.runtimeDirectory, 'nested');
    if (kind === 'forbidden-parent') options.forbiddenRoots = [f.parentDirectory];
    if (kind === 'forbidden-runtime') options.forbiddenRoots = [f.runtimeDirectory];
    if (kind === 'forbidden-missing-descendant') options.forbiddenRoots = [path.join(f.parentDirectory, 'future', 'production')];
    assert.throws(() => api.prepareIsolatedRun(options), invalid);
    assert.deepEqual(fs.readdirSync(f.parentDirectory), []);
  });
}

test('symlink roots and ancestors cannot redirect writes into existing directories', t => {
  const f = fixture(t); const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.parentDirectory, alias);
  const nested = path.join(f.parentDirectory, 'nested'); fs.mkdirSync(nested, { mode: 0o700 });
  for (const parentDirectory of [alias, path.join(alias, 'nested')]) {
    assert.throws(() => api.prepareIsolatedRun({ ...f.options, parentDirectory }), invalid);
  }
  const runtimeAlias = path.join(f.root, 'runtime-alias'); fs.symlinkSync(f.runtimeDirectory, runtimeAlias);
  assert.throws(() => api.prepareIsolatedRun({ ...f.options, runtimeDirectory: runtimeAlias }), invalid);
  assert.deepEqual(fs.readdirSync(f.parentDirectory), ['nested']);
  assert.deepEqual(fs.readdirSync(nested), []);
  assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'unchanged synthetic runtime');
});

test('preexisting claims, unsafe modes and foreign owner identities refuse before creating a run', t => {
  const f = fixture(t); const claim = path.join(f.parentDirectory, api.CLAIM_FILE);
  fs.writeFileSync(claim, 'existing claim', { mode: 0o600 });
  assert.throws(() => api.prepareIsolatedRun(f.options), invalid);
  assert.equal(fs.readFileSync(claim, 'utf8'), 'existing claim'); fs.unlinkSync(claim);
  fs.chmodSync(f.parentDirectory, 0o755);
  assert.throws(() => api.prepareIsolatedRun(f.options), invalid); fs.chmodSync(f.parentDirectory, 0o700);
  fs.chmodSync(f.runtimeDirectory, 0o777);
  assert.throws(() => api.prepareIsolatedRun(f.options), invalid); fs.chmodSync(f.runtimeDirectory, 0o700);
  assert.throws(() => modeledApi({ getuid: () => process.getuid() + 1 }).prepareIsolatedRun(f.options), invalid);
  assert.deepEqual(fs.readdirSync(f.parentDirectory), []);
});

for (const mutation of ['claim-content', 'claim-mode', 'claim-replacement', 'claim-symlink', 'claim-hardlink', 'user-data-replacement', 'root-replacement', 'runtime-replacement']) {
  test(`prepared identity detects ${mutation} before environment or launch use`, t => {
    const f = fixture(t); const plan = api.prepareIsolatedRun(f.options);
    const claim = path.join(plan.root, api.CLAIM_FILE);
    if (mutation === 'claim-content') {
      const bytes = fs.readFileSync(claim); bytes[0] = 32; fs.writeFileSync(claim, bytes);
    }
    if (mutation === 'claim-mode') fs.chmodSync(claim, 0o644);
    if (mutation === 'claim-replacement') {
      fs.renameSync(claim, claim + '.old'); fs.copyFileSync(claim + '.old', claim);
    }
    if (mutation === 'claim-symlink') { fs.renameSync(claim, claim + '.old'); fs.symlinkSync(claim + '.old', claim); }
    if (mutation === 'claim-hardlink') fs.linkSync(claim, claim + '.link');
    const changedDirectory = mutation === 'user-data-replacement' ? plan.paths.userData
      : mutation === 'root-replacement' ? plan.root : mutation === 'runtime-replacement' ? plan.runtimeRoot : null;
    if (changedDirectory) {
      fs.renameSync(changedDirectory, changedDirectory + '.old'); fs.mkdirSync(changedDirectory, { mode: 0o700 });
    }
    assert.throws(plan.assertIdentity, invalid);
    assert.throws(() => api.isolatedChildEnvironment(plan), invalid);
    assert.throws(() => api.assertIsolatedLaunchReady(plan), invalid);
  });
}
