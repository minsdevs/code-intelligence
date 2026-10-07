'use strict';

// Regression for the stage 7 packaging defect: the macOS candidate shipped no
// Electron/Chromium licence files (electron-builder copies only Electron.app from
// the upstream archive, not its top-level LICENSE and LICENSES.chromium.html) and
// no third-party notices for the npm and Maven components. The packaging inputs
// below must place both into Contents/Resources/legal/. Reads checked-in packaging
// inputs only; nothing is built or launched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sbom = require('../sbom-candidate.cjs');
const notices = require('../licence-notices.cjs');

const repo = path.resolve(__dirname, '../../..');
const desktop = path.join(repo, 'desktop');
const REQUIRED = [
  { from: 'node_modules/electron/dist/LICENSE', to: 'legal/electron/LICENSE' },
  { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'legal/electron/LICENSES.chromium.html' },
  { from: 'build/third-party-notices', to: 'legal/third-party' },
];

test('macOS packaging copies Electron licence files and generated third-party notices into Contents/Resources/legal', () => {
  const build = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).build;
  const mac = build.mac.extraResources || [];
  for (const mapping of REQUIRED) assert.ok(mac.some(item => item.from === mapping.from && item.to === mapping.to), JSON.stringify(mapping));
  // Windows keeps its own notice set (windows-runtime-notices.json); the shared list stays runtime-only.
  assert.deepEqual(build.extraResources, [{ from: 'stage/runtime', to: 'runtime' }]);
  // The SBOM generator attributes exactly these destinations; electron-builder only warns on a missing source.
  for (const mapping of REQUIRED) {
    const shipped = `Contents/Resources/${mapping.to}${mapping.to.endsWith('third-party') ? '/THIRD-PARTY-NOTICES.txt' : ''}`;
    assert.ok(sbom.attributeFile(shipped), shipped);
  }
  assert.equal(notices.ELSEWHERE.chromium, 'Contents/Resources/legal/electron/LICENSES.chromium.html');
  assert.equal(notices.OUTPUT, 'desktop/' + REQUIRED[2].from);
});

test('Electron licence sources exist in the locked electron package', { skip: !fs.existsSync(path.join(desktop, 'node_modules/electron')) && 'desktop/node_modules absent' }, () => {
  const lock = JSON.parse(fs.readFileSync(path.join(desktop, 'package-lock.json'), 'utf8')).packages['node_modules/electron'].version;
  assert.equal(fs.readFileSync(path.join(desktop, 'node_modules/electron/dist/version'), 'utf8').trim(), lock);
  for (const mapping of REQUIRED.slice(0, 2)) assert.ok(fs.statSync(path.join(desktop, mapping.from)).size > 0, mapping.from);
});

test('checked-in third-party notices are self-consistent and keep every missing text visible', () => {
  const directory = path.join(desktop, REQUIRED[2].from);
  const text = fs.readFileSync(path.join(directory, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  const index = JSON.parse(fs.readFileSync(path.join(directory, 'third-party-notices.json'), 'utf8'));
  assert.deepEqual(fs.readdirSync(directory).sort(), ['THIRD-PARTY-NOTICES.txt', 'third-party-notices.json']);
  assert.match(index.generatedFrom.candidateBundleDigest, /^[a-f0-9]{64}$/);
  const sections = [...text.matchAll(/^===== \[text ([a-f0-9]{64})\] =====\n([\s\S]*?)(?=\n\n===== \[text |\n$)/gm)];
  assert.equal(sections.length, index.texts);
  for (const [, digest] of sections) assert.ok(index.components.some(item => item.licenceTextSha256.includes(digest)), digest);
  for (const item of index.components) {
    for (const digest of item.licenceTextSha256) assert.ok(text.includes(`===== [text ${digest}] =====`), `${item.name}: ${digest}`);
    assert.ok(['INCLUDED', 'TEXT_MISSING', 'BUNDLED_ELSEWHERE', 'NO_NOTICE_REQUIRED'].includes(item.status), item.name);
    if (item.status === 'INCLUDED') assert.ok(item.licenceTextSha256.length > 0, item.name);
    const line = `- ${item.name}${item.version ? ' ' + item.version : ''} [${item.kind}]`;
    assert.ok(text.includes(line), line);
  }
  const counts = index.components.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  assert.deepEqual(counts, index.counts);
  for (const [, digest, body] of sections) assert.ok(body.trim().length > 0, digest);
});
