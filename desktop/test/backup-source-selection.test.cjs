'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { normalizeSourceSelection, sourceSelectionSha256, createBackupSourceInventory } = require('../src/backup-source-selection.cjs');
const { createBackupExportPolicy, REVIEWED_SCHEMA } = require('../src/backup-export-policy.cjs');

const POLICY = createBackupExportPolicy(REVIEWED_SCHEMA);
const P = '9007199254740993', Q = '9007199254740995', S = '9007199254740994', T = '9007199254740996';
const UUID = '11111111-2222-4333-8444-555555555555', OTHER_UUID = '21111111-2222-4333-8444-555555555555';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const STAMP = '2026-10-03T00:00:00.123456Z';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function frozen(value) { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
function safe(error) { assert.ok(error instanceof Error); assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.message, /private-path|credential-sentinel|synthetic-secret|SELECT/); return true; }
const rejects = fn => assert.throws(fn, safe);
function row(table, changes = {}) {
  const values = {};
  const definition = REVIEWED_SCHEMA.tables.find(t => t.name === table);
  for (const c of definition.columns.filter(c => POLICY.columnsFor(table).includes(c.name))) {
    values[c.name] = c.nullable ? null : c.type === 'bigint' ? '1' : c.type === 'integer' ? 1 : c.type === 'timestamptz' ? STAMP
      : c.type === 'uuid' ? UUID : c.type.startsWith('char(') ? 'a'.repeat(Number(c.type.slice(5, -1))) : 'synthetic';
  }
  const defaults = { projects: { id: P, current_snapshot_id: S, source_type: 'LOCAL' }, snapshots: { id: S, project_id: P, commit_sha: A, status: 'READY', source_contract_version: 0 },
    files: { snapshot_id: S, path: 'src/main.ts', size: '3', content_hash: git(Buffer.from('abc')) },
    commits: { project_id: P, sha: B }, branches: { project_id: P, name: 'main', head_sha: C },
    source_blobs: { project_id: P, sha256: sha(Buffer.from('abc')), byte_size: '3', key_id: 'a'.repeat(32) },
    source_manifests: { project_id: P, snapshot_id: S, source_kind: 'LOCAL', file_count: 1, byte_size: '3', sealed_at: STAMP },
    source_manifest_entries: { manifest_id: UUID, project_id: P, path: 'src/main.ts', blob_sha256: sha(Buffer.from('abc')), git_oid: git(Buffer.from('abc')), byte_size: '3' } };
  return POLICY.projectRow(table, Object.assign(values, defaults[table], changes));
}
function collect(input) { const collector = createBackupSourceInventory(); input.forEach(r => collector.add(r)); return collector.finish(); }
function legacy() { return [row('projects'), row('snapshots'), row('files'), row('commits'), row('branches')]; }
function retained() { return [row('projects'), row('snapshots', { source_contract_version: 1 }), row('files'), row('source_blobs'), row('source_manifests'), row('source_manifest_entries')]; }
function selection() { return { snapshots: [{ snapshotId: S, commitOid: A, files: [{ path: 'src/main.ts', gitOid: git(Buffer.from('abc')), byteSize: 3 }] }],
  commits: [B], branches: [{ name: 'main', headOid: C }], headOid: A }; }

test('normalization owns its data, preserves exact IDs, and produces the Java helper insertion-order digest', () => {
  const input = selection(); input.snapshots.unshift({ snapshotId: '10', commitOid: D, files: [{ path: '😀.ts', gitOid: A, byteSize: 0 }, { path: 'Ω.ts', gitOid: B, byteSize: 2 }] });
  input.commits.unshift(D); input.branches.unshift({ name: 'zebra', headOid: D }); const before = clone(input);
  const output = normalizeSourceSelection(frozen(input));
  assert.deepEqual(output.snapshots.map(s => s.snapshotId), ['10', S]); assert.equal(output.snapshots[1].snapshotId, S);
  assert.deepEqual(output.snapshots[0].files.map(f => f.path), ['Ω.ts', '😀.ts']); assert.deepEqual(output.commits, [B, D]);
  assert.deepEqual(output.branches.map(b => b.name), ['main', 'zebra']); assert.deepEqual(input, before);
  assert.notEqual(output.snapshots, input.snapshots); assert.notEqual(output.snapshots[1].files, input.snapshots[0].files);
  assert.equal(sourceSelectionSha256(input), sha(JSON.stringify(output)));
  const reordered = clone(before); reordered.snapshots.reverse(); reordered.commits.reverse(); reordered.branches.reverse();
  reordered.snapshots.forEach(s => s.files.reverse()); assert.equal(sourceSelectionSha256(reordered), sourceSelectionSha256(input));
});

test('empty selection is explicit and hashes the exact empty helper wire representation', () => {
  const empty = { snapshots: [], commits: [], branches: [], headOid: null };
  assert.deepEqual(normalizeSourceSelection(empty), empty);
  assert.equal(sourceSelectionSha256(empty), sha('{"snapshots":[],"commits":[],"branches":[],"headOid":null}'));
});

for (const input of ['../private-path', '/private-path', 'a/../b', 'a//b', '.git/config', 'a/.GIT/config', 'a\\b', 'a:b',
  'a%2fb', 'a%2Eb', 'a%5Cb', 'a\0b', 'a\nb', 'e\u0301.ts', '\ud800.ts', 'a/'.repeat(64) + 'b']) {
  test('selection rejects unsafe, non-NFC or excessive-depth paths', () => { const s = selection(); s.snapshots[0].files[0].path = input; rejects(() => normalizeSourceSelection(s)); });
}

for (const name of ['.hidden', 'main.lock', 'main..next', 'main@{1}', 'a b', 'a~b', 'a^b', 'a?b', 'a*b', 'a[b', 'main.', '.git/main']) {
  test(`selection rejects invalid Git ref ${JSON.stringify(name)}`, () => { const s = selection(); s.branches[0].name = name; rejects(() => normalizeSourceSelection(s)); });
}

for (const [name, mutate] of [
  ['unknown root field', s => { s.credentials = 'synthetic-secret'; }], ['unknown snapshot field', s => { s.snapshots[0].localRoot = 'private-path'; }],
  ['unknown file field', s => { s.snapshots[0].files[0].executable = true; }], ['unknown branch field', s => { s.branches[0].force = true; }],
  ['numeric snapshot ID', s => { s.snapshots[0].snapshotId = Number(S); }], ['snapshot overflow', s => { s.snapshots[0].snapshotId = '9223372036854775808'; }],
  ['uppercase OID', s => { s.commits[0] = B.toUpperCase(); }], ['SHA256 in Git OID field', s => { s.commits[0] = 'a'.repeat(64); }],
  ['negative source size', s => { s.snapshots[0].files[0].byteSize = -1; }], ['oversize source file', s => { s.snapshots[0].files[0].byteSize = 2097153; }],
  ['missing head binding', s => { s.headOid = D; }], ['duplicate snapshot', s => { s.snapshots.push(clone(s.snapshots[0])); }],
  ['duplicate commit', s => { s.commits.push(B); }], ['duplicate path', s => { s.snapshots[0].files.push(clone(s.snapshots[0].files[0])); }],
  ['file-directory collision', s => { s.snapshots[0].files.push({ path: 'src', gitOid: B, byteSize: 0 }); }],
  ['case-colliding refs', s => { s.branches.push({ name: 'MAIN', headOid: A }); }],
  ['ref-directory collision', s => { s.branches.push({ name: 'main/child', headOid: A }); }],
]) test(`selection rejects ${name}`, () => { const s = selection(); mutate(s); rejects(() => normalizeSourceSelection(s)); });

test('legacy DB rows produce only explicit snapshot, commit and branch selections without path authority', () => {
  const input = legacy(); const before = clone(input); const output = collect(frozen(input));
  assert.deepEqual(output, { git: [{ projectId: P, selection: selection(), selectionSha256: sha(JSON.stringify(selection())) }], vault: [] });
  assert.deepEqual(input, before); assert.equal(JSON.stringify(output).includes('local_path'), false); assert.equal(JSON.stringify(output).includes('clone_path'), false);
});

test('retained snapshots preserve ciphertext references and select their exact historical Git source', () => {
  const input = retained(); const output = collect(frozen(input));
  const selected = { snapshots: selection().snapshots, commits: [], branches: [], headOid: A };
  assert.deepEqual(output, { git: [{ projectId: P, selection: selected, selectionSha256: sourceSelectionSha256(selected) }],
    vault: [{ projectId: P, sha256: sha(Buffer.from('abc')), byteSize: 3, keyId: 'a'.repeat(32) }],
    retained: [{ projectId: P, snapshotId: S, commitOid: A, commitEpochSecond: null,
      policyVersion: input[4].values.policy_version, limitsSha256: input[4].values.limits_sha256,
      manifestSha256: input[4].values.approval_manifest_sha256, fileCount: 1, totalBytes: 3,
      entries: [{ path: 'src/main.ts', gitOid: git(Buffer.from('abc')), rawSha256: sha(Buffer.from('abc')), byteSize: 3 }] }] });
});

test('retained analyzed files cannot duplicate a path even when both match one valid manifest entry', () => {
  const input = retained(); input.splice(3, 0, row('files', { id: '2' }));
  rejects(() => collect(input));
});

test('retained manifest entries beyond analyzed files are selected as Git source while orphan ciphertext remains separate', () => {
  const input = retained(); input[4] = row('source_manifests', { file_count: 2, byte_size: '3' });
  input.splice(4, 0, row('source_blobs', { sha256: sha(Buffer.alloc(0)), byte_size: '0', key_id: 'b'.repeat(32) }));
  input.push(row('source_manifest_entries', { path: 'unanalysed.txt', blob_sha256: sha(Buffer.alloc(0)), git_oid: git(Buffer.alloc(0)), byte_size: '0' }));
  const orphan = row('source_blobs', { sha256: sha(Buffer.from('unused')), byte_size: '6', key_id: 'c'.repeat(32) }); input.splice(3, 0, orphan);
  const output = collect(input); assert.equal(output.git.length, 1); assert.equal(output.vault.length, 3);
  assert.deepEqual(output.git[0].selection.snapshots[0].files, [
    { path: 'src/main.ts', gitOid: git(Buffer.from('abc')), byteSize: 3 },
    { path: 'unanalysed.txt', gitOid: git(Buffer.alloc(0)), byteSize: 0 }]);
  assert.deepEqual(output.retained[0].entries.map(e => e.path), ['src/main.ts', 'unanalysed.txt']);
  assert.equal(output.retained[0].fileCount, 2); assert.equal(output.retained[0].totalBytes, 3);
  assert.equal(output.git[0].selectionSha256, sourceSelectionSha256(output.git[0].selection));
  assert.equal(output.vault.find(ref => ref.keyId === 'b'.repeat(32)).byteSize, 0);
  assert.equal(output.vault.find(ref => ref.keyId === 'c'.repeat(32)).sha256, orphan.values.sha256);
});

test('retained source remains complete when the analyzer recorded no files at all', () => {
  const input = retained().filter(r => r.table !== 'files'), output = collect(frozen(input));
  assert.equal(output.git[0].selection.snapshots[0].files.length, 1);
  assert.equal(output.retained[0].entries.length, 1);
  assert.equal(output.retained[0].entries[0].rawSha256, output.vault[0].sha256);
  assert.equal(output.git[0].selection.headOid, A);
});

test('a sealed empty retained snapshot still binds its historical commit and has an explicit empty manifest', () => {
  const input = clone(retained()).filter(r => !['files', 'source_blobs', 'source_manifest_entries'].includes(r.table));
  input[2].values.file_count = 0; input[2].values.byte_size = '0';
  const output = collect(input);
  assert.deepEqual(output.git[0].selection, { snapshots: [{ snapshotId: S, commitOid: A, files: [] }], commits: [], branches: [], headOid: A });
  assert.deepEqual(output.vault, []); assert.deepEqual(output.retained[0].entries, []);
  assert.equal(output.retained[0].fileCount, 0); assert.equal(output.retained[0].totalBytes, 0);
});

test('mixed legacy and retained history in one project preserves both snapshots and the retained current HEAD', () => {
  const input = retained();
  input.splice(1, 0, row('snapshots', { id: '10', commit_sha: D }));
  input.splice(3, 0, row('files', { snapshot_id: '10', path: 'old.ts', content_hash: B, size: '0' }));
  const output = collect(input), selected = output.git[0].selection;
  assert.equal(output.git.length, 1); assert.deepEqual(selected.snapshots.map(s => s.snapshotId), ['10', S]);
  assert.deepEqual(selected.snapshots[0].files, [{ path: 'old.ts', gitOid: B, byteSize: 0 }]);
  assert.equal(selected.headOid, A); assert.deepEqual(output.retained.map(s => s.snapshotId), [S]);
  assert.equal(output.vault.length, 1);
});

test('historical retained snapshots from different projects keep distinct descriptors and exact IDs', () => {
  const first = retained(), second = retained().map(r => {
    const next = clone(r), v = next.values;
    if (r.table === 'projects') Object.assign(v, { id: Q, current_snapshot_id: T });
    if (r.table === 'snapshots') Object.assign(v, { id: T, project_id: Q, commit_sha: D });
    if (r.table === 'files') Object.assign(v, { id: '2', snapshot_id: T });
    if (r.table.startsWith('source_')) v.project_id = Q;
    if (r.table === 'source_manifests') Object.assign(v, { id: OTHER_UUID, snapshot_id: T });
    if (r.table === 'source_manifest_entries') v.manifest_id = OTHER_UUID;
    return next;
  });
  const output = collect([...second, ...first]);
  assert.deepEqual(output.git.map(p => p.projectId), [P, Q]);
  assert.deepEqual(output.retained.map(s => [s.projectId, s.snapshotId, s.commitOid]), [[P, S, A], [Q, T, D]]);
  assert.deepEqual(output.vault.map(b => b.projectId), [P, Q]);
  assert.notEqual(output.git[0].selectionSha256, output.git[1].selectionSha256);
});

test('publishing a later retained snapshot keeps every historical manifest while deduplicating only shared ciphertext', () => {
  const input = retained(); input[0] = row('projects', { current_snapshot_id: T });
  input.splice(2, 0, row('snapshots', { id: T, commit_sha: D, source_contract_version: 1 }));
  input.splice(4, 0, row('files', { id: '2', snapshot_id: T }));
  input.splice(7, 0, row('source_manifests', { id: OTHER_UUID, snapshot_id: T }));
  input.push(row('source_manifest_entries', { manifest_id: OTHER_UUID }));
  const output = collect(input);
  assert.deepEqual(output.git[0].selection.snapshots.map(s => [s.snapshotId, s.commitOid]), [[S, A], [T, D]]);
  assert.equal(output.git[0].selection.headOid, D); assert.deepEqual(output.retained.map(s => s.snapshotId), [S, T]);
  assert.equal(output.retained[0].entries.length, 1); assert.equal(output.retained[1].entries.length, 1);
  assert.deepEqual(output.retained[0].entries, output.retained[1].entries); assert.equal(output.vault.length, 1);
});

test('retained reconstruction metadata is copied exactly without local paths or guessed commit timestamps', () => {
  const input = clone(retained()); Object.assign(input[4].values, { policy_version: 'local-ingest-v1', limits_sha256: 'b'.repeat(64), approval_manifest_sha256: 'c'.repeat(64) });
  const output = collect(input); input[4].values.policy_version = 'changed'; input[5].values.path = 'changed.ts';
  const r = output.retained[0]; assert.equal(r.policyVersion, 'local-ingest-v1'); assert.equal(r.limitsSha256, 'b'.repeat(64));
  assert.equal(r.manifestSha256, 'c'.repeat(64)); assert.equal(r.commitEpochSecond, null); assert.equal(r.entries[0].path, 'src/main.ts');
  assert.deepEqual(Object.keys(r).sort(), ['projectId', 'snapshotId', 'commitOid', 'commitEpochSecond', 'policyVersion', 'limitsSha256', 'manifestSha256', 'fileCount', 'totalBytes', 'entries'].sort());
  assert.doesNotMatch(JSON.stringify(r), /local_path|clone_path|keyId|encrypted_token/);
});

test('manifest entry order cannot change retained descriptors or the helper selection digest', () => {
  const input = clone(retained()); input[4].values.file_count = 2; input[4].values.byte_size = '6';
  input.push(row('source_manifest_entries', { path: 'a-first.ts' }));
  const reverse = clone(input); [reverse[5], reverse[6]] = [reverse[6], reverse[5]];
  assert.deepEqual(collect(input), collect(reverse));
  assert.deepEqual(collect(input).retained[0].entries.map(e => e.path), ['a-first.ts', 'src/main.ts']);
});

test('an analyzer-skipped manifest path cannot collide with a directory in the retained Git tree', () => {
  const input = clone(retained()); input[4].values.file_count = 2; input[4].values.byte_size = '6';
  input.push(row('source_manifest_entries', { path: 'src' })); rejects(() => collect(input));
});

test('different projects retain precise large IDs and deterministic per-project source selections', () => {
  const input = [row('projects', { id: Q, current_snapshot_id: T }), row('projects'),
    row('snapshots', { id: T, project_id: Q, commit_sha: D }), row('snapshots')];
  const output = collect(input); assert.deepEqual(output.git.map(x => x.projectId), [P, Q]);
  assert.deepEqual(output.git.map(x => x.selection.snapshots[0].snapshotId), [S, T]);
});

test('fallback HEAD is stable under equivalent unordered commit and branch input', () => {
  const p = row('projects', { current_snapshot_id: null });
  const first = [p, row('commits', { sha: D }), row('commits', { id: '2', sha: B }), row('branches', { head_sha: C })];
  const second = [p, first[2], first[1], first[3]];
  assert.deepEqual(collect(first), collect(second));
});

for (const [name, mutate] of [
  ['orphan snapshot', rows => { rows[1].values.project_id = Q; }],
  ['orphan file', rows => { rows[2].values.snapshot_id = T; }],
  ['missing snapshot', rows => { rows.splice(1, 1); }],
  ['missing current snapshot', rows => { rows[0].values.current_snapshot_id = T; }],
  ['orphan commit', rows => { rows[3].values.project_id = Q; }],
  ['orphan branch', rows => { rows[4].values.project_id = Q; }],
  ['duplicate project', rows => { rows.splice(1, 0, clone(rows[0])); }],
  ['duplicate snapshot', rows => { rows.splice(2, 0, clone(rows[1])); }],
  ['unsafe extra path authority', rows => { rows[0].values.local_path = 'private-path'; }],
  ['unknown row policy kind', rows => { rows[0].kind = 'future-authority'; }],
]) test(`legacy inventory rejects ${name}`, () => { const input = clone(legacy()); mutate(input); rejects(() => collect(input)); });

test('a current snapshot from another known project cannot satisfy the project pointer', () => {
  const input = [row('projects', { current_snapshot_id: T }), row('projects', { id: Q, current_snapshot_id: T }),
    row('snapshots'), row('snapshots', { id: T, project_id: Q })];
  rejects(() => collect(input));
});

for (const [name, mutate] of [
  ['missing manifest', rows => { rows.splice(4, 1); }], ['unsealed manifest', rows => { rows[4].values.sealed_at = null; }],
  ['manifest for another project', rows => { rows[4].values.project_id = Q; }], ['manifest for another snapshot', rows => { rows[4].values.snapshot_id = T; }],
  ['legacy snapshot with retained manifest', rows => { rows[1].values.source_contract_version = 0; }],
  ['duplicate manifest', rows => { rows.splice(5, 0, { ...clone(rows[4]), values: { ...rows[4].values, id: OTHER_UUID } }); }],
  ['missing blob', rows => { rows.splice(3, 1); }], ['blob for another project', rows => { rows[3].values.project_id = Q; }],
  ['entry for another project', rows => { rows[5].values.project_id = Q; }], ['entry without its manifest', rows => { rows[5].values.manifest_id = OTHER_UUID; }],
  ['entry byte size mismatch', rows => { rows[5].values.byte_size = '2'; }], ['entry Git OID mismatch', rows => { rows[5].values.git_oid = D; }],
  ['entry raw SHA mismatch', rows => { rows[5].values.blob_sha256 = 'd'.repeat(64); }],
  ['manifest false byte total', rows => { rows[4].values.byte_size = '2'; }], ['manifest false file count', rows => { rows[4].values.file_count = 2; }],
  ['missing analyzed file in manifest', rows => { rows[5].values.path = 'another.ts'; }], ['duplicated path', rows => { rows.push(clone(rows[5])); }],
  ['duplicated blob key', rows => { rows.splice(4, 0, clone(rows[3])); }],
  ['malformed retained raw hash', rows => { rows[3].values.sha256 = 'not-a-hash'; }], ['malformed retained key ID', rows => { rows[3].values.key_id = 'not-a-key'; }],
]) test(`retained inventory rejects ${name}`, () => { const input = clone(retained()); mutate(input); rejects(() => collect(input)); });

for (const [name, change] of [['unsafe unanalysed path', { path: '../private-path' }], ['invalid unanalysed Git OID', { git_oid: 'z'.repeat(40) }]]) {
  test(`retained manifest validates ${name} even when no analyzed file references it`, () => {
    const input = retained().filter(r => r.table !== 'files'); const entry = clone(input.at(-1)); Object.assign(entry.values, change); input[input.length - 1] = entry;
    rejects(() => collect(input));
  });
}

for (const input of [{ table: 'future_source_table', values: { local_path: 'private-path' } },
  { table: 'github_credentials', values: { encrypted_token: 'credential-sentinel' } }]) test(`source collector cannot silently ignore ${input.table}`, () => { rejects(() => collect([input])); });

test('valid irrelevant product rows are validated and ignored while malformed extra fields fail', () => {
  const note = row('notes'); assert.deepEqual(collect([note]), { git: [], vault: [] });
  const invalid = clone(note); invalid.values.new_secret = 'synthetic-secret'; rejects(() => collect([invalid]));
});

test('source collector is one-use and does not retain caller-owned mutable row objects', () => {
  const input = clone(legacy()); const collector = createBackupSourceInventory(); input.forEach(r => collector.add(r));
  input[0].values.current_snapshot_id = T; input[2].values.path = '../private-path';
  assert.deepEqual(collector.finish().git[0].selection, selection()); rejects(() => collector.finish()); rejects(() => collector.add(row('projects')));
});
