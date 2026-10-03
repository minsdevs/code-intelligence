'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyJarInputs } = require('../scripts/build-isolated.cjs');

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function fixture(t, mutation) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-jar-readback-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workRoot = path.join(root, 'work'); const outputRoot = path.join(root, 'output');
  const home = path.join(root, 'home'); const temp = path.join(root, 'temp');
  for (const directory of [workRoot, outputRoot, home, temp]) fs.mkdirSync(directory, { mode: 0o700 });
  const frontend = Buffer.from('<!doctype html><title>Synthetic readback fixture</title>');
  const migration = Buffer.from('CREATE TABLE synthetic_fixture (id INTEGER);\n');
  write(workRoot, 'frontend/dist/index.html', frontend);
  write(workRoot, 'backend/src/main/resources/db/migration/V1__synthetic.sql', migration);
  const bootJar = write(workRoot, 'backend/build/libs/synthetic.jar', Buffer.from([0x50, 0x4b, 3, 4, 0x66, 0x61, 0x6b, 0x65]));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(bootJar)).digest('hex');
  const entries = [
    { path: 'BOOT-INF/classes/static/index.html', uncompressedSize: frontend.length, data: frontend.toString('base64') },
    { path: 'BOOT-INF/classes/db/migration/V1__synthetic.sql', uncompressedSize: migration.length, data: migration.toString('base64') },
  ];
  if (mutation === 'content-mismatch') entries[0].data = Buffer.alloc(frontend.length, 88).toString('base64');
  if (mutation === 'oversized-stream') entries[0].data = Buffer.concat([frontend, Buffer.from('excess')]).toString('base64');
  if (mutation === 'duplicate-entry') entries.push({ ...entries[0] });
  const marker = path.join(outputRoot, 'dependency-load.json');
  const moduleFile = write(workRoot, 'desktop/node_modules/unzipper/index.js', `
'use strict';
if (process.env.SYNTHETIC_BUILD_SECRET || process.env.NODE_OPTIONS) throw new Error('HOST_ENVIRONMENT_LEAKED');
const fs = require('node:fs');
const { Readable } = require('node:stream');
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, home: process.env.HOME,
  temp: process.env.TMPDIR }), { flag: 'wx', mode: 0o600 });
exports.Open = { file: async () => ({ files: ${JSON.stringify(entries)}.map(entry => ({ ...entry,
  stream: () => Readable.from([Buffer.from(entry.data, 'base64')]) })) }) };
`);
  let identityChecks = 0;
  const plan = { root, workRoot, outputRoot,
    assertIdentity() { identityChecks++; },
    childEnvironment() { return { HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, PATH: path.dirname(process.execPath) }; } };
  return { plan, bootJar, sha256, moduleFile, marker, home, temp, get identityChecks() { return identityChecks; },
    run: () => verifyJarInputs(plan, bootJar, sha256) };
}

test('JAR reader dependency loads only in a private-env child and verifies frontend plus migrations', t => {
  const f = fixture(t);
  const previous = Object.fromEntries(['SYNTHETIC_BUILD_SECRET', 'NODE_OPTIONS'].map(name => [name, process.env[name]]));
  try {
    process.env.SYNTHETIC_BUILD_SECRET = 'synthetic-parent-secret';
    process.env.NODE_OPTIONS = '--synthetic-option-that-must-never-reach-a-child';
    const result = f.run();
    assert.deepEqual(result, { frontendArchiveReadbackVerified: true, frontendFiles: 1, migrationFiles: 1 });
    assert.equal(process.env.SYNTHETIC_BUILD_SECRET, 'synthetic-parent-secret');
    assert.equal(process.env.NODE_OPTIONS, '--synthetic-option-that-must-never-reach-a-child');
    const loaded = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    assert.notEqual(loaded.pid, process.pid);
    assert.equal(loaded.home, f.home); assert.equal(loaded.temp, f.temp);
    assert.equal(require.cache[f.moduleFile], undefined);
    assert.ok(f.identityChecks >= 2);
    assert.equal(fs.statSync(path.join(f.plan.outputRoot, 'jar-readback.json')).mode & 0o777, 0o600);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('mismatched, oversized and duplicate archive entries fail the child without publishing success', t => {
  for (const mutation of ['content-mismatch', 'oversized-stream', 'duplicate-entry']) {
    const f = fixture(t, mutation);
    assert.throws(f.run, { code: 'BUILD_FAILED_BACKEND_JAR_READBACK' });
    assert.equal(fs.existsSync(path.join(f.plan.outputRoot, 'jar-readback.json')), false);
    assert.equal(require.cache[f.moduleFile], undefined);
    const loaded = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    assert.notEqual(loaded.pid, process.pid);
    const log = fs.readFileSync(path.join(f.plan.outputRoot, 'backend-jar-readback.log'), 'utf8');
    assert.match(log, /BACKEND_JAR_READBACK_FAILED/);
    assert.equal(log.includes('synthetic-parent-secret'), false);
  }
});

test('successful archive contents cannot approve a JAR that differs from the built artifact hash', t => {
  const f = fixture(t);
  fs.writeFileSync(f.bootJar, Buffer.from([0x50, 0x4b, 3, 4, 0x63, 0x68, 0x61, 0x6e]));
  assert.throws(f.run, { code: 'BACKEND_JAR_CHANGED' });
  assert.equal(require.cache[f.moduleFile], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.plan.outputRoot, 'jar-readback.json'), 'utf8')).frontendArchiveReadbackVerified, true);
});
