'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SIZE_CLASSES, planWorkload, generateWorkload, hashTree, mutateWorkload, commentFill, rngFor } = require('../workload-fixture.cjs');

const ts = require(path.join(__dirname, '../../../analyzers/ts-analyzer/node_modules/typescript'));
// Copies of the local-ingest credential signatures (LocalSourcePolicy); a match would exclude a file.
const CREDENTIAL_SIGNATURES = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/i,
  /AKIA[0-9A-Z]{16}/, /sk-[A-Za-z0-9_-]{20,}/, /AIza[0-9A-Za-z_-]{20,}/, /bearer[ \t]+[A-Za-z0-9._+/-]{16,}={0,2}/i,
  /(?:password|passwd|client_secret|secret|token|api[_-]?key)["']?\s*[:=]\s*/im];
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '.gradle', 'build', 'dist', 'target', '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', 'vendor', 'generated']);

function privateRoot(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workload-fixture-test-')));
  const root = path.join(parent, 'tree'); fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return root;
}

test('every size class has the exact file count and byte budget and a stable digest', () => {
  for (const [name, size] of Object.entries(SIZE_CLASSES)) {
    const plan = planWorkload({ ...size, seed: 'g-perf-1' });
    assert.equal(plan.files.length, size.files, name);
    assert.equal(plan.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0), size.bytes, name);
    assert(plan.files.every(file => Buffer.byteLength(file.content) <= 1024 * 1024), name);
  }
  assert.deepEqual(SIZE_CLASSES.small, { files: 1000, bytes: 5 * 1024 * 1024 });
  assert.deepEqual(SIZE_CLASSES.medium, { files: 10000, bytes: 50 * 1024 * 1024 });
  assert.deepEqual(SIZE_CLASSES.large, { files: 50000, bytes: 200 * 1024 * 1024 });
});

test('the generator is deterministic for a seed and different for another seed', () => {
  const a = planWorkload({ ...SIZE_CLASSES.small, seed: 'g-perf-1' });
  const b = planWorkload({ ...SIZE_CLASSES.small, seed: 'g-perf-1' });
  const c = planWorkload({ ...SIZE_CLASSES.small, seed: 'g-perf-2' });
  assert.deepEqual(a.files, b.files);
  assert.notDeepEqual(a.files.map(file => file.content), c.files.map(file => file.content));
});

test('generated sources are ASCII, admitted by local-ingest rules and syntactically valid TypeScript/JavaScript', () => {
  const plan = planWorkload({ ...SIZE_CLASSES.small, seed: 'g-perf-1' });
  const counts = { java: 0, script: 0 };
  for (const file of plan.files) {
    assert.match(file.content, /^[\x09\x0a\x20-\x7e]*$/, file.path);
    assert(file.content.endsWith('\n'), file.path);
    for (const signature of CREDENTIAL_SIGNATURES) assert.doesNotMatch(file.content, signature, file.path);
    for (const part of file.path.split('/')) {
      assert(!EXCLUDED_DIRECTORIES.has(part) && !part.startsWith('.'), file.path);
    }
    if (/\.(tsx?|js)$/.test(file.path)) {
      const kind = file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : file.path.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ES2022, false, kind);
      assert.deepEqual(source.parseDiagnostics.map(d => d.messageText), [], file.path);
      counts.script++;
    } else if (file.path.endsWith('.java')) {
      // No Java parser is available offline here; check balanced braces and one top-level type.
      const code = file.content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
      let depth = 0; for (const ch of code) { depth += ch === '{' ? 1 : ch === '}' ? -1 : 0; assert(depth >= 0, file.path); }
      assert.equal(depth, 0, file.path);
      assert.match(code, /^package com\.example\.workload(\.m\d+)?;/, file.path);
      counts.java++;
    } else assert.match(file.path, /(^|\/)(pom\.xml|package\.json|tsconfig\.json)$/);
  }
  assert(counts.java > 400 && counts.script > 500);
});

test('cross-file references point at files that exist in the same fixture', () => {
  const plan = planWorkload({ ...SIZE_CLASSES.small, seed: 'g-perf-1' });
  const paths = new Set(plan.files.map(file => file.path));
  let imports = 0, javaImports = 0, httpCalls = 0;
  for (const file of plan.files) {
    for (const match of file.content.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[1]));
      assert(['', '.ts', '.tsx'].some(extension => paths.has(base + extension)), file.path + ' -> ' + match[1]);
      imports++;
    }
    for (const match of file.content.matchAll(/^import (com\.example\.workload\.[\w.]+);$/gm)) {
      assert(paths.has('src/main/java/' + match[1].replace(/\./g, '/') + '.java'), file.path);
      javaImports++;
    }
    for (const match of file.content.matchAll(/fetch\('\/api\/items(\d+)\//g)) {
      assert(paths.has(`src/main/java/com/example/workload/m${match[1]}/Item${match[1]}Controller.java`));
      httpCalls++;
    }
  }
  assert(imports > 700 && javaImports > 80 && httpCalls > 80, JSON.stringify({ imports, javaImports, httpCalls }));
});

test('generation writes the planned tree into an empty private directory and the digest reads back', t => {
  const root = privateRoot(t);
  const manifest = generateWorkload({ root, sizeClass: 'small' });
  assert.equal(manifest.files, 1000); assert.equal(manifest.bytes, 5 * 1024 * 1024);
  assert.match(manifest.treeSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(hashTree(root), { files: 1000, bytes: 5 * 1024 * 1024, treeSha256: manifest.treeSha256 });
  assert.equal(fs.statSync(path.join(root, 'pom.xml')).mode & 0o777, 0o600);
  assert.throws(() => generateWorkload({ root, sizeClass: 'small' }), /WORKLOAD_ROOT_NOT_EMPTY/);
});

test('generation refuses non-private, relative and unknown targets', t => {
  const root = privateRoot(t);
  fs.chmodSync(root, 0o755);
  assert.throws(() => generateWorkload({ root, sizeClass: 'small' }), /WORKLOAD_ROOT_INVALID/);
  fs.chmodSync(root, 0o700);
  assert.throws(() => generateWorkload({ root: 'relative', sizeClass: 'small' }), /WORKLOAD_ROOT_INVALID/);
  assert.throws(() => generateWorkload({ root, sizeClass: 'huge' }), /WORKLOAD_CLASS_INVALID/);
  assert.throws(() => generateWorkload({ root, sizeClass: 'small', files: 3 }), /WORKLOAD_CLASS_INVALID/);
  assert.throws(() => planWorkload({ files: 1000, bytes: 1000, seed: 'x' }), /WORKLOAD_BYTE_BUDGET_TOO_SMALL/);
  assert.throws(() => planWorkload({ files: 1000, bytes: 5 * 1024 * 1024, seed: '../x' }), /WORKLOAD_SEED_INVALID/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('the one-percent change rewrites ceil(1%) files with equal sizes and is reproducible', t => {
  const root = privateRoot(t);
  const manifest = generateWorkload({ root, sizeClass: 'small' });
  const change = mutateWorkload({ root, manifest });
  assert.equal(change.changedFiles, 10);
  const after = hashTree(root);
  assert.equal(after.files, manifest.files); assert.equal(after.bytes, manifest.bytes);
  assert.notEqual(after.treeSha256, manifest.treeSha256);
  // A second tree with the same inputs yields the same changed digest.
  const other = privateRoot(t);
  const again = mutateWorkload({ root: other, manifest: generateWorkload({ root: other, sizeClass: 'small' }) });
  assert.equal(again.changedPathsSha256, change.changedPathsSha256);
  assert.equal(hashTree(other).treeSha256, after.treeSha256);
  // A tree that no longer matches the plan is refused instead of being changed again.
  assert.throws(() => mutateWorkload({ root, manifest }), /WORKLOAD_TREE_CHANGED/);
});

test('comment filler produces exact byte counts for every small remainder', () => {
  const rng = rngFor('filler');
  for (let bytes = 0; bytes < 400; bytes++) {
    const text = commentFill(bytes, rng);
    assert.equal(Buffer.byteLength(text), bytes);
    for (const line of text.split('\n').slice(0, -1)) assert(line === '' || line.startsWith('// ') || line === '//', JSON.stringify(line));
  }
});
