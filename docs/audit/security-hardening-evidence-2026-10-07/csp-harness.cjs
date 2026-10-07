'use strict';
// Scratch CSP compatibility check: serves the candidate's bundled frontend with a fake API on
// loopback, applies the CSP string from desktop/src/main.cjs via onHeadersReceived (as main does),
// opens the code explorer so Monaco renders with its workers, then attacks the page.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const [staticRoot, mainSource, outFile, mode] = process.argv.slice(-4);
const policy = mode === 'none' ? null : eval(/const APP_CONTENT_SECURITY_POLICY = (\[[\s\S]*?\]\.join\('; '\));/.exec(fs.readFileSync(mainSource, 'utf8'))[1]);
app.setPath('userData', path.join(path.dirname(outFile), 'profile-' + mode));
const log = { mode, policy, served: [], foreign: [], console: [] };
const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const meta = { resolvedSnapshotId: 70, contentOid: 'a'.repeat(40), sourceState: 'AVAILABLE', snapshotTime: '2026-10-02T00:00:00Z', currentSnapshot: true, evidenceState: null };
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); log.served.push(url.pathname);
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/projects/7') return json(res, { id: 7, name: 'fixture', currentSnapshot: { id: 70 }, sourceType: 'LOCAL', analysisStatus: 'READY' });
    if (url.pathname === '/api/projects/7/snapshots') return json(res, [{ id: 70, status: 'READY', analyzedAt: '2026-10-02T00:00:00Z', current: true }]);
    if (url.pathname === '/api/projects/7/files') return json(res, [{ path: 'src/app.ts', language: 'typescript', size: 80, lineCount: 3 }]);
    if (url.pathname === '/api/projects/7/file-content') return json(res, { ...meta, path: 'src/app.ts', language: 'typescript', content: 'export const answer: number = 42;\nfunction twice(x: number) { return x * 2; }\nconsole.log(twice(answer));\n' });
    if (/graph|nodes/.test(url.pathname)) return json(res, { page: 1, size: 100, total: 0, items: [] });
    return json(res, []);
  }
  let file = path.join(staticRoot, path.normalize(url.pathname));
  if (!file.startsWith(staticRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticRoot, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
const foreign = http.createServer((req, res) => { log.foreign.push(req.url); res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('x'); });
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const port = await listen(server), foreignPort = await listen(foreign);
  const origin = `http://127.0.0.1:${port}`;
  const ses = session.fromPartition('csp-harness');
  if (policy) ses.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    const responseHeaders = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([n]) => n.toLowerCase() !== 'content-security-policy'));
    responseHeaders['Content-Security-Policy'] = [policy]; callback({ responseHeaders });
  });
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_e, level, message) => { log.console.push({ level, message: String(message).slice(0, 300) }); });
  await win.loadURL(`${origin}/projects/7/code?path=src%2Fapp.ts`);
  let editor = null;
  for (let i = 0; i < 60 && !editor?.lines; i++) {
    await sleep(500);
    editor = await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.monaco-editor .view-lines'); return v ? { lines: v.textContent.includes('twice'), tokens: document.querySelectorAll('.monaco-editor .view-lines span[class^="mtk"]').length } : null })()`);
  }
  await sleep(3000); // let workers start and answer
  log.editor = editor;
  log.editorAfterWorkers = await win.webContents.executeJavaScript(`(() => { const spans = [...document.querySelectorAll('.monaco-editor .view-lines span[class^="mtk"]')]; return { spans: spans.length, classes: [...new Set(spans.map(s => s.className))].sort(), text: document.querySelector('.monaco-editor .view-lines')?.textContent.slice(0, 80) } })()`);
  log.attack = await win.webContents.executeJavaScript(`(async () => {
    const r = {}; const violations = []; document.addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective));
    try { r.evalAllowed = (0, eval)('1 + 1') === 2; } catch { r.evalAllowed = false; }
    const s = document.createElement('script'); s.textContent = 'window.__inline = true'; document.head.append(s); r.inlineRan = window.__inline === true;
    try { await fetch('http://127.0.0.1:${foreignPort}/fetch', { mode: 'no-cors' }); r.crossOriginFetch = 'sent'; } catch { r.crossOriginFetch = 'blocked'; }
    await new Promise(res => { const i = new Image(); i.onload = i.onerror = res; i.src = 'http://127.0.0.1:${foreignPort}/img'; setTimeout(res, 1500); });
    try { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))); r.blobWorker = await new Promise(res => { w.onmessage = () => res('ran'); w.onerror = () => res('error'); setTimeout(() => res('timeout'), 1500); }); } catch { r.blobWorker = 'blocked'; }
    r.violations = violations; return r; })()`);
  log.workerScriptsServed = log.served.filter(p => /worker/.test(p));
  log.cspConsole = log.console.filter(c => /Content Security Policy|Refused to/.test(c.message));
  fs.writeFileSync(outFile, JSON.stringify(log, null, 2));
  win.destroy(); server.close(); foreign.close(); app.exit(0);
}).catch(error => { fs.writeFileSync(outFile, JSON.stringify({ error: String(error.stack) })); app.exit(1); });
