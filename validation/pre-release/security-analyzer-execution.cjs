'use strict';

// G-SEC "no code execution from configuration" probe for the packaged TypeScript analyzer.
// The candidate's own Electron binary runs in Node mode (as production spawns the analyzer) and
// loads the packaged dist. Before any analyzer module loads, a trap records every fs path outside
// the analyzer install directory and every process, socket, DNS, HTTP, worker or native-addon call.
// A hostile project (tsconfig extends/plugins outside the snapshot, package scripts/entry points,
// absolute and traversal imports, remote dynamic import) is analysed; nothing may execute or read
// outside the request. This is a product-contract check, not the OS-level C15 sandbox evidence.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ensureOutputParent } = require('./owned-output.cjs');

const DRIVER = String.raw`
'use strict';
const path = require('path');
const [installDir, scratch] = process.argv.slice(-2);
const violations = [];
// TypeScript probes volume case sensitivity by stat-ing its own file name with swapped case. On the
// default case-insensitive APFS volume that is the same install file, so it is listed separately
// (still visible in the report) instead of counting as a read outside the install directory.
const caseFoldedInstall = [];
let armed = true;
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const describe = value => {
  if (typeof value === 'string') return path.resolve(value);
  if (value instanceof URL) return value.protocol === 'file:' ? path.resolve(decodeURIComponent(value.pathname)) : value.href;
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  return null;
};
const trapPaths = (object, label) => {
  for (const name of Object.keys(object)) {
    const original = object[name];
    if (typeof original !== 'function' || /^[A-Z]/.test(name) || name === 'promises') continue;
    object[name] = function trapped(...args) {
      if (armed) {
        const target = describe(args[0]);
        if (target && !inside(target, installDir)) {
          if (inside(target.toLowerCase(), installDir.toLowerCase())) caseFoldedInstall.push({ call: label + name, target });
          else violations.push({ kind: 'fs', call: label + name, target: inside(target, scratch) ? '<scratch>/' + path.relative(scratch, target) : target });
        }
      }
      return original.apply(this, args);
    };
  }
};
const fs = require('fs');
trapPaths(fs, 'fs.'); trapPaths(fs.promises, 'fs.promises.');
const forbid = (object, label) => {
  for (const name of Object.keys(object)) {
    const original = object[name];
    if (typeof original !== 'function' || /^[A-Z]/.test(name)) continue;
    object[name] = function forbidden(...args) {
      if (armed) violations.push({ kind: label, call: label + '.' + name });
      return original.apply(this, args);
    };
  }
};
for (const name of ['child_process', 'net', 'dgram', 'dns', 'http', 'https', 'http2', 'tls', 'worker_threads', 'cluster', 'inspector', 'vm']) forbid(require(name), name);
const dlopen = process.dlopen;
process.dlopen = function trappedDlopen(...args) { if (armed) violations.push({ kind: 'native', call: 'process.dlopen' }); return dlopen.apply(this, args); };
require('reflect-metadata');
const { AnalyzeService } = require(path.join(installDir, 'dist/analyze.service.js'));
const service = new AnalyzeService();
const secret = fs.readFileSync(path.join(scratch, 'outside-secret.ts'), 'utf8');
armed = true;
(async () => {
  const project = JSON.parse(fs.readFileSync(path.join(scratch, 'project.json'), 'utf8'));
  violations.length = 0; caseFoldedInstall.length = 0;
  const result = { violations, caseFoldedInstall };
  try {
    const response = await service.analyze({ files: project.files });
    result.analysis = 'COMPLETED';
    result.secretInResponse = JSON.stringify(response).includes(secret.trim());
    result.symbolCount = Array.isArray(response.symbols) ? response.symbols.length : null;
  } catch (error) { result.analysis = 'REFUSED:' + (error?.response?.code ?? error?.status ?? error?.name); }
  result.traversal = {};
  for (const hostile of project.hostilePaths) {
    try { await service.analyze({ files: [{ path: hostile, content: 'export const x = 1' }] }); result.traversal[hostile] = 'ACCEPTED'; }
    catch (error) { result.traversal[hostile] = 'REFUSED'; }
  }
  armed = false;
  result.sentinelCreated = require('fs').existsSync(path.join(scratch, 'executed-sentinel'));
  process.stdout.write('SECURITY_ANALYZER_RESULT ' + JSON.stringify(result) + '\n');
})().catch(error => { armed = false; process.stdout.write('SECURITY_ANALYZER_RESULT ' + JSON.stringify({ failure: String(error?.name) }) + '\n'); });
`;

function hostileProject(scratch) {
  const sentinel = path.join(scratch, 'executed-sentinel');
  const files = [
    { path: 'tsconfig.json', content: JSON.stringify({ extends: ['/etc/hosts', '../../../../outside/tsconfig.json', path.join(scratch, 'outside-secret.ts')],
      compilerOptions: { plugins: [{ name: path.join(scratch, 'evil-plugin.cjs') }], typeRoots: [scratch, '/Users'],
        baseUrl: '/', paths: { '@secret/*': [path.join(scratch, '*')] }, rootDirs: ['/', scratch] }, include: ['/**/*'] }) },
    { path: 'jsconfig.json', content: JSON.stringify({ extends: path.join(scratch, 'outside-secret.ts') }) },
    { path: 'package.json', content: JSON.stringify({ name: 'hostile', main: '../../../outside.js',
      exports: { '.': path.join(scratch, 'outside-secret.ts') },
      scripts: { preinstall: `touch ${sentinel}`, postinstall: `touch ${sentinel}`, prepare: `touch ${sentinel}`, build: `touch ${sentinel}` },
      dependencies: { 'left-pad': '1.3.0' } }) },
    { path: '.babelrc', content: JSON.stringify({ plugins: [path.join(scratch, 'evil-plugin.cjs')] }) },
    { path: 'vite.config.ts', content: `import { execSync } from 'node:child_process'\nexecSync('touch ${sentinel}')\nexport default {}\n` },
    { path: 'eslint.config.js', content: `require('child_process').execSync('touch ${sentinel}')\nmodule.exports = []\n` },
    { path: 'src/index.ts', content: [
      `/// <reference path="${path.join(scratch, 'outside-secret.ts')}" />`,
      `/// <reference types="${scratch}" />`,
      `import secret from '${path.join(scratch, 'outside-secret')}'`,
      `import other from '../../../../../../../${path.relative('/', scratch)}/outside-secret'`,
      `import aliased from '@secret/outside-secret'`,
      `import pkg from 'hostile'`,
      `export const remote = () => import('http://127.0.0.1:9/remote.js')`,
      `export function run() { return [secret, other, aliased, pkg] }`,
    ].join('\n') },
  ];
  const hostilePaths = ['../outside.ts', '/etc/hosts', 'src/../../outside.ts', 'C:\\Windows\\win.ini', 'src/\u0000.ts', '..\\outside.ts'];
  return { files, hostilePaths };
}

function main(argv = process.argv.slice(2)) {
  assert(argv.length === 2 && argv[0] === '--app' && path.isAbsolute(argv[1]));
  assert.equal(path.basename(argv[1]), 'Code Intelligence Validation.app');
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(argv[1]);
  assert.equal(path.dirname(path.dirname(app)), repo);
  const executable = path.join(app, 'Contents/MacOS/Code Intelligence Validation');
  const installDir = path.join(app, 'Contents/Resources/runtime/ts-analyzer');
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/security-internal-review'), 'analyzer-'));
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-sec-analyzer-')));
  const report = { format: 1, scope: 'packaged ts-analyzer source-execution contract (not OS sandbox C15)', app,
    analyzerDistSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(installDir, 'dist/analyze.service.js'))).digest('hex'),
    probeSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), observedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(path.join(scratch, 'outside-secret.ts'), `export default 'OUTSIDE-SNAPSHOT-SENTINEL-${crypto.randomUUID()}'\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(scratch, 'evil-plugin.cjs'), `require('fs').writeFileSync(${JSON.stringify(path.join(scratch, 'executed-sentinel'))}, 'x')\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(scratch, 'project.json'), JSON.stringify(hostileProject(scratch)), { mode: 0o600 });
    const driver = path.join(scratch, 'driver.cjs');
    fs.writeFileSync(driver, DRIVER, { mode: 0o600 });
    const output = execFileSync(executable, [driver, installDir, scratch], { cwd: path.join(installDir, 'dist'), encoding: 'utf8', timeout: 120000,
      env: { ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', HOME: scratch, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
        NODE_PATH: path.join(installDir, 'node_modules') } });
    const line = output.split('\n').find(item => item.startsWith('SECURITY_ANALYZER_RESULT '));
    Object.assign(report, JSON.parse(line.slice('SECURITY_ANALYZER_RESULT '.length)));
    report.status = report.analysis === 'COMPLETED' && report.violations.length === 0 && !report.sentinelCreated && report.secretInResponse === false
      && Object.values(report.traversal).every(value => value === 'REFUSED') ? 'PASS' : 'FAIL';
  } catch (error) { report.status = 'INCOMPLETE'; report.failure = String(error?.code ?? error?.name ?? 'ERROR'); }
  finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, evidence, violations: report.violations?.length ?? null }));
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { hostileProject };
