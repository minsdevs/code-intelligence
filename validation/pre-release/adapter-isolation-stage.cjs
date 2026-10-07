'use strict';

// ADR-01 staged acceptance (local, ad-hoc signatures only). Not a release candidate.
//
//   assemble <candidate.app> <stage-dir>
//     APFS-clones a retained Validation candidate into <stage-dir>/Code Intelligence Validation.app and
//     turns it into an `xpc-required` app built from this checkout: current desktop sources in app.asar
//     (adapterIsolation set only in the staged copy), the backend jar and frontend from this checkout,
//     RunAsNode off on the app binary, and the product adapter supervisor and bridge installed and
//     signed by desktop/scripts/adapter-supervisor.cjs. The signed worker table also lists the two
//     test-only denial probes. The candidate directory itself is never written.
//
//   analyze <staged.app> <evidence-dir> [--expect-unavailable]
//     Launches the staged app in a fresh isolated automation profile (mock Keychain), imports a
//     synthetic TypeScript fixture through the real folder-picker flow and records the job outcome,
//     the runtime services, the supervisor/bridge/worker processes seen during the analysis, and the
//     denial probes run by the same supervisor.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const repo = path.resolve(__dirname, '../..');
const desktop = path.join(repo, 'desktop');
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json', { paths: [desktop] }));
const APP_NAME = 'Code Intelligence Validation';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 64 * 1024 * 1024, timeout: 900000, ...options });

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

async function assemble(candidate, stageDirectory) {
  const adapterSupervisor = require('../../desktop/scripts/adapter-supervisor.cjs');
  const { fusesFor } = require('../../desktop/scripts/electron-fuses.cjs');
  assert.equal(path.basename(candidate), `${APP_NAME}.app`);
  fs.mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });
  const app = path.join(stageDirectory, `${APP_NAME}.app`), contents = path.join(app, 'Contents');
  assert.equal(fs.existsSync(app), false, 'STAGE_EXISTS');
  const work = fs.mkdtempSync(path.join(stageDirectory, 'work-'));
  run('/bin/cp', ['-cR', candidate, app]);
  const appId = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(contents, 'Info.plist')]).trim();
  const version = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(contents, 'Info.plist')]).trim();

  // app.asar: this checkout's desktop sources, the candidate's package metadata plus the flag.
  const asar = builderRequire('@electron/asar');
  const archive = path.join(contents, 'Resources', 'app.asar'), unpacked = path.join(work, 'app');
  asar.extractAll(archive, unpacked);
  fs.rmSync(path.join(unpacked, 'src'), { recursive: true });
  fs.cpSync(path.join(desktop, 'src'), path.join(unpacked, 'src'), { recursive: true });
  // Other packed files of this checkout (e.g. build/update-keys.json), as listed in build.files.
  for (const entry of JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).build.files) {
    if (/[*?]/.test(entry) || entry === 'package.json') continue;
    fs.mkdirSync(path.dirname(path.join(unpacked, entry)), { recursive: true });
    fs.copyFileSync(path.join(desktop, entry), path.join(unpacked, entry));
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(unpacked, 'package.json'), JSON.stringify({ ...metadata, adapterIsolation: 'xpc-required' }, null, 2) + '\n');
  fs.rmSync(archive);
  await asar.createPackage(unpacked, archive);
  const headerHash = crypto.createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
  run('/usr/bin/plutil', ['-replace', 'ElectronAsarIntegrity.Resources/app\\.asar.hash', '-string', headerHash, path.join(contents, 'Info.plist')]);

  // Runtime: this checkout's backend (with the frontend build) and no analyzer outside the service.
  const runtime = path.join(contents, 'Resources', 'runtime');
  const jars = fs.readdirSync(path.join(repo, 'backend/build/libs')).filter(name => name.endsWith('.jar')
    && !name.endsWith('-plain.jar') && name !== 'code-intelligence-control.jar');
  assert.equal(jars.length, 1, 'BACKEND_JAR_REQUIRED');
  fs.rmSync(path.join(runtime, 'backend', 'code-intelligence.jar'));
  fs.copyFileSync(path.join(repo, 'backend/build/libs', jars[0]), path.join(runtime, 'backend', 'code-intelligence.jar'));
  const analyzer = path.join(work, 'ts-analyzer');
  run('/bin/cp', ['-cR', path.join(runtime, 'ts-analyzer'), analyzer]);
  fs.rmSync(path.join(analyzer, 'dist'), { recursive: true });
  run('/bin/cp', ['-cR', path.join(repo, 'analyzers/ts-analyzer/dist'), path.join(analyzer, 'dist')]);
  fs.rmSync(path.join(runtime, 'ts-analyzer'), { recursive: true });

  // The app binary no longer needs RunAsNode (fuse wire as the afterPack hook sets it for this flag).
  const { flipFuses, FuseVersion, FuseV1Options } = builderRequire('@electron/fuses');
  const wanted = fusesFor(appId, { adapterIsolation: 'xpc-required' });
  const names = { runAsNode: 'RunAsNode', enableCookieEncryption: 'EnableCookieEncryption',
    enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable', enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
    enableEmbeddedAsarIntegrityValidation: 'EnableEmbeddedAsarIntegrityValidation', onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar',
    grantFileProtocolExtraPrivileges: 'GrantFileProtocolExtraPrivileges' };
  const config = { version: FuseVersion.V1 };
  for (const [key, value] of Object.entries(wanted)) config[FuseV1Options[names[key]]] = value;
  await flipFuses(app, config);

  // The product supervisor and bridge, built and assembled exactly as stage-runtime.mjs/afterPack do.
  const adapterStage = path.join(work, 'adapter-supervisor');
  adapterSupervisor.compile(path.join(adapterStage, 'bin'), { probe: true });
  await adapterSupervisor.assembleService({ destination: adapterStage, binaries: path.join(adapterStage, 'bin'),
    electronApp: path.join(desktop, 'node_modules/electron/dist/Electron.app'), analyzer, appId, version, testWorkers: true });
  adapterSupervisor.installService({ app, stage: adapterStage });

  // Signing order of sign-macos-runtime.cjs: service and bridge, manifest, then the app.
  const section = adapterSupervisor.signService({ app, identity: '-', appId, version, testWorkers: true });
  const manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const files = {};
  for (const file of filesUnder(runtime)) {
    const relative = path.relative(runtime, file).split(path.sep).join('/');
    if (relative !== 'runtime-manifest.json') files[relative] = sha256(file);
  }
  fs.chmodSync(manifestFile, 0o644);
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, files, adapterSupervisor: section }, null, 2) + '\n');
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(contents, 'Frameworks', 'Electron Framework.framework')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime',
    '--entitlements', path.join(desktop, 'build/entitlements.mac.plist'), app]);
  run('/usr/bin/codesign', ['--verify', '--strict', '--deep', app]);
  fs.rmSync(work, { recursive: true, force: true });
  const fuses = await builderRequire('@electron/fuses').getCurrentFuseWire(app);
  const result = { app, appId, adapterSupervisor: section, asarHeaderSha256: headerHash, runAsNodeFuse: fuses[FuseV1Options.RunAsNode] === 48 ? 'DISABLE' : 'ENABLE',
    bytes: { service: Number(run('/usr/bin/du', ['-sk', path.join(contents, adapterSupervisor.SERVICE_DIRECTORY)]).split('\t')[0]) * 1024 } };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function fixture(root) {
  const write = (relative, text) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); };
  write('package.json', JSON.stringify({ name: 'adr01-synthetic', private: true, version: '0.0.0' }, null, 2) + '\n');
  write('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true } }, null, 2) + '\n');
  write('src/api.ts', "export async function loadItems() {\n  return fetch('/api/items')\n}\n");
  write('src/App.tsx', "import { loadItems } from './api'\n\nexport function App() {\n  void loadItems()\n  return <main>items</main>\n}\n");
}

function processTable() {
  return run('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm=']).trim().split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] }));
}

async function analyze(app, evidenceDirectory, { expectUnavailable }) {
  const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
  const { closeValidatedApplication, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const work = fs.realpathSync(fs.mkdtempSync('/private/tmp/ciadr-'));
  const runs = path.join(work, 'runs'), project = path.join(work, 'project');
  fs.mkdirSync(runs, { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 });
  fixture(project);
  const report = { format: 1, scope: 'ADR-01 staged xpc-required app, ad-hoc signatures (not a candidate)', app, expectUnavailable,
    observedAt: new Date().toISOString(), mockKeychain: true, realAccount: false, checks: {} };
  const save = () => fs.writeFileSync(path.join(evidenceDirectory, expectUnavailable ? 'unavailable.json' : 'result.json'),
    JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const support = path.join(os.homedir(), 'Library', 'Application Support');
  const plan = prepareIsolatedRun({ parentDirectory: runs, runtimeDirectory: path.join(contents, 'Resources/runtime'), purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', APP_NAME].map(name => path.join(support, name)) });
  const frontend = createRequire(path.join(repo, 'frontend/package.json'));
  const { _electron: electron } = frontend('playwright'), { expect } = frontend('@playwright/test');
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'C', LC_ALL: 'C' };
  let electronApp, page, child, stop;
  const stderr = [];
  try {
    electronApp = await electron.launch({ executablePath: path.join(contents, 'MacOS', APP_NAME),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: repo, env, timeout: 90000 });
    child = electronApp.process(); stop = observeStartup(child, report, save);
    child.stderr.on('data', chunk => {
      for (const line of String(chunk).split('\n')) if (/^(DESKTOP_|\[desktop\])/.test(line) && stderr.length < 100) stderr.push(line.slice(0, 300));
    });
    page = await electronApp.firstWindow({ timeout: 90000 }); page.setDefaultTimeout(30000);
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: 90000 });
    let status;
    for (const end = Date.now() + 120000; ;) {
      status = await page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus());
      if (status.ready) break;
      assert.ok(Date.now() < end, 'RUNTIME_NOT_READY'); await new Promise(resolve => setTimeout(resolve, 500));
    }
    report.checks.services = [...status.services].sort();
    const call = (route, method = 'GET', body) => page.evaluate(async ({ route, method, body }) => {
      const desktopApi = window.codeIntelligenceDesktop, headers = { 'X-Code-Intelligence-Token': desktopApi.apiToken };
      if (method !== 'GET') {
        await fetch(desktopApi.apiBaseUrl + '/api/csrf', { credentials: 'include', headers });
        const cookie = document.cookie.split(';').map(p => p.trim()).find(p => p.startsWith('XSRF-TOKEN='));
        if (cookie) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie.slice(11));
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(desktopApi.apiBaseUrl + route, { method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, text: await response.text() };
    }, { route, method, body });
    const api = async route => { const response = await call(route); assert.equal(response.status, 200, route); return JSON.parse(response.text); };

    await page.evaluate(() => { history.pushState(null, '', '/import'); window.dispatchEvent(new PopStateEvent('popstate')); });
    const picker = await electronApp.evaluateHandle(({ dialog }, selected) => {
      const original = dialog.showOpenDialog; let calls = 0;
      const choose = async (...args) => {
        const options = args.at(-1);
        if (calls || options?.title !== 'Choose a source folder to analyze') throw new Error('FOLDER_PICKER_REFUSED');
        calls++; return { canceled: false, filePaths: [selected] };
      };
      dialog.showOpenDialog = choose;
      return { restore() { dialog.showOpenDialog = original; return calls; } };
    }, project);
    try { await page.getByRole('button', { name: 'Choose folder', exact: true }).click(); }
    finally { assert.equal(await picker.evaluate(value => value.restore()), 1); await picker.dispose(); }
    await page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click();
    const seen = new Map();
    const sampler = setInterval(() => {
      for (const row of processTable()) {
        if (/adapter-bridge$|AdapterSupervisor$|adapter-node$/.test(row.comm)) seen.set(row.pid, { ppid: row.ppid, comm: path.basename(row.comm) });
      }
    }, 100);
    const [created] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local' && r.request().method() === 'POST', { timeout: 60000 }),
      page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click()]);
    assert.ok(created.ok());
    const { project: createdProject, jobId } = await created.json();
    let job;
    for (const end = Date.now() + 300000; ;) {
      job = await api('/api/jobs/' + jobId);
      if (['DONE', 'FAILED', 'CANCELLED'].includes(job.status)) break;
      assert.ok(Date.now() < end, 'JOB_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 300));
    }
    clearInterval(sampler);
    const pids = new Set(seen.keys());
    report.checks.job = { status: job.status, failureCode: job.failureCode ?? null, error: job.error ?? null,
      tsParsing: job.steps?.find(step => step.stepKey === 'TS_PARSING')?.status ?? null };
    report.checks.processes = [...seen.entries()].map(([pid, value]) => ({ comm: value.comm,
      parent: pids.has(value.ppid) ? seen.get(value.ppid).comm : value.ppid === 1 ? 'launchd' : value.ppid === child.pid ? 'app' : 'other' }));
    if (job.status === 'DONE') {
      const snapshot = (await api('/api/projects/' + createdProject.id)).currentSnapshot.id;
      const nodes = await api(`/api/projects/${createdProject.id}/graph/nodes?snapshotId=${snapshot}&size=100&page=1&sort=path`);
      const files = await api(`/api/projects/${createdProject.id}/files?snapshotId=${snapshot}`);
      report.checks.graph = { total: nodes.total, nodes: nodes.items.map(node => [node.nodeType, node.name, node.filePath ?? null]),
        files: files.map(file => Object.fromEntries(Object.entries(file).filter(([key]) => /path|status|reason|outcome|language/i.test(key)))) };
    } else {
      await page.getByRole('alert').waitFor({ timeout: 30000 });
      report.checks.alertText = await page.getByRole('alert').innerText();
    }
    report.checks.desktopLog = stderr;
    save();
  } catch (error) { report.failure = String(error?.message ?? error).split('\n')[0]; report.checks.desktopLog = stderr; save(); throw error; }
  finally {
    if (electronApp) {
      const owner = child, current = electronApp;
      try { await closeValidatedApplication({ process: () => owner, close: () => owner.exitCode !== null ? Promise.resolve() : current.close() }, report); }
      catch (error) { report.closeFailure = String(error?.message ?? error); }
      finally { stop?.(); report.exit = { code: owner.exitCode, signal: owner.signalCode }; save(); }
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
  report.adapterProcessesAfterExit = processTable().filter(row => /adapter-bridge$|adapter-node$/.test(row.comm)).length;
  if (!expectUnavailable) report.checks.denialProbes = await denialProbes(contents);
  save();
  console.log(JSON.stringify(report.checks, null, 2));
  return report;
}

/** The spike's probes, run by the staged product supervisor through its bridge. */
async function denialProbes(contents) {
  const scratch = fs.realpathSync(fs.mkdtempSync('/private/tmp/ciadr-probe-'));
  const sentinel = path.join(scratch, 'sentinel.txt'), target = path.join(scratch, 'write-target');
  fs.writeFileSync(sentinel, 'outside\n');
  const seen = [];
  const tcp = net.createServer(socket => { let data = ''; socket.on('data', c => { data += c; }); socket.on('close', () => seen.push('tcp:' + data)); });
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const port = tcp.address().port, udp = dgram.createSocket('udp4');
  udp.on('message', m => seen.push('udp:' + m));
  await new Promise(resolve => udp.bind(port, '127.0.0.1', resolve));
  const bridge = (worker, input) => {
    const result = spawnSync(path.join(contents, 'MacOS', 'adapter-bridge'), [], { input: `open ${worker} ${crypto.randomBytes(32).toString('hex')}\n${input}`,
      encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    return { status: result.status, lines: result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), stderr: result.stderr.trim() };
  };
  try {
    const result = {
      probe: bridge('probe', `${sentinel} ${target} ${port} supervisor-child\n`),
      nodeProbe: bridge('node-probe', `${sentinel} ${target} ${port}\n`),
      unknownWorker: (() => { const r = spawnSync(path.join(contents, 'MacOS', 'adapter-bridge'), [], { input: `open shell ${'a'.repeat(64)}\n`, encoding: 'utf8' });
        return { status: r.status, stderr: r.stderr.trim() }; })(),
    };
    await new Promise(resolve => setTimeout(resolve, 300));
    result.listenerPayloadsFromProbes = seen.filter(entry => /supervisor-child|node-grandchild/.test(entry));
    result.writeTargetCreated = fs.existsSync(target);
    return result;
  } finally { tcp.close(); udp.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin');
  if (argv[0] === 'assemble' && argv.length === 3) return assemble(path.resolve(argv[1]), path.resolve(argv[2]));
  if (argv[0] === 'analyze' && (argv.length === 3 || (argv.length === 4 && argv[3] === '--expect-unavailable'))) {
    return analyze(path.resolve(argv[1]), path.resolve(argv[2]), { expectUnavailable: argv.length === 4 });
  }
  throw new Error('USAGE: adapter-isolation-stage.cjs assemble <candidate.app> <stage-dir> | analyze <staged.app> <evidence-dir> [--expect-unavailable]');
}

if (require.main === module) main().catch(error => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
module.exports = { fixture };
