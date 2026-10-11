'use strict';

// Validation candidates only (G-UPDATE packaged acceptance, 2026-10-11). A build-time loopback update
// feed stands in for the shipped pinned key file so the product updater (update-service.cjs,
// update-startup.cjs, the area-B floor and the pre-migration checkpoint) can be driven end to end on an
// ad-hoc signed Validation app: install → update → rollback. The feed is read from the packaged
// package.json inside the integrity-checked app.asar, exactly like the PK-08 fake AI provider, so no
// environment variable, renderer, file or user setting can supply it, and any other build refuses it
// (desktop-build-gate.cjs). Fixture material only: the CA, the Ed25519 key and the Team ID are test
// values. Developer ID signing, notarization and stapling are not exercised; the Validation tool runner
// below simulates exactly those three observations and says so in the status. Release code paths
// (electronRequest, createProcessRunner, build/update-keys.json) are unchanged.
const https = require('node:https');
const { parseUpdateKeys, createProcessRunner, TOOLS, UpdateServiceError } = require('./update-service.cjs');

const VALIDATION_PACKAGE_NAME = 'code-intelligence-validation';
const FEED_KEY = 'validationUpdateFeed';
const FEED_FIELDS = Object.freeze(['host', 'port', 'caPem', 'keyId', 'publicKey', 'teamId', 'manifestPath']);
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PEM = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]{64,8192}-----END CERTIFICATE-----\n?$/;
const refuse = () => { throw Object.assign(new Error('UPDATE_VALIDATION_FEED_REFUSED'), { code: 'UPDATE_VALIDATION_FEED_REFUSED' }); };

// null when the metadata carries no feed; a frozen feed for a validation build; a refusal otherwise.
function validationUpdateFeed(metadata) {
  if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, FEED_KEY)) return null;
  const feed = metadata[FEED_KEY];
  if (metadata.name !== VALIDATION_PACKAGE_NAME || !feed || typeof feed !== 'object' || Array.isArray(feed)) refuse();
  const keys = Object.keys(feed).sort();
  if (keys.length !== FEED_FIELDS.length || keys.some((key, index) => key !== [...FEED_FIELDS].sort()[index])) refuse();
  if (typeof feed.host !== 'string' || !HOST.test(feed.host) || /^[0-9.]+$/.test(feed.host) || !Number.isInteger(feed.port) || feed.port < 1024 || feed.port > 65535
      || typeof feed.caPem !== 'string' || !PEM.test(feed.caPem) || typeof feed.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(feed.keyId)
      || typeof feed.publicKey !== 'string' || typeof feed.teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(feed.teamId)
      || typeof feed.manifestPath !== 'string' || !/^\/[A-Za-z0-9._/-]{1,200}$/.test(feed.manifestPath) || feed.manifestPath.includes('..')) refuse();
  return Object.freeze({ ...feed });
}

// The product key-file parser validates the pinned key; the feed is only its source.
function feedUpdateConfig(feed, { product = 'code-intelligence', bundleId = 'dev.codeintelligence.desktop.validation' } = {}) {
  const file = { format: 1, purpose: 'code-intelligence-update-manifest', product, bundleId, teamId: feed.teamId, channel: 'stable',
    manifestUrl: `https://${feed.host}${feed.manifestPath}`, allowedHosts: [feed.host], keys: [{ keyId: feed.keyId, publicKey: feed.publicKey }] };
  const config = parseUpdateKeys(Buffer.from(JSON.stringify(file)));
  if (!config.enabled) refuse();
  return config;
}

// Same shape as electronRequest(net): the fixture host resolves only to loopback, the TLS chain must
// end at the fixture CA, nothing else is trusted and no redirect is followed.
function feedRequest(feed, requestImpl = https.request) {
  return url => new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch { return reject(new UpdateServiceError('UPDATE_NETWORK')); }
    if (target.protocol !== 'https:' || target.hostname !== feed.host || target.port) return reject(new UpdateServiceError('UPDATE_NETWORK'));
    const outgoing = requestImpl({ host: '127.0.0.1', port: feed.port, servername: feed.host, method: 'GET',
      path: target.pathname + target.search, headers: { host: feed.host }, ca: feed.caPem, rejectUnauthorized: true,
      minVersion: 'TLSv1.2', agent: false, lookup: (hostname, options, callback) => callback(new Error('fixture host only')) },
    response => resolve({ statusCode: response.statusCode, headers: response.headers, body: response, abort: () => outgoing.destroy() }));
    outgoing.once('error', () => reject(new UpdateServiceError('UPDATE_NETWORK')));
    outgoing.end();
  });
}

// Real codesign/hdiutil/ditto; simulated Team ID (ad-hoc signatures have none), Gatekeeper notarization
// assessment and staple validation. Every simulation is recorded so the acceptance report can list it.
function feedRunner(feed, real = createProcessRunner()) {
  const simulated = [];
  const runner = async (file, args) => {
    if (file === TOOLS.spctl) { simulated.push('spctl'); return { code: 0, stdout: '', stderr: 'accepted\nsource=Notarized Developer ID\n' }; }
    if (file === TOOLS.xcrun && args[0] === 'stapler') { simulated.push('stapler'); return { code: 0, stdout: '', stderr: '' }; }
    const result = await real(file, args);
    if (file === TOOLS.codesign && args[0] === '-dv' && result.code === 0) {
      const text = `${result.stdout}\n${result.stderr}`;
      if (/^TeamIdentifier=not set$/m.test(text)) {
        simulated.push('teamIdentifier');
        return { ...result, stderr: result.stderr.replace(/^TeamIdentifier=not set$/m, `TeamIdentifier=${feed.teamId}`) };
      }
    }
    return result;
  };
  return { runner, simulated, note: 'Validation build: codesign verification and archive tools are real; Team ID, notarization and stapling are simulated fixture observations (Developer ID/notary BLOCKED O2).' };
}

module.exports = Object.freeze({ validationUpdateFeed, feedUpdateConfig, feedRequest, feedRunner, FEED_KEY, FEED_FIELDS, VALIDATION_PACKAGE_NAME });
