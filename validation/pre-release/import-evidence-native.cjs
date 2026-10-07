'use strict';

// G-IMPORT / G-EVIDENCE packaged-app check on a retained candidate. Only the OS folder
// dialog result is controlled (single use, title/property checked), exactly like the
// existing native runner controls its archive picker. Preview, approval, the real
// path-capability IPC, backend, PostgreSQL, vault and analyzers stay real. A fresh
// isolated automation profile with mock Keychain is used; no user profile is read.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { ensureOutputParent } = require('./owned-output.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { closeValidatedApplication, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha256(fs.readFileSync(file));
const gitOid = bytes => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
const SENTINEL = 'C05NATIVESENTINEL';
const timeout = (promise, ms, code) => { let t; return Promise.race([promise, new Promise((_, r) => { t = setTimeout(() => r(new Error(code)), ms); })]).finally(() => clearTimeout(t)); };

function lines(text) {
  const result = []; let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || c === '\r') { result.push(text.slice(start, i)); if (c === '\r' && text[i + 1] === '\n') i++; start = i + 1; }
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}
function simpleName(name) {
  let value = String(name ?? ''); const hash = value.lastIndexOf('#'); if (hash >= 0) value = value.slice(hash + 1);
  const paren = value.indexOf('('); if (paren >= 0) value = value.slice(0, paren);
  const dot = value.lastIndexOf('.'); if (dot >= 0) value = value.slice(dot + 1);
  return /[A-Za-z_$][A-Za-z0-9_$]*/.exec(value)?.[0] ?? null;
}

/** Synthetic attack tree; every forbidden byte sequence carries the sentinel and is hashed. */
function buildTree(root, outside, marker) {
  const forbidden = [], approved = {};
  const put = (relative, bytes, secret) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    if (secret) forbidden.push(sha256(bytes)); else approved[relative] = Buffer.from(bytes);
  };
  const secret = label => `${SENTINEL}-${label}-${crypto.randomBytes(8).toString('hex')}`;
  put('.gitignore', 'private/\n');
  put('package.json', JSON.stringify({ name: 'attack', scripts: { preinstall: 'touch ' + marker, postinstall: 'touch ' + marker } }) + '\n');
  put('src/main.ts', "import { both } from './calls';\nexport function main(): number { return both(); }\n");
  put('src/util.ts', 'export function a(): number { return 1; }\nexport function b(): number { return 2; }\n');
  put('src/calls.ts', "import { a, b } from './util';\nexport function both(): number { return a() + b(); }\n");
  put('src/crlf.ts', '// crlf\r\nexport function crlfOne(): number {\r\n  return 1;\r\n}\r\n');
  put('src/bom.ts', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export function bomFirst(): number { return 1; }\n')]));
  put('svc/src/main/java/demo/HelloController.java', 'package demo;\n\nimport org.springframework.web.bind.annotation.GetMapping;\n'
    + 'import org.springframework.web.bind.annotation.RestController;\n\n@RestController\npublic class HelloController {\n'
    + '    @GetMapping("/hello")\n    public String hello() { return "hi"; }\n}\n');
  put('.env', `TOKEN=${secret('env')}\n`, true);
  put('config/.env.local', `DB=${secret('envlocal')}\n`, true);
  put('deploy/.ssh/id_ed25519', `-----BEGIN OPENSSH PRIVATE KEY-----\n${secret('ssh')}\n`, true);
  put('certs/server.pem', `${secret('pem')}\n`, true);
  put('src/leak.ts', `const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; // ${secret('ghp')}\n`, true);
  put('app.properties', `password=${secret('props')}\n`, true);
  put('node_modules/pkg/index.js', `module.exports = '${secret('nm')}';\n`, true);
  put('.git/HEAD', 'ref: refs/heads/main\n', false); delete approved['.git/HEAD'];
  put('.git/config', `[remote "o"]\n\turl = https://x:${secret('git')}@example.invalid/r\n`, true);
  put('private/notes.txt', `${secret('ignored')}\n`, true);
  put('src/hard-a.ts', `export const h = '${secret('hard')}';\n`, true);
  fs.linkSync(path.join(root, 'src/hard-a.ts'), path.join(root, 'src/hard-b.ts'));
  const big = Buffer.alloc(1024 * 1024 + 1, 0x78); Buffer.from(secret('big')).copy(big); put('big/huge.txt', big, true);
  put('src/bad.ts', Buffer.concat([Buffer.from(secret('utf8')), Buffer.from([0xc3, 0x28])]), true);
  const outsideSecret = Buffer.from(`export const o = '${secret('outside')}';\n`);
  fs.writeFileSync(path.join(outside, 'outside-secret.ts'), outsideSecret, { flag: 'wx', mode: 0o600 }); forbidden.push(sha256(outsideSecret));
  fs.symlinkSync(path.join(outside, 'outside-secret.ts'), path.join(root, 'src/link.ts'));
  return { forbidden, approved };
}
function treeState(root) {
  const entries = {};
  const walk = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), s = fs.lstatSync(file), rel = path.relative(root, file);
      const common = [s.mode, s.ino, s.nlink, s.size, s.mtimeMs].join(' ');
      if (s.isSymbolicLink()) entries[rel] = 'link ' + common + ' ' + fs.readlinkSync(file);
      else if (s.isDirectory()) { entries[rel] = 'dir ' + common; walk(file); }
      else if (s.isFile()) entries[rel] = 'file ' + common + ' ' + hashFile(file);
      else entries[rel] = 'other ' + common;
    }
  };
  walk(root); return entries;
}
function sweepProfile(root, needle, forbidden) {
  const result = { files: 0, bytes: 0, hits: [], forbiddenAddresses: [] }, marker = Buffer.from(needle);
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), s = fs.lstatSync(file);
      if (s.isDirectory()) { if (/^[0-9a-f]{64}$/.test(name) && forbidden.includes(name)) result.forbiddenAddresses.push(name); walk(file); }
      else if (s.isFile() && s.size <= 512 * 1024 * 1024) {
        result.files++; result.bytes += s.size;
        if (fs.readFileSync(file).includes(marker)) result.hits.push(path.relative(root, file));
      }
    }
  };
  walk(root); return result;
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert(argv.length === 2 && argv[0] === '--app', 'USAGE: --app <retained candidate>');
  process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(argv[1]);
  assert.equal(path.dirname(path.dirname(app)), repo); assert.match(path.basename(path.dirname(app)), /^\.native-product-[A-Za-z0-9]+$/);
  const manifestFile = path.join(app, 'Contents/Resources/runtime/runtime-manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
  await validateRuntimeManifest(path.dirname(manifestFile), manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], { timeout: 30000, stdio: 'pipe' });
  const asar = path.join(app, 'Contents/Resources/app.asar');
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/import-evidence'), 'native-'));
  const work = fs.realpathSync(fs.mkdtempSync('/private/tmp/cie-'));
  const runs = path.join(work, 'runs'), owned = path.join(work, 'owned'), outside = path.join(work, 'outside');
  for (const dir of [runs, owned, outside]) fs.mkdirSync(dir, { mode: 0o700 });
  const report = { format: 1, status: 'RUNNING', scope: 'G-IMPORT/G-EVIDENCE packaged picker->preview->snapshot and published-fact check',
    appBundle: app, buildSequence: manifest.buildSequence, manifestSha256: hashFile(manifestFile), appAsarSha256: hashFile(asar),
    driverSha256: hashFile(__filename), revision: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    mockKeychain: true, realAccount: false, nativePickerInteraction: false, checks: [], work };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence }));
  const project = path.join(owned, 'attack-project'), sibling = path.join(owned, 'ungranted-sibling');
  fs.mkdirSync(project, { mode: 0o700 }); fs.mkdirSync(sibling, { mode: 0o700 }); fs.writeFileSync(path.join(sibling, 'x.ts'), 'export const x = 1;\n');
  const marker = path.join(outside, 'executed-marker');
  const { forbidden, approved } = buildTree(project, outside, marker);
  const before = treeState(project);
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(repo, 'desktop/package.json')));
  const support = path.join(os.homedir(), 'Library', 'Application Support');
  const plan = require('../../desktop/src/isolated-run.cjs').prepareIsolatedRun({ parentDirectory: runs,
    runtimeDirectory: path.join(app, 'Contents/Resources/runtime'), purpose: 'automation',
    forbiddenRoots: [path.join(support, desktopPackage.name), path.join(support, desktopPackage.build.productName)] });
  report.profile = plan.paths.userData;
  const { _electron: electron } = createRequire(path.join(repo, 'frontend/package.json'))('playwright');
  const { expect } = createRequire(path.join(repo, 'frontend/package.json'))('@playwright/test');
  let electronApp, page, child, stop;
  const step = name => { report.phase = name; save(); };
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'C', LC_ALL: 'C' };
  const call = (route, method = 'GET', body, extra = {}) => page.evaluate(async ({ route, method, body, extra }) => {
    const desktop = window.codeIntelligenceDesktop, headers = { 'X-Code-Intelligence-Token': desktop.apiToken, ...extra };
    if (method !== 'GET') {
      await fetch(desktop.apiBaseUrl + '/api/csrf', { credentials: 'include', headers });
      const cookie = document.cookie.split(';').map(p => p.trim()).find(p => p.startsWith('XSRF-TOKEN='));
      if (cookie) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie.slice(11));
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(desktop.apiBaseUrl + route, { method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  }, { route, method, body, extra });
  const api = async (route, method, body) => {
    const r = await call(route, method, body); assert.ok(r.status >= 200 && r.status < 300, 'API ' + route + ' ' + r.status);
    return r.text ? JSON.parse(r.text) : null;
  };
  const awaitJob = async id => {
    for (const end = Date.now() + 300000; Date.now() < end;) {
      const job = await api('/api/jobs/' + id);
      if (job.status === 'DONE') return;
      if (['FAILED', 'CANCELLED'].includes(job.status)) { report.failedJob = { status: job.status, failureCode: job.failureCode ?? null }; throw new Error('JOB_' + job.status); }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('JOB_TIMEOUT');
  };
  const withFolderPicker = async (selected, action) => {
    const picker = await electronApp.evaluateHandle(({ dialog }, selected) => {
      const original = dialog.showOpenDialog; let calls = 0;
      const choose = async (...args) => {
        const options = args.at(-1);
        if (calls || options?.title !== 'Choose a source folder to analyze' || options.properties?.length !== 1
          || options.properties[0] !== 'openDirectory') throw new Error('FOLDER_PICKER_REFUSED');
        calls++; return { canceled: false, filePaths: [selected] };
      };
      dialog.showOpenDialog = choose;
      return { restore() { if (dialog.showOpenDialog !== choose) throw new Error('PICKER_REPLACED'); dialog.showOpenDialog = original; return calls; } };
    }, selected);
    try { await action(); } finally { assert.equal(await picker.evaluate(v => v.restore()), 1); await picker.dispose(); }
  };
  const verifyFacts = async (projectId, snapshot, bytes) => {
    const result = { nodes: 0, nodeSpanVerified: 0, fileLevelVerified: 0, noSourceLocation: 0, evidenceVerified: 0, filesVerified: 0, failures: [] };
    const fail = m => { if (result.failures.length < 100) result.failures.push(m); };
    const sources = {};
    const source = async file => {
      if (file in sources) return sources[file];
      const c = await api(`/api/projects/${projectId}/file-content?path=${encodeURIComponent(file)}&snapshotId=${snapshot}`);
      const raw = Buffer.from(c.content, 'utf8');
      let value = null;
      if (c.resolvedSnapshotId !== snapshot || c.sourceState !== 'AVAILABLE' || gitOid(raw) !== c.contentOid) fail('served identity ' + file);
      else if (!bytes[file] || !raw.equals(bytes[file])) fail('served bytes differ from approved bytes ' + file);
      else { value = { text: c.content, lines: lines(c.content) }; result.filesVerified++; }
      return (sources[file] = value);
    };
    const files = await api(`/api/projects/${projectId}/files?snapshotId=${snapshot}`);
    if (JSON.stringify(files.map(f => f.path).sort()) !== JSON.stringify(Object.keys(bytes).sort())) fail('snapshot path set differs');
    for (const f of files) await source(f.path);
    const nodes = [];
    for (let pageNo = 1; ; pageNo++) {
      const pageData = await api(`/api/projects/${projectId}/graph/nodes?snapshotId=${snapshot}&size=100&page=${pageNo}&sort=path`);
      assert.equal(pageData.resolvedSnapshotId, snapshot); nodes.push(...pageData.items);
      if (nodes.length >= pageData.total || pageData.items.length === 0) { assert.equal(nodes.length, pageData.total); break; }
    }
    for (const node of nodes) {
      result.nodes++;
      if (!node.filePath) { if (node.lineStart != null) fail('span without file ' + node.naturalKey); else result.noSourceLocation++; continue; }
      const s = await source(node.filePath); if (!s) continue;
      const pathKey = /^(file|component|hook|store|config|migration|module):([^#]+)(#.*)?$/.exec(node.naturalKey);
      if (pathKey && pathKey[2] !== node.filePath) { fail('namespace ' + node.naturalKey); continue; }
      const javaKey = /^java:([A-Za-z0-9_.$]+)(#.*)?$/.exec(node.naturalKey);
      if (javaKey) {
        const fq = javaKey[1], pkg = node.nodeType === 'PACKAGE' ? fq : fq.slice(0, fq.lastIndexOf('.'));
        if (!new RegExp('^\\s*package\\s+' + pkg.replace(/\./g, '\\.') + '\\s*;', 'm').test(s.text)) { fail('java namespace ' + node.naturalKey); continue; }
      }
      if (node.lineStart == null) { result.fileLevelVerified++; continue; }
      const end = node.lineEnd ?? node.lineStart;
      if (node.lineStart < 1 || end < node.lineStart || end > s.lines.length) { fail('span bounds ' + node.naturalKey + ' ' + node.lineStart + '-' + end + ' of ' + s.lines.length); continue; }
      const span = s.lines.slice(node.lineStart - 1, end).join('\n');
      let ok;
      if (node.nodeType === 'FILE') ok = node.lineStart === 1 && end === s.lines.length && path.basename(node.filePath) === node.name;
      else if (node.nodeType === 'API_ENDPOINT') ok = span.includes('"' + /^[A-Z]+ (\/\S*)$/.exec(node.name)?.[1] + '"');
      else ok = span.includes(node.name) || span.includes(simpleName(node.name));
      if (!ok) { fail('name/span ' + node.naturalKey + ' ' + node.lineStart + '-' + end); continue; }
      result.nodeSpanVerified++;
      const detail = await api(`/api/projects/${projectId}/graph/nodes/${node.id}?snapshotId=${snapshot}`);
      for (const e of detail.evidences ?? []) {
        if (!e.filePath) continue;
        const es = await source(e.filePath); if (!es) continue;
        const ee = e.lineEnd ?? e.lineStart;
        if (e.lineStart != null && (e.lineStart < 1 || ee < e.lineStart || ee > es.lines.length)) fail('evidence span ' + node.naturalKey);
        else result.evidenceVerified++;
      }
    }
    result.verifiedFacts = result.nodeSpanVerified + result.fileLevelVerified + result.evidenceVerified;
    return result;
  };
  const launch = async () => {
    step('launch');
    electronApp = await electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: repo, env, timeout: 90000 });
    child = electronApp.process(); stop = observeStartup(child, report, save);
    page = await electronApp.firstWindow({ timeout: 90000 }); page.setDefaultTimeout(30000);
    assert.equal(await electronApp.evaluate(({ app }) => app.getPath('userData')), plan.paths.userData);
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: 90000 });
    for (const end = Date.now() + 120000; ;) {
      const status = await page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus());
      if (status.ready) { assert.equal(status.aiOff, true); break; }
      assert.ok(Date.now() < end, 'RUNTIME_NOT_READY'); await new Promise(r => setTimeout(r, 1000));
    }
  };
  const close = async () => {
    if (!electronApp) return;
    const current = electronApp, owner = child; electronApp = null; step('shutdown');
    try { await closeValidatedApplication({ process: () => owner, close: () => owner.exitCode !== null ? Promise.resolve() : current.close() }, report); }
    finally { stop?.(); report.exit = { code: owner.exitCode, signal: owner.signalCode, shutdown: report.shutdown ?? null }; save(); }
  };
  try {
    await launch();
    step('renderer-capability-refusal');
    const direct = await call('/api/desktop/paths', 'POST', { path: project });
    assert.equal(direct.status, 403, 'renderer authorization without the main path token must be refused');
    const unGranted = await call('/api/projects/local/preview', 'POST', { path: project, name: 'attack' });
    assert.equal(unGranted.status, 400); assert.ok(!unGranted.text.includes(SENTINEL));
    const forged = await call('/api/desktop/paths', 'POST', { path: project }, { 'X-Code-Intelligence-Path-Token': '0'.repeat(64) });
    assert.equal(forged.status, 403);
    report.checks.push('renderer-path-authorization-refused-403', 'ungranted-preview-refused-400', 'forged-path-token-refused-403');
    step('picker-preview-approve');
    await page.evaluate(() => { history.pushState(null, '', '/import'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await withFolderPicker(project, () => page.getByRole('button', { name: 'Choose folder', exact: true }).click());
    const [previewResponse] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local/preview' && r.request().method() === 'POST', { timeout: 60000 }),
      page.getByRole('button', { name: /^(Preview files to import|가져올 파일 미리보기)$/ }).click()]);
    const previewText = await previewResponse.text(); assert.ok(previewResponse.ok()); assert.ok(!previewText.includes(SENTINEL));
    const preview = JSON.parse(previewText);
    report.preview = { acceptedFiles: preview.localImport.acceptedFiles, bytesRead: preview.localImport.bytesRead,
      excludedEntriesByReason: preview.localImport.excludedEntriesByReason, expiresAt: preview.expiresAt, changedPaths: preview.changedPaths };
    assert.deepEqual(preview.changedPaths, Object.keys(approved).sort().map(p => 'A ' + p));
    assert.deepEqual(preview.localImport.excludedEntriesByReason, { BINARY: 1, GENERATED_DIRECTORY: 2, HARD_LINK: 2, IGNORED: 1,
      OVERSIZED: 1, SECRET_CONTENT: 2, SECRET_PATH: 4, SYMLINK: 1 });
    const siblingPreview = await call('/api/projects/local/preview', 'POST', { path: path.join(project, '..', 'ungranted-sibling'), name: 'x' });
    assert.equal(siblingPreview.status, 400, 'a grant must not extend to a sibling');
    report.checks.push('controlled-native-dialog-grant-preview-exact-exclusions', 'sibling-of-granted-root-refused-400');
    const [created] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local' && r.request().method() === 'POST', { timeout: 60000 }),
      page.getByRole('button', { name: /^(Import and analyze the reviewed files|확인한 파일 가져오기 및 분석)$/ }).click()]);
    assert.ok(created.ok()); const createdBody = await created.json(); const projectId = createdBody.project.id;
    await awaitJob(createdBody.jobId);
    const first = (await api('/api/projects/' + projectId)).currentSnapshot.id;
    report.snapshots = { first };
    step('sentinel-sweep');
    const files = await api(`/api/projects/${projectId}/files?snapshotId=${first}`);
    assert.deepEqual(files.map(f => f.path).sort(), Object.keys(approved).sort());
    for (const f of files) {
      const c = await api(`/api/projects/${projectId}/file-content?path=${encodeURIComponent(f.path)}&snapshotId=${first}`);
      assert.ok(!c.content.includes(SENTINEL));
    }
    for (const format of ['json', 'markdown']) {
      const r = await call(`/api/projects/${projectId}/export?format=${format}`); assert.equal(r.status, 200); assert.ok(!r.text.includes(SENTINEL));
    }
    report.aiPreview = [];
    for (const focus of ['.env', 'src/leak.ts', 'src/main.ts', 'app.properties']) {
      const r = await call(`/api/projects/${projectId}/ai/preview`, 'POST', { question: 'Explain secrets and tokens', view: 'code', focusedFile: focus, selectedAreas: [], excludedContextIds: [] });
      assert.ok(!r.text.includes(SENTINEL)); report.aiPreview.push({ focus, status: r.status });
    }
    report.checks.push('snapshot-equals-approved-set', 'retained-source-export-ai-preview-sentinel-free');
    // A published-fact failure is recorded and judged after the independent sentinel, script,
    // original-folder and shutdown checks have run, so one bad span does not hide those results.
    step('published-facts-first');
    const firstFacts = await verifyFacts(projectId, first, approved);
    report.factsFirst = firstFacts; save();
    assert.ok(firstFacts.nodeSpanVerified > 0);
    if (!firstFacts.failures.length) report.checks.push('published-facts-hash-span-namespace-100pct-first-snapshot');
    step('reanalysis');
    const changed = { ...approved };
    fs.appendFileSync(path.join(project, 'src/util.ts'), 'export function c(): number { return 3; }\n');
    changed['src/util.ts'] = fs.readFileSync(path.join(project, 'src/util.ts'));
    const after = treeState(project);
    await page.evaluate(id => { history.pushState(null, '', '/projects/' + id + '/overview'); window.dispatchEvent(new PopStateEvent('popstate')); }, projectId);
    const refresh = page.getByRole('button', { name: /^(Refresh status|상태 새로고침)$/ });
    if (await refresh.isVisible({ timeout: 10000 }).catch(() => false)) {
      await refresh.click();
      await page.getByRole('button', { name: /^(Preview changes|변경 사항 미리보기)$/ }).click();
      await expect(page.getByRole('region', { name: /^(Import preview to review|확인할 가져오기 미리보기)$/ })).toBeVisible();
      const [refreshed] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === `/api/projects/${projectId}/reanalyze` && r.request().method() === 'POST', { timeout: 60000 }),
        page.getByRole('button', { name: /^(Re-analyze everything after reviewing changes|변경 확인 후 전체 재분석)$/ }).click()]);
      assert.ok(refreshed.ok()); await awaitJob((await refreshed.json()).jobId);
      report.reanalysisPath = 'ui-preview-approval';
    } else {
      const refreshPreview = await api(`/api/projects/${projectId}/local-preview`, 'POST');
      const job = await api(`/api/projects/${projectId}/reanalyze`, 'POST', { previewToken: refreshPreview.previewToken });
      await awaitJob(job.jobId);
      report.reanalysisPath = 'renderer-api-preview-approval';
    }
    const second = (await api('/api/projects/' + projectId)).currentSnapshot.id; assert.notEqual(second, first);
    report.snapshots.second = second;
    step('published-facts-both');
    report.factsFirstAfterReanalysis = await verifyFacts(projectId, first, approved);
    report.factsSecond = await verifyFacts(projectId, second, changed); save();
    if (!report.factsFirstAfterReanalysis.failures.length) report.checks.push('old-snapshot-facts-and-bytes-unchanged-after-reanalysis');
    if (!report.factsSecond.failures.length) report.checks.push('new-snapshot-facts-100pct');
    step('profile-sweep');
    report.profileSweep = sweepProfile(plan.record?.root ?? path.dirname(plan.paths.userData), SENTINEL, forbidden);
    assert.deepEqual(report.profileSweep.hits, []); assert.deepEqual(report.profileSweep.forbiddenAddresses, []);
    assert.equal(fs.existsSync(marker), false, 'package scripts must never run');
    assert.deepEqual(treeState(project), after, 'original folder must be unchanged by import/analysis');
    assert.deepEqual(Object.fromEntries(Object.entries(before).filter(([k]) => k !== 'src/util.ts' && k !== 'src')),
      Object.fromEntries(Object.entries(after).filter(([k]) => k !== 'src/util.ts' && k !== 'src')));
    report.checks.push('profile-db-logs-vault-addresses-sentinel-free', 'no-script-execution', 'original-folder-unchanged');
    await close(); report.checks.push('clean-shutdown-complete');
    step('published-facts-verdict');
    for (const key of ['factsFirst', 'factsFirstAfterReanalysis', 'factsSecond']) assert.deepEqual(report[key].failures, [], key);
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.failure = { phase: report.phase, name: error?.name ?? null, code: /^[A-Z_]{3,60}$/.test(error?.message ?? '') ? error.message : null,
      assertion: error?.code === 'ERR_ASSERTION' ? String(error.message).slice(0, 300).replaceAll(SENTINEL, '<sentinel>') : null };
    try { await close(); } catch { report.cleanupFailure = true; }
  } finally {
    try { assert.equal(hashFile(manifestFile), report.manifestSha256); assert.equal(hashFile(asar), report.appAsarSha256); report.candidateUnchanged = true; }
    catch { report.status = 'FAIL'; report.candidateUnchanged = false; }
    save();
  }
  console.log(JSON.stringify({ status: report.status, evidence, checks: report.checks.length, phase: report.phase }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
module.exports = { main, lines, simpleName, gitOid };
if (require.main === module) main().catch(() => { console.error('IMPORT_EVIDENCE_NATIVE_FAILED'); process.exitCode = 1; });
