'use strict';
// G-UPDATE fixture-key rehearsal of the REFERENCE manifest contract
// (validation/pre-release/update-manifest-reference.cjs). Every key is generated in memory
// for this process and discarded; no key is read from or written to disk. The product has
// no updater yet, so a PASS here is a contract rehearsal, never a G-UPDATE PASS.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const reference = require('../../validation/pre-release/update-manifest-reference.cjs');

const release = crypto.generateKeyPairSync('ed25519');
const attacker = crypto.generateKeyPairSync('ed25519');
const NOW = Date.UTC(2026, 9, 7, 12);
const ARTIFACT = Buffer.from('synthetic full signed DMG bytes for rehearsal only\n'.repeat(64));
const CHECKPOINT = '5b1f0a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';

function body(changes = {}) {
  return { format: 1, kind: 'update', product: 'code-intelligence', bundleId: 'dev.codeintelligence.desktop', teamId: 'ABCDE12345',
    channel: 'stable', serial: 42, issuedAt: NOW - 60000, expiresAt: NOW + 7 * 86400000, version: '0.2.0', buildSequence: '200',
    platform: 'darwin', arch: 'arm64', minimumSystemVersion: '13.0', compatibleFromBuild: '100',
    schema: { flyway: 28, safetyJournalMajor: 1, backupFormat: 3 },
    artifact: { kind: 'dmg', url: 'https://updates.example.invalid/code-intelligence/0.2.0/app.dmg', size: ARTIFACT.length,
      sha256: crypto.createHash('sha256').update(ARTIFACT).digest('hex') }, recovery: null, ...changes };
}
function context(changes = {}) {
  return { pinnedKeys: { 'release-2026': release.publicKey }, allowedHosts: ['updates.example.invalid'], now: NOW,
    running: { product: 'code-intelligence', bundleId: 'dev.codeintelligence.desktop', teamId: 'ABCDE12345', platform: 'darwin',
      arch: 'arm64', osVersion: '13.6', buildSequence: '150', schemaFlyway: 27, safetyJournalMajor: 1 },
    state: { highWaterBuild: '150', lastManifestSerial: 41 }, ...changes };
}
const signed = (value = body(), privateKey = release.privateKey, keyId = 'release-2026') => reference.signManifest(value, { keyId, privateKey });
const rejects = (envelope, code, ctx = context()) => assert.throws(() => reference.verifyUpdateManifest(envelope, ctx), { code });

test('a correctly signed, current, compatible manifest and matching artifact are accepted', () => {
  const result = reference.verifyUpdateManifest(signed(), context());
  assert.equal(result.manifest.buildSequence, '200'); assert.equal(result.acceptedSerial, 42);
  assert.equal(reference.verifyArtifactBytes(ARTIFACT, result.manifest), true);
});

test('forged signature: an attacker key under the pinned key ID is rejected before the body is trusted', () => {
  rejects(signed(body(), attacker.privateKey), 'UPDATE_SIGNATURE_INVALID');
  rejects(signed(body(), attacker.privateKey, 'attacker'), 'UPDATE_KEY_UNKNOWN');
  const envelope = signed(); envelope.signature = Buffer.alloc(64, 1).toString('base64');
  rejects(envelope, 'UPDATE_SIGNATURE_INVALID');
  rejects({ ...signed(), signature: 'AAAA' }, 'UPDATE_SIGNATURE_INVALID');
  // A schema-invalid body under a bad signature must report the signature, not leak parsing.
  rejects(signed({ format: 1, unexpected: true }, attacker.privateKey), 'UPDATE_SIGNATURE_INVALID');
});

test('tampered manifest or artifact: any changed field or byte is rejected', () => {
  for (const mutate of [b => { b.artifact.sha256 = '0'.repeat(64); }, b => { b.buildSequence = '201'; },
    b => { b.artifact.url = 'https://updates.example.invalid/other.dmg'; }, b => { b.minimumSystemVersion = '12.0'; }]) {
    const envelope = signed(); mutate(envelope.body); rejects(envelope, 'UPDATE_SIGNATURE_INVALID');
  }
  const manifest = reference.verifyUpdateManifest(signed(), context()).manifest;
  const tampered = Buffer.from(ARTIFACT); tampered[10] ^= 1;
  assert.throws(() => reference.verifyArtifactBytes(tampered, manifest), { code: 'UPDATE_ARTIFACT_HASH' });
  assert.throws(() => reference.verifyArtifactBytes(Buffer.concat([ARTIFACT, Buffer.from('x')]), manifest), { code: 'UPDATE_ARTIFACT_SIZE' });
  assert.throws(() => reference.verifyArtifactBytes(ARTIFACT.subarray(1), manifest), { code: 'UPDATE_ARTIFACT_SIZE' });
});

test('wrong platform, architecture or product identity is rejected even when correctly signed', () => {
  rejects(signed(body({ platform: 'win32' })), 'UPDATE_PLATFORM_MISMATCH');
  rejects(signed(body({ arch: 'x64' })), 'UPDATE_ARCH_MISMATCH');
  rejects(signed(body({ bundleId: 'dev.codeintelligence.desktop.validation' })), 'UPDATE_IDENTITY_MISMATCH');
  rejects(signed(body({ teamId: 'ZZZZZ99999' })), 'UPDATE_IDENTITY_MISMATCH');
});

test('downgrade: an older, equal or below-high-water build is refused through the update path', () => {
  rejects(signed(body({ buildSequence: '149' })), 'UPDATE_DOWNGRADE');
  rejects(signed(body({ buildSequence: '150' })), 'UPDATE_DOWNGRADE');
  rejects(signed(body({ buildSequence: '160' })), 'UPDATE_DOWNGRADE', context({ state: { highWaterBuild: '170', lastManifestSerial: 41 } }));
  // Numeric, not lexical, comparison of build sequences.
  rejects(signed(body({ buildSequence: '99' })), 'UPDATE_DOWNGRADE', context({ running: { ...context().running, buildSequence: '100' },
    state: { highWaterBuild: '100', lastManifestSerial: 41 } }));
});

test('replayed older manifest: a validly signed but already-superseded serial is refused', () => {
  const older = signed(body({ serial: 41 }));
  rejects(older, 'UPDATE_MANIFEST_REPLAYED');
  rejects(signed(body({ serial: 40, buildSequence: '180' })), 'UPDATE_MANIFEST_REPLAYED');
  rejects(signed(body({ expiresAt: NOW - 1, issuedAt: NOW - 86400000 })), 'UPDATE_MANIFEST_EXPIRED');
  rejects(signed(body({ issuedAt: NOW + 3600000, expiresAt: NOW + 7200000 })), 'UPDATE_MANIFEST_EXPIRED');
});

test('minimum-version violations: host OS, direct-upgrade floor and data schema compatibility', () => {
  rejects(signed(body({ minimumSystemVersion: '14.0' })), 'UPDATE_OS_TOO_OLD');
  rejects(signed(body({ compatibleFromBuild: '151' })), 'UPDATE_REQUIRES_INTERMEDIATE');
  rejects(signed(body({ schema: { flyway: 26, safetyJournalMajor: 1, backupFormat: 3 } })), 'UPDATE_SCHEMA_INCOMPATIBLE');
  rejects(signed(body({ schema: { flyway: 28, safetyJournalMajor: 0, backupFormat: 3 } })), 'UPDATE_MANIFEST_SCHEMA');
});

test('artifact location must be an allowlisted HTTPS host without credentials or alternate port', () => {
  for (const url of ['http://updates.example.invalid/app.dmg', 'https://evil.example/app.dmg', 'https://user:pw@updates.example.invalid/app.dmg',
    'https://updates.example.invalid:8443/app.dmg', 'https://updates.example.invalid.evil.example/app.dmg']) {
    rejects(signed(body({ artifact: { ...body().artifact, url } })), 'UPDATE_ARTIFACT_URL');
  }
});

test('exceptional downgrade only through a signed recovery manifest bound to a compatible retained checkpoint', () => {
  const recovery = changes => body({ kind: 'recovery', buildSequence: '120', serial: 43,
    schema: { flyway: 27, safetyJournalMajor: 1, backupFormat: 3 },
    recovery: { checkpointId: CHECKPOINT, checkpointSchemaFlyway: 27, reason: 'rollback after failed 0.2.0 migration' }, ...changes });
  const checkpoint = { id: CHECKPOINT, schemaFlyway: 27, createdByBuild: '120' };
  assert.equal(reference.verifyUpdateManifest(signed(recovery()), context({ checkpoint })).manifest.kind, 'recovery');
  rejects(signed(recovery()), 'UPDATE_RECOVERY_CHECKPOINT');
  rejects(signed(recovery()), 'UPDATE_RECOVERY_CHECKPOINT', context({ checkpoint: { ...checkpoint, id: crypto.randomUUID() } }));
  rejects(signed(recovery()), 'UPDATE_RECOVERY_CHECKPOINT', context({ checkpoint: { ...checkpoint, schemaFlyway: 28 } }));
  rejects(signed(recovery({ recovery: { checkpointId: CHECKPOINT, checkpointSchemaFlyway: 27, reason: 'x' } }), attacker.privateKey),
    'UPDATE_SIGNATURE_INVALID', context({ checkpoint }));
  // A plain update manifest can never carry a downgrade, with or without a checkpoint.
  rejects(signed(body({ buildSequence: '120' })), 'UPDATE_DOWNGRADE', context({ checkpoint }));
});

test('installed app identity comes from its code signature and notarization, not from the manifest', () => {
  const manifest = reference.verifyUpdateManifest(signed(), context()).manifest;
  const good = { codesignStrictDeep: true, teamId: 'ABCDE12345', bundleId: 'dev.codeintelligence.desktop', gatekeeperNotarized: true,
    stapled: true, buildSequence: '200' };
  assert.equal(reference.verifyInstalledIdentity(good, manifest), true);
  for (const [change, code] of [[{ codesignStrictDeep: false }, 'UPDATE_APP_SIGNATURE_INVALID'], [{ teamId: 'ZZZZZ99999' }, 'UPDATE_APP_TEAM_MISMATCH'],
    [{ bundleId: 'x' }, 'UPDATE_APP_BUNDLE_MISMATCH'], [{ gatekeeperNotarized: false }, 'UPDATE_APP_NOT_NOTARIZED'],
    [{ stapled: false }, 'UPDATE_APP_NOT_NOTARIZED'], [{ buildSequence: '199' }, 'UPDATE_APP_BUILD_MISMATCH']]) {
    assert.throws(() => reference.verifyInstalledIdentity({ ...good, ...change }, manifest), { code });
  }
});

test('high-water state is monotonic: installs raise it and a restored older state never lowers it', () => {
  const live = { highWaterBuild: '200', lastManifestSerial: 42 };
  assert.deepEqual({ ...reference.mergeAfterRestore(live, { highWaterBuild: '150', lastManifestSerial: 30 }) }, live);
  assert.deepEqual({ ...reference.mergeAfterRestore(live, { highWaterBuild: '1000', lastManifestSerial: 50 }) }, { highWaterBuild: '1000', lastManifestSerial: 50 });
  assert.deepEqual({ ...reference.raiseHighWater(live, { installedBuild: '9', acceptedSerial: 1 }) }, live);
  assert.equal(reference.raiseHighWater({ highWaterBuild: '99', lastManifestSerial: 0 }, { installedBuild: '100' }).highWaterBuild, '100');
});

test('canonical encoding rejects values that could be signed ambiguously', () => {
  assert.equal(reference.canonical({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  for (const value of [{ a: 1.5 }, { a: Number.MAX_SAFE_INTEGER + 1 }, { a: undefined }, { a: new Date(0) }]) {
    assert.throws(() => reference.canonical(value), { code: 'UPDATE_MANIFEST_SCHEMA' });
  }
});
