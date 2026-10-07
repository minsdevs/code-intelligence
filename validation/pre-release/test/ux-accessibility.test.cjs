'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contrastRatio, requiredRatio, summarizeAxTree, summarizeTraversal } = require('../ux-page-audit.cjs');
const { fixtureNames, fixtureFiles, fixtureDigest, writeFixture } = require('../ux-fixtures.cjs');
const { parseArguments, parseLsof, classifySocket } = require('../ux-accessibility-pilot.cjs');

test('contrast ratio follows WCAG 2.1 reference values', () => {
  assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255]) * 100) / 100, 21);
  assert.equal(contrastRatio([119, 119, 119], [119, 119, 119]), 1);
  // #767676 on white is the well-known 4.54:1 boundary sample.
  assert.ok(Math.abs(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255]) - 4.54) < 0.01);
  // The app's faint ink token on its main surface (measured in the packaged renderer too).
  assert.ok(contrastRatio([0x64, 0x64, 0x6e], [0x16, 0x16, 0x19]) < 4.5);
  assert.ok(contrastRatio([0x94, 0x94, 0x9e], [0x16, 0x16, 0x19]) >= 4.5);
});

test('large-text threshold uses 24px or 18.66px bold', () => {
  assert.equal(requiredRatio(13, 400), 4.5);
  assert.equal(requiredRatio(24, 400), 3);
  assert.equal(requiredRatio(19, 700), 3);
  assert.equal(requiredRatio(19, 600), 4.5);
});

test('accessibility tree summary flags unnamed controls, semantic-less focus and heading gaps', () => {
  const node = (role, name, properties = [], extra = {}) => ({ role: { value: role }, name: { value: name },
    properties: properties.map(([key, value]) => ({ name: key, value: { value } })), ...extra });
  const summary = summarizeAxTree([
    node('main', ''), node('navigation', 'Main menu'), node('region', ''), node('region', 'Overview'),
    node('heading', 'Projects', [['level', 1]]), node('heading', 'Detail', [['level', 3]]),
    node('button', ''), node('button', 'Save', [['pressed', true]]), node('generic', '', [['focusable', true]], { backendDOMNodeId: 7 }),
    node('textbox', 'Search', [['focusable', true], ['editable', 'plaintext']]), node('button', 'Hidden', [], { ignored: true }),
  ]);
  assert.equal(summary.mainCount, 1);
  assert.deepEqual(summary.landmarks.map(entry => entry.role), ['main', 'navigation', 'region']);
  assert.equal(summary.hasH1, true);
  assert.equal(summary.skippedHeadingLevel, true);
  assert.deepEqual(summary.unnamedInteractive, [{ role: 'button', backendDOMNodeId: null }]);
  assert.deepEqual(summary.focusableWithoutRole, [{ role: 'generic', name: '', backendDOMNodeId: 7 }]);
  assert.equal(summary.states.pressed, 1);
  assert.equal(summary.interactive.some(entry => entry.name === 'Hidden'), false);
});

test('traversal summary reports unreached focusables, missing indicators and low rings', () => {
  const summary = summarizeTraversal(
    [{ id: 1, indicator: true, ringRatio: 8, inViewport: true }, { id: 2, indicator: false, ringRatio: null, inViewport: false },
      { id: 3, indicator: true, ringRatio: 2.1, inViewport: true }],
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4, name: 'unreached' }], { wrapped: true });
  assert.equal(summary.tabStops, 3);
  assert.equal(summary.unreachedCount, 1);
  assert.equal(summary.unreached[0].name, 'unreached');
  assert.equal(summary.noVisibleIndicatorCount, 1);
  assert.equal(summary.lowContrastRing.length, 1);
  assert.equal(summary.focusedOffscreenCount, 1);
  assert.equal(summary.wrapped, true);
});

test('lsof field output is parsed and sockets are classified without hostname lookups', () => {
  const sockets = parseLsof(['p10', 'cjava', 'f40', 'PTCP', 'n127.0.0.1:5000->127.0.0.1:5432', 'TST=ESTABLISHED',
    'f41', 'PTCP', 'n*:6379', 'TST=LISTEN', 'p11', 'cnode', 'f12', 'PTCP', 'n10.0.0.2:5555->140.82.112.3:443', 'TST=SYN_SENT',
    'f13', 'PUDP', 'n[::1]:5353', ''].join('\n'));
  assert.equal(sockets.length, 4);
  assert.deepEqual(sockets.map(socket => classifySocket(socket).kind),
    ['loopback-connection', 'listen-all-interfaces', 'external-connection', 'loopback-listen']);
  assert.equal(classifySocket(sockets[2]).remoteHost, '140.82.112.3');
  assert.equal(sockets[2].state, 'SYN_SENT');
});

test('runner arguments accept only known stages', () => {
  assert.equal(parseArguments(['--app', '/x.app']).stages.size > 5, true);
  assert.deepEqual([...parseArguments(['--app', '/x.app', '--stages', 'u1,u5']).stages], ['u1', 'u5']);
  assert.throws(() => parseArguments(['--app', '/x.app', '--stages', 'u1,unknown']));
  assert.throws(() => parseArguments(['--app']));
});

test('fixtures are deterministic, synthetic and written into a fresh private directory', () => {
  assert.deepEqual(fixtureNames(), ['order-desk', 'library-loans']);
  for (const name of fixtureNames()) {
    assert.match(fixtureDigest(name), /^[a-f0-9]{64}$/);
    assert.equal(fixtureDigest(name), fixtureDigest(name));
    for (const relative of Object.keys(fixtureFiles(name))) assert.ok(!relative.startsWith('/') && !relative.includes('..'));
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-fixture-'));
  try {
    const destination = path.join(parent, 'order-desk');
    const written = writeFixture('order-desk', destination);
    assert.equal(written.sha256, fixtureDigest('order-desk'));
    assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(destination, 'web/src/App.tsx')).mode & 0o777, 0o600);
    assert.throws(() => writeFixture('order-desk', destination), /EEXIST/);
    // The fixture includes deliberate exclusion triggers and both certain and inferred HTTP links.
    const files = fixtureFiles('order-desk');
    assert.ok(files['.env'] && files['node_modules/left-pad/index.js']);
    assert.match(files['web/src/pages/OrderListPage.tsx'], /fetch\('\/api\/orders'\)/);
    assert.match(files['web/src/pages/OrderListPage.tsx'], /fetch\('\/orders\/summary'\)/);
    assert.match(files['legacy-api/src/main/java/com/example/legacy/LegacyOrderController.java'], /@RequestMapping\("\/api\/orders"\)/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
