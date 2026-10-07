'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Inside Electron the asar fs patch makes `<resources>/app.asar` look like a directory, so a
// plain node:fs stream of the archive fails with ENOENT. The bundle record must hash the
// physical archive through original-fs, as runtime-manifest.cjs does.
function asarPatchedFs() {
  return { ...fs, createReadStream(file, ...rest) {
    if (String(file).endsWith('.asar')) throw Object.assign(new Error(`ENOENT, ${file}`), { code: 'ENOENT' });
    return fs.createReadStream(file, ...rest);
  } };
}
function loadStartup() {
  const file = path.resolve(__dirname, '../src/update-startup.cjs'), requireSource = createRequire(file), requested = [];
  const context = { module: { exports: {} }, __dirname: path.dirname(file), __filename: file,
    process: { ...process, versions: { ...process.versions, electron: 'synthetic' } },
    require(name) {
      requested.push(name);
      if (name === 'node:fs') return asarPatchedFs();
      if (name === 'original-fs') return fs;
      return requireSource(name);
    } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { exports: context.module.exports, requested };
}

test('packaged bundle record hashes app.asar through original-fs under Electron', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-update-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Code Intelligence.app'), resources = path.join(app, 'Contents', 'Resources');
  const runtimeRoot = path.join(resources, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true }); fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'synthetic archive bytes');
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-manifest.json'), '{}');
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const { exports, requested } = loadStartup();
  const bundle = await exports.currentBundle({ app: { isPackaged: true }, runningBuild: '7', runtimeRoot,
    execPath: path.join(app, 'Contents', 'MacOS', 'Code Intelligence'), resourcesPath: resources });
  assert.ok(requested.includes('original-fs'));
  assert.deepEqual({ ...bundle }, { path: app, build: '7', runtimeManifestSha256: sha(path.join(runtimeRoot, 'runtime-manifest.json')),
    asarSha256: sha(path.join(resources, 'app.asar')) });
});
