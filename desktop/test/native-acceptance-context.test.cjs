'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requireExecutionContext, validateVmIdentity, validateHostIdentity, validateLocalEnvironment, privatePath,
  privateDescendant, freshProfile, claimExecution, prepareArtifacts, writeRuntimeEnvironment } = require('../scripts/native-acceptance-context.cjs');

const posix = { skip: process.platform === 'win32' };
function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-context-')));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function identity() {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const descriptor = { format: 1, kind: 'disposable-macos-vm', provider: 'tart-apple-virtualization',
    revision: 'a'.repeat(40), buildSequence: '123', imageDigest: 'sha256:' + 'b'.repeat(64),
    vmUuid: '12345678-1234-1234-1234-123456789abc',
    createdAt: '2026-10-04T11:00:00Z', expiresAt: '2026-10-04T13:00:00Z' };
  const observed = { platform: 'darwin', arch: 'arm64', model: 'VirtualMac2,1', uuid: descriptor.vmUuid.toUpperCase(),
    bootTime: Date.parse('2026-10-04T10:00:00Z') };
  return { descriptor, observed, now };
}

test('VM identity policy binds approval to hardware UUID, exact image digest and this boot', () => {
  // Policy-unit observations are not evidence of an actual virtualized OS run.
  const { descriptor, observed, now } = identity();
  validateVmIdentity(descriptor, observed, now);
  for (const change of [
    { platform: 'linux' }, { platform: 'win32' }, { arch: 'x64' }, { model: 'Mac14,6' },
    { model: 'VirtualMac2,1\nMac14,6' }, { uuid: 'abcdefab-1234-1234-1234-123456789abc' },
    { bootTime: now }, { bootTime: NaN },
  ]) assert.throws(() => validateVmIdentity(descriptor, { ...observed, ...change }, now));
  for (const change of [
    { format: 2 }, { kind: 'local' }, { provider: 'personal-host' }, { imageDigest: 'latest' },
    { imageDigest: 'sha256:abc' }, { vmUuid: '' }, { revision: 'main' }, { buildSequence: '01' },
    { buildSequence: '9223372036854775808' }, { createdAt: '2026-10-04T09:00:00Z' },
    { createdAt: '2026-10-04T12:01:00Z' }, { expiresAt: '2026-10-04T12:00:00Z' },
    { expiresAt: '2026-10-06T12:00:00Z' }, { createdAt: 'invalid' },
  ]) assert.throws(() => validateVmIdentity({ ...descriptor, ...change }, observed, now));
});
test('host identity uses a short-lived local authorization without storing a hardware UUID', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const descriptor = { format: 1, kind: 'isolated-macos-host', provider: 'local-macos', uid: 501,
    revision: 'a'.repeat(40), buildSequence: '123',
    createdAt: '2026-10-04T11:00:00Z', expiresAt: '2026-10-04T13:00:00Z' };
  const observed = { platform: 'darwin', arch: 'arm64', model: 'Mac16,1', uid: 501 };
  validateHostIdentity(descriptor, observed, now);
  validateHostIdentity(descriptor, { ...observed, model: 'MacBookPro18,4' }, now);
  assert.equal(Object.hasOwn(descriptor, 'uuid'), false);
  for (const change of [{ platform: 'linux' }, { arch: 'x64' }, { model: 'VirtualMac2,1' }, { uid: 502 }]) {
    assert.throws(() => validateHostIdentity(descriptor, { ...observed, ...change }, now));
  }
  for (const change of [{ kind: 'disposable-macos-vm' }, { provider: 'personal-host' }, { uid: 502 },
    { revision: 'main' }, { buildSequence: '01' }, { createdAt: '2026-10-04T12:01:00Z' },
    { expiresAt: '2026-10-06T12:00:00Z' }]) {
    assert.throws(() => validateHostIdentity({ ...descriptor, ...change }, observed, now));
  }
});

test('local consent cannot impersonate hosted context or inject startup/gate options', () => {
  validateLocalEnvironment({ HOME: '/guest', NATIVE_ACCEPTANCE_CONTEXT: '/guest/control/context.json' });
  for (const key of ['GITHUB_ACTIONS', 'GITHUB_ENV', 'RUNNER_TEMP', 'RUNNER_ENVIRONMENT', 'NATIVE_ACCEPTANCE_CONSENT',
    'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_EXTRA_LAUNCH_ARGS', 'DYLD_INSERT_LIBRARIES',
    'CODE_INTELLIGENCE_ISOLATED_RUN', 'CODE_INTELLIGENCE_ISOLATED_ROOT']) {
    assert.throws(() => validateLocalEnvironment({ [key]: 'injected' }), /Unexpected/);
  }
  for (const arg of ['-r', '-rinjected', '--require=injected', '--import=injected', '--loader=injected', '--inspect-brk']) {
    assert.throws(() => validateLocalEnvironment({}, [arg]), /startup options/);
  }
  assert.throws(() => requireExecutionContext({}), /Hosted workflow required/);
});

test('private paths reject public permissions, links, hardlinks and escaping roots', posix, t => {
  const root = temporary(t), directory = path.join(root, 'private'); fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, 'context.json'); fs.writeFileSync(file, '{}', { mode: 0o600 });
  privatePath(file, false); privateDescendant(root, directory);
  fs.chmodSync(file, 0o644); assert.throws(() => privatePath(file, false), /permissions/); fs.chmodSync(file, 0o600);
  fs.linkSync(file, path.join(directory, 'hardlink')); assert.throws(() => privatePath(file, false), /type/);
  fs.symlinkSync(directory, path.join(root, 'link')); assert.throws(() => privateDescendant(root, path.join(root, 'link')), /Canonical/);
  fs.chmodSync(directory, 0o755); assert.throws(() => privateDescendant(root, directory), /permissions/);
  assert.throws(() => privateDescendant(directory, root), /inside/);
  assert.throws(() => privateDescendant(root, root), /inside/);
});

test('initial profile freshness rejects existing and dangling default profiles without deleting them', posix, t => {
  const home = temporary(t), source = path.join(home, 'source');
  fs.mkdirSync(path.join(source, 'desktop'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, 'desktop', 'package.json'), JSON.stringify({ name: 'context-test-app' }));
  const support = path.join(home, 'Library', 'Application Support'); fs.mkdirSync(support, { recursive: true, mode: 0o700 });
  const profile = freshProfile(source, home); fs.mkdirSync(profile, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'existing'), 'preserve');
  assert.throws(() => freshProfile(source, home), /fresh disposable/);
  assert.equal(fs.readFileSync(path.join(profile, 'existing'), 'utf8'), 'preserve');
  fs.renameSync(profile, profile + '-saved'); fs.symlinkSync(path.join(home, 'missing'), profile);
  assert.throws(() => freshProfile(source, home), /fresh disposable/);
});

test('phase claims refuse old provisioning work and repeat product execution', posix, t => {
  const tempRoot = temporary(t), context = { kind: 'disposable-macos-vm', tempRoot, revision: 'a'.repeat(40) };
  claimExecution(context, 'provision');
  assert.throws(() => claimExecution(context, 'provision'), /Fresh provisioning/);
  const artifacts = prepareArtifacts(context); privateDescendant(tempRoot, artifacts);
  claimExecution(context, 'acceptance'); claimExecution(context, 'product');
  assert.throws(() => claimExecution(context, 'acceptance'), { code: 'EEXIST' });
  assert.throws(() => claimExecution(context, 'product'), { code: 'EEXIST' });
  assert.throws(() => claimExecution(context, '../../outside'));
});

test('local runtime artifact is sourceable, quoted, private and never writes GITHUB_ENV', posix, t => {
  const tempRoot = temporary(t), context = { kind: 'disposable-macos-vm', tempRoot };
  const values = { PG_CONFIG: "/guest/a b/'literal'/$not_expanded/pg_config", REDIS_SERVER: '/guest/redis', CODE_INTELLIGENCE_BUILD_SEQUENCE: '123' };
  const github = path.join(tempRoot, 'github-env');
  writeRuntimeEnvironment(context, values, { GITHUB_ENV: github });
  assert.equal(fs.existsSync(github), false);
  const artifact = path.join(tempRoot, 'native-runtime.env'); privatePath(artifact, false);
  const result = spawnSync('/bin/bash', ['-c', '. "$1"; printf "%s\\0%s\\0%s" "$PG_CONFIG" "$REDIS_SERVER" "$CODE_INTELLIGENCE_BUILD_SEQUENCE"', 'bash', artifact], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.split('\0'), Object.values(values));
  assert.throws(() => writeRuntimeEnvironment(context, values), { code: 'EEXIST' });
  assert.throws(() => writeRuntimeEnvironment(context, { PG_CONFIG: 'path\nINJECTED=1' }));
  assert.throws(() => writeRuntimeEnvironment(context, { NODE_OPTIONS: '--require anything' }));
});

test('hosted runtime output remains GitHub env format, separate from guest shell artifacts', t => {
  const tempRoot = temporary(t), file = path.join(tempRoot, 'github-env');
  writeRuntimeEnvironment({ kind: 'github-hosted' }, { PG_CONFIG: '/runtime/pg_config' }, { GITHUB_ENV: file });
  assert.equal(fs.readFileSync(file, 'utf8'), 'PG_CONFIG=/runtime/pg_config\n');
  assert.equal(fs.existsSync(path.join(tempRoot, 'native-runtime.env')), false);
});

test('plain local switch and absent descriptor refuse direct product entry before dependency loading', async () => {
  const { runProduct } = require('../scripts/native-acceptance-electron.cjs');
  await assert.rejects(runProduct({ env: { NATIVE_ACCEPTANCE_CONTEXT: 'true' } }));
});

test('hosted context derives common fields while retaining consent and fork checks', {
  skip: !((process.platform === 'darwin' && process.arch === 'arm64') || (process.platform === 'win32' && process.arch === 'x64')),
}, t => {
  const root = temporary(t);
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'workflow_dispatch',
    NATIVE_ACCEPTANCE_CONSENT: 'disposable-hosted-os', GITHUB_SHA: 'a'.repeat(40), CODE_INTELLIGENCE_BUILD_SEQUENCE: '123',
    RUNNER_TEMP: root, GITHUB_WORKSPACE: root };
  const context = requireExecutionContext(env);
  assert.equal(context.kind, 'github-hosted'); assert.equal(context.sourceRoot, root); assert.equal(context.tempRoot, root);
  assert.equal(context.revision, env.GITHUB_SHA); assert.equal(context.buildSequence, '123');
  assert.throws(() => requireExecutionContext({ ...env, NATIVE_ACCEPTANCE_CONSENT: '' }));
  assert.throws(() => requireExecutionContext({ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }));
  const event = path.join(root, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { head: { repo: { full_name: 'fork/repo' } },
    base: { repo: { full_name: 'owner/repo' } } } }));
  assert.throws(() => requireExecutionContext({ ...env, GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'owner/repo' }), /Fork source/);
});
