'use strict';

// Main process only. User-initiated update check, download, verification and hand-off (05 §6).
// The first update is a full signed DMG/ZIP: after verification and user confirmation the artifact
// is revealed and the app quits. There is no silent in-place swap and no background installer.
// Nothing here is renderer input; every URL, key, path and tool is fixed by trusted main code.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { UpdateManifestError, verifyUpdateManifest, verifyArtifactFile, verifyInstalledIdentity } = require('./update-manifest.cjs');

const PURPOSE = 'code-intelligence-update-manifest';
const KEY_FILE_FIELDS = Object.freeze(['format', 'purpose', 'product', 'bundleId', 'teamId', 'channel', 'manifestUrl', 'allowedHosts', 'keys']);
const LIMITS = Object.freeze({ keyFileBytes: 64 * 1024, manifestBytes: 64 * 1024, artifactBytes: 4 * 1024 ** 3,
  runtimeManifestBytes: 8 * 1024 * 1024, toolOutputBytes: 1024 * 1024, toolTimeoutMs: 300000 });
const TOOLS = Object.freeze({ codesign: '/usr/bin/codesign', spctl: '/usr/sbin/spctl', xcrun: '/usr/bin/xcrun',
  hdiutil: '/usr/bin/hdiutil', ditto: '/usr/bin/ditto' });
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

class UpdateServiceError extends Error {
  // Codes only: never a URL, path, header, tool output or key in a message.
  constructor(code) { super(code); this.name = 'UpdateServiceError'; this.code = code; }
}
const fail = code => { throw new UpdateServiceError(code); };
const safeError = (error, fallback) => error instanceof UpdateServiceError || error instanceof UpdateManifestError
  ? new UpdateServiceError(error.code) : new UpdateServiceError(fallback);
function exact(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const keys = Object.keys(value).sort(), expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail(code);
}
function httpsUrl(raw, allowedHosts, code) {
  let url;
  try { url = new URL(raw); } catch { fail(code); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !allowedHosts.includes(url.hostname)) fail(code);
  return url;
}

// Pinned public keys and channel identity, packed into the signed asar. An empty key set disables
// the updater; a release (distribution) build refuses it, see requireReleaseUpdateKeys.
function parseUpdateKeys(bytes, { release = false } = {}) {
  let value;
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.keyFileBytes) fail('UPDATE_KEYS_INVALID');
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('UPDATE_KEYS_INVALID'); }
  exact(value, KEY_FILE_FIELDS, 'UPDATE_KEYS_INVALID');
  if (value.format !== 1 || value.purpose !== PURPOSE || value.channel !== 'stable'
      || typeof value.product !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value.product)
      || typeof value.bundleId !== 'string' || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value.bundleId)
      || !(value.teamId === null || (typeof value.teamId === 'string' && /^[A-Z0-9]{10}$/.test(value.teamId)))
      || !(value.manifestUrl === null || typeof value.manifestUrl === 'string')
      || !Array.isArray(value.allowedHosts) || value.allowedHosts.length > 8
      || value.allowedHosts.some(host => typeof host !== 'string' || !HOST.test(host)) || new Set(value.allowedHosts).size !== value.allowedHosts.length
      || !Array.isArray(value.keys) || value.keys.length > 8) fail('UPDATE_KEYS_INVALID');
  const pinnedKeys = Object.create(null);
  for (const entry of value.keys) {
    exact(entry, ['keyId', 'publicKey'], 'UPDATE_KEYS_INVALID');
    if (typeof entry.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.keyId) || Object.hasOwn(pinnedKeys, entry.keyId)
        || typeof entry.publicKey !== 'string') fail('UPDATE_KEYS_INVALID');
    let key;
    try {
      const der = Buffer.from(entry.publicKey, 'base64');
      if (der.toString('base64') !== entry.publicKey) fail('UPDATE_KEYS_INVALID');
      key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch { fail('UPDATE_KEYS_INVALID'); }
    if (key.asymmetricKeyType !== 'ed25519') fail('UPDATE_KEYS_INVALID');
    pinnedKeys[entry.keyId] = key;
  }
  const configured = [value.keys.length > 0, value.manifestUrl !== null, value.allowedHosts.length > 0, value.teamId !== null];
  // All or nothing: a key without a channel (or a channel without a key) is a packaging mistake.
  if (configured.some(Boolean) && !configured.every(Boolean)) fail('UPDATE_KEYS_INVALID');
  const enabled = configured.every(Boolean);
  if (release && !enabled) fail('UPDATE_KEYS_MISSING');
  if (enabled) httpsUrl(value.manifestUrl, value.allowedHosts, 'UPDATE_KEYS_INVALID');
  return Object.freeze({ enabled, product: value.product, bundleId: value.bundleId, teamId: value.teamId, channel: value.channel,
    manifestUrl: value.manifestUrl, allowedHosts: Object.freeze([...value.allowedHosts]), pinnedKeys: Object.freeze(pinnedKeys) });
}
async function loadUpdateKeys(file, options) {
  let bytes;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > LIMITS.keyFileBytes) fail('UPDATE_KEYS_INVALID');
    bytes = await fs.readFile(file);
  } catch (error) { throw safeError(error, 'UPDATE_KEYS_INVALID'); }
  return parseUpdateKeys(bytes, options);
}
// beforePack: a distributed (non-directory) macOS build must ship a usable pinned key set.
async function requireReleaseUpdateKeys(projectDir, targets) {
  if (!Array.isArray(targets) || targets.every(target => target?.name === 'dir')) return null;
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) fail('UPDATE_KEYS_MISSING');
  return loadUpdateKeys(path.join(projectDir, 'build', 'update-keys.json'), { release: true });
}

// HTTPS GET through Electron's network stack (system proxy and trust store). No redirects,
// cookies, credentials or cache. The service enforces status and size; this only adapts events.
function electronRequest(net) {
  return url => new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url, redirect: 'error', credentials: 'omit', useSessionCookies: false, cache: 'no-store' });
    request.once('response', response => resolve({ statusCode: response.statusCode, headers: response.headers,
      body: response, abort: () => request.abort() }));
    request.once('error', () => reject(new UpdateServiceError('UPDATE_NETWORK')));
    request.end();
  });
}
function createProcessRunner() {
  return (file, args) => new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', shell: false, timeout: LIMITS.toolTimeoutMs, maxBuffer: LIMITS.toolOutputBytes,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function privateDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail('UPDATE_STORAGE');
  return directory;
}
async function bounded(request, url, maxBytes, sink) {
  let response;
  try { response = await request(url.href); } catch (error) { throw safeError(error, 'UPDATE_NETWORK'); }
  try {
    if (response?.statusCode !== 200) fail('UPDATE_HTTP_STATUS');
    const declared = [response.headers?.['content-length']].flat()[0];
    if (declared !== undefined && (!/^[0-9]{1,16}$/.test(String(declared)) || Number(declared) > maxBytes)) fail('UPDATE_TOO_LARGE');
    let total = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) fail('UPDATE_TOO_LARGE');
      await sink(bytes);
    }
    return total;
  } catch (error) {
    try { response?.abort?.(); } catch { /* The refusal below is what matters. */ }
    throw safeError(error, 'UPDATE_NETWORK');
  }
}
function field(output, name) {
  const values = output.split('\n').filter(line => line.startsWith(`${name}=`)).map(line => line.slice(name.length + 1).trim());
  return values.length === 1 ? values[0] : null;
}

function createUpdateService(options) {
  const { config, userData, running, request, runner, readState, recordAccepted, sanctionRollback, restoreCheckpoint,
    readCheckpoint, reveal, confirm, quit, now = Date.now } = options || {};
  if (!config || typeof userData !== 'string' || !path.isAbsolute(userData) || !running
      || [request, runner, readState, recordAccepted, sanctionRollback, restoreCheckpoint, readCheckpoint, reveal, confirm, quit, now]
        .some(item => typeof item !== 'function')) fail('UPDATE_INVALID');
  const updatesRoot = path.join(userData, 'updates');
  let phase = 'IDLE', verified = null, artifact = null, busy = false, lastError = null;
  const status = () => Object.freeze({ enabled: config.enabled, phase, kind: verified?.manifest.kind ?? null,
    version: verified?.manifest.version ?? null, buildSequence: verified?.manifest.buildSequence ?? null, error: lastError });
  function serialize(fallback, action) {
    if (busy) return Promise.reject(new UpdateServiceError('UPDATE_BUSY'));
    busy = true;
    return (async () => {
      try { if (!config.enabled) fail('UPDATE_NOT_CONFIGURED'); const result = await action(); lastError = null; return result; }
      catch (error) { const safe = safeError(error, fallback); lastError = safe.code; throw safe; }
      finally { busy = false; }
    })();
  }
  async function run(tool, args) {
    const result = await runner(tool, args);
    if (!result || !Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') fail('UPDATE_TOOL');
    return result;
  }
  async function locateApp(root) {
    const apps = [];
    for (const name of await fs.readdir(root)) {
      if (!name.endsWith('.app')) continue;
      const stat = await fs.lstat(path.join(root, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) apps.push(path.join(root, name));
    }
    if (apps.length !== 1) fail('UPDATE_APP_MISSING');
    return apps[0];
  }
  async function bundledBuild(app) {
    const file = path.join(app, 'Contents', 'Resources', 'runtime', 'runtime-manifest.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > LIMITS.runtimeManifestBytes) fail('UPDATE_APP_BUILD_MISMATCH');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof value?.buildSequence === 'string' ? value.buildSequence : null;
  }
  // Identity is read from the downloaded app's own code signature, never from the manifest.
  async function inspectApp(app) {
    const strict = await run(TOOLS.codesign, ['--verify', '--deep', '--strict', app]);
    const display = await run(TOOLS.codesign, ['-dv', '--verbose=4', app]);
    const signature = `${display.stdout}\n${display.stderr}`;
    const assessment = await run(TOOLS.spctl, ['--assess', '--type', 'execute', '-vv', app]);
    const staple = await run(TOOLS.xcrun, ['stapler', 'validate', app]);
    return { codesignStrictDeep: strict.code === 0, teamId: display.code === 0 ? field(signature, 'TeamIdentifier') : null,
      bundleId: display.code === 0 ? field(signature, 'Identifier') : null,
      gatekeeperNotarized: assessment.code === 0 && /^.*source=Notarized Developer ID$/m.test(`${assessment.stdout}\n${assessment.stderr}`),
      stapled: staple.code === 0, buildSequence: await bundledBuild(app) };
  }
  return Object.freeze({
    status,
    check() {
      return serialize('UPDATE_MANIFEST_INVALID', async () => {
        const chunks = [];
        await bounded(request, httpsUrl(config.manifestUrl, config.allowedHosts, 'UPDATE_MANIFEST_URL'), LIMITS.manifestBytes,
          async bytes => { chunks.push(bytes); });
        let envelope;
        try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { fail('UPDATE_MANIFEST_INVALID'); }
        const checkpoint = await readCheckpoint();
        const result = verifyUpdateManifest(envelope, { pinnedKeys: config.pinnedKeys, allowedHosts: config.allowedHosts, now: now(),
          running, state: readState(), ...(checkpoint ? { checkpoint } : {}) });
        verified = result; artifact = null; phase = 'AVAILABLE';
        return status();
      });
    },
    download() {
      return serialize('UPDATE_DOWNLOAD_FAILED', async () => {
        if (phase !== 'AVAILABLE' || !verified) fail('UPDATE_NOT_AVAILABLE');
        const manifest = verified.manifest;
        if (manifest.artifact.size > LIMITS.artifactBytes) fail('UPDATE_TOO_LARGE');
        const url = httpsUrl(manifest.artifact.url, config.allowedHosts, 'UPDATE_ARTIFACT_URL');
        await privateDirectory(updatesRoot);
        const directory = await privateDirectory(path.join(updatesRoot, String(manifest.serial)));
        const partial = path.join(directory, `artifact-${crypto.randomUUID()}.partial`);
        const handle = await fs.open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let kept = false;
        try {
          try {
            await bounded(request, url, manifest.artifact.size, async bytes => {
              let offset = 0;
              while (offset < bytes.length) offset += (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten;
            });
            await handle.sync();
          } finally { await handle.close(); }
          await verifyArtifactFile(partial, manifest);
          const target = path.join(directory, `artifact.${manifest.artifact.kind}`);
          await fs.rename(partial, target); kept = true;
          artifact = target; phase = 'DOWNLOADED';
          return status();
        } finally { if (!kept) await fs.unlink(partial).catch(() => {}); }
      });
    },
    verifyDownloaded() {
      return serialize('UPDATE_VERIFY_FAILED', async () => {
        if (phase !== 'DOWNLOADED' || !artifact) fail('UPDATE_NOT_DOWNLOADED');
        const manifest = verified.manifest;
        await verifyArtifactFile(artifact, manifest);
        const scratch = path.join(path.dirname(artifact), `inspect-${crypto.randomUUID()}`);
        await privateDirectory(scratch);
        let mounted = false;
        try {
          if (manifest.artifact.kind === 'dmg') {
            const attach = await run(TOOLS.hdiutil, ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', scratch, artifact]);
            if (attach.code !== 0) fail('UPDATE_ARTIFACT_UNREADABLE');
            mounted = true;
          } else if ((await run(TOOLS.ditto, ['-x', '-k', artifact, scratch])).code !== 0) fail('UPDATE_ARTIFACT_UNREADABLE');
          verifyInstalledIdentity(await inspectApp(await locateApp(scratch)), manifest);
        } finally {
          if (mounted) await run(TOOLS.hdiutil, ['detach', scratch]).catch(() => {});
          if (mounted) await fs.rmdir(scratch).catch(() => {});
          else await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
        }
        phase = 'VERIFIED';
        return status();
      });
    },
    // User-confirmed hand-off: record the consumed serial in area B, reveal the verified artifact and
    // quit. A recovery manifest first restores its bound checkpoint, then records the sanctioned rollback.
    handOff() {
      return serialize('UPDATE_HANDOFF_FAILED', async () => {
        if (phase !== 'VERIFIED' || !artifact) fail('UPDATE_NOT_VERIFIED');
        if (await confirm(status()) !== true) return status();
        await verifyArtifactFile(artifact, verified.manifest);
        if (verified.manifest.kind === 'recovery') {
          await restoreCheckpoint(verified.manifest.recovery.checkpointId);
          await sanctionRollback(verified);
          await reveal(artifact);
        } else {
          // Reveal first: a failed reveal leaves the serial unconsumed so the same update can be retried.
          await reveal(artifact);
          await recordAccepted(verified);
        }
        phase = 'HANDED_OFF';
        quit();
        return status();
      });
    },
  });
}

module.exports = Object.freeze({ createUpdateService, parseUpdateKeys, loadUpdateKeys, requireReleaseUpdateKeys, electronRequest,
  createProcessRunner, UpdateServiceError, LIMITS, TOOLS });
