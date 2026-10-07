'use strict';

// G-COST PK-08 packaged ask through a local fake provider. Runs only on a validation candidate whose
// packaged package.json carries the build-time loopback provider origin (validation-build-only variant;
// release builds keep the fixed https://api.openai.com transport and refuse the variant). Fresh isolated
// profile, mock Keychain, synthetic key, synthetic source with dummy personal data; no paid call, no real
// account. The app imports the source through the UI, the renderer's own API authority saves the key,
// configures and activates a budget, previews and approves one request plan and asks once. The fake
// provider records every request; the run checks that exactly one masked request was sent, that it is
// byte-for-byte the approved prompt, that the ledger settled the exact amount, that a replay is refused
// and that no non-loopback socket was opened. Accepted limit: the release binary's endpoint path is not
// exercised. Wrap every run in with-native-lock.sh.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { ensureOutputParent } = require('./owned-output.cjs');
const { inetSockets } = require('./cost-egress-packaged-probe.cjs');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { validationProviderTarget } = require('../../desktop/src/ai-https-transport.cjs');
const { SUPPORTED_MODEL } = require('../../desktop/src/ai-model-contracts.cjs');
const { launchEnvironment } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { observeStartup, closeValidatedApplication } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { captureOwnedApplication } = require('../backup-compatibility/interruption-hooks.cjs');
const { confirmObservedGone } = require('./run-startup-benchmark.cjs');
const { withDropConfirmation } = require('./drop-confirmation.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = file => sha(fs.readFileSync(file));
const SYNTHETIC_KEY = 'sk-publicSyntheticPackagedAskKey0123456789ab';
const SOURCE = 'src/contact.ts';
// Dummy personal data (D4 fixture list); none of these may reach the fake provider, preview or plan.
const PERSONAL = Object.freeze(['jane.sentinel@example.invalid', '078-05-1120', '010-2345-6789', '+44 20 7946 0958',
  '900101-1234567', '4111 1111 1111 1111']);
const PLACEHOLDERS = Object.freeze(['[EMAIL_1]', '[SSN_1]', '[PHONE_1]', '[PHONE_2]', '[RRN_1]', '[CARD_1]']);
// 100 input (40 cached) + 50 output tokens at the production gpt-4o-mini contract = 42 microUSD.
const SETTLED_MICRO_USD = '42';

function sourceText() {
  return [
    '// Contact card fixture for the packaged AI ask probe.',
    `// owner: Jane Sentinel-Doe, ${PERSONAL[0]}, SSN ${PERSONAL[1]}`,
    `// phone ${PERSONAL[2]} or ${PERSONAL[3]}, RRN ${PERSONAL[4]}, card ${PERSONAL[5]}`,
    'export interface Contact { id: string; version: string }',
    "export const RELEASE = '2.345.678.9012';",
    'export function label(contact: Contact): string {',
    "  return contact.id + '@' + contact.version;",
    '}',
    '',
  ].join('\n');
}

function providerResponse(sequence) {
  return Buffer.from(JSON.stringify({ id: `chatcmpl-packaged-${sequence}`, model: SUPPORTED_MODEL, service_tier: 'default',
    choices: [{ message: { role: 'assistant', content: JSON.stringify({ explanation: 'Synthetic packaged answer',
      claims: [{ text: 'The approved file defines a contact label.', confidence: 'HIGH', evidence: [] }], alternatives: [] }) },
    finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 40 } } }));
}

// Local fake provider on the candidate's build-time loopback origin. It keeps request bodies in memory
// only for the checks; the evidence records digests, lengths and booleans, never the key. A request that is
// not the provider call (a stray local port probe on this shared host) is answered 404 and kept separately.
async function startFakeProvider(target) {
  const requests = []; const strays = []; const connections = { count: 0 };
  const server = http.createServer((incoming, response) => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') {
        strays.push({ method: incoming.method, path: String(incoming.url).slice(0, 64), bytes: body.length,
          authorizationPresent: incoming.headers.authorization !== undefined });
        response.writeHead(404); response.end(); return;
      }
      requests.push({ method: incoming.method, url: incoming.url, authorization: incoming.headers.authorization ?? null,
        contentType: incoming.headers['content-type'] ?? null, remoteAddress: incoming.socket.remoteAddress, body });
      response.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': `packaged-${requests.length}` });
      response.end(providerResponse(requests.length));
    });
  });
  server.on('connection', () => { connections.count++; });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: target.hostname, port: target.port, exclusive: true }, resolve);
  });
  return { requests, strays, connections, port: server.address().port, close: () => new Promise(resolve => server.close(() => resolve())) };
}

function packagedVariant(asar, asarFile) {
  const metadata = JSON.parse(asar.extractFile(asarFile, 'package.json'));
  try { return { metadata, target: validationProviderTarget(metadata) }; }
  catch { return { metadata, target: null, refused: true }; }
}

async function main(argv = process.argv.slice(2)) {
  assert(argv.length === 2 && argv[0] === '--app', 'Use --app <repo>/.native-product-<id>/Code Intelligence Validation.app');
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(argv[1]);
  assert.equal(path.dirname(path.dirname(app)), repo); assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(app)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); await validateRuntimeManifest(runtime, manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 30000 });
  const asarFile = path.join(app, 'Contents/Resources/app.asar');
  const asar = require(path.join(repo, 'desktop/node_modules/@electron/asar'));
  const transportIdentical = sha(asar.extractFile(asarFile, 'src/ai-https-transport.cjs')) === hash(path.join(repo, 'desktop/src/ai-https-transport.cjs'));
  const variant = packagedVariant(asar, asarFile);
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/cost-egress-packaged-ask'), 'ask-'));
  const report = { format: 1, status: 'RUNNING', scope: 'packaged-ask-through-validation-fake-provider', app,
    buildSequence: manifest.buildSequence, appAsarSha256: hash(asarFile), manifestSha256: hash(manifestFile), probeSha256: hash(__filename),
    packagedTransportIdenticalToSource: transportIdentical, providerOrigin: variant.metadata.validationAiProviderOrigin ?? null,
    variantLimit: 'validation-build-only loopback provider origin; the release binary endpoint path (api.openai.com) is not exercised',
    mockKeychain: true, realAccount: false, paidAI: false, checks: [], socketSamples: [] };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (!variant.target || !transportIdentical) {
    // Not a failure of the product: this candidate predates the variant (or carries other transport code).
    report.status = 'BLOCKED';
    report.reason = !transportIdentical ? 'PACKAGED_TRANSPORT_NOT_CURRENT_SOURCE'
      : variant.refused ? 'PACKAGED_PROVIDER_VARIANT_REFUSED' : 'CANDIDATE_WITHOUT_VALIDATION_PROVIDER_VARIANT';
    save(); console.log(JSON.stringify({ status: report.status, reason: report.reason, evidence })); process.exitCode = 2; return report;
  }
  const parent = fs.mkdtempSync('/private/tmp/cicp-');
  const folder = path.join(parent, 'contact-fixture');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, SOURCE), sourceText(), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'contact-fixture', private: true }) + '\n', { flag: 'wx', mode: 0o600 });
  const plan = prepareIsolatedRun({ parentDirectory: parent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(name => path.join(os.homedir(), 'Library/Application Support', name)) });
  report.profile = plan.paths.userData; save(); console.log(JSON.stringify({ status: report.status, evidence }));
  const provider = await startFakeProvider(variant.target);
  const { _electron } = createRequire(path.join(repo, 'frontend/package.json'))('playwright');
  const { expect } = createRequire(path.join(repo, 'frontend/package.json'))('@playwright/test');
  let sdk, owner, stopObserving; const diagnostics = {};
  const check = (name, value) => { report.checks.push({ name, ...value }); save(); };
  try {
    sdk = await _electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: repo, env: launchEnvironment(process.env), timeout: 120000 });
    owner = captureOwnedApplication(sdk);
    stopObserving = observeStartup(owner.process(), diagnostics, () => {});
    const page = await sdk.firstWindow({ timeout: 120000 });
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: 120000 });
    assert.deepEqual(await sdk.evaluate(({ app }) => ({ profile: app.getPath('userData'), packaged: app.isPackaged })),
      { profile: plan.paths.userData, packaged: true });
    const sample = async label => { const value = await inetSockets(owner.process().pid); report.socketSamples.push({ label, ...value }); save(); return value; };
    const runtimeStatus = () => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus());
    check('first-run-status', { aiOff: (await runtimeStatus()).aiOff });
    await sample('ready');
    const api = (route, method = 'GET', body) => page.evaluate(async ({ route, method, body }) => {
      const desktop = window.codeIntelligenceDesktop; const headers = { 'X-Code-Intelligence-Token': desktop.apiToken };
      if (method !== 'GET') {
        await fetch(desktop.apiBaseUrl + '/api/csrf', { credentials: 'include', headers });
        const cookie = document.cookie.split(';').map(p => p.trim()).find(p => p.startsWith('XSRF-TOKEN='));
        if (cookie) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie.slice('XSRF-TOKEN='.length));
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(desktop.apiBaseUrl + route, { method, credentials: 'include', headers,
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: response.status, json, text };
    }, { route, method, body });
    const ok = async (route, method, body) => {
      const response = await api(route, method, body);
      assert(response.status >= 200 && response.status < 300, `API_${method ?? 'GET'}_${route.replace(/[0-9]+/g, 'N')}_${response.status}`);
      return response.json;
    };

    // Import the synthetic source through the unmodified UI (native drag, preview, approve).
    await page.evaluate(() => { history.pushState(null, '', '/import'); dispatchEvent(new PopStateEvent('popstate')); });
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true }); await expect(picker).toBeVisible();
    const box = await picker.boundingBox(); assert.ok(box);
    const { confirmation } = await withDropConfirmation(sdk, folder, async () => {
      const cdp = await page.context().newCDPSession(page);
      try {
        for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', {
          type, x: box.x + box.width / 2, y: box.y + box.height / 2, data: { items: [], files: [folder], dragOperationsMask: 1 } });
      } finally { await cdp.detach().catch(() => {}); }
      await page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click();
    });
    check('drop-confirmation', confirmation);
    await expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible({ timeout: 60000 });
    const [created] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local' && r.request().method() === 'POST', { timeout: 120000 }),
      page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click()]);
    assert(created.ok(), 'IMPORT_CREATE_FAILED');
    const { project: { id: projectId }, jobId } = await created.json();
    let job;
    for (const stop = Date.now() + 180000; Date.now() < stop;) {
      job = await ok(`/api/jobs/${jobId}`);
      if (['DONE', 'FAILED', 'CANCELLED'].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    check('import-analysis', { status: job?.status ?? 'TIMEOUT' });
    assert.equal(job?.status, 'DONE', 'ANALYSIS_NOT_DONE');

    // Key save, budget configure and one-use activation through the product API: zero provider calls.
    const saved = await api('/api/ai/settings', 'PUT', { provider: 'openai', model: SUPPORTED_MODEL, apiKey: SYNTHETIC_KEY });
    check('save-synthetic-key', { status: saved.status, state: saved.json?.state ?? null, keyEchoed: saved.text.includes(SYNTHETIC_KEY) });
    const initial = await ok('/api/ai/budget');
    const configured = await ok('/api/ai/budget', 'PUT', { expectedRevision: initial.policyRevision,
      dailyLimitMicroUsd: '1000000', monthlyLimitMicroUsd: '10000000' });
    const ready = await ok('/api/ai/budget/activate', 'POST', { expectedRevision: configured.policyRevision,
      activationToken: configured.activationToken });
    check('budget-activated', { state: ready.state, providerRequests: provider.requests.length, aiOff: (await runtimeStatus()).aiOff });

    // Preview, approve one plan, ask once.
    const askBody = { question: 'Explain this approved contact file.', intent: 'EXPLAIN', view: 'file', focusedFile: SOURCE,
      selectedAreas: [], excludedContextIds: [] };
    const preview = await ok(`/api/projects/${projectId}/ai/preview`, 'POST', askBody);
    const approved = await ok(`/api/projects/${projectId}/ai/request-plan`, 'POST', askBody);
    const shown = JSON.stringify(preview) + JSON.stringify(approved);
    check('approved-plan', { costStatus: approved.costStatus, reservedMicroUsd: approved.cost?.reservedMicroUsd ?? null,
      previewEqualsPlan: preview.copyablePrompt === approved.userPrompt,
      personalDataShown: PERSONAL.filter(value => shown.includes(value)).length,
      placeholdersShown: PLACEHOLDERS.filter(value => approved.userPrompt.includes(value)),
      providerRequests: provider.requests.length });
    await sample('before-ask');
    const answered = await api(`/api/projects/${projectId}/ai/ask`, 'POST', { ...askBody, requestPlanToken: approved.requestPlanToken });
    await sample('after-ask');
    const replay = await api(`/api/projects/${projectId}/ai/ask`, 'POST', { ...askBody, requestPlanToken: approved.requestPlanToken });
    const [sent] = provider.requests;
    let sentPrompt = null;
    try { sentPrompt = JSON.parse(sent.body.toString('utf8')).messages[1].content; } catch {}
    check('ask', { status: answered.status, explanation: answered.json?.explanation ?? null, replayStatus: replay.status,
      replayCode: replay.json?.code ?? null });
    check('fake-provider', { requests: provider.requests.length, connections: provider.connections.count, strays: provider.strays,
      method: sent?.method ?? null, path: sent?.url ?? null, loopbackPeer: sent ? /^(?:::ffff:)?127\.0\.0\.1$|^::1$/.test(sent.remoteAddress) : null,
      syntheticKeyAuthorization: sent ? sent.authorization === 'Bearer ' + SYNTHETIC_KEY : null,
      bodySha256: sent ? sha(sent.body) : null, bodyBytes: sent?.body.length ?? null,
      sentEqualsApprovedPrompt: sentPrompt === approved.userPrompt,
      personalDataSent: sent ? PERSONAL.filter(value => sent.body.toString('utf8').includes(value)).length : null,
      placeholdersSent: sentPrompt ? PLACEHOLDERS.filter(value => sentPrompt.includes(value)) : [] });
    const after = await ok('/api/ai/budget');
    check('ledger-after', { state: after.state, held: after.allDatesHeldMicroUsd, daily: after.dailySettledMicroUsd,
      monthly: after.monthlySettledMicroUsd });

    const failures = [];
    if (saved.status !== 200 || saved.text.includes(SYNTHETIC_KEY)) failures.push('KEY_SAVE_UNEXPECTED');
    if (ready.state !== 'READY') failures.push('BUDGET_NOT_READY');
    if (preview.copyablePrompt !== approved.userPrompt) failures.push('PREVIEW_NOT_PLAN');
    if (PERSONAL.some(value => shown.includes(value))) failures.push('PERSONAL_DATA_SHOWN');
    if (PLACEHOLDERS.some(value => !approved.userPrompt.includes(value))) failures.push('PLACEHOLDERS_MISSING');
    if (answered.status !== 200) failures.push('ASK_FAILED');
    if (replay.status !== 409) failures.push('REPLAY_NOT_REFUSED');
    if (provider.requests.length !== 1) failures.push('PROVIDER_REQUEST_COUNT');
    if (provider.strays.some(stray => stray.authorizationPresent)) failures.push('CREDENTIAL_OUTSIDE_PROVIDER_CALL');
    if (sent && (sent.method !== 'POST' || sent.url !== '/v1/chat/completions' || sent.authorization !== 'Bearer ' + SYNTHETIC_KEY))
      failures.push('PROVIDER_REQUEST_SHAPE');
    if (sentPrompt !== approved.userPrompt) failures.push('SENT_NOT_APPROVED');
    if (sent && PERSONAL.some(value => sent.body.toString('utf8').includes(value))) failures.push('PERSONAL_DATA_SENT');
    if (after.dailySettledMicroUsd !== SETTLED_MICRO_USD || after.monthlySettledMicroUsd !== SETTLED_MICRO_USD
        || after.allDatesHeldMicroUsd !== '0') failures.push('LEDGER_NOT_SETTLED_EXACTLY');
    if (report.socketSamples.some(s => s.remote.length)) failures.push('NON_LOOPBACK_SOCKET');
    report.failures = failures; report.status = failures.length ? 'FAIL' : 'PASS';
  } catch (error) { report.status = 'FAIL'; report.failure = String(error?.message ?? 'PROBE_FAILED').slice(0, 120); }
  finally {
    if (owner) {
      try { await closeValidatedApplication(owner, diagnostics); await confirmObservedGone([owner.process().pid]); report.cleanupConfirmed = true; }
      catch { report.cleanupConfirmed = false; report.status = 'FAIL'; }
      report.exit = { code: owner.process().exitCode, signal: owner.process().signalCode, shutdown: diagnostics.shutdown ?? null };
    }
    stopObserving?.();
    report.providerRequestsAtClose = provider.requests.length;
    await provider.close();
    // The synthetic profile and source are not evidence; remove this run's parent only after the app is gone.
    if (report.cleanupConfirmed) { fs.rmSync(parent, { recursive: true, force: true }); report.profileRemoved = true; }
    try { assert.equal(hash(asarFile), report.appAsarSha256); assert.equal(hash(manifestFile), report.manifestSha256); report.bundleUnchanged = true; }
    catch { report.bundleUnchanged = false; report.status = 'FAIL'; }
    save();
  }
  console.log(JSON.stringify({ status: report.status, evidence, failures: report.failures ?? null }));
  if (report.status !== 'PASS') process.exitCode = 1;
  return report;
}
if (require.main === module) main().catch(error => { console.error(error?.message ?? 'PROBE_FAILED'); process.exitCode = 1; });
module.exports = { PERSONAL, PLACEHOLDERS, SETTLED_MICRO_USD, packagedVariant, providerResponse, sourceText, startFakeProvider };
