'use strict';

const { requireThat } = require('./errors.cjs');
const LIMITS = Object.freeze({ jsonBytes: 4 * 1024 * 1024, sourceBytes: 1024 * 1024,
  totalBytes: 64 * 1024 * 1024, depth: 64, nodes: 200000, arrayItems: 20000, fixtures: 64, cases: 10000 });

// JSON.parse alone accepts duplicate keys and may include source excerpts in its errors.
// This bounded parser rejects duplicates after escape decoding and emits only fixed codes.
function parseJson(bytes) {
  requireThat(bytes.length <= LIMITS.jsonBytes, 'INPUT_TOO_LARGE');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { requireThat(false, 'INVALID_UTF8'); }
  let index = 0, nodes = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(source[index] ?? '') && index < source.length) index++; };
  function string() {
    const start = index++;
    while (index < source.length) {
      const char = source[index++];
      if (char === '\\') { index++; continue; }
      if (char !== '"') continue;
      let result;
      try { result = JSON.parse(source.slice(start, index)); }
      catch { requireThat(false, 'MALFORMED_JSON'); }
      requireThat(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result), 'INVALID_UNICODE');
      return result;
    }
    requireThat(false, 'MALFORMED_JSON');
  }
  function value(depth) {
    requireThat(depth <= LIMITS.depth && ++nodes <= LIMITS.nodes, 'JSON_COMPLEXITY_LIMIT');
    whitespace();
    const char = source[index];
    if (char === '"') return string();
    if (char === '{') {
      index++; whitespace();
      const result = Object.create(null), seen = new Set();
      if (source[index] === '}') { index++; return result; }
      while (index < source.length) {
        requireThat(source[index] === '"', 'MALFORMED_JSON');
        const key = string();
        requireThat(!seen.has(key), 'DUPLICATE_JSON_KEY');
        requireThat(!['__proto__', 'prototype', 'constructor'].includes(key), 'FORBIDDEN_JSON_KEY');
        seen.add(key); whitespace();
        requireThat(source[index++] === ':', 'MALFORMED_JSON');
        result[key] = value(depth + 1); whitespace();
        if (source[index] === '}') { index++; return result; }
        requireThat(source[index++] === ',', 'MALFORMED_JSON'); whitespace();
      }
      requireThat(false, 'MALFORMED_JSON');
    }
    if (char === '[') {
      index++; whitespace(); const result = [];
      if (source[index] === ']') { index++; return result; }
      while (index < source.length) {
        requireThat(result.length < LIMITS.arrayItems, 'JSON_COMPLEXITY_LIMIT');
        result.push(value(depth + 1)); whitespace();
        if (source[index] === ']') { index++; return result; }
        requireThat(source[index++] === ',', 'MALFORMED_JSON');
      }
      requireThat(false, 'MALFORMED_JSON');
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, index)) { index += literal.length; return result; }
    }
    const match = source.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    requireThat(match != null, 'MALFORMED_JSON');
    index += match[0].length; const number = Number(match[0]);
    requireThat(Number.isFinite(number), 'NONFINITE_NUMBER');
    return number;
  }
  const result = value(0); whitespace();
  requireThat(index === source.length, 'MALFORMED_JSON');
  return result;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = { parseJson, stableJson, LIMITS };
