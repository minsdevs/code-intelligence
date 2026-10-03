'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJson, LIMITS } = require('../lib/json.cjs');
const { SafeIO, relativePath } = require('../lib/safe-io.cjs');
const parse = value => parseJson(Buffer.from(value));
const code = expected => error => error.code === expected && error.message === expected;
function file(t, bytes = 'abcd') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't00-io-')), result = path.join(dir, 'bytes');
  fs.writeFileSync(result, bytes); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return result;
}

test('strict JSON supports ordinary JSON values and paired Unicode without lossy decoding', () => {
  const value = parse('{"s":"café\\n\\uD83D\\uDE00","n":-1.25e2,"a":[true,false,null]}');
  assert.equal(value.s, 'café\n😀'); assert.equal(value.n, -125); assert.deepEqual(value.a, [true, false, null]);
  assert.equal(Object.getPrototypeOf(value), null);
});

for (const [input, expected] of [
  ['{"a":1,"a":2}', 'DUPLICATE_JSON_KEY'],
  ['{"__proto__":1}', 'FORBIDDEN_JSON_KEY'],
  ['{"constructor":1}', 'FORBIDDEN_JSON_KEY'],
  ['[1,]', 'MALFORMED_JSON'],
  ['{"a":1,}', 'MALFORMED_JSON'],
  ['01', 'MALFORMED_JSON'],
  ['true false', 'MALFORMED_JSON'],
  ['"\\uD800"', 'INVALID_UNICODE'],
  ['1e999', 'NONFINITE_NUMBER'],
]) test('bounded parser rejects ' + expected + ' sample ' + JSON.stringify(input), () => {
  assert.throws(() => parse(input), code(expected));
});

test('invalid UTF-8 and excessive nesting fail with fixed diagnostic codes', () => {
  assert.throws(() => parseJson(Buffer.from([0xff])), code('INVALID_UTF8'));
  assert.throws(() => parse('['.repeat(66) + '0' + ']'.repeat(66)), code('JSON_COMPLEXITY_LIMIT'));
  assert.throws(() => parse('[' + '0,'.repeat(LIMITS.arrayItems) + '0]'), code('JSON_COMPLEXITY_LIMIT'));
});

test('fixture-relative paths reject traversal, aliases, separators and encoded escapes', () => {
  for (const value of ['../x', './x', '/x', 'x//y', 'x/../y', 'x\\y', 'C:x', 'x%2Fy', 'x%2ey', 'x\0y']) {
    assert.throws(() => relativePath(value), code('UNSAFE_PATH'));
  }
  assert.equal(relativePath('source/calls.ts'), 'source/calls.ts');
});

test('source and JSON reads respect inclusive byte limit and fail one byte above', t => {
  const source = file(t), io = new SafeIO();
  assert.equal(io.read(source, 4).length, 4);
  assert.throws(() => io.read(source, 3), code('INPUT_TOO_LARGE'));
});

test('64 MiB cumulative budget includes integrity rereads; exact boundary is allowed', t => {
  const source = file(t), io = new SafeIO(); io.totalBytes = LIMITS.totalBytes - 8;
  io.read(source, 4); io.assertUnchanged();
  assert.equal(io.totalBytes, LIMITS.totalBytes);
  assert.throws(() => io.read(source), code('INPUT_TOO_LARGE'));
});

test('opened descriptor size is rechecked when the file grows after lstat', t => {
  const source = file(t, 'a'), held = fs.openSync(source, 'a'), originalOpen = fs.openSync;
  t.after(() => fs.closeSync(held));
  const io = new SafeIO(); io.totalBytes = LIMITS.totalBytes - 1;
  t.mock.method(fs, 'openSync', function (...args) {
    fs.writeSync(held, Buffer.from('b')); return originalOpen.apply(fs, args);
  });
  assert.throws(() => io.read(source), code('INPUT_TOO_LARGE'));
});

test('a second read detects changed source instead of silently rebinding its hash', t => {
  const source = file(t), io = new SafeIO(); io.read(source); fs.writeFileSync(source, 'abce');
  assert.throws(() => io.assertUnchanged(), code('INPUT_CHANGED'));
});
