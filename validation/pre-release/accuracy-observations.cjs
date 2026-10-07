'use strict';

// Maps one product dump (backend DB rows or packaged-app API responses, same normalized shape)
// onto the T00 observation contract. It reads fixture manifests and roster sources only: never
// gold, negatives or review files. Every product row is either emitted as a fact or counted in
// the evidence audit with a reason; nothing is dropped silently, truncated or re-targeted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stableJson } = require('../t00/lib/json.cjs');
const { sourceDigest } = require('../t00/lib/contracts.cjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ADAPTER_VERSION = 'accuracy-observations/1';
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

// Same digest as T00ObservationExportTest.treeDigest: "relative\tsha256\n" lines in UTF-16 order.
function treeDigest(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('TREE_SYMLINK'), { code: 'TREE_SYMLINK' });
  if (stat.isFile()) return { kind: 'FILE', files: 1, sha256: sha256(Buffer.from(path.basename(root) + '\t' + sha256(fs.readFileSync(root)) + '\n')) };
  const files = [];
  (function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), entry = fs.lstatSync(file);
      if (entry.isSymbolicLink()) throw Object.assign(new Error('TREE_SYMLINK'), { code: 'TREE_SYMLINK' });
      if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(path.relative(root, file).split(path.sep).join('/'));
    }
  })(root);
  files.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const lines = files.map(file => file + '\t' + sha256(fs.readFileSync(path.join(root, file))) + '\n').join('');
  return { kind: 'DIRECTORY_TREE', files: files.length, sha256: sha256(Buffer.from(lines)) };
}

const gitBlobSha1 = bytes => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
const languageOf = file => /\.java$/i.test(file) ? 'java' : /\.(?:[cm]?ts|tsx)$/i.test(file) ? 'ts'
  : /\.(?:[cm]?js|jsx)$/i.test(file) ? 'js' : /\.sql$/i.test(file) ? 'sql' : 'other';
const PARSER_CELL = { java: 'J-P', ts: 'T-P', js: 'JS-P', sql: 'SQL-P' };
const SYMBOL_CELL = { java: 'J-S', ts: 'T-S', js: 'JS-S', sql: 'SQL-S' };
const CALL_CELL = { java: 'J-C', ts: 'T-C', js: 'JS-C' };
const UI_CELL = { ts: 'T-UI', js: 'JS-UI' };
const JAVA_SYMBOLS = new Set(['CLASS', 'INTERFACE', 'ENUM', 'RECORD', 'ANNOTATION', 'METHOD']);
// Only a per-file parse failure is a file-level syntax verdict. PROJECT_SYNTAX_REJECTED marks every
// submitted TS/JS file alike (TsParsingStep), so it does not say which file is invalid: no verdict.
const SYNTAX_REASONS = new Set(['JAVA_PARSE_FAILED']);
// Product reason vocabulary -> annotation-guide vocabulary (validation/t00/ANNOTATING.md).
const UNRESOLVED_REASON = { DYNAMIC_MEMBER: 'DYNAMIC_TARGET', UNRESOLVED_TARGET: 'UNRESOLVED_TARGET' };

class Source {
  constructor(meta, bytes) {
    this.meta = meta; this.bytes = bytes; this.lines = [0];
    for (let index = 0; index < bytes.length; index++) if (bytes[index] === 0x0a) this.lines.push(index + 1);
  }
  lineBounds(line) {
    if (!Number.isSafeInteger(line) || line < 1 || line > this.lines.length) return null;
    const start = this.lines[line - 1];
    let end = line < this.lines.length ? this.lines[line] - 1 : this.bytes.length;
    return { start, end };
  }
  // Product evidence is a 1-based line range. Project it to the trimmed bytes of those lines.
  lineSpan(lineStart, lineEnd) {
    const first = this.lineBounds(lineStart), last = this.lineBounds(lineEnd);
    if (!first || !last || lineEnd < lineStart) return null;
    let start = first.start, end = last.end;
    while (start < end && [0x20, 0x09, 0x0d, 0x0a].includes(this.bytes[start])) start++;
    while (end > start && [0x20, 0x09, 0x0d, 0x0a].includes(this.bytes[end - 1])) end--;
    return end > start ? { start, end } : null;
  }
  // Unique occurrence of text on one line; null when absent or ambiguous.
  textOnLine(line, text) {
    const bounds = this.lineBounds(line); if (!bounds || !text) return null;
    const needle = Buffer.from(text, 'utf8'), hits = [];
    for (let index = this.bytes.indexOf(needle, bounds.start); index !== -1 && index + needle.length <= bounds.end;
      index = this.bytes.indexOf(needle, index + 1)) hits.push(index);
    return hits.length === 1 ? { start: hits[0], end: hits[0] + needle.length } : null;
  }
  // Extend a callee expression to its call's closing parenthesis (lexical, strings/comments aware).
  callExpression(callee) {
    let index = callee.end; const b = this.bytes, skip = () => { while (index < b.length && [0x20, 0x09, 0x0d, 0x0a].includes(b[index])) index++; };
    skip();
    if (b[index] === 0x3f && b[index + 1] === 0x2e) { index += 2; skip(); }
    if (b[index] === 0x3c) { // generic type arguments
      let depth = 0;
      for (; index < b.length; index++) { if (b[index] === 0x3c) depth++; else if (b[index] === 0x3e && --depth === 0) { index++; break; } else if (b[index] === 0x0a || b[index] === 0x3b) return null; }
      skip();
    }
    if (b[index] !== 0x28) return null;
    let depth = 0, quote = null;
    for (; index < b.length; index++) {
      const c = b[index];
      if (quote) { if (c === 0x5c) index++; else if (c === quote) quote = null; continue; }
      if (c === 0x27 || c === 0x22 || c === 0x60) quote = c;
      else if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) return { start: callee.start, end: index + 1 };
    }
    return null;
  }
}

function readFixture(corpusFile, reference) {
  const manifestFile = path.join(path.dirname(corpusFile), reference.path);
  const bytes = fs.readFileSync(manifestFile);
  if (sha256(bytes) !== reference.sha256) throw Object.assign(new Error('FIXTURE_HASH_MISMATCH'), { code: 'FIXTURE_HASH_MISMATCH' });
  const manifest = JSON.parse(bytes.toString('utf8')), root = path.dirname(manifestFile), sources = new Map();
  for (const meta of manifest.source) {
    const source = fs.readFileSync(path.join(root, meta.path));
    if (source.length !== meta.bytes || sha256(source) !== meta.sha256) throw Object.assign(new Error('SOURCE_HASH_MISMATCH'), { code: 'SOURCE_HASH_MISMATCH' });
    sources.set(meta.path, new Source(meta, source));
  }
  return { manifest, sources };
}

// Observation ids are unique across the whole bundle, so each fixture gets its own id prefix.
function convertFixture(fixture, dump, idPrefix = 'p') {
  const { manifest, sources } = fixture, cells = new Set(manifest.capabilities);
  const eligible = new Map(manifest.eligibility.map(item => [item.path + '\n' + item.cellId, item]));
  const audit = { fixtureId: manifest.fixtureId, dumpPath: dump.path, executionState: dump.executionState,
    publishedRows: { files: dump.files.length, nodes: dump.nodes.length, edges: dump.edges.length,
      endpoints: dump.endpoints.length, entities: dump.entities.length, routes: dump.routes.length },
    evidence: { hashChecked: 0, hashValid: 0, hashInvalid: [], factsWithSpan: 0, factsWithoutValidSpan: [],
      incompleteLineRange: 0, namespace: 'NOT_PUBLISHED_BY_PRODUCT_ROSTER_ASSIGNED' },
    emitted: {}, excludedByFixtureEligibility: 0, notInDeclaredCells: 0, unmappedByType: {}, projections: {},
    outsideRoster: [], candidateSetsOverFive: 0 };
  const facts = [], bump = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };
  const nodes = new Map(dump.nodes.map(node => [node.key, node]));
  const files = new Map(dump.files.map(file => [file.path, file]));
  for (const file of dump.files) if (!sources.has(file.path)) audit.outsideRoster.push(file.path);
  // Product-published hash evidence: files.content_hash is the git blob id of the analysed bytes.
  for (const [file, source] of sources) {
    const row = files.get(file); if (!row) continue;
    audit.evidence.hashChecked++;
    if (row.contentHash === gitBlobSha1(source.bytes) && Number(row.size) === source.bytes.length) audit.evidence.hashValid++;
    else audit.evidence.hashInvalid.push(file);
  }
  let sequence = 0;
  function emit(cellId, file, span, fact, origin) {
    if (!cells.has(cellId)) { audit.notInDeclaredCells++; return; }
    const source = sources.get(file);
    if (!source) { audit.outsideRoster.push(file); return; }
    const eligibility = eligible.get(file + '\n' + cellId);
    if (!eligibility?.eligible) { audit.excludedByFixtureEligibility++; return; }
    if (!span) { audit.evidence.factsWithoutValidSpan.push({ cellId, path: file, origin }); return; }
    audit.evidence.factsWithSpan++;
    bump(audit.emitted, cellId);
    facts.push({ observationId: idPrefix + String(++sequence).padStart(5, '0'), cellId, kind: fact.kind, relationKind: fact.relationKind,
      source: { path: file, sha256: source.meta.sha256, namespace: source.meta.namespace, start: span.start, end: span.end },
      resolution: fact.resolution, targets: fact.targets ?? [], valid: fact.valid ?? null, diagnostics: fact.diagnostics ?? [],
      reasonCode: fact.reasonCode ?? null });
  }
  const nodeSpan = node => {
    const source = sources.get(node?.path); if (!source) return null;
    if (node.lineStart != null && node.lineEnd == null) audit.evidence.incompleteLineRange++;
    return source.lineSpan(node.lineStart, node.lineEnd ?? node.lineStart);
  };
  const namespaceOf = file => sources.get(file)?.meta.namespace ?? null;
  const ok = file => languageOf(file ?? '');

  // P: one parser verdict per inventoried roster file.
  for (const [file, source] of sources) {
    const cellId = PARSER_CELL[ok(file)], row = files.get(file); if (!cellId || !row) continue;
    const whole = { start: 0, end: source.bytes.length };
    if (['SUCCESS', 'PARTIAL'].includes(row.analysisStatus)) emit(cellId, file, whole, { kind: 'PARSER', relationKind: 'PARSE', resolution: 'NOT_APPLICABLE', valid: true }, 'file');
    else if (row.analysisStatus === 'FAILED' && SYNTAX_REASONS.has(row.analysisReason)) {
      emit(cellId, file, whole, { kind: 'PARSER', relationKind: 'PARSE', resolution: 'NOT_APPLICABLE', valid: false, diagnostics: ['SYNTAX_ERROR'] }, 'file');
    } else bump(audit.projections, 'parser-no-verdict-' + row.analysisStatus + (row.analysisReason ? '-' + row.analysisReason : ''));
  }
  // S: declarations with their line evidence.
  for (const node of dump.nodes) {
    const language = ok(node.path);
    if (language === 'java' && JAVA_SYMBOLS.has(node.type) && node.key.startsWith('java:')) {
      emit('J-S', node.path, nodeSpan(node), { kind: 'FACT', relationKind: 'SYMBOL', resolution: 'STATIC_RESOLVED', targets: [node.key] }, 'node');
    } else if ((language === 'ts' || language === 'js') && /^(?:ts|js):/.test(node.key) && node.type !== 'FILE') {
      emit(SYMBOL_CELL[language], node.path, nodeSpan(node), { kind: 'FACT', relationKind: 'SYMBOL', resolution: 'STATIC_RESOLVED', targets: [node.key] }, 'node');
      for (const call of node.metadata?.unresolvedCalls ?? []) {
        const source = sources.get(node.path), callee = source?.textOnLine(call.lineStart, call.expression);
        const span = callee ? source.callExpression(callee) ?? callee : null;
        bump(audit.projections, span ? 'unresolved-call-expression' : 'unresolved-call-unlocated');
        const reason = UNRESOLVED_REASON[call.reason] ?? (REASON.test(call.reason ?? '') ? call.reason : 'UNRESOLVED_TARGET');
        emit(CALL_CELL[language], node.path, span, { kind: 'FACT', relationKind: 'CALLS', resolution: 'UNRESOLVED', reasonCode: reason }, 'unresolved-call');
      }
    } else if (language === 'sql' && node.type === 'DB_TABLE') {
      emit('SQL-S', node.path, nodeSpan(node), { kind: 'FACT', relationKind: 'SYMBOL', resolution: 'STATIC_RESOLVED', targets: ['sql:' + node.key.replace(/^table:/, '')] }, 'node');
      bump(audit.unmappedByType, 'sql-column-without-span', (node.metadata?.columns ?? []).length);
    } else if ((language === 'ts' || language === 'js') && node.type === 'COMPONENT') {
      emit(UI_CELL[language], node.path, nodeSpan(node), { kind: 'FACT', relationKind: 'FRAMEWORK', resolution: 'STATIC_RESOLVED',
        targets: [language + ':' + node.key.replace(/^component:/, '')] }, 'node');
      for (const call of node.metadata?.apiCalls ?? []) {
        const source = sources.get(node.path);
        const span = ['\'', '"', '`'].map(quote => source?.textOnLine(call.lineStart, quote + call.url + quote)).find(Boolean) ?? null;
        bump(audit.projections, span ? 'http-call-url-literal' : 'http-call-line-fallback');
        emit(UI_CELL[language], node.path, span ?? source?.lineSpan(call.lineStart, call.lineStart) ?? null,
          { kind: 'FACT', relationKind: 'FRAMEWORK', resolution: 'STATIC_RESOLVED', targets: ['http-call:' + call.method + ' ' + call.url] }, 'api-call');
      }
    } else bump(audit.unmappedByType, 'node:' + node.type);
  }
  // Inheritance declarations (J-S inheritance-span) and calls.
  const candidateGroups = new Map();
  for (const edge of dump.edges) {
    const from = nodes.get(edge.source), to = nodes.get(edge.target), language = ok(from?.path);
    if ((edge.type === 'EXTENDS' || edge.type === 'IMPLEMENTS') && language === 'java') {
      emit('J-S', from.path, nodeSpan(from), { kind: 'FACT', relationKind: 'SYMBOL', resolution: 'STATIC_RESOLVED',
        targets: [edge.type.toLowerCase() + ' ' + edge.target] }, 'edge');
    } else if (edge.type === 'CALLS' && CALL_CELL[language]) {
      const source = sources.get(from.path);
      let span = null;
      const line = edge.metadata?.lineStart, expression = edge.metadata?.expression;
      if (line != null && expression) {
        const callee = source?.textOnLine(line, expression);
        span = callee ? source.callExpression(callee) ?? null : null;
        bump(audit.projections, span ? 'call-expression' : 'call-declaration-fallback');
      } else bump(audit.projections, 'call-declaration-no-callsite-evidence');
      span ??= nodeSpan(from);
      if (edge.confidence === 'CONFIRMED') {
        emit(CALL_CELL[language], from.path, span, { kind: 'FACT', relationKind: 'CALLS', resolution: 'STATIC_RESOLVED', targets: [edge.target] }, 'edge');
      } else group(CALL_CELL[language], 'CALLS', from.path, span, edge.target);
    } else if (edge.type === 'CONSUMES' && to?.type === 'API_ENDPOINT') {
      const endpoint = dump.endpoints.find(item => item.nodeKey === to.key);
      const target = namespaceOf(to.path) + ':route:' + (endpoint?.method ?? '?') + ' ' + (endpoint?.path ?? '?');
      let span = null;
      const calls = (from?.metadata?.apiCalls ?? []).filter(call => call.method === endpoint?.method);
      if (from?.type === 'COMPONENT' && calls.length === 1) {
        const source = sources.get(from.path);
        span = ['\'', '"', '`'].map(quote => source?.textOnLine(calls[0].lineStart, quote + calls[0].url + quote)).find(Boolean) ?? null;
      }
      bump(audit.projections, span ? 'consumes-single-call-url-literal' : 'consumes-source-declaration');
      span ??= nodeSpan(from);
      if (edge.confidence === 'CONFIRMED') emit('X-HTTP', from.path, span, { kind: 'FACT', relationKind: 'HTTP_CONTRACT', resolution: 'STATIC_RESOLVED', targets: [target] }, 'edge');
      else group('X-HTTP', 'HTTP_CONTRACT', from.path, span, target);
    } else if ((edge.type === 'MAPS_TO' || edge.type === 'READS_WRITES') && to?.type === 'DB_TABLE') {
      const target = namespaceOf(to.path) + ':sql:' + to.key.replace(/^table:/, '');
      if (edge.confidence === 'CONFIRMED') emit('X-DATA', from.path, nodeSpan(from), { kind: 'FACT', relationKind: 'DATA_CONTRACT', resolution: 'STATIC_RESOLVED', targets: [target] }, 'edge');
      else group('X-DATA', 'DATA_CONTRACT', from.path, nodeSpan(from), target);
    } else bump(audit.unmappedByType, 'edge:' + edge.type);
  }
  function group(cellId, relationKind, file, span, target) {
    const key = stableJson([cellId, relationKind, file, span?.start ?? null, span?.end ?? null]);
    if (!candidateGroups.has(key)) candidateGroups.set(key, { cellId, relationKind, file, span, targets: [] });
    candidateGroups.get(key).targets.push(target);
  }
  for (const item of candidateGroups.values()) {
    const targets = [...new Set(item.targets)].sort();
    // More than five candidates is a contract violation; emit unchanged so the runner rejects it.
    if (targets.length > 5) audit.candidateSetsOverFive++;
    emit(item.cellId, item.file, item.span, { kind: 'CANDIDATES', relationKind: item.relationKind, resolution: 'INFERRED', targets }, 'candidate-set');
  }
  for (const endpoint of dump.endpoints) {
    const node = nodes.get(endpoint.nodeKey), language = ok(node?.path);
    const cellId = language === 'java' ? 'J-F' : language === 'ts' || language === 'js' ? 'T-F' : null;
    if (!cellId) { bump(audit.unmappedByType, 'endpoint-without-source'); continue; }
    emit(cellId, node.path, nodeSpan(node), { kind: 'FACT', relationKind: 'FRAMEWORK', resolution: 'STATIC_RESOLVED',
      targets: ['route:' + endpoint.method + ' ' + endpoint.path] }, 'endpoint');
  }
  for (const entity of dump.entities) {
    const node = nodes.get(entity.nodeKey);
    if (entity.source !== 'JPA' || ok(node?.path) !== 'java') { bump(audit.unmappedByType, 'entity:' + entity.source); continue; }
    emit('J-D', node.path, nodeSpan(node), { kind: 'FACT', relationKind: 'FRAMEWORK', resolution: 'STATIC_RESOLVED',
      targets: ['jpa:' + node.key.replace(/^entity:/, '') + ' -> sql:' + entity.tableName] }, 'entity');
  }
  for (const route of dump.routes) {
    const node = nodes.get(route.nodeKey), language = ok(node?.path);
    if (!UI_CELL[language]) { bump(audit.unmappedByType, 'route-without-ui-source'); continue; }
    const span = nodeSpan(node);
    emit(UI_CELL[language], node.path, span, { kind: 'FACT', relationKind: 'FRAMEWORK', resolution: 'STATIC_RESOLVED', targets: ['ui-route:' + route.path] }, 'route');
    // The route->component binding is its own published edge with its own confidence.
    const bindings = dump.edges.filter(edge => edge.source === route.nodeKey && edge.type === 'CONTAINS' && nodes.get(edge.target)?.type === 'COMPONENT');
    for (const binding of bindings) {
      const target = 'ui-route:' + route.path + ' -> ' + language + ':' + binding.target.replace(/^component:/, '');
      if (binding.confidence === 'CONFIRMED') emit(UI_CELL[language], node.path, span, { kind: 'FACT', relationKind: 'FRAMEWORK', resolution: 'STATIC_RESOLVED', targets: [target] }, 'route-binding');
      else group(UI_CELL[language], 'FRAMEWORK', node.path, span, target);
    }
    if (route.componentKey && bindings.length === 0) bump(audit.unmappedByType, 'route-component-name-without-binding-edge');
  }
  for (const item of [...candidateGroups.values()].filter(item => item.relationKind === 'FRAMEWORK')) {
    candidateGroups.delete(stableJson([item.cellId, item.relationKind, item.file, item.span?.start ?? null, item.span?.end ?? null]));
    const targets = [...new Set(item.targets)].sort();
    if (targets.length > 5) audit.candidateSetsOverFive++;
    emit(item.cellId, item.file, item.span, { kind: 'CANDIDATES', relationKind: item.relationKind, resolution: 'INFERRED', targets }, 'candidate-set');
  }
  // Coverage: exactly one outcome per declared (file, capability) pair.
  const outcomes = manifest.eligibility.map(item => {
    const row = files.get(item.path), parser = item.cellId.endsWith('-P');
    const base = { path: item.path, cellId: item.cellId, owner: item.owner };
    if (!item.eligible) return { ...base, status: 'EXCLUDED', bytesRead: 0, reasonCode: item.exclusionReason };
    if (!row) return { ...base, status: 'FAILED', bytesRead: 0, reasonCode: 'NOT_INVENTORIED' };
    const bytesRead = Number(row.size), reason = REASON.test(row.analysisReason ?? '') ? row.analysisReason : 'PRODUCT_REASON_UNAVAILABLE';
    if (row.analysisStatus === 'SUCCESS' || (parser && row.analysisStatus === 'PARTIAL')) return { ...base, status: 'SUCCESS', bytesRead, reasonCode: null };
    if (parser && row.analysisStatus === 'FAILED' && SYNTAX_REASONS.has(row.analysisReason)) return { ...base, status: 'SUCCESS', bytesRead, reasonCode: null };
    if (row.analysisStatus === 'PARTIAL') return { ...base, status: 'PARTIAL', bytesRead, reasonCode: reason };
    if (row.analysisStatus === 'FAILED') return { ...base, status: 'FAILED', bytesRead, reasonCode: reason };
    if (row.analysisStatus === 'UNSUPPORTED') return { ...base, status: 'UNSUPPORTED', bytesRead, reasonCode: reason };
    if (row.analysisStatus === 'TARGETED') return { ...base, status: 'PENDING', bytesRead, reasonCode: 'PRODUCT_OUTCOME_PENDING' };
    return { ...base, status: 'PARTIAL', bytesRead, reasonCode: 'PRODUCT_OUTCOME_UNMEASURED' };
  });
  const executionState = dump.executionState === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
  const run = { fixtureId: manifest.fixtureId, sourceDigest: sourceDigest(manifest.source), executionState,
    reasonCode: executionState === 'COMPLETED' ? null : REASON.test(dump.failureCode ?? '') ? dump.failureCode : 'PRODUCT_EXECUTION_FAILED',
    versions: manifest.versions, facts, outcomes };
  audit.outsideRoster = [...new Set(audit.outsideRoster)].sort();
  return { run, audit };
}

// Comparison of two dumps on the fields both paths expose through the product API.
function apiVisible(dump) {
  const strip = value => value === undefined ? null : value;
  return {
    files: dump.files.map(f => [f.path, Number(f.size), strip(f.analysisStatus), strip(f.analysisReason)]).sort(),
    nodes: dump.nodes.filter(n => n.type !== 'DIRECTORY').map(n => [n.type, n.key, strip(n.path), strip(n.lineStart), strip(n.lineEnd)]).sort(),
    edges: dump.edges.map(e => [e.type, e.source, e.target, e.confidence]).sort(),
    endpoints: dump.endpoints.map(e => [e.nodeKey, e.method, e.path, e.handlerKey]).sort(),
    entities: dump.entities.map(e => [e.nodeKey, e.entityName, e.tableName]).sort(),
  };
}
function compareDumps(left, right) {
  const a = apiVisible(left), b = apiVisible(right), result = {};
  for (const key of Object.keys(a)) {
    const x = new Set(a[key].map(item => JSON.stringify(item))), y = new Set(b[key].map(item => JSON.stringify(item)));
    result[key] = { left: x.size, right: y.size, onlyLeft: [...x].filter(item => !y.has(item)).map(item => JSON.parse(item)),
      onlyRight: [...y].filter(item => !x.has(item)).map(item => JSON.parse(item)) };
  }
  result.equal = Object.values(result).every(item => item.onlyLeft.length === 0 && item.onlyRight.length === 0);
  return result;
}
// Remove fields that only the backend DB path can see (edge metadata), for an API-equivalent conversion.
const apiProjection = dump => ({ ...dump, edges: dump.edges.map(edge => ({ ...edge, metadata: {} })) });

function writeBundle({ root, corpus, capabilities, dumps, build, execution }) {
  const corpusBytes = fs.readFileSync(corpus), corpusJson = JSON.parse(corpusBytes.toString('utf8'));
  const fixtures = new Map(corpusJson.fixtures.map(reference => { const fixture = readFixture(corpus, reference); return [fixture.manifest.fixtureId, fixture]; }));
  const runs = [], audits = [];
  for (const [fixtureId, fixture] of fixtures) {
    const dump = dumps.get(fixtureId);
    if (!dump) throw Object.assign(new Error('DUMP_MISSING'), { code: 'DUMP_MISSING' });
    const converted = convertFixture(fixture, dump, 'f' + runs.length + '.p'); runs.push(converted.run); audits.push(converted.audit);
  }
  const productBuildSha256 = sha256(Buffer.from(stableJson(build)));
  const observations = { contractVersion: '1.0.0', bundleId: 'product-' + execution.nonce.slice(0, 16),
    provenance: { kind: 'PRODUCT_CAPTURE', producerVersion: ADAPTER_VERSION, captureAttestation: 'EXTERNAL_ATTESTATION', productBuildSha256 },
    corpusSha256: sha256(corpusBytes), capabilityManifestSha256: sha256(fs.readFileSync(capabilities)), runs };
  const bundle = path.join(root, 'bundle'); fs.mkdirSync(bundle, { mode: 0o700 });
  const observationText = JSON.stringify(observations, null, 2) + '\n';
  fs.writeFileSync(path.join(bundle, 'observations.json'), observationText, { flag: 'wx', mode: 0o600 });
  const attestation = { contractVersion: '1.0.0', attestationId: 'attest-' + execution.nonce, kind: build.path,
    productBuildSha256, build, observationsSha256: sha256(Buffer.from(observationText)),
    corpusSha256: observations.corpusSha256, capabilityManifestSha256: observations.capabilityManifestSha256,
    runs: [...fixtures.values()].map(fixture => ({ fixtureId: fixture.manifest.fixtureId, sourceDigest: sourceDigest(fixture.manifest.source),
      consumedSources: dumps.get(fixture.manifest.fixtureId).consumedSources.map(item => ({ path: item.path, sha256: item.sha256, bytes: Number(item.bytes) }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      executionState: dumps.get(fixture.manifest.fixtureId).executionState === 'COMPLETED' ? 'COMPLETED' : 'FAILED' })),
    execution: { ...execution, adapterVersion: ADAPTER_VERSION } };
  const attestationText = JSON.stringify(attestation, null, 2) + '\n';
  fs.writeFileSync(path.join(bundle, 'attestation.json'), attestationText, { flag: 'wx', mode: 0o600 });
  const auditText = JSON.stringify({ format: 'accuracy-evidence-audit/1', productBuildSha256, fixtures: audits }, null, 2) + '\n';
  fs.writeFileSync(path.join(bundle, 'evidence-audit.json'), auditText, { flag: 'wx', mode: 0o600 });
  return { directory: bundle, productBuildSha256, observationsSha256: attestation.observationsSha256,
    attestationSha256: sha256(Buffer.from(attestationText)), evidenceAuditSha256: sha256(Buffer.from(auditText)),
    facts: runs.reduce((total, run) => total + run.facts.length, 0) };
}

module.exports = { ADAPTER_VERSION, treeDigest, gitBlobSha1, Source, readFixture, convertFixture, writeBundle, compareDumps,
  apiProjection, apiVisible, sha256 };
