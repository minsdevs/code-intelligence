'use strict';

// Main process only. The G-UPDATE manifest contract (05 §6, D12, ADR-02), promoted unchanged in
// behaviour from the former validation reference. Public keys come only from the pinned key file
// (desktop/build/update-keys.json); nothing in a manifest body is trusted before its signature.
// See docs/release/update-acceptance-plan.md §2 for the verification order.
const crypto = require('node:crypto');

const DOMAIN = 'CI-UPDATE-MANIFEST-1\0';
const BODY_FIELDS = Object.freeze(['format', 'kind', 'product', 'bundleId', 'teamId', 'channel', 'serial', 'issuedAt', 'expiresAt',
  'version', 'buildSequence', 'platform', 'arch', 'minimumSystemVersion', 'compatibleFromBuild', 'schema', 'artifact', 'recovery']);
const ARTIFACT_FIELDS = Object.freeze(['kind', 'url', 'size', 'sha256']);
const SCHEMA_FIELDS = Object.freeze(['flyway', 'safetyJournalMajor', 'backupFormat']);
const RECOVERY_FIELDS = Object.freeze(['checkpointId', 'checkpointSchemaFlyway', 'reason']);
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

class UpdateManifestError extends Error {
  constructor(code) { super(code); this.name = 'UpdateManifestError'; this.code = code; }
}
const fail = code => { throw new UpdateManifestError(code); };
const exact = (value, fields, code) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const keys = Object.keys(value).sort();
  if (keys.length !== fields.length || keys.some((key, index) => key !== [...fields].sort()[index])) fail(code);
};
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const version = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,2}$/.test(value);
function compareVersion(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}

// Canonical JSON: sorted keys, no whitespace, only null/boolean/finite-integer/string/array/object.
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('UPDATE_MANIFEST_SCHEMA'); return String(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail('UPDATE_MANIFEST_SCHEMA');
}

function signManifest(body, { keyId, privateKey }) {
  const signature = crypto.sign(null, Buffer.from(DOMAIN + canonical(body)), privateKey).toString('base64');
  return { keyId, signature, body };
}

function validateBody(body) {
  exact(body, BODY_FIELDS, 'UPDATE_MANIFEST_SCHEMA');
  if (body.format !== 1 || !['update', 'recovery'].includes(body.kind) || body.channel !== 'stable'
      || typeof body.product !== 'string' || typeof body.bundleId !== 'string' || !/^[A-Z0-9]{10}$/.test(body.teamId)
      || !Number.isSafeInteger(body.serial) || body.serial < 1 || !Number.isSafeInteger(body.issuedAt) || !Number.isSafeInteger(body.expiresAt)
      || body.expiresAt <= body.issuedAt || !version(body.version) || !decimal(body.buildSequence) || !decimal(body.compatibleFromBuild)
      || typeof body.platform !== 'string' || typeof body.arch !== 'string' || !version(body.minimumSystemVersion)) fail('UPDATE_MANIFEST_SCHEMA');
  exact(body.schema, SCHEMA_FIELDS, 'UPDATE_MANIFEST_SCHEMA');
  for (const key of SCHEMA_FIELDS) if (!Number.isSafeInteger(body.schema[key]) || body.schema[key] < 1) fail('UPDATE_MANIFEST_SCHEMA');
  exact(body.artifact, ARTIFACT_FIELDS, 'UPDATE_MANIFEST_SCHEMA');
  if (!['dmg', 'zip'].includes(body.artifact.kind) || typeof body.artifact.url !== 'string' || !Number.isSafeInteger(body.artifact.size)
      || body.artifact.size < 1 || !/^[0-9a-f]{64}$/.test(body.artifact.sha256)) fail('UPDATE_MANIFEST_SCHEMA');
  if (body.kind === 'update') {
    if (body.recovery !== null) fail('UPDATE_MANIFEST_SCHEMA');
  } else {
    exact(body.recovery, RECOVERY_FIELDS, 'UPDATE_MANIFEST_SCHEMA');
    if (typeof body.recovery.checkpointId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.recovery.checkpointId)
        || !Number.isSafeInteger(body.recovery.checkpointSchemaFlyway) || typeof body.recovery.reason !== 'string') fail('UPDATE_MANIFEST_SCHEMA');
  }
}

// Order matters: nothing in the body is trusted before the pinned-key signature verifies.
function verifyUpdateManifest(envelope, context) {
  exact(envelope, ['keyId', 'signature', 'body'], 'UPDATE_ENVELOPE_INVALID');
  const key = context.pinnedKeys?.[envelope.keyId];
  if (!key) fail('UPDATE_KEY_UNKNOWN');
  let signature;
  try { signature = Buffer.from(envelope.signature, 'base64'); } catch { fail('UPDATE_SIGNATURE_INVALID'); }
  let message;
  try { message = Buffer.from(DOMAIN + canonical(envelope.body)); } catch { fail('UPDATE_SIGNATURE_INVALID'); }
  if (signature.length !== 64 || !crypto.verify(null, message, key, signature)) fail('UPDATE_SIGNATURE_INVALID');
  const body = envelope.body;
  validateBody(body);
  const { running, state, now } = context;
  if (body.product !== running.product || body.bundleId !== running.bundleId || body.teamId !== running.teamId) fail('UPDATE_IDENTITY_MISMATCH');
  if (body.platform !== running.platform) fail('UPDATE_PLATFORM_MISMATCH');
  if (body.arch !== running.arch) fail('UPDATE_ARCH_MISMATCH');
  if (body.issuedAt > now + MAX_CLOCK_SKEW_MS || body.expiresAt <= now) fail('UPDATE_MANIFEST_EXPIRED');
  if (body.serial <= state.lastManifestSerial) fail('UPDATE_MANIFEST_REPLAYED');
  const target = BigInt(body.buildSequence), current = BigInt(running.buildSequence), floor = BigInt(state.highWaterBuild);
  if (body.kind === 'update') {
    if (target <= current || target < floor) fail('UPDATE_DOWNGRADE');
  } else {
    // Exceptional downgrade: only to a build that can read a retained, compatible data checkpoint.
    const checkpoint = context.checkpoint;
    if (!checkpoint || checkpoint.id !== body.recovery.checkpointId || checkpoint.schemaFlyway !== body.recovery.checkpointSchemaFlyway
        || checkpoint.schemaFlyway > body.schema.flyway || BigInt(checkpoint.createdByBuild) > target) fail('UPDATE_RECOVERY_CHECKPOINT');
  }
  if (compareVersion(running.osVersion, body.minimumSystemVersion) < 0) fail('UPDATE_OS_TOO_OLD');
  if (current < BigInt(body.compatibleFromBuild)) fail('UPDATE_REQUIRES_INTERMEDIATE');
  if (body.kind === 'update' && (body.schema.flyway < running.schemaFlyway || body.schema.safetyJournalMajor < running.safetyJournalMajor))
    fail('UPDATE_SCHEMA_INCOMPATIBLE');
  let url;
  try { url = new URL(body.artifact.url); } catch { fail('UPDATE_ARTIFACT_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !context.allowedHosts.includes(url.hostname)
      || url.hash) fail('UPDATE_ARTIFACT_URL');
  return Object.freeze({ manifest: body, acceptedSerial: body.serial });
}

function verifyArtifactBytes(bytes, manifest) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== manifest.artifact.size) fail('UPDATE_ARTIFACT_SIZE');
  const digest = crypto.createHash('sha256').update(bytes).digest();
  if (!crypto.timingSafeEqual(digest, Buffer.from(manifest.artifact.sha256, 'hex'))) fail('UPDATE_ARTIFACT_HASH');
  return true;
}

// The installed app must match before it may run: identity from code signature, not from the manifest.
function verifyInstalledIdentity(observed, manifest) {
  if (!observed || observed.codesignStrictDeep !== true) fail('UPDATE_APP_SIGNATURE_INVALID');
  if (observed.teamId !== manifest.teamId) fail('UPDATE_APP_TEAM_MISMATCH');
  if (observed.bundleId !== manifest.bundleId) fail('UPDATE_APP_BUNDLE_MISMATCH');
  if (observed.gatekeeperNotarized !== true || observed.stapled !== true) fail('UPDATE_APP_NOT_NOTARIZED');
  if (observed.buildSequence !== manifest.buildSequence) fail('UPDATE_APP_BUILD_MISMATCH');
  return true;
}

// Area-B monotonic state. Restore merges and new installs can only raise it.
function raiseHighWater(state, { installedBuild, acceptedSerial }) {
  const highWater = [state.highWaterBuild, installedBuild ?? '0'].map(BigInt).reduce((a, b) => (a > b ? a : b));
  return Object.freeze({ highWaterBuild: highWater.toString(), lastManifestSerial: Math.max(state.lastManifestSerial, acceptedSerial ?? 0) });
}
function mergeAfterRestore(live, restored) {
  return raiseHighWater(live, { installedBuild: restored.highWaterBuild, acceptedSerial: restored.lastManifestSerial });
}

module.exports = { DOMAIN, BODY_FIELDS, UpdateManifestError, canonical, signManifest, verifyUpdateManifest, verifyArtifactBytes,
  verifyInstalledIdentity, raiseHighWater, mergeAfterRestore, compareVersion };
