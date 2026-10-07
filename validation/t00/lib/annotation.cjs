'use strict';

// Deterministic gold authoring for T00 fixtures. Spans come only from the source bytes and a
// human-written spec (inline markers or text anchors). There is no input path for product
// observations or dumps: such inputs are refused, and no command updates an existing fixture.
const fs = require('node:fs');
const path = require('node:path');
const { ContractError, requireThat } = require('./errors.cjs');
const { parseJson, stableJson } = require('./json.cjs');
const { sha256, relativePath } = require('./safe-io.cjs');
const { CELLS } = require('./policy.cjs');

const SPEC_FORMAT = 't00-annotation-spec/1', RECORD_FORMAT = 't00-annotation-record/1';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const MARKER = /\[\[(\/?)@([A-Za-z0-9][A-Za-z0-9_.-]{0,95})\]\]/g;
// Keys that only product observations, product dumps or graph rows carry. A spec containing
// them was derived from product output and is refused before any byte is written.
const PRODUCT_KEYS = new Set(['observationId', 'runs', 'facts', 'provenance', 'captureAttestation', 'productBuildSha256',
  'naturalKey', 'metadataJson', 'confidence', 'nodeKey', 'handlerKey', 'componentKey', 'consumedSources', 'outcomes']);
const LANGUAGES = [[/\.java$/, 'java'], [/\.(?:[cm]?ts|tsx)$/, 'ts'], [/\.(?:[cm]?js|jsx)$/, 'js'], [/\.sql$/, 'sql']];
const CELL_LANGUAGES = { J: ['java'], T: ['ts'], JS: ['js'], SQL: ['sql'], 'X-HTTP': ['ts', 'js', 'java'], 'X-DATA': ['java', 'sql'] };

const languageOf = file => (LANGUAGES.find(([pattern]) => pattern.test(file.toLowerCase())) ?? [null, 'other'])[1];
function cellLanguages(cellId) {
  if (CELL_LANGUAGES[cellId]) return CELL_LANGUAGES[cellId];
  return CELL_LANGUAGES[cellId.split('-')[0]] ?? [];
}

function refuseProductShape(value, trail = 'spec') {
  if (Array.isArray(value)) { value.forEach(item => refuseProductShape(item, trail)); return; }
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    requireThat(!PRODUCT_KEYS.has(key), 'PRODUCT_OUTPUT_INPUT_REFUSED');
    refuseProductShape(value[key], trail + '.' + key);
  }
}

function looksLikeProductOutput(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return false; }
  if (value === null || typeof value !== 'object') return false;
  return (typeof value.format === 'string' && value.format.startsWith('code-intelligence-accuracy-product-dump'))
    || (Array.isArray(value.runs) && value.provenance != null) || value.observationsSha256 != null;
}

function listFiles(root) {
  const files = [];
  (function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      requireThat(!stat.isSymbolicLink(), 'SYMLINK_REJECTED');
      if (stat.isDirectory()) walk(file);
      else { requireThat(stat.isFile() && stat.nlink === 1, 'SPECIAL_FILE_REJECTED'); files.push(path.relative(root, file).split(path.sep).join('/')); }
    }
  })(root);
  return files.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

// Strip [[@id]] ... [[/@id]] markers; spans are byte offsets in the stripped output.
function stripMarkers(bytes) {
  const text = bytes.toString('utf8');
  requireThat(Buffer.from(text, 'utf8').equals(bytes), 'INVALID_UTF8');
  const spans = new Map(), open = new Map();
  let output = '', last = 0, offset = 0;
  for (const match of text.matchAll(MARKER)) {
    const chunk = text.slice(last, match.index);
    output += chunk; offset += Buffer.byteLength(chunk); last = match.index + match[0].length;
    const [, closing, id] = match;
    if (!closing) {
      requireThat(!open.has(id) && !spans.has(id), 'DUPLICATE_MARKER');
      open.set(id, offset);
    } else {
      requireThat(open.has(id), 'UNBALANCED_MARKER');
      spans.set(id, { start: open.get(id), end: offset }); open.delete(id);
    }
  }
  output += text.slice(last);
  requireThat(open.size === 0, 'UNBALANCED_MARKER');
  requireThat(!/\[\[\/?@/.test(output), 'MARKER_RESIDUE');
  return { bytes: Buffer.from(output, 'utf8'), spans };
}

function occurrences(bytes, needle, from = 0) {
  const result = [], target = Buffer.from(needle, 'utf8');
  requireThat(target.length > 0, 'EMPTY_ANCHOR');
  for (let index = bytes.indexOf(target, from); index !== -1; index = bytes.indexOf(target, index + 1)) result.push(index);
  return result;
}

function select(selector, files, markers) {
  if (selector.marker != null) {
    requireThat(markers.has(selector.marker), 'MARKER_NOT_FOUND');
    return markers.get(selector.marker);
  }
  const file = files.get(selector.file);
  requireThat(file != null, 'SELECT_FILE_NOT_FOUND');
  if (selector.wholeFile === true) return { path: selector.file, start: 0, end: file.length };
  if (selector.text != null) {
    const found = occurrences(file, selector.text), nth = selector.occurrence ?? 1;
    requireThat(Number.isSafeInteger(nth) && nth >= 1 && found.length >= nth, 'ANCHOR_NOT_FOUND');
    requireThat(selector.occurrence != null || found.length === 1, 'ANCHOR_AMBIGUOUS');
    return { path: selector.file, start: found[nth - 1], end: found[nth - 1] + Buffer.byteLength(selector.text) };
  }
  requireThat(selector.from != null && selector.to != null, 'SELECTOR_INVALID');
  const starts = occurrences(file, selector.from), nth = selector.fromOccurrence ?? 1;
  requireThat(Number.isSafeInteger(nth) && nth >= 1 && starts.length >= nth, 'ANCHOR_NOT_FOUND');
  requireThat(selector.fromOccurrence != null || starts.length === 1, 'ANCHOR_AMBIGUOUS');
  const start = starts[nth - 1], ends = occurrences(file, selector.to, start), endNth = selector.toOccurrence ?? 1;
  requireThat(Number.isSafeInteger(endNth) && endNth >= 1 && ends.length >= endNth, 'ANCHOR_NOT_FOUND');
  return { path: selector.file, start, end: ends[endNth - 1] + Buffer.byteLength(selector.to) };
}

function loadSpec(specFile) {
  const bytes = fs.readFileSync(specFile);
  const spec = parseJson(bytes);
  requireThat(spec.format === SPEC_FORMAT, 'SPEC_FORMAT_UNSUPPORTED');
  refuseProductShape(spec);
  requireThat(spec.annotator && ID.test(spec.annotator.id) && ['HUMAN', 'AGENT'].includes(spec.annotator.kind), 'SPEC_ANNOTATOR_INVALID');
  requireThat(Array.isArray(spec.cases) && spec.cases.length > 0, 'EMPTY_ORACLE');
  return { spec, specSha256: sha256(bytes) };
}

// Resolve every case span. Used by build and by the two-annotator comparison.
function resolveSpec(specFile) {
  const { spec, specSha256 } = loadSpec(specFile), fixture = spec.fixture;
  requireThat(fixture && ID.test(fixture.fixtureId) && ['ANCHOR', 'INLINE_MARKERS'].includes(fixture.sourceMode), 'SPEC_FIXTURE_INVALID');
  const sourceRoot = path.resolve(path.dirname(specFile), fixture.sourceRoot);
  const prefix = fixture.sourcePrefix ?? 'source';
  requireThat(ID.test(prefix), 'SPEC_FIXTURE_INVALID');
  const exclude = new Set(fixture.exclude ?? []);
  const files = new Map(), annotated = [], markers = new Map();
  for (const file of listFiles(sourceRoot)) {
    if (exclude.has(file)) continue;
    relativePath(file);
    const raw = fs.readFileSync(path.join(sourceRoot, file));
    requireThat(!looksLikeProductOutput(raw), 'PRODUCT_OUTPUT_INPUT_REFUSED');
    annotated.push({ path: file, sha256: sha256(raw) });
    if (fixture.sourceMode === 'INLINE_MARKERS') {
      const stripped = stripMarkers(raw);
      files.set(file, stripped.bytes);
      for (const [id, span] of stripped.spans) {
        requireThat(!markers.has(id), 'DUPLICATE_MARKER');
        markers.set(id, { path: file, ...span });
      }
    } else {
      requireThat(!MARKER.test(raw.toString('utf8')), 'UNEXPECTED_MARKER'); MARKER.lastIndex = 0;
      files.set(file, raw);
    }
  }
  requireThat(files.size > 0, 'EMPTY_SOURCE_ROOT');
  const namespaceOf = file => {
    const rule = (fixture.namespaces ?? []).filter(item => file.startsWith(item.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    requireThat(rule != null && ID.test(rule.namespace), 'NAMESPACE_UNDECLARED');
    return rule.namespace;
  };
  const caseIds = new Set();
  const cases = spec.cases.map(item => {
    requireThat(ID.test(item.caseId) && !caseIds.has(item.caseId), 'DUPLICATE_ID'); caseIds.add(item.caseId);
    requireThat(item.select && typeof item.select === 'object', 'SELECTOR_INVALID');
    const span = select(item.select, files, markers);
    const text = files.get(span.path).subarray(span.start, span.end);
    if (item.expectText != null) requireThat(text.equals(Buffer.from(item.expectText, 'utf8')), 'SPAN_TEXT_MISMATCH');
    if (item.expectSha256 != null) requireThat(sha256(text) === item.expectSha256, 'SPAN_TEXT_MISMATCH');
    return { item, span, spanSha256: sha256(text) };
  });
  return { spec, specSha256, fixture, prefix, files, annotated, cases, namespaceOf };
}

function caseRecord(resolved, entry) {
  const { item, span } = entry, file = resolved.prefix + '/' + span.path, bytes = resolved.files.get(span.path);
  return { caseId: item.caseId, cellId: item.cellId, patternId: item.patternId, stratum: item.stratum ?? null,
    kind: item.kind, relationKind: item.relationKind, polarity: item.polarity,
    source: { path: file, sha256: sha256(bytes), namespace: resolved.namespaceOf(span.path), start: span.start, end: span.end },
    expected: { resolution: item.expected.resolution, targets: item.expected.targets ?? [], valid: item.expected.valid ?? null,
      diagnostics: item.expected.diagnostics ?? [], reasonCode: item.expected.reasonCode ?? null },
    mustNotEmitResolved: item.mustNotEmitResolved, rationale: item.rationale };
}

const json = value => JSON.stringify(value, null, 2) + '\n';
function writeNewFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 });
  return sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
}

function build(specFile, outputDirectory, toolSha256) {
  const resolved = resolveSpec(specFile), { spec, fixture } = resolved;
  requireThat(!fs.existsSync(outputDirectory), 'OUTPUT_EXISTS');
  const capabilities = [...new Set(fixture.capabilities)];
  requireThat(capabilities.every(cellId => CELLS.some(cell => cell.cellId === cellId)), 'UNKNOWN_CELL');
  const source = [...resolved.files].map(([file, bytes]) => ({ path: resolved.prefix + '/' + file, sha256: sha256(bytes),
    bytes: bytes.length, namespace: resolved.namespaceOf(file) }));
  const overrides = new Map((fixture.eligibility?.overrides ?? []).map(item => [item.path + '\n' + item.cellId, item]));
  const eligibility = [];
  for (const meta of source) for (const cellId of capabilities) {
    const relative = meta.path.slice(resolved.prefix.length + 1), override = overrides.get(relative + '\n' + cellId);
    const eligible = override ? override.eligible : cellLanguages(cellId).includes(languageOf(relative));
    eligibility.push({ path: meta.path, cellId, owner: fixture.owner ?? 'fixture-declared', eligible,
      exclusionReason: eligible ? null : override?.exclusionReason ?? 'NOT_IN_CELL_LANGUAGE' });
  }
  const records = resolved.cases.map(entry => caseRecord(resolved, entry));
  const gold = { contractVersion: '1.0.0', fixtureId: fixture.fixtureId, cases: records.filter(item => item.polarity === 'POSITIVE') };
  const negatives = { contractVersion: '1.0.0', fixtureId: fixture.fixtureId, cases: records.filter(item => item.polarity !== 'POSITIVE') };
  const goldBytes = json(gold), negativeBytes = json(negatives);
  const review = { contractVersion: '1.0.0', fixtureId: fixture.fixtureId,
    author: { id: spec.annotator.id, kind: spec.annotator.kind, method: 'SOURCE_AUTHORED' }, status: 'AUTHOR_PROVISIONAL',
    goldSha256: sha256(Buffer.from(goldBytes)), negativesSha256: sha256(Buffer.from(negativeBytes)), reviews: [], adjudicator: null };
  const reviewBytes = json(review);
  const patterns = [];
  for (const item of records) {
    if (!patterns.some(p => p.cellId === item.cellId && p.patternId === item.patternId && p.stratum === item.stratum)) {
      patterns.push({ cellId: item.cellId, patternId: item.patternId, stratum: item.stratum });
    }
  }
  const manifest = { contractVersion: '1.0.0', fixtureId: fixture.fixtureId, fixtureVersion: fixture.fixtureVersion,
    corpusId: fixture.corpusId, license: fixture.license, origin: fixture.origin, scenarioFamilyId: fixture.scenarioFamilyId,
    generatorFamilyId: fixture.generatorFamilyId, split: fixture.split, versions: fixture.versions, capabilities, patterns,
    source, eligibility,
    gold: { path: 'gold.json', sha256: review.goldSha256 }, negatives: { path: 'negatives.json', sha256: review.negativesSha256 },
    review: { path: 'review.json', sha256: sha256(Buffer.from(reviewBytes)) } };
  fs.mkdirSync(outputDirectory, { mode: 0o755 });
  for (const [file, bytes] of resolved.files) writeNewFile(path.join(outputDirectory, resolved.prefix, file), bytes);
  writeNewFile(path.join(outputDirectory, 'gold.json'), goldBytes);
  writeNewFile(path.join(outputDirectory, 'negatives.json'), negativeBytes);
  writeNewFile(path.join(outputDirectory, 'review.json'), reviewBytes);
  const manifestSha256 = writeNewFile(path.join(outputDirectory, 'fixture.json'), json(manifest));
  const record = { format: RECORD_FORMAT, fixtureId: fixture.fixtureId, toolSha256, specSha256: resolved.specSha256,
    annotator: spec.annotator, provenanceNote: spec.provenanceNote ?? null, annotatedSources: resolved.annotated,
    goldSha256: review.goldSha256, negativesSha256: review.negativesSha256,
    cases: resolved.cases.map(({ item, span, spanSha256 }) => ({ caseId: item.caseId, path: resolved.prefix + '/' + span.path,
      start: span.start, end: span.end, spanSha256 })) };
  writeNewFile(path.join(outputDirectory, 'annotation-record.json'), json(record));
  return { fixtureId: fixture.fixtureId, manifestSha256, cases: records.length,
    positive: gold.cases.length, negativeOrAmbiguous: negatives.cases.length };
}

// Two independent annotators author separate specs for the same fixture; disagreements go to
// a third adjudicator. Matching is by caseId; a span or expectation difference is a disagreement.
function compare(specA, specB) {
  const a = resolveSpec(specA), b = resolveSpec(specB);
  requireThat(a.fixture.fixtureId === b.fixture.fixtureId, 'FIXTURE_ID_MISMATCH');
  requireThat(a.spec.annotator.id !== b.spec.annotator.id, 'SAME_ANNOTATOR');
  const index = resolved => new Map(resolved.cases.map(entry => [entry.item.caseId, caseRecord(resolved, entry)]));
  const left = index(a), right = index(b), disagreements = [];
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const x = left.get(id), y = right.get(id);
    if (!x || !y) { disagreements.push({ caseId: id, kind: x ? 'ONLY_A' : 'ONLY_B' }); continue; }
    const fields = [];
    if (x.source.path !== y.source.path || x.source.start !== y.source.start || x.source.end !== y.source.end) fields.push('span');
    for (const key of ['cellId', 'patternId', 'stratum', 'kind', 'relationKind', 'polarity', 'mustNotEmitResolved']) if (x[key] !== y[key]) fields.push(key);
    if (stableJson(x.expected) !== stableJson(y.expected)) fields.push('expected');
    if (fields.length) disagreements.push({ caseId: id, kind: 'DIFFERENT', fields });
  }
  const agreed = [...left.keys()].filter(id => right.has(id) && !disagreements.some(item => item.caseId === id)).length;
  return { fixtureId: a.fixture.fixtureId, annotators: [a.spec.annotator.id, b.spec.annotator.id], casesA: left.size,
    casesB: right.size, agreed, disagreements, agreement: agreed / Math.max(1, new Set([...left.keys(), ...right.keys()]).size) };
}

module.exports = { SPEC_FORMAT, RECORD_FORMAT, stripMarkers, select, resolveSpec, build, compare, languageOf, cellLanguages,
  refuseProductShape, looksLikeProductOutput, ContractError };
