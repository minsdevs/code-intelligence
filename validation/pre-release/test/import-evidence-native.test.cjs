'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { lines, nodeSpanMatches } = require('../import-evidence-native.cjs');

function fileNode(type, filePath, text) {
  return { nodeType: type, naturalKey: type.toLowerCase() + ':' + filePath,
    name: filePath.split('/').at(-1), filePath, lineStart: 1, lineEnd: lines(text).length };
}
for (const [type, filePath, text] of [
  ['CONFIG', 'package.json', '{"name":"attack"}\n'],
  ['MIGRATION', 'db/migration/V1__init.sql', 'create table account (\n  id bigint primary key\n);\n'],
]) test(type + ' file identity does not require its filename in the source text', () => {
  assert.equal(nodeSpanMatches(fileNode(type, filePath, text), lines(text)), true);
});

test('whole-file facts still require the correct name and complete declared span', () => {
  const text = '{\n  "name": "attack"\n}\n', node = fileNode('CONFIG', 'package.json', text);
  for (const changed of [{ name: 'other.json' }, { lineStart: 2 }, { lineEnd: 2 }, { lineEnd: 4 }]) {
    assert.equal(nodeSpanMatches({ ...node, ...changed }, lines(text)), false);
  }
});

test('a file-level locator may omit its end but must start at the first source line', () => {
  const text = '{\n  "version": 2\n}\n', node = { ...fileNode('CONFIG', 'vercel.json', text), lineEnd: null };
  assert.equal(nodeSpanMatches(node, lines(text)), true);
  assert.equal(nodeSpanMatches({ ...node, lineStart: 2 }, lines(text)), false);
});

test('a CONFIG subentity does not receive the whole-file identity exemption', () => {
  const source = ['{"dependencies":{"present":"1"}}'];
  const node = { nodeType: 'CONFIG', naturalKey: 'config:package.json#dep:missing',
    name: 'missing', filePath: 'package.json', lineStart: 1, lineEnd: 1 };
  assert.equal(nodeSpanMatches(node, source), false);
  assert.equal(nodeSpanMatches({ ...node, name: 'present', naturalKey: 'config:package.json#dep:present' }, source), true);
});

test('a symbol still has to occur in its declared span rather than another source line', () => {
  const source = ['function elsewhere() {}', 'function compute() {}'];
  const node = { nodeType: 'FUNCTION', name: 'compute', lineStart: 2, lineEnd: 2 };
  assert.equal(nodeSpanMatches(node, source), true);
  assert.equal(nodeSpanMatches({ ...node, lineStart: 1, lineEnd: 1 }, source), false);
});

test('an endpoint keeps its route-literal evidence check', () => {
  const node = { nodeType: 'API_ENDPOINT', name: 'GET /items', lineStart: 1, lineEnd: 1 };
  assert.equal(nodeSpanMatches(node, ['@GetMapping("/items")']), true);
  assert.equal(nodeSpanMatches(node, ['@GetMapping("/different")']), false);
});
