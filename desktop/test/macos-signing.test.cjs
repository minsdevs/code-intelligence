'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { signRuntime, validateMacBuild } = require('../scripts/sign-macos-runtime.cjs');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function context(names, overrides = {}) {
  return {
    targets: names.map(name => ({ name })),
    packager: {
      forceCodeSigning: true,
      platformSpecificBuildOptions: {
        hardenedRuntime: true, type: 'distribution', notarize: true,
        sign: './scripts/sign-macos-runtime.cjs', ...overrides,
      },
      get codeSigningInfo() { throw new Error('Unexpected credential-store access'); },
    },
  };
}

test('ad-hoc or unnotarized distributable targets cannot be mislabeled as release builds', async () => {
  for (const targets of [['dmg'], ['zip'], ['dir', 'zip']]) {
    for (const options of [{ identity: '-', notarize: false }, { notarize: false }, { identity: null }]) {
      await assert.rejects(validateMacBuild(context(targets, options), {}), {
        code: 'MAC_DISTRIBUTION_REQUIRES_DEVELOPER_ID_AND_NOTARIZATION',
      });
    }
  }
});

test('missing and incomplete notary credentials fail before a signing identity is accessed', async () => {
  for (const environment of [
    {}, { APPLE_ID: 'build@example.test' }, { APPLE_API_KEY: '/private/notary.p8' },
    { APPLE_ID: 'build@example.test', APPLE_API_KEY: '/private/notary.p8', APPLE_API_KEY_ID: 'key', APPLE_API_ISSUER: 'issuer' },
  ]) {
    await assert.rejects(validateMacBuild(context(['dmg']), environment), { code: 'MAC_NOTARY_CREDENTIALS_REQUIRED' });
  }
});

test('disabling hardened runtime or bypassing native signing prevents packaging', async () => {
  for (const options of [{ hardenedRuntime: false }, { sign: undefined }]) {
    await assert.rejects(validateMacBuild(context([], { identity: '-', notarize: false, ...options }), {}), {
      code: 'MAC_RUNTIME_SIGNING_REQUIRED',
    });
  }
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeintel-signing-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  for (const name of ['bin', 'lib', 'share']) fs.mkdirSync(path.join(stage, 'postgres', name), { recursive: true, mode: 0o700 });
  const source = path.join(root, 'probe.c');
  const binary = 'postgres/bin/probe';
  fs.writeFileSync(source, 'int main(void) { return 0; }\n');
  execFileSync('/usr/bin/clang', [source, '-o', path.join(stage, binary)], { stdio: 'pipe', timeout: 120000 });
  fs.writeFileSync(path.join(stage, 'postgres/share/catalog.txt'), 'immutable ordinary resource\n', { mode: 0o600 });
  const manifest = {
    format: 1, platform: 'darwin', arch: process.arch, buildSequence: '1',
    runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/lib', postgresPkgLib: 'postgres/lib', postgresShare: 'postgres/share' },
    files: { [binary]: hash(path.join(stage, binary)), 'postgres/share/catalog.txt': hash(path.join(stage, 'postgres/share/catalog.txt')) },
  };
  fs.writeFileSync(path.join(stage, 'runtime-manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  const runtime = path.join(root, 'Probe.app', 'Contents', 'Resources', 'runtime');
  fs.cpSync(stage, runtime, { recursive: true });
  return { stage, runtime, manifest, binary };
}
const options = {
  identity: '-',
  optionsForFile: () => ({ hardenedRuntime: true, entitlements: path.resolve(__dirname, '../build/entitlements.mac.plist') }),
};

test('real native signing leaves a verifiable, readable runtime without modifying the build input', {
  skip: process.platform !== 'darwin',
}, async t => {
  const { stage, runtime, manifest, binary } = fixture(t);
  const originalManifestHash = hash(path.join(stage, 'runtime-manifest.json'));
  const signed = await signRuntime(runtime, options);
  assert.notEqual(signed.files[binary], manifest.files[binary]);
  assert.equal(signed.files[binary], hash(path.join(runtime, binary)));
  assert.equal(signed.files['postgres/share/catalog.txt'], manifest.files['postgres/share/catalog.txt']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-manifest.json'), 'utf8')), signed);
  await validateRuntimeManifest(runtime, signed);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', path.join(runtime, binary)], { stdio: 'pipe', timeout: 120000 });
  assert.equal(hash(path.join(stage, binary)), manifest.files[binary]);
  assert.equal(hash(path.join(stage, 'runtime-manifest.json')), originalManifestHash);
  assert.equal(fs.statSync(path.join(stage, 'runtime-manifest.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(runtime, 'runtime-manifest.json')).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(runtime, 'postgres/share/catalog.txt')).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(runtime, 'postgres/bin')).mode & 0o777, 0o755);
});

test('signing never blesses a changed ordinary resource or an extra unlisted file', {
  skip: process.platform !== 'darwin',
}, async t => {
  for (const mutation of ['replace', 'add']) {
    const { runtime, manifest, binary } = fixture(t);
    const target = mutation === 'replace' ? 'postgres/share/catalog.txt' : 'unexpected.txt';
    fs.writeFileSync(path.join(runtime, target), 'not present in the staged inventory');
    await assert.rejects(signRuntime(runtime, options), /manifest or inventory is invalid/);
    assert.equal(hash(path.join(runtime, binary)), manifest.files[binary]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-manifest.json'), 'utf8')), manifest);
  }
});
