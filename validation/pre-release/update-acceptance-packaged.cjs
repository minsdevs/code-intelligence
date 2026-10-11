'use strict';

// G-UPDATE packaged acceptance (2026-10-11): drives the product updater of a Validation candidate that
// carries the loopback update feed (build-candidate.cjs --update-feed) through install → update → rollback
// boundaries on one isolated profile, with a fixture HTTPS server on 127.0.0.1 and fixture Ed25519
// manifests. Rows follow C14 U1–U10 of docs/release/update-acceptance-plan.md §5. Not exercised: Developer
// ID signing, notarization, stapling (simulated by the Validation tool runner and listed in the report),
// a real update host, a clean Mac, and U8 (older backup restore). A PASS here is row-level evidence, not
// G-UPDATE PASS (O2 stays BLOCKED).
//
//   with-native-lock.sh <name> node validation/pre-release/update-acceptance-packaged.cjs \
//     --app <repo>/.native-product-<id>/Code Intelligence Validation.app --fixture <fixture directory>
//
// The candidate's package.json must carry the fixture's feed. The "next" build (N+1) is the same bundle
// with runtime-manifest buildSequence+1, re-signed ad-hoc; it is served as a zip artifact and launched
// from a sibling `.native-update-*` directory under the repository root. Owned processes only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { ensureOutputParent } = require('./owned-output.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { observeStartup, closeOwnedApplication } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { captureOwnedApplication } = require('../backup-compatibility/interruption-hooks.cjs');
const manifests = require('../../desktop/src/update-manifest.cjs');
const { validationUpdateFeed } = require('../../desktop/src/update-validation-feed.cjs');
const { checkpointIdFor } = require('../../desktop/src/update-checkpoint.cjs');
const { TARGET_FLYWAY } = require('../../desktop/src/update-startup.cjs');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha256(fs.readFileSync(file));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const EXECUTABLE = 'Code Intelligence Validation';
const APP_NAME = `${EXECUTABLE}.app`;

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function listRecords(userData) {
  const root = path.join(userData, 'update-checkpoints');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(name => name !== 'schema.json').sort()
    .map(id => ({ id, ...readJson(path.join(root, id, 'record.json')) }));
}
function journalRecords(userData) {
  const file = path.join(userData, 'safety', 'ai-journal', 'events.log');
  if (!fs.existsSync(file)) return [];
  const bytes = fs.readFileSync(file), events = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(bytes.length - offset >= 4, 'JOURNAL_TORN_HEADER');
    const length = bytes.readUInt32BE(offset);
    assert.ok(length > 0 && length <= bytes.length - offset - 4, 'JOURNAL_TORN_FRAME');
    const record = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString('utf8'));
    assert.equal(record.major, 1); assert.equal(record.sequence, events.length + 1);
    events.push(record.event); offset += 4 + length;
  }
  return events;
}
function journalEvents(userData, type) {
  return journalRecords(userData).filter(event => event.type === type).length;
}

// Fixture HTTPS server: routes are set per scenario; every request is logged for the report.
async function startFeedServer(fixture, feed) {
  const routes = new Map(), requests = [];
  const server = https.createServer({ key: fs.readFileSync(path.join(fixture, 'private/server-key.pem')),
    cert: fs.readFileSync(path.join(fixture, 'private/server-cert.pem')), minVersion: 'TLSv1.2' }, (request, response) => {
    requests.push({ at: Date.now(), url: request.url, host: request.headers.host });
    if (request.headers.host !== feed.host) { response.writeHead(421).end(); request.resume(); return; }
    const route = routes.get(request.url);
    if (!route) { response.writeHead(404); return response.end(); }
    if (typeof route === 'function') return route(request, response);
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(route.length) });
    response.end(route);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(feed.port, '127.0.0.1', resolve); });
  return { routes, requests, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

// Prepare the "next" bundle: same app, buildSequence+1 in runtime-manifest.json, ad-hoc re-signed, zipped.
function prepareNextBuild({ repo, app, work, report }) {
  const retained = fs.mkdtempSync(path.join(repo, '.native-update-')); report.nextBundleRoot = retained;
  const next = path.join(retained, APP_NAME);
  execFileSync('/usr/bin/ditto', [app, next], { stdio: 'pipe', timeout: 600000 });
  const manifestFile = path.join(next, 'Contents/Resources/runtime/runtime-manifest.json');
  const manifest = readJson(manifestFile);
  manifest.buildSequence = (BigInt(manifest.buildSequence) + 1n).toString();
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  // Ad-hoc identity, as the Validation candidate itself; no Developer ID is involved.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', next], { stdio: 'pipe', timeout: 600000 });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', next], { stdio: 'pipe', timeout: 120000 });
  const zip = path.join(work, 'next.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', next, zip], { stdio: 'pipe', timeout: 600000 });
  return { app: next, buildSequence: manifest.buildSequence, zip, manifestSha256: hashFile(manifestFile),
    asarSha256: hashFile(path.join(next, 'Contents/Resources/app.asar')) };
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert(argv.length === 4 && argv[0] === '--app' && argv[2] === '--fixture', 'USAGE: --app <candidate> --fixture <fixture directory>');
  process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(argv[1]), fixture = fs.realpathSync(argv[3]);
  assert.equal(path.dirname(path.dirname(app)), repo); assert.match(path.basename(path.dirname(app)), /^\.native-product-[A-Za-z0-9]+$/);
  const feedFile = readJson(path.join(fixture, 'feed.json'));
  const feed = validationUpdateFeed({ name: 'code-intelligence-validation', validationUpdateFeed: feedFile });
  const signingKey = crypto.createPrivateKey(fs.readFileSync(path.join(fixture, 'private/manifest-signing-key.pem')));
  const attackerKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const manifestFile = path.join(app, 'Contents/Resources/runtime/runtime-manifest.json'), manifest = readJson(manifestFile);
  await validateRuntimeManifest(path.dirname(manifestFile), manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], { timeout: 30000, stdio: 'pipe' });
  // The packaged package.json must carry exactly this fixture's feed (asar listing through the asar module).
  const asarModule = createRequire(path.join(repo, 'desktop/package.json'))('@electron/asar');
  const packaged = JSON.parse(asarModule.extractFile(path.join(app, 'Contents/Resources/app.asar'), 'package.json').toString('utf8'));
  assert.deepEqual(packaged.validationUpdateFeed, feedFile, 'CANDIDATE_FEED_MISMATCH');
  assert.equal(packaged.name, 'code-intelligence-validation');

  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/update-acceptance'), 'packaged-'));
  const work = fs.realpathSync(fs.mkdtempSync('/private/tmp/ciu-'));
  const report = { format: 1, status: 'RUNNING', scope: 'G-UPDATE packaged install → update → rollback acceptance on a Validation candidate with a loopback fixture feed (C14 U1–U10 rows)',
    appBundle: app, buildSequence: manifest.buildSequence, manifestSha256: hashFile(manifestFile), appAsarSha256: hashFile(path.join(app, 'Contents/Resources/app.asar')),
    driverSha256: hashFile(__filename), revision: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    fixture: readJson(path.join(fixture, 'fixture.json')), feed: { host: feed.host, port: feed.port, keyId: feed.keyId, teamId: feed.teamId },
    mockKeychain: true, realAccount: false, signedArtifacts: false, notarization: 'SIMULATED_BY_VALIDATION_RUNNER', realUpdateHost: false,
    rows: [], launches: [], dialogs: [], work };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence }));
  const row = (id, title, status, detail) => { report.rows.push({ id, title, status, ...detail }); save(); console.log(JSON.stringify({ row: id, status })); };

  const { _electron: electron } = createRequire(path.join(repo, 'frontend/package.json'))('playwright');
  const desktopPackage = readJson(path.join(repo, 'desktop/package.json'));
  const support = path.join(os.homedir(), 'Library', 'Application Support');
  const forbiddenRoots = [path.join(support, desktopPackage.name), path.join(support, desktopPackage.build.productName)];
  const isolated = require('../../desktop/src/isolated-run.cjs');
  const runs = path.join(work, 'runs'); fs.mkdirSync(runs, { mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'C', LC_ALL: 'C' };
  const server = await startFeedServer(fixture, feed);
  let plan = null, userData = null, active = null;

  // One profile across launches: each launch gets its own isolated-run root, and the previous run's
  // userData directory (database, vault, journal, checkpoints) is moved into it (same device, same inodes).
  function planFor(bundle) {
    const next = isolated.prepareIsolatedRun({ parentDirectory: runs, runtimeDirectory: path.join(bundle, 'Contents/Resources/runtime'),
      purpose: 'automation', forbiddenRoots });
    if (userData) { fs.rmdirSync(next.paths.userData); fs.renameSync(userData, next.paths.userData); }
    plan = next; userData = next.paths.userData; return next;
  }
  const dialogLog = () => path.join(plan.paths.output, 'update-acceptance-dialogs.jsonl');
  const readDialogs = () => fs.existsSync(dialogLog()) ? fs.readFileSync(dialogLog(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

  async function launch(bundle, { script = [], expectWindow = true, label }) {
    const current = planFor(bundle);
    const entry = { label, bundle, claim: current.claimFile, userData, startedAt: new Date().toISOString() }; report.launches.push(entry); save();
    const electronApp = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS', EXECUTABLE),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + current.claimFile], cwd: repo, env, timeout: 120000 });
    const child = electronApp.process(); const stop = observeStartup(child, entry, save);
    active = { owner: captureOwnedApplication(electronApp), stop, entry };
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    // Script native dialogs before startup reaches them; every dialog and reveal is logged to the owned output dir.
    await electronApp.evaluate(({ dialog, shell }, { script, log }) => {
      const fsMain = process.getBuiltinModule('node:fs');
      const record = value => fsMain.appendFileSync(log, JSON.stringify({ at: Date.now(), ...value }) + '\n', { mode: 0o600 });
      dialog.showMessageBox = async (...args) => {
        const options = args.length > 1 ? args[1] : args[0];
        const answer = script.find(item => item.title === options.title);
        record({ kind: 'messageBox', title: options.title, message: options.message, detail: options.detail, buttons: options.buttons,
          response: answer ? answer.response : null });
        if (!answer) throw new Error('UNSCRIPTED_DIALOG');
        return { response: answer.response, checkboxChecked: false };
      };
      dialog.showErrorBox = (title, content) => { record({ kind: 'errorBox', title, content }); };
      shell.showItemInFolder = file => { record({ kind: 'reveal', file }); };
      return true;
    }, { script, log: dialogLog() });
    let page = null;
    if (expectWindow) {
      page = await electronApp.firstWindow({ timeout: 120000 }); page.setDefaultTimeout(30000);
      assert.equal(await electronApp.evaluate(({ app }) => app.getPath('userData')), userData);
      for (const end = Date.now() + 180000; ;) {
        const status = await page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()).catch(() => null);
        if (status?.ready) break;
        assert.ok(Date.now() < end, 'RUNTIME_NOT_READY'); await sleep(1000);
      }
    }
    const waitExit = async (timeoutMs = 120000) => {
      const result = await bounded(() => exited, timeoutMs, 'APP_EXIT_TIMEOUT');
      stop(); active = null; entry.exit = result; entry.finishedAt = new Date().toISOString(); save(); return result;
    };
    const quit = async () => { await electronApp.evaluate(({ app }) => app.quit()); const result = await waitExit(); assert.equal(result.code, 0, 'UNCLEAN_EXIT'); return result; };
    const clickCheck = async () => assert.equal(await electronApp.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('check-for-updates'); if (!item) return false; item.click(); return true;
    }), true, 'UPDATE_MENU_MISSING');
    const waitDialog = async (title, timeoutMs = 120000) => {
      for (const end = Date.now() + timeoutMs; ;) {
        const found = readDialogs().filter(item => item.title === title);
        if (found.length) return found.at(-1);
        assert.ok(Date.now() < end, 'DIALOG_TIMEOUT ' + title); await sleep(500);
      }
    };
    return { electronApp, child, page, waitExit, quit, clickCheck, waitDialog, entry };
  }

  const bodyBase = (changes = {}) => {
    const now = Date.now();
    return { format: 1, kind: 'update', product: 'code-intelligence', bundleId: 'dev.codeintelligence.desktop.validation', teamId: feed.teamId,
      channel: 'stable', serial: 1, issuedAt: now - 60000, expiresAt: now + 86400000, version: '0.1.1', buildSequence: manifest.buildSequence,
      platform: 'darwin', arch: 'arm64', minimumSystemVersion: '13.0', compatibleFromBuild: '1',
      schema: { flyway: TARGET_FLYWAY, safetyJournalMajor: 1, backupFormat: 3 }, artifact: { kind: 'zip', url: `https://${feed.host}/stable/next.zip`, size: 1, sha256: '0'.repeat(64) },
      recovery: null, ...changes };
  };
  const serve = (body, privateKey = signingKey, artifact = null) => {
    server.routes.clear();
    server.routes.set(feed.manifestPath, Buffer.from(JSON.stringify(manifests.signManifest(body, { keyId: feed.keyId, privateKey }))));
    if (artifact) server.routes.set(new URL(body.artifact.url).pathname, artifact);
  };
  const requestsSince = mark => server.requests.slice(mark).map(item => item.url);
  const noVerified = { title: 'No verified update', response: 0 };
  const acceptUpdate = [{ title: 'Update available', response: 0 }, { title: 'Ready to install', response: 0 }];

  try {
    const next = prepareNextBuild({ repo, app, work, report }); report.next = { buildSequence: next.buildSequence, manifestSha256: next.manifestSha256, asarSha256: next.asarSha256, zipSha256: hashFile(next.zip), zipBytes: fs.statSync(next.zip).size }; save();
    const nextZip = fs.readFileSync(next.zip);
    const currentZip = path.join(work, 'current.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, currentZip], { stdio: 'pipe', timeout: 600000 });
    const currentZipBytes = fs.readFileSync(currentZip);
    const nextBody = (changes = {}) => bodyBase({ serial: 10, version: '0.1.1', buildSequence: next.buildSequence,
      artifact: { kind: 'zip', url: `https://${feed.host}/stable/next.zip`, size: nextZip.length, sha256: sha256(nextZip) }, ...changes });

    // ---- Phase A: build N on a fresh profile; refusals, then the verified update hand-off (U1–U4, U6a, U10a).
    let session = await launch(app, { script: [noVerified, ...acceptUpdate], label: 'A: build N fresh profile' });
    const schema0 = readJson(path.join(userData, 'update-checkpoints', 'schema.json'));
    assert.equal(schema0.build, manifest.buildSequence); assert.equal(schema0.flyway, TARGET_FLYWAY);
    assert.equal(journalEvents(userData, 'BUILD_STARTED'), 1);
    row('U0', 'Healthy first start records the schema and raises the started-build floor', 'PASS', { schema: schema0, buildStarted: 1,
      updateMenu: await session.electronApp.evaluate(({ Menu }) => Boolean(Menu.getApplicationMenu()?.getMenuItemById('check-for-updates'))) });
    const bundleN = schema0.bundle;

    const refusal = async (id, title, body, privateKey, artifact, expectedCode, expectedRequests) => {
      const mark = server.requests.length; const before = readDialogs().length;
      serve(body, privateKey, artifact);
      await session.clickCheck();
      for (const end = Date.now() + 120000; ;) { if (readDialogs().length > before && readDialogs().at(-1).title === 'No verified update') break; assert.ok(Date.now() < end, 'DIALOG_TIMEOUT'); await sleep(500); }
      const dialog = readDialogs().at(-1); const reason = /Reason: ([A-Z_]+)/.exec(dialog.detail || '')?.[1];
      const requests = requestsSince(mark);
      const updatesDir = path.join(userData, 'updates');
      const downloaded = fs.existsSync(updatesDir) ? fs.readdirSync(updatesDir).flatMap(serial => fs.readdirSync(path.join(updatesDir, serial)).map(name => serial + '/' + name)) : [];
      const ok = reason === expectedCode && JSON.stringify(requests) === JSON.stringify(expectedRequests);
      row(id, title, ok ? 'PASS' : 'FAIL', { reason, expectedCode, requests, expectedRequests, downloadedFiles: downloaded, journalAccepted: journalEvents(userData, 'MANIFEST_ACCEPTED') });
      return ok;
    };
    await refusal('U2a', 'Manifest signed by an unknown key is refused without a download', nextBody(), attackerKey, nextZip, 'UPDATE_SIGNATURE_INVALID', [feed.manifestPath]);
    const tamperedBody = nextBody(); const tamperedEnvelope = manifests.signManifest(tamperedBody, { keyId: feed.keyId, privateKey: signingKey });
    tamperedEnvelope.body.version = '9.9.9';
    server.routes.clear(); server.routes.set(feed.manifestPath, Buffer.from(JSON.stringify(tamperedEnvelope)));
    {
      const mark = server.requests.length, before = readDialogs().length; await session.clickCheck();
      for (const end = Date.now() + 120000; ;) { if (readDialogs().length > before) break; assert.ok(Date.now() < end); await sleep(500); }
      const reason = /Reason: ([A-Z_]+)/.exec(readDialogs().at(-1).detail || '')?.[1];
      row('U2b', 'Manifest with one changed body field is refused (signature covers the canonical body)', reason === 'UPDATE_SIGNATURE_INVALID' ? 'PASS' : 'FAIL', { reason, requests: requestsSince(mark) });
    }
    await refusal('U4', 'Manifest for another arch is refused', nextBody({ arch: 'x86_64' }), signingKey, nextZip, 'UPDATE_ARCH_MISMATCH', [feed.manifestPath]);
    await refusal('U4b', 'Manifest for another platform is refused', nextBody({ platform: 'win32' }), signingKey, nextZip, 'UPDATE_PLATFORM_MISMATCH', [feed.manifestPath]);
    await refusal('U6a', 'Manifest for an older build (kind update) is refused', nextBody({ buildSequence: (BigInt(manifest.buildSequence) - 1n).toString(), artifact: { kind: 'zip', url: `https://${feed.host}/stable/current.zip`, size: currentZipBytes.length, sha256: sha256(currentZipBytes) } }), signingKey, currentZipBytes, 'UPDATE_DOWNGRADE', [feed.manifestPath]);
    await refusal('U10a', 'Manifest naming another Team ID is refused before any download', nextBody({ teamId: 'OTHERTEAM0' }), signingKey, nextZip, 'UPDATE_IDENTITY_MISMATCH', [feed.manifestPath]);
    const corrupted = Buffer.from(nextZip); corrupted[Math.floor(corrupted.length / 2)] ^= 0x01;
    await refusal('U3', 'Artifact with one changed byte is refused after download; nothing kept', nextBody(), signingKey, corrupted, 'UPDATE_ARTIFACT_HASH', [feed.manifestPath, '/stable/next.zip']);
    // U1: verified update, user-confirmed hand-off: reveal + quit, serial recorded in area B.
    {
      const mark = server.requests.length; serve(nextBody(), signingKey, nextZip);
      await session.clickCheck();
      const exit = await session.waitExit(600000);
      const dialogs = readDialogs().slice(-3); const revealed = dialogs.find(item => item.kind === 'reveal');
      const artifactFile = revealed?.file;
      const stored = artifactFile && fs.existsSync(artifactFile) ? sha256(fs.readFileSync(artifactFile)) : null;
      const accepted = journalRecords(userData).some(event => event.type === 'MANIFEST_ACCEPTED' && event.serial === 10) && journalEvents(userData, 'MANIFEST_ACCEPTED') === 1;
      const ok = exit.code === 0 && stored === sha256(nextZip) && accepted && artifactFile.startsWith(path.join(userData, 'updates', '10') + path.sep);
      row('U1', 'Verified update: downloaded, hash/identity verified, user-confirmed hand-off reveals the artifact, serial recorded, app quits', ok ? 'PASS' : 'FAIL',
        { exit, requests: requestsSince(mark), revealed: artifactFile, storedSha256: stored, expectedSha256: sha256(nextZip), manifestAccepted: accepted,
          dialogs: dialogs.map(item => ({ kind: item.kind, title: item.title, response: item.response })), simulatedIdentity: 'teamIdentifier, spctl, stapler (Validation runner)' });
    }

    // ---- Phase A2: build N again on the same profile: replay of the consumed serial is refused.
    session = await launch(app, { script: [noVerified], label: 'A2: build N replay' });
    await refusal('U5', 'Replaying the accepted manifest serial is refused', nextBody(), signingKey, nextZip, 'UPDATE_MANIFEST_REPLAYED', [feed.manifestPath]);
    await session.quit();

    // ---- Phase B: "install" N+1 (the verified artifact's bundle) on the same profile; then N is refused by the floor (U6b).
    session = await launch(next.app, { script: [], label: 'B: build N+1 first start' });
    const schema1 = readJson(path.join(userData, 'update-checkpoints', 'schema.json'));
    const floorRaised = schema1.build === next.buildSequence && journalRecords(userData).filter(event => event.type === 'BUILD_STARTED').at(-1)?.build === next.buildSequence;
    await session.quit();
    row('U1b', 'Build N+1 starts on the data of N, records its schema and raises the floor', floorRaised ? 'PASS' : 'FAIL', { schema: schema1 });
    {
      const older = await launch(app, { script: [], expectWindow: false, label: 'B2: build N after N+1 started' });
      const exit = await older.waitExit(300000);
      const errors = readDialogs().filter(item => item.kind === 'errorBox');
      const startedAgain = journalRecords(userData).filter(event => event.type === 'BUILD_STARTED').at(-1)?.build !== next.buildSequence;
      const ok = exit.code === 0 && errors.length === 1 && !startedAgain;
      row('U6b', 'An older build reinstalled after N+1 started cannot run normally (floor refusal, recovery-only)', ok ? 'PASS' : 'FAIL',
        { exit, errorBoxes: errors.map(item => item.title), startup: older.entry.startup ?? null, floorKeptAt: next.buildSequence });
    }

    // ---- Phase C: a failing upgrade (killed during migration) leaves the checkpoint open; restore returns the database (U9).
    // planFor moves userData at each launch; never retain an absolute profile path across launches.
    const schemaFile = () => path.join(userData, 'update-checkpoints', 'schema.json');
    const livePostgres = () => path.join(userData, 'postgres');
    fs.writeFileSync(schemaFile(), JSON.stringify({ format: 1, build: manifest.buildSequence, flyway: TARGET_FLYWAY - 1, bundle: bundleN }) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(livePostgres(), 'ci-update-acceptance-sentinel'), 'pre-upgrade cluster marker\n', { mode: 0o600 });
    const expectedId = checkpointIdFor(manifest.buildSequence, next.buildSequence);
    {
      const upgrading = await launch(next.app, { script: [], expectWindow: false, label: 'C1: build N+1 migrating, killed' });
      let seen = null;
      for (const end = Date.now() + 180000; Date.now() < end; await sleep(200)) {
        const record = listRecords(userData).find(item => item.id === expectedId);
        if (record && record.state === 'MIGRATING') { seen = record; break; }
      }
      assert.ok(seen, 'CHECKPOINT_NOT_TAKEN');
      upgrading.child.kill('SIGKILL'); const exit = await upgrading.waitExit(60000);
      row('U9a', 'Pre-migration checkpoint is cloned before the backend may migrate; the run was killed while MIGRATING', 'PASS',
        { checkpoint: { id: seen.id, state: seen.state, createdByBuild: seen.createdByBuild, targetBuild: seen.targetBuild, schemaFlyway: seen.schemaFlyway }, exit,
          imageHasSentinel: fs.existsSync(path.join(userData, 'update-checkpoints', expectedId, 'postgres', 'ci-update-acceptance-sentinel')) });
      // Let the killed tree's children (PostgreSQL) go away before the next start inspects postmaster.pid.
      for (const end = Date.now() + 60000; Date.now() < end; await sleep(500)) {
        const pidFile = path.join(livePostgres(), 'postmaster.pid'); if (!fs.existsSync(pidFile)) break;
        const pid = Number(fs.readFileSync(pidFile, 'utf8').split('\n')[0]); try { process.kill(pid, 0); } catch { break; }
      }
    }
    fs.rmSync(path.join(livePostgres(), 'ci-update-acceptance-sentinel'), { force: true });
    fs.writeFileSync(path.join(livePostgres(), 'ci-update-acceptance-failed-marker'), 'post-kill cluster marker\n', { mode: 0o600 });
    {
      const journalBeforeRecovery = fs.readFileSync(path.join(userData, 'safety', 'ai-journal', 'events.log'));
      const recovery = await launch(next.app, { script: [{ title: 'Data upgrade did not complete', response: 0 }, { title: 'Previous data restored', response: 0 }], expectWindow: false, label: 'C2: recovery-only start, restore' });
      const exit = await recovery.waitExit(300000);
      const record = listRecords(userData).find(item => item.id === expectedId);
      const dialogs = readDialogs().filter(item => item.kind === 'messageBox').map(item => ({ title: item.title, buttons: item.buttons, response: item.response }));
      const schemaAfter = readJson(schemaFile());
      const journalAfterRecovery = fs.readFileSync(path.join(userData, 'safety', 'ai-journal', 'events.log'));
      const journalPrefixPreserved = journalAfterRecovery.subarray(0, journalBeforeRecovery.length).equals(journalBeforeRecovery);
      const ok = exit.code === 0 && record?.state === 'RESTORED' && fs.existsSync(path.join(userData, 'postgres', 'ci-update-acceptance-sentinel'))
        && fs.existsSync(path.join(userData, 'update-checkpoints', expectedId, 'failed-postgres', 'ci-update-acceptance-failed-marker'))
        && schemaAfter.build === manifest.buildSequence && schemaAfter.flyway === TARGET_FLYWAY - 1 && journalEvents(userData, 'BUILD_STARTED') === 2 && journalPrefixPreserved;
      row('U9b', 'Next start is recovery-only; restoring returns the checkpoint database, keeps the failed cluster and the newest journal', ok ? 'PASS' : 'FAIL',
        { exit, record: record ? { state: record.state, previousBundleBuild: record.previousBundle?.build } : null, dialogs, schemaAfter, restoredSentinel: fs.existsSync(path.join(userData, 'postgres', 'ci-update-acceptance-sentinel')), buildStartedRecords: journalEvents(userData, 'BUILD_STARTED'), journalPrefixPreserved });
    }
    fs.rmSync(path.join(userData, 'postgres', 'ci-update-acceptance-sentinel'), { force: true });
    // Retry the upgrade: a healthy N+1 start commits a fresh checkpoint of the same transition.
    session = await launch(next.app, { script: acceptUpdate, label: 'C3: build N+1 retried upgrade' });
    const committed = listRecords(userData).find(item => item.id === expectedId);
    row('U9c', 'The retried upgrade commits the checkpoint and the app is healthy again', committed?.state === 'COMMITTED' && readJson(schemaFile()).build === next.buildSequence ? 'PASS' : 'FAIL',
      { record: committed ? { state: committed.state, createdByBuild: committed.createdByBuild } : null, schema: readJson(schemaFile()) });

    // ---- Phase D: signed recovery manifest bound to the retained checkpoint: sanctioned rollback to N (U7).
    {
      const mark = server.requests.length;
      const recoveryBody = bodyBase({ kind: 'recovery', serial: 20, version: '0.1.0', buildSequence: manifest.buildSequence,
        artifact: { kind: 'zip', url: `https://${feed.host}/stable/current.zip`, size: currentZipBytes.length, sha256: sha256(currentZipBytes) },
        recovery: { checkpointId: expectedId, checkpointSchemaFlyway: TARGET_FLYWAY - 1, reason: 'acceptance rollback to the previous build' } });
      serve(recoveryBody, signingKey, currentZipBytes);
      await session.clickCheck();
      const exit = await session.waitExit(600000);
      const dialogs = readDialogs().slice(-4).map(item => ({ kind: item.kind, title: item.title, message: item.message, response: item.response }));
      const record = listRecords(userData).find(item => item.id === expectedId);
      const sanctioned = journalEvents(userData, 'ROLLBACK_SANCTIONED') === 1 && journalRecords(userData).some(event => event.type === 'ROLLBACK_SANCTIONED' && event.serial === 20 && event.targetBuild === manifest.buildSequence && event.checkpointId === expectedId);
      const ok = exit.code === 0 && record?.state === 'RESTORED' && sanctioned && dialogs.some(item => item.kind === 'reveal');
      row('U7', 'Signed recovery manifest bound to the retained checkpoint: data restored, rollback sanctioned once, artifact revealed', ok ? 'PASS' : 'FAIL',
        { exit, requests: requestsSince(mark), record: record ? { state: record.state } : null, rollbackSanctioned: sanctioned, dialogs });
    }
    // Build N may run again: the sanctioned floor admits it and the restored database is at the previous schema.
    session = await launch(app, { script: [], label: 'D2: build N after sanctioned rollback' });
    const schemaBack = readJson(schemaFile());
    // The recovery event already lowers the floor to N; a normal N start must not raise it again.
    const floorEvent = journalRecords(userData).filter(event => ['BUILD_STARTED', 'ROLLBACK_SANCTIONED'].includes(event.type)).at(-1);
    const runtimeBack = await session.page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus());
    const reopened = runtimeBack.ready && !runtimeBack.recoveryOnly && !runtimeBack.error
      && floorEvent?.type === 'ROLLBACK_SANCTIONED' && floorEvent.targetBuild === manifest.buildSequence && floorEvent.serial === 20;
    await session.quit();
    row('U7b', 'After the sanctioned rollback the previous build starts normally at the sanctioned floor', reopened && schemaBack.build === manifest.buildSequence ? 'PASS' : 'FAIL', { schema: schemaBack, reopened, floorEvent });
    // Replaying the consumed recovery serial is refused.
    session = await launch(app, { script: [noVerified], label: 'D3: recovery serial replay' });
    {
      const mark = server.requests.length, before = readDialogs().length;
      await session.clickCheck();
      for (const end = Date.now() + 120000; ;) { if (readDialogs().length > before) break; assert.ok(Date.now() < end); await sleep(500); }
      const reason = /Reason: ([A-Z_]+)/.exec(readDialogs().at(-1).detail || '')?.[1];
      row('U7c', 'The consumed recovery serial cannot be replayed', reason === 'UPDATE_MANIFEST_REPLAYED' ? 'PASS' : 'FAIL', { reason, requests: requestsSince(mark) });
    }
    await session.quit();
    row('U8', 'Restore an older backup on N+1: high-water stays N+1', 'NOT_RUN', { note: 'Needs the backup restore flow on this profile; covered by update-anti-rollback unit tests only.' });
    row('U10b', 'N+1 re-signed with another Team ID or ad-hoc is refused before launch', 'BLOCKED', { note: 'Validation runner simulates the Team ID observation (ad-hoc builds have none); needs Developer ID material (O2).' });

    report.status = report.rows.some(item => item.status === 'FAIL') ? 'FAIL' : 'ROWS_RECORDED_NOT_GATE_PASS';
    if (report.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    report.status = 'FAIL'; report.failure = error.code || error.message; report.failureStack = String(error.stack || '').split('\n').slice(0, 6);
    throw error;
  } finally {
    if (active) {
      try { await closeOwnedApplication(active.owner); active.entry.cleanupConfirmed = true; }
      catch (error) { report.cleanupFailure = error.message; report.status = 'FAIL'; process.exitCode = 1; }
      finally { active.stop(); active = null; }
    }
    await server.close().catch(() => {});
    report.dialogs = plan ? readDialogs().map(item => ({ kind: item.kind, title: item.title, response: item.response })) : [];
    report.candidateUnchanged = hashFile(manifestFile) === report.manifestSha256 && hashFile(path.join(app, 'Contents/Resources/app.asar')) === report.appAsarSha256;
    report.serverRequests = server.requests; report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ status: report.status, evidence, rows: report.rows.map(item => [item.id, item.status]) }));
  }
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
