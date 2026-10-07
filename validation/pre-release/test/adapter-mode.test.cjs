'use strict';

// ADR-01 runner adaptation: the candidate's adapter mode decides the expected runtime services and
// where the packaged analyzer lives. Synthetic app directories only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { adapterMode, analyzerInstall, expectedServices } = require('../adapter-mode.cjs');

test('a candidate with the supervisor service has no persistent analyzer child', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'Legacy.app'), isolated = path.join(root, 'Isolated.app');
  fs.mkdirSync(path.join(legacy, 'Contents/Resources/runtime/ts-analyzer'), { recursive: true });
  fs.mkdirSync(path.join(isolated, 'Contents/XPCServices/AdapterSupervisor.xpc/Contents/Resources/ts-analyzer'), { recursive: true });
  assert.equal(adapterMode(legacy), 'legacy-http');
  assert.deepEqual(expectedServices(legacy), ['backend', 'postgres', 'redis', 'ts-analyzer']);
  assert.equal(analyzerInstall(legacy), path.join(legacy, 'Contents/Resources/runtime/ts-analyzer'));
  assert.equal(adapterMode(isolated), 'xpc-required');
  assert.deepEqual(expectedServices(isolated), ['backend', 'postgres', 'redis']);
  assert.equal(analyzerInstall(isolated), path.join(isolated, 'Contents/XPCServices/AdapterSupervisor.xpc/Contents/Resources/ts-analyzer'));
});
