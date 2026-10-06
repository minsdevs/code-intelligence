'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { finalizeIntegrity, diagnosticFailure } = require('../run-integrity-diagnostic.cjs');

test('final integrity failure preserves the original failure and observed cleanup evidence', () => {
  const failure = { code: 'FIRST_FAILURE' }, exit = { code: 0, signal: null };
  const report = { status: 'FAIL', failure, exit, cleanupFailed: true };
  finalizeIntegrity(report, () => { throw new Error('private pathname'); });
  assert.equal(report.failure, failure); assert.equal(report.exit, exit); assert.equal(report.cleanupFailed, true);
  assert.equal(report.finalizationFailure, 'DIAGNOSTIC_FINAL_INTEGRITY_FAILED');
  assert.equal(report.artifactIdentityUnchanged, false); assert.doesNotMatch(JSON.stringify(report), /private/);
});
test('final identity mismatch changes a provisional pass to fail', () => {
  const report = { status: 'PASS' };
  finalizeIntegrity(report, () => { throw new Error('changed'); });
  assert.equal(report.status, 'FAIL'); assert.equal(report.failure.code, 'DIAGNOSTIC_FINAL_INTEGRITY_FAILED');
});
test('successful identity readback never erases an earlier failed diagnostic', () => {
  const report = { status: 'FAIL', failure: { code: 'EARLIER' } };
  finalizeIntegrity(report, () => {});
  assert.equal(report.status, 'FAIL'); assert.equal(report.artifactIdentityUnchanged, true);
});

test('diagnostic errors read each field once and never export unknown or throwing values', () => {
  let reads = 0;
  assert.equal(diagnosticFailure({ get code() { return reads++ ? 'private-sentinel' : 'RUNTIME_IO_EMFILE'; } }), 'RUNTIME_IO_EMFILE');
  assert.equal(reads, 1);
  assert.equal(diagnosticFailure({ get code() { throw new Error('private'); } }), 'DIAGNOSTIC_FAILED');
  assert.equal(diagnosticFailure(new Error('/private/error')), 'DIAGNOSTIC_FAILED');
  assert.equal(diagnosticFailure(new Error('INVENTORY_DIAGNOSTIC_TIMEOUT')), 'INVENTORY_DIAGNOSTIC_TIMEOUT');
  assert.equal(diagnosticFailure({ code: 'PRIVATE_BUT_UPPERCASE' }), 'DIAGNOSTIC_FAILED');
});

test('diagnostic runner source wraps builtin and original-fs promise namespaces and restores both', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../run-integrity-diagnostic.cjs'), 'utf8');
  assert.match(source, /install\(fs\.promises, 'fs'\)/);
  assert.match(source, /install\(originalFs\.promises, 'original-fs'\)/);
  assert.match(source, /while \(restore\.length\) restore\.pop\(\)\(\)/);
  assert.match(source, /const stat = originalFs\.lstatSync\(file\)/);
  assert.doesNotMatch(source, /process\.noAsar\s*=/);
});
