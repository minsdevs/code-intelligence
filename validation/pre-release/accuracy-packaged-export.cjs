'use strict';

// G-ACCURACY packaged-app observation run. Launches the retained candidate bundle through the
// same isolated-run/mock-Keychain boundary as run-product-candidate.cjs, imports a byte-verified
// copy of one T00 fixture roster through the unmodified UI (native drag, preview, approve), reads
// the persisted analysis back through the product API only, converts it with the shared
// accuracy-observations.cjs adapter, binds it to the manifest/app.asar digests in an execution
// attestation, compares it with a backend-harness dump of the same fixture, and evaluates the
// bundle with validation/t00/runner.cjs. No gold file is read; no real profile, Keychain, GitHub
// account or AI provider is used. Wrap every run in with-native-lock.sh.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { ensureOutputParent, assertOutputPath } = require('./owned-output.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { validateLocalEnvironment, requireExecutionContext, productPaths, claimExecution } = require('../../desktop/scripts/native-acceptance-context.cjs');
const { closeValidatedApplication, createDeadline, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { treeDigest, readFixture, convertFixture, writeBundle, compareDumps, apiProjection, sha256 } = require('./accuracy-observations.cjs');
const { evaluate } = require('./accuracy-export.cjs');
const { expectedServices } = require('./adapter-mode.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const PRODUCT_PATHS = ['backend/src/main', 'backend/build.gradle.kts', 'analyzers/ts-analyzer/src', 'analyzers/ts-analyzer/package.json',
  'analyzers/ts-analyzer/package-lock.json', 'analyzers/tree-analyzer/src', 'desktop/src', 'desktop/package.json', 'frontend/src'];

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    assert(['--app', '--corpus', '--capabilities', '--backend-dumps', '--candidate-revision', '--label'].includes(flag)
      && typeof value === 'string' && !Object.hasOwn(options, flag.slice(2)), 'ACCURACY_PACKAGED_ARGUMENTS');
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  assert(options.app && options.corpus && options.capabilities && options.backendDumps && options.candidateRevision, 'ACCURACY_PACKAGED_ARGUMENTS');
  assert(/^[a-f0-9]{40}$/.test(options.candidateRevision), 'ACCURACY_PACKAGED_ARGUMENTS');
  assert(options.label == null || /^[a-z0-9][a-z0-9-]{0,31}$/.test(options.label), 'ACCURACY_PACKAGED_ARGUMENTS');
  return options;
}

// Product source paths that differ between the candidate's declared build revision and HEAD.
function candidateDrift(repo, revision) {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30000 }).trim();
  execFileSync('git', ['merge-base', '--is-ancestor', revision, 'HEAD'], { cwd: repo, timeout: 30000, stdio: 'ignore' });
  return { head: git(['rev-parse', 'HEAD']),
    changedProductPaths: git(['diff', '--name-only', revision, 'HEAD', '--', ...PRODUCT_PATHS]).split('\n').filter(Boolean) };
}

function copyRoster(fixture, destination) {
  const consumed = [];
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const [relative, source] of fixture.sources) {
    const target = path.join(destination, relative);
    assert(target.startsWith(destination + path.sep), 'ROSTER_PATH_INVALID');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, source.bytes, { flag: 'wx', mode: 0o600 });
    const written = fs.readFileSync(target);
    assert(written.length === source.meta.bytes && sha256(written) === source.meta.sha256, 'ROSTER_COPY_MISMATCH');
    consumed.push({ path: relative, sha256: sha256(written), bytes: written.length });
  }
  return consumed;
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const options = argumentsFor(argv);
  validateLocalEnvironment(process.env, process.execArgv); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(options.app);
  assert.equal(path.dirname(path.dirname(app)), repo); assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(app)), /^\.native-product-[A-Za-z0-9]+$/);
  const manifestFile = path.join(app, 'Contents/Resources/runtime/runtime-manifest.json'), asarFile = path.join(app, 'Contents/Resources/app.asar');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  await validateRuntimeManifest(path.dirname(manifestFile), manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], { timeout: 30000, stdio: 'pipe' });
  const corpus = fs.realpathSync(path.resolve(options.corpus)), capabilities = fs.realpathSync(path.resolve(options.capabilities));
  const corpusJson = JSON.parse(fs.readFileSync(corpus, 'utf8'));
  assert.equal(corpusJson.fixtures.length, 1, 'ONE_FIXTURE_CORPUS_REQUIRED');
  const fixture = readFixture(corpus, corpusJson.fixtures[0]), fixtureId = fixture.manifest.fixtureId;
  const backendDumpFile = path.join(fs.realpathSync(path.resolve(options.backendDumps)), fixtureId + '.dump.json');
  const backendDump = JSON.parse(fs.readFileSync(backendDumpFile, 'utf8'));
  assert.equal(backendDump.path, 'BACKEND_PIPELINE_HARNESS');

  const evidenceParent = ensureOutputParent(repo, 'validation/local/accuracy-export');
  const evidence = fs.mkdtempSync(path.join(evidenceParent, (options.label ?? 'packaged') + '-'));
  const root = fs.mkdtempSync('/private/tmp/cnpa-'), temp = path.join(root, 'work'), owned = path.join(temp, 'owned');
  for (const directory of [temp, owned]) fs.mkdirSync(directory, { mode: 0o700 });
  const short = fs.mkdtempSync('/private/tmp/cnpr-'), control = path.join(root, 'context.json');
  const artifacts = path.join(temp, 'artifacts'); fs.mkdirSync(artifacts, { mode: 0o700 });
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(repo, 'desktop/package.json'), 'utf8'));
  fs.writeFileSync(control, JSON.stringify({ format: 1, kind: 'isolated-macos-host', provider: 'local-macos',
    uid: process.getuid(), revision: options.candidateRevision, buildSequence: manifest.buildSequence, sourceRoot: repo, tempRoot: temp,
    isolatedRunParent: short, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }), { flag: 'wx', mode: 0o600 });
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'C', LC_ALL: 'C',
    NATIVE_ACCEPTANCE_CONTEXT: control, CODE_INTELLIGENCE_BUILD_SEQUENCE: manifest.buildSequence };
  const context = requireExecutionContext(env);
  const folder = path.join(owned, fixtureId);
  const report = { format: 1, status: 'RUNNING', path: 'PACKAGED_APP_API', fixtureId, appBundle: path.relative(repo, app),
    manifestSha256: hash(manifestFile), appAsarSha256: hash(asarFile), buildSequence: manifest.buildSequence,
    candidate: { revision: options.candidateRevision, ...candidateDrift(repo, options.candidateRevision) },
    nonce: crypto.randomBytes(16).toString('hex'), startedAt: new Date().toISOString(),
    driverSha256: hash(__filename), converterSha256: hash(path.join(__dirname, 'accuracy-observations.cjs')),
    productRunnerSha256: hash(path.join(repo, 'desktop/scripts/native-acceptance-electron.cjs')),
    corpusSha256: hash(corpus), capabilityManifestSha256: hash(capabilities), backendDumpSha256: hash(backendDumpFile),
    mockKeychain: true, realAccount: false, realKeychain: false, paidAI: false, checks: [] };
  const resultFile = path.join(evidence, 'result.json');
  const save = () => fs.writeFileSync(assertOutputPath(evidence, resultFile), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = name => { report.phase = name; save(); };
  save(); console.log(JSON.stringify({ status: report.status, evidence }));
  let application, child, stopObserving, failure;
  try {
    const consumedSources = copyRoster(fixture, folder);
    productPaths(context, { source: folder, owned, artifacts });
    claimExecution(context, 'product');
    const frontendRequire = createRequire(path.join(repo, 'frontend/package.json'));
    const { _electron: electron } = frontendRequire('playwright');
    const { expect } = frontendRequire('@playwright/test');
    const runtimeDirectory = path.join(app, 'Contents/Resources/runtime');
    const support = path.join(os.homedir(), 'Library', 'Application Support');
    const plan = require(path.join(repo, 'desktop/src/isolated-run.cjs')).prepareIsolatedRun({ parentDirectory: short, runtimeDirectory,
      purpose: 'automation', forbiddenRoots: [path.join(support, desktopPackage.name), path.join(support, desktopPackage.build.productName)] });
    report.validationIdentity = plan.appIdentity;
    const deadline = createDeadline();
    const perform = (action, timeoutMs = 30000, code) => deadline.run(action, timeoutMs, code);
    phase('electron-launch');
    application = await electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: path.join(repo, 'desktop'), env, timeout: deadline.limit(90000) });
    child = application.process();
    stopObserving = observeStartup(child, report, save);
    phase('electron-first-window');
    const page = await application.firstWindow({ timeout: deadline.limit(90000) });
    page.setDefaultTimeout(30000);
    let pageErrors = 0; page.on('pageerror', () => pageErrors++);
    const userData = await perform(() => application.evaluate(({ app }) => app.getPath('userData')));
    assert.equal(userData, plan.paths.userData, 'Isolated validation profile required');
    report.packagedLaunch = await perform(() => application.evaluate(({ app }) => app.isPackaged));
    assert.equal(report.packagedLaunch, true);
    report.electronVersion = await perform(() => application.evaluate(() => process.versions.electron));
    phase('native-home-visible');
    await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: deadline.limit(30000) }));
    report.appVersion = await perform(() => page.evaluate(() => window.codeIntelligenceDesktop.appVersion));
    const status = await perform(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()));
    assert.equal(status.ready, true); assert.equal(status.recoveryOnly, false); assert.equal(status.error, null);
    assert.equal(status.aiOff, true, 'Provider egress must remain disabled');
    assert.deepEqual([...status.services].sort(), expectedServices(app));
    report.checks.push('packaged-services-ready-ai-off');
    // Batched GETs through the renderer's own API authority (token header; no CSRF needed for GET).
    const get = routes => perform(() => page.evaluate(async routes => {
      const desktop = window.codeIntelligenceDesktop, headers = { 'X-Code-Intelligence-Token': desktop.apiToken }, results = [];
      for (const route of routes) {
        const response = await fetch(desktop.apiBaseUrl + route, { credentials: 'include', headers });
        const text = await response.text();
        results.push({ status: response.status, body: response.ok && text ? JSON.parse(text) : null });
      }
      return results;
    }, routes), 120000, 'NATIVE_API_TIMEOUT').then(results => results.map((result, index) => {
      if (result.status < 200 || result.status >= 300) {
        report.apiFailure = { status: result.status, route: routes[index].replace(/[0-9]+/g, 'N').replace(/\?.*$/, '') }; save();
      }
      assert(result.status >= 200 && result.status < 300, 'PRODUCT_API_REQUEST_FAILED'); return result.body;
    }));
    assert.deepEqual((await get(['/api/projects']))[0], []);

    phase('fixture-import');
    await perform(() => page.evaluate(route => { history.pushState(null, '', route); window.dispatchEvent(new PopStateEvent('popstate')); }, '/import'));
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true });
    await perform(() => expect(picker).toBeVisible());
    const bounds = await perform(() => picker.boundingBox()); assert(bounds);
    const cdp = await perform(() => page.context().newCDPSession(page));
    try {
      const data = { items: [], files: [folder], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await perform(() => cdp.send('Input.dispatchDragEvent', {
        type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, data }));
    } finally { await perform(() => cdp.detach()).catch(() => {}); }
    const [previewResponse] = await perform(() => Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local/preview' && response.request().method() === 'POST', { timeout: deadline.limit() }),
      page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click()]));
    assert(previewResponse.ok(), 'IMPORT_PREVIEW_FAILED');
    report.localImport = (await perform(() => previewResponse.json())).localImport ?? null;
    await perform(() => expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible());
    const [created] = await perform(() => Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local' && response.request().method() === 'POST', { timeout: deadline.limit() }),
      page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click()]));
    assert(created.ok(), 'IMPORT_CREATE_FAILED');
    const createdBody = await perform(() => created.json());
    const projectId = createdBody.project.id, jobId = createdBody.jobId;
    assert(Number.isSafeInteger(projectId) && Number.isSafeInteger(jobId));
    report.checks.push('packaged-ui-native-drag-preview-approve-import');

    phase('analysis-job');
    let job;
    for (const stop = Date.now() + 300000; Date.now() < stop;) {
      [job] = await get([`/api/jobs/${jobId}`]);
      if (['DONE', 'FAILED', 'CANCELLED'].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const code = value => typeof value === 'string' && /^[A-Z_]{1,80}$/.test(value) ? value : null;
    report.job = { status: job?.status ?? 'TIMEOUT', failureCode: code(job?.failureCode),
      steps: Array.isArray(job?.steps) ? job.steps.slice(0, 50).map(step => ({ key: code(step.stepKey), status: code(step.status) })) : [] };
    assert(['DONE', 'FAILED'].includes(report.job.status), 'ANALYSIS_JOB_UNFINISHED');
    const [project] = await get([`/api/projects/${projectId}`]);
    const snapshotId = project.currentSnapshot?.id;
    assert(report.job.status === 'DONE' && Number.isSafeInteger(snapshotId), 'PACKAGED_ANALYSIS_NOT_PUBLISHED');
    report.snapshotId = snapshotId;

    phase('api-readback');
    const base = `/api/projects/${projectId}`, at = `snapshotId=${snapshotId}`;
    const [files, endpoints, entities] = await get([`${base}/files?${at}`, `${base}/endpoints?${at}`, `${base}/entities?${at}`]);
    const summaries = [];
    for (let page = 1; ; page++) {
      const [result] = await get([`${base}/graph/nodes?${at}&page=${page}&size=100`]);
      assert.equal(result.resolvedSnapshotId, snapshotId);
      summaries.push(...result.items);
      if (summaries.length >= result.total || result.items.length === 0) { assert.equal(summaries.length, result.total); break; }
    }
    const byId = new Map(summaries.map(node => [node.id, node]));
    const details = await get(summaries.map(node => `${base}/graph/nodes/${node.id}?${at}`));
    const relations = await get(summaries.map(node => `${base}/graph/nodes/${node.id}/relations?direction=out&depth=1&${at}`));
    assert(relations.every(item => item.truncated === false && item.resolvedSnapshotId === snapshotId), 'RELATIONS_TRUNCATED');
    // Only inventoried files have retained content; a roster file the import policy refused stays absent.
    const inventoried = [...fixture.sources.keys()].filter(file => files.some(row => row.path === file));
    const contents = await get(inventoried.map(file => `${base}/file-content?path=${encodeURIComponent(file)}&${at}`));
    const served = new Map(inventoried.map((file, index) => [file, { bytes: Buffer.from(contents[index].content ?? '', 'utf8'), oid: contents[index].contentOid }]));
    const nodes = summaries.map((node, index) => ({ type: node.nodeType, key: node.naturalKey, name: node.name, path: node.filePath,
      lineStart: node.lineStart, lineEnd: node.lineEnd, area: node.areaType, metadata: details[index].metadata ?? {} }));
    const edges = relations.flatMap(item => item.relations.filter(relation => relation.depth === 1).map(relation => ({
      type: relation.edgeType, source: byId.get(relation.sourceNodeId)?.naturalKey ?? null, target: relation.node.naturalKey,
      confidence: relation.confidence, metadata: {} })));
    const dump = { format: 'code-intelligence-accuracy-product-dump/1', path: 'PACKAGED_APP_API', fixtureId,
      executionState: 'COMPLETED', failureCode: null, steps: report.job.steps, consumedSources,
      files: files.map(file => ({ path: file.path, language: file.language, size: file.size,
        // The API publishes the retained content object id (files.content_hash) through file-content.
        contentHash: served.get(file.path)?.oid ?? null, analysisStatus: file.analysisStatus,
        analysisReason: file.analysisReason, analysisTargeted: file.analysisTargeted })),
      nodes, edges,
      endpoints: endpoints.map(item => ({ nodeKey: byId.get(item.nodeId)?.naturalKey ?? null, method: item.httpMethod, path: item.path, handlerKey: item.handlerKey })),
      // EntityView has no source column; only Java-path entities are projected as JPA, and that is recorded.
      entities: entities.map(item => ({ nodeKey: byId.get(item.nodeId)?.naturalKey ?? null, entityName: item.entityName, tableName: item.tableName,
        source: /\.java$/.test(byId.get(item.nodeId)?.filePath ?? '') ? 'JPA' : 'API_SOURCE_UNAVAILABLE' })),
      routes: nodes.filter(node => node.type === 'FE_ROUTE').map(node => ({ nodeKey: node.key, path: node.key.replace(/^route:/, ''), componentKey: null })),
      apiLimits: ['NO_EDGE_METADATA', 'NO_AMBIGUOUS_NODES', 'ENTITY_SOURCE_FROM_JAVA_PATH', 'ROUTE_COMPONENT_KEY_UNAVAILABLE'] };
    report.rosterFiles = fixture.sources.size; report.inventoriedRosterFiles = inventoried.length;
    report.notInventoried = [...fixture.sources.keys()].filter(file => !served.has(file));
    report.servedContentMismatches = inventoried.filter(file => !served.get(file).bytes.equals(fixture.sources.get(file).bytes));
    fs.mkdirSync(path.join(evidence, 'dumps'), { mode: 0o700 });
    fs.writeFileSync(path.join(evidence, 'dumps', fixtureId + '.dump.json'), JSON.stringify(dump, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    report.dumpSha256 = hash(path.join(evidence, 'dumps', fixtureId + '.dump.json'));
    assert.equal(pageErrors, 0, 'Renderer errors occurred');
    report.checks.push('packaged-api-readback-complete');

    phase('native-clean-shutdown');
    const launched = application;
    const current = { process: () => child, close: () => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : launched.close() };
    application = null;
    await closeValidatedApplication(current, report);
    report.checks.push('native-clean-shutdown');

    phase('compare-and-bundle');
    // Both paths through the same adapter; the backend dump loses edge metadata the API cannot expose.
    report.dumpComparison = compareDumps(backendDump, dump);
    const strip = run => ({ ...run, facts: run.facts.map(({ observationId, ...fact }) => fact) });
    const fromBackend = strip(convertFixture(fixture, apiProjection(backendDump)).run), fromPackaged = strip(convertFixture(fixture, dump).run);
    const factKey = fact => JSON.stringify(fact);
    const left = new Set(fromBackend.facts.map(factKey)), right = new Set(fromPackaged.facts.map(factKey));
    report.observationComparison = { backendApiProjectionFacts: left.size, packagedFacts: right.size,
      onlyBackend: [...left].filter(item => !right.has(item)).map(item => JSON.parse(item)),
      onlyPackaged: [...right].filter(item => !left.has(item)).map(item => JSON.parse(item)),
      outcomesEqual: JSON.stringify(fromBackend.outcomes) === JSON.stringify(fromPackaged.outcomes) };
    report.observationComparison.equal = report.observationComparison.onlyBackend.length === 0
      && report.observationComparison.onlyPackaged.length === 0 && report.observationComparison.outcomesEqual;
    const relative = file => path.relative(repo, file);
    report.build = { path: 'PACKAGED_APP_API', revision: options.candidateRevision,
      dirtyProductPaths: report.candidate.changedProductPaths.length, appVersion: report.appVersion, buildSequence: manifest.buildSequence,
      components: [
        { name: 'runtime-manifest', path: relative(manifestFile), ...treeDigest(manifestFile) },
        { name: 'app-asar', path: relative(asarFile), ...treeDigest(asarFile) },
      ] };
    report.bundle = writeBundle({ root: evidence, corpus, capabilities, dumps: new Map([[fixtureId, dump]]), build: report.build, execution: {
      path: 'PACKAGED_APP_API', nonce: report.nonce, startedAt: report.startedAt, finishedAt: new Date().toISOString(),
      driverSha256: report.driverSha256, converterSha256: report.converterSha256, productRunnerSha256: report.productRunnerSha256,
      revision: options.candidateRevision, electronVersion: report.electronVersion, packagedLaunch: true,
      validationIdentity: report.validationIdentity?.appId } });
    report.status = 'EXPORTED'; save();
    report.t00 = await evaluate({ repo, root: evidence, corpus, capabilities, bundle: report.bundle,
      command: async (label, executable, args, cwd, childEnv, timeout) => {
        const { runOwnedCommand } = require('./owned-test-process.cjs');
        const fd = fs.openSync(path.join(evidence, label + '.log'), 'wx', 0o600);
        try { return await runOwnedCommand(executable, args, { cwd, env: childEnv, stdio: ['ignore', fd, fd] }, { timeoutMs: timeout }); }
        finally { fs.closeSync(fd); }
      } });
    report.status = report.t00.exit === 2 ? 'EVALUATED_BLOCKED' : report.t00.exit === 1 ? 'EVALUATED_FAIL' : 'EVALUATED_UNEXPECTED';
  } catch (error) {
    failure = error; report.status = 'FAIL';
    report.failure = { phase: report.phase, code: error?.code === 'ERR_ASSERTION' ? String(error.message).slice(0, 120)
      : /^[A-Z_]{3,80}$/.test(error?.message ?? '') ? error.message : 'PACKAGED_EXPORT_FAILED' };
  } finally {
    if (application) {
      const launched = application;
      const current = { process: () => child, close: () => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : launched.close() };
      try { await closeValidatedApplication(current, report); } catch { report.status = 'FAIL'; report.cleanupFailure = true; }
    }
    stopObserving?.();
    try { assert.equal(hash(manifestFile), report.manifestSha256); assert.equal(hash(asarFile), report.appAsarSha256); }
    catch { report.status = 'FAIL'; report.finalIdentityFailure = true; }
    // The isolated profile (bundled PostgreSQL data) and the roster copy are this run's own temporaries.
    try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(short, { recursive: true, force: true }); }
    catch { report.temporaryCleanupFailed = true; }
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ status: report.status, evidence, failure: report.failure ?? null, t00: report.t00?.summary ?? null,
    dumpsEqual: report.dumpComparison?.equal ?? null, observationsEqual: report.observationComparison?.equal ?? null }));
  if (!['EVALUATED_BLOCKED', 'EVALUATED_FAIL'].includes(report.status) || failure) process.exitCode = 1;
  return report;
}
module.exports = { argumentsFor, candidateDrift, copyRoster, main };
if (require.main === module) main().catch(() => { console.error('ACCURACY_PACKAGED_EXPORT_REFUSED'); process.exitCode = 1; });
