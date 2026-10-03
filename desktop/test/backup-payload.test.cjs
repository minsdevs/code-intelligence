'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBackupPayload, readBackupPayload, inspectBackupPayload, BackupPayloadError, LIMITS } = require('../src/backup-payload.cjs');
const { createBackupExportPolicy, REVIEWED_SCHEMA } = require('../src/backup-export-policy.cjs');

// Independent framing/digest oracles. No SQL, JGit process, provider or OS key storage is used.
const POLICY = createBackupExportPolicy(REVIEWED_SCHEMA);
const TABLES = REVIEWED_SCHEMA.tables.map(table => table.name);
const INSTALLATION = 'synthetic-backup-payload-installation';
const BUILD = '20261003';
const ID = '9007199254740993';
const STAMP = '2026-10-03T12:34:56.123456Z';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
function framed(value, raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? canonical(value));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}
function header(changes = {}) { return { kind: 'HEADER', format: 'code-intelligence-backup-payload', version: 1,
  installationSha256: sha(INSTALLATION), minimumVersion: BUILD, ...changes }; }
function summary(rows) {
  return { version: 1, schema: REVIEWED_SCHEMA, ownerUserId: ID, catalogSha256: sha('synthetic reviewed catalog'),
    sequenceHighWater: Object.fromEntries(REVIEWED_SCHEMA.tables.flatMap(table => table.columns.filter(column => column.generation !== 'none')
      .map(column => [`${table.name}.${column.name}`, table.name === 'users' ? ID : '0']))),
    preferenceRevisionHighWater: {},
    tableCounts: Object.fromEntries(TABLES.map(name => [name, String(rows.filter(row => row.table === name).length)])),
    tableSha256: Object.fromEntries(TABLES.map(name => [name, sha(rows.filter(row => row.table === name).map(row => `${canonical(row)}\n`).join(''))])),
    rowCount: String(rows.length) };
}
function user() { return POLICY.projectRow('users', { id: ID, github_id: '1234', login: 'synthetic-user', name: null,
  avatar_url: null, created_at: STAMP, updated_at: STAMP, identity_type: 'LOCAL_LINKED' }); }
function note(content = '한국어\r\n😀\nselect * from notes; remains data') {
  return POLICY.projectRow('notes', { id: '9', project_id: '7', title: 'synthetic note', content_md: content, created_at: STAMP, updated_at: STAMP });
}
function message(context = { json: null }) { return POLICY.projectRow('ai_messages', { id: '8', conversation_id: '7', role: 'USER',
  content: 'synthetic question', context, claims: null, prompt_tokens: 0, completion_tokens: null, created_at: STAMP }); }
function preference() { return POLICY.projectRow('user_ai_settings', { id: '6', user_id: ID, provider: 'openai',
  model: 'synthetic-model', created_at: STAMP, updated_at: STAMP }); }
function ordered(rows) { return [...rows].sort((a, b) => TABLES.indexOf(a.table) - TABLES.indexOf(b.table)); }
function object(objectType, bytes) {
  return { version: 1, kind: 'OBJECT', objectType,
    gitOid: crypto.createHash('sha1').update(`${objectType.toLowerCase()} ${bytes.length}\0`).update(bytes).digest('hex'),
    rawSha256: sha(bytes), byteSize: bytes.length, bytesBase64: bytes.toString('base64') };
}
function source(projectId = '7', { empty = false } = {}) {
  const blob = object('BLOB', Buffer.from('export const answer = 42;\n'));
  const tree = object('TREE', Buffer.concat([Buffer.from('100644 index.ts\0'), Buffer.from(blob.gitOid, 'hex')]));
  const commit = object('COMMIT', Buffer.from(`tree ${tree.gitOid}\nauthor Synthetic <synthetic@example.invalid> 0 +0000\ncommitter Synthetic <synthetic@example.invalid> 0 +0000\n\nsynthetic commit\n`));
  const objects = empty ? [] : [blob, tree, commit].sort((a, b) => a.gitOid.localeCompare(b.gitOid));
  // This insertion order matches SourceSelection.wire(), not the payload's sorted-key JSON.
  const selection = empty ? { snapshots: [], commits: [], branches: [], headOid: null }
    : { snapshots: [{ snapshotId: '9', commitOid: commit.gitOid, files: [{ path: 'index.ts', gitOid: blob.gitOid, byteSize: blob.byteSize }] }],
      commits: [], branches: [{ name: 'main', headOid: commit.gitOid }], headOid: commit.gitOid };
  const receipt = { version: 1, kind: 'BEGIN', projectId, selectionSha256: sha(JSON.stringify(selection)),
    objectCount: objects.length, totalObjectBytes: objects.reduce((sum, item) => sum + item.byteSize, 0),
    objectsSha256: sha('CI_BACKUP_OBJECTS_V1\n' + objects.map(o => `${o.objectType}\0${o.gitOid}\0${o.rawSha256}\0${o.byteSize}\n`).join('')) };
  return [{ kind: 'SOURCE_BEGIN', projectId, selection, receipt }, ...objects.map(o => ({ kind: 'GIT_OBJECT', projectId, object: o })),
    { kind: 'SOURCE_END', projectId, receipt: { ...receipt, kind: 'END' } }];
}
function vaultObject(projectId = '7') {
  const bytes = Buffer.from('synthetic retained source');
  const metadata = { format: 'code-intelligence-source-blob', major: 1, installationId: INSTALLATION,
    projectId, keyId: 'a'.repeat(32), sha256: sha(bytes), byteSize: bytes.length };
  const key = crypto.randomBytes(32); const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(JSON.stringify(metadata)));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]); key.fill(0);
  const body = Buffer.from(JSON.stringify({ ...metadata, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') }));
  const prefix = Buffer.alloc(12); Buffer.from('CISRCBLB').copy(prefix); prefix.writeUInt32BE(body.length, 8);
  const envelope = Buffer.concat([prefix, body, encrypted]);
  return { kind: 'VAULT_OBJECT', projectId, format: 1, sha256: metadata.sha256, byteSize: bytes.length,
    keyId: metadata.keyId, cipherSha256: sha(envelope), envelopeBase64: envelope.toString('base64') };
}
function complete(rows = [user()], sources = []) {
  const records = [header(), ...rows.map(row => ({ kind: 'ROW', row })), { kind: 'DATABASE', summary: summary(rows) }, ...sources];
  return footer(records);
}
function footer(records) {
  return [...records, { kind: 'FOOTER', rowCount: records.filter(record => record.kind === 'ROW').length,
    sourceCount: records.filter(record => ['SOURCE_END', 'VAULT_OBJECT'].includes(record.kind)).length,
    recordsSha256: sha(Buffer.concat(records.map(record => framed(record)))) }];
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ci-backup-payload-')));
  const handles = [];
  t.after(async () => { for (const handle of handles) await handle.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const f = { root, file: path.join(root, 'payload.bin'), options: { root, installationId: INSTALLATION, runningBuild: BUILD },
    async create(extra = {}) { const writer = await createBackupPayload({ root, installationId: INSTALLATION, minimumVersion: BUILD, ...extra }); handles.push(writer); return writer; },
    async raw(records) { await fs.writeFile(f.file, Buffer.concat(records.map(record => Buffer.isBuffer(record) ? record : framed(record))), { mode: 0o600 }); },
    async read(extra = {}) { const result = []; for await (const record of readBackupPayload({ ...f.options, ...extra })) result.push(record); return result; },
  };
  return f;
}
async function rejects(promise, expected) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BackupPayloadError, `unexpected error type: ${error?.name}`);
    if (expected) assert.equal(error.code, `BACKUP_PAYLOAD_${expected}`);
    assert.match(error.code, /^BACKUP_PAYLOAD_[A-Z_]+$/);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /ci-backup-payload-|synthetic-clear|private-password|injected-error|SELECT|ENOENT|EEXIST/);
    return true;
  });
}

test('writes canonical framed typed rows, source receipts and exact bigint/JSON-null values through EOF', async t => {
  const f = await fixture(t); const rows = ordered([user(), note(), message(), preference()]);
  const sources = [...source(), ...source('8', { empty: true }), vaultObject()];
  const expected = complete(rows, sources); const writer = await f.create();
  for (const row of rows) await writer.writeRow(row);
  await writer.writeDatabase(summary(rows));
  for (const record of sources) await writer.writeSource(record);
  const finished = await writer.finish();
  assert.equal(finished.rowCount, rows.length); assert.equal(finished.sourceCount, 3);
  assert.equal(finished.filePath, f.file); assert.equal(finished.payloadBytes, (await fs.stat(f.file)).size);
  assert.deepEqual(await fs.readFile(f.file), Buffer.concat(expected.map(record => framed(record))));
  assert.deepEqual(await f.read(), expected);
  assert.deepEqual(await inspectBackupPayload(f.options), { header: expected[0], summary: summary(rows), footer: expected.at(-1) });
  const output = (await f.read()).filter(record => record.kind === 'ROW');
  assert.equal(output.find(record => record.row.table === 'users').row.values.id, ID);
  const values = output.find(record => record.row.table === 'ai_messages').row.values;
  assert.deepEqual(values.context, { json: null }); assert.equal(values.claims, null);
  assert.equal(output.find(record => record.row.table === 'notes').row.values.content_md, note().values.content_md);
  assert.deepEqual(output.find(record => record.row.table === 'user_ai_settings').row.settings,
    { enabled: false, reconnectRequired: true, allowEnvironmentFallback: false });
  assert.equal((await fs.stat(f.file)).mode & 0o7777, 0o600); assert.equal((await fs.stat(f.file)).nlink, 1);
});

test('minimal empty database and explicit empty Git source have distinct honest source counts', async t => {
  const f = await fixture(t); await f.raw(complete([], source('7', { empty: true })));
  const result = await inspectBackupPayload(f.options);
  assert.equal(result.footer.rowCount, 0); assert.equal(result.footer.sourceCount, 1);
  assert.equal(result.summary.rowCount, '0');
});

for (const [name, mutate] of [
  ['unknown kind', rows => { rows[0].kind = 'FUTURE_HEADER'; }],
  ['unknown format', rows => { rows[0].format = 'future-format'; }],
  ['unknown major', rows => { rows[0].version = 2; }],
  ['foreign installation', rows => { rows[0].installationSha256 = sha('other'); }],
  ['newer minimum build', rows => { rows[0].minimumVersion = '9223372036854775807'; }],
  ['extra header authority', rows => { rows[0].trusted = true; }],
]) test(`rejects ${name} before treating any product row as validated`, async t => {
  const f = await fixture(t); const records = complete(); mutate(records); await f.raw(records);
  await rejects(f.read());
});

for (const [name, mutate] of [
  ['missing table count', s => { delete s.tableCounts.notes; }],
  ['extra table count', s => { s.tableCounts.credentials_v2 = '0'; }],
  ['wrong table hash', s => { s.tableSha256.users = 'b'.repeat(64); }],
  ['wrong total rows', s => { s.rowCount = '2'; }],
  ['wrong table rows', s => { s.tableCounts.users = '2'; s.rowCount = '2'; }],
  ['unknown summary field', s => { s.credentials = 'synthetic-clear'; }],
  ['missing sequence high water', s => { delete s.sequenceHighWater['users.id']; }],
  ['sequence overflow', s => { s.sequenceHighWater['users.id'] = '9223372036854775808'; }],
  ['revision underflow', s => { s.preferenceRevisionHighWater[ID] = '-1'; }],
  ['unsafe owner number', s => { s.ownerUserId = Number(ID); }],
  ['unreviewed schema', s => { s.schema.migrations[0].sha256 = 'b'.repeat(64); }],
  ['nonzero excluded credentials', s => { s.tableCounts.github_credentials = '1'; s.rowCount = '2'; }],
]) test(`rejects database ${name} independently of a recomputed outer footer`, async t => {
  const f = await fixture(t); const records = clone(complete().slice(0, -1)); mutate(records.at(-1).summary);
  await f.raw(footer(records)); await rejects(f.read(), name === 'unsafe owner number' ? 'INVALID' : 'SUMMARY');
});

for (const [name, mutate] of [
  ['row hash change', rows => { rows[1].row.values.login = 'changed'; }],
  ['row omission', rows => { rows.splice(1, 1); }],
  ['row duplicate', rows => { rows.splice(1, 0, clone(rows[1])); }],
  ['row policy future version', rows => { rows[1].row.policyVersion = 2; }],
  ['row kind future version', rows => { rows[1].row.kind = 'future-owner-authority'; }],
  ['bigint changed to unsafe number', rows => { rows[1].row.values.id = Number(ID); }],
  ['extra credential column', rows => { rows[1].row.values.local_key = 'synthetic-clear'; }],
]) test(`rejects ${name} instead of accepting rehashed framing`, async t => {
  const f = await fixture(t); const records = clone(complete().slice(0, -1)); mutate(records);
  await f.raw(footer(records)); await rejects(f.read());
});

test('writer snapshots input metadata rather than retaining mutable row, summary or BEGIN receipt authority', async t => {
  const f = await fixture(t); const writer = await f.create(); const row = clone(user());
  const pendingRow = writer.writeRow(row); row.values.login = 'mutated'; await pendingRow;
  const selected = summary([user()]); const pendingSummary = writer.writeDatabase(selected);
  selected.tableCounts.users = '900'; await pendingSummary;
  const records = source(); const begin = clone(records[0]); const pendingBegin = writer.writeSource(begin);
  begin.receipt.objectCount = 900; await pendingBegin;
  for (const record of records.slice(1)) await writer.writeSource(record);
  const result = await writer.finish(); assert.equal(result.summary.tableCounts.users, '1');
  assert.deepEqual(await f.read(), complete([user()], records));
});

for (const table of ['github_credentials', 'local_source_approvals', 'job_local_source_inputs']) test(`excluded ${table} cannot enter a payload`, async t => {
  const f = await fixture(t); const writer = await f.create();
  await rejects(writer.writeRow({ table, values: { encrypted_token: 'synthetic-clear' } }), 'ROW');
  assert.equal((await fs.readFile(f.file)).includes(Buffer.from('synthetic-clear')), false);
  await rejects(writer.finish());
});

for (const secret of ['sk-' + 'a'.repeat(32), 'ghp_' + 'b'.repeat(32), 'password=synthetic-clear',
  '-----BEGIN PRIVATE KEY-----\nsynthetic-clear\n-----END PRIVATE KEY-----', 'Bearer synthetic-clear-value']) {
  test(`plaintext secret pattern ${secret.split(/[_= -]/)[0]} is rejected from notes before disk write`, async t => {
    const f = await fixture(t); const writer = await f.create();
    await rejects(writer.writeRow(note(secret)), 'SECRET_DETECTED');
    assert.equal((await fs.readFile(f.file)).includes(Buffer.from(secret)), false);
  });
}

for (const [name, value] of [['api key field', { api_key: 'synthetic-clear-value' }], ['nested password', { nested: [{ password: 'synthetic-clear-value' }] }],
  ['token stored as key', { 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': 'innocent-value' }]]) test(`JSONB ${name} cannot bypass scalar scanning`, async t => {
  const f = await fixture(t); const writer = await f.create();
  await rejects(writer.writeRow(message({ json: value })), 'SECRET_DETECTED');
  assert.equal((await fs.readFile(f.file)).includes(Buffer.from('synthetic-clear')), false);
});

for (const [name, records] of [
  ['source before database', () => [header(), ...source()]],
  ['second database summary', () => [...complete().slice(0, -1), { kind: 'DATABASE', summary: summary([user()]) }]],
  ['row after database', () => [...complete().slice(0, -1), { kind: 'ROW', row: user() }]],
  ['table order moves backwards', () => [header(), { kind: 'ROW', row: note() }, { kind: 'ROW', row: user() }]],
  ['source object outside group', () => [...complete().slice(0, -1), source()[1]]],
  ['nested source begin', () => [...complete().slice(0, -1), source()[0], source('8')[0]]],
  ['repeated source project', () => complete([user()], [...source(), ...source()]).slice(0, -1)],
  ['vault inside Git group', () => [...complete().slice(0, -1), source()[0], vaultObject()]],
  ['footer inside source group', () => [...complete().slice(0, -1), source()[0]]],
]) test(`rejects protocol order: ${name}`, async t => {
  const f = await fixture(t); await f.raw(footer(records())); await rejects(f.read());
});

for (const [name, mutate] of [
  ['typed Git OID', o => { o.gitOid = 'a'.repeat(40); }],
  ['raw SHA256', o => { o.rawSha256 = 'b'.repeat(64); }],
  ['declared byte size', o => { o.byteSize++; }],
  ['unknown object type', o => { o.objectType = 'TAG'; }],
  ['unknown object kind', o => { o.kind = 'FUTURE_OBJECT'; }],
  ['unknown object major', o => { o.version = 2; }],
  ['noncanonical base64', o => { o.bytesBase64 += '\n'; }],
  ['unknown object field', o => { o.path = '../../private'; }],
]) test(`Git source verifies ${name} before trusting its receipt`, async t => {
  const f = await fixture(t); const records = source(); mutate(records[1].object);
  await f.raw(complete([user()], records)); await rejects(f.read());
});

for (const [name, mutate] of [
  ['same count different object digest', records => { for (const r of [records[0], records.at(-1)]) r.receipt.objectsSha256 = 'b'.repeat(64); }],
  ['false count in both receipts', records => { for (const r of [records[0], records.at(-1)]) r.receipt.objectCount++; }],
  ['false byte total in both receipts', records => { for (const r of [records[0], records.at(-1)]) r.receipt.totalObjectBytes++; }],
  ['END-only selection hash change', records => { records.at(-1).receipt.selectionSha256 = 'a'.repeat(64); }],
  ['object from another project', records => { records[1].projectId = '8'; }],
  ['duplicated object with adjusted count', records => { records.splice(2, 0, clone(records[1])); for (const r of [records[0], records.at(-1)]) { r.receipt.objectCount++; r.receipt.totalObjectBytes += records[1].object.byteSize; } }],
  ['descending OID order', records => { [records[1], records[2]] = [records[2], records[1]]; }],
  ['missing object', records => { records.splice(1, 1); }],
]) test(`source BEGIN/OBJECT/END rejects ${name}`, async t => {
  const f = await fixture(t); const records = source(); mutate(records);
  await f.raw(complete([user()], records)); await rejects(f.read());
});

for (const [name, mutate] of [
  ['unknown selection field', records => { records[0].selection.extra = 'unreviewed'; }],
  ['wrong selection digest in both receipts', records => { for (const r of [records[0], records.at(-1)]) r.receipt.selectionSha256 = 'b'.repeat(64); }],
  ['selection path traversal', records => { records[0].selection.snapshots[0].files[0].path = '../private'; }],
]) test(`source selection rejects ${name}`, async t => {
  const f = await fixture(t); const records = source(); mutate(records);
  await f.raw(complete([user()], records)); await rejects(f.read());
});

test('Git blob credentials are rejected even with correct typed OID, raw SHA and recomputed receipts', async t => {
  const f = await fixture(t); const secret = object('BLOB', Buffer.from('api_key="synthetic-clear-value"'));
  const records = source(); const index = records.findIndex(record => record.object?.objectType === 'BLOB');
  records[index].object = secret;
  const objects = records.slice(1, -1).map(record => record.object).sort((a, b) => a.gitOid.localeCompare(b.gitOid));
  const digest = sha('CI_BACKUP_OBJECTS_V1\n' + objects.map(o => `${o.objectType}\0${o.gitOid}\0${o.rawSha256}\0${o.byteSize}\n`).join(''));
  for (const r of [records[0], records.at(-1)]) { r.receipt.objectsSha256 = digest; r.receipt.totalObjectBytes = objects.reduce((n, o) => n + o.byteSize, 0); }
  await f.raw(complete([user()], [records[0], ...objects.map(o => ({ kind: 'GIT_OBJECT', projectId: '7', object: o })), records.at(-1)]));
  await rejects(f.read(), 'SECRET_DETECTED');
});

for (const [name, change] of [
  ['cipher hash', value => { value.cipherSha256 = 'b'.repeat(64); }],
  ['cipher bytes', value => { value.envelopeBase64 = Buffer.from('changed ciphertext').toString('base64'); }],
  ['noncanonical base64', value => { value.envelopeBase64 += '\n'; }],
  ['key ID', value => { value.keyId += '\n'; }],
  ['unknown format', value => { value.format = 2; }],
  ['extra archived key', value => { value.keyMaterial = 'synthetic-clear'; }],
]) test(`vault ciphertext frame rejects changed ${name}`, async t => {
  const f = await fixture(t); const value = vaultObject(); change(value);
  await f.raw(complete([user()], [value])); await rejects(f.read());
});

test('duplicate vault addresses fail even with independently valid ciphertext frames', async t => {
  const f = await fixture(t); const value = vaultObject();
  await f.raw(complete([user()], [value, clone(value)])); await rejects(f.read(), 'SOURCE');
});

for (const [name, mutate] of [
  ['records digest', f => { f.recordsSha256 = '0'.repeat(64); }],
  ['row count', f => { f.rowCount++; }],
  ['source count', f => { f.sourceCount++; }],
  ['future footer field', f => { f.signature = 'unreviewed'; }],
]) test(`footer rejects wrong ${name}`, async t => {
  const f = await fixture(t); const records = complete(); mutate(records.at(-1));
  await f.raw(records); await rejects(f.read());
});

for (const [name, bytes] of [
  ['missing footer', () => Buffer.concat(complete().slice(0, -1).map(record => framed(record)))],
  ['truncated length prefix', () => Buffer.from([0, 0, 0])],
  ['truncated body', () => framed(header()).subarray(0, -1)],
  ['trailing raw byte', () => Buffer.concat([...complete().map(record => framed(record)), Buffer.from([0])])],
  ['second footer', () => Buffer.concat([...complete(), complete().at(-1)].map(record => framed(record)))],
  ['row after footer', () => Buffer.concat([...complete(), { kind: 'ROW', row: user() }].map(record => framed(record)))],
]) test(`EOF validation rejects ${name}`, async t => {
  const f = await fixture(t); await f.raw([bytes()]); await rejects(inspectBackupPayload(f.options));
});

for (const [name, raw] of [
  ['noncanonical key order', () => JSON.stringify(header())],
  ['duplicate key', () => canonical(header()).replace('"version":1', '"version":2,"version":1')],
  ['trailing JSON token', () => canonical(header()) + '{}'],
  ['JSON whitespace', () => ' ' + canonical(header())],
  ['invalid UTF8', () => Buffer.from([0xc3, 0x28])],
]) test(`canonical frame rejects ${name}`, async t => {
  const f = await fixture(t); await f.raw([framed(null, raw())]); await rejects(f.read());
});

for (const kind of ['symlink', 'hardlink', 'wide permissions']) test(`reader refuses ${kind} payload before yielding records`, async t => {
  const f = await fixture(t); await f.raw(complete()); const target = path.join(f.root, 'target');
  if (kind === 'wide permissions') await fs.chmod(f.file, 0o644);
  else { await fs.rename(f.file, target); if (kind === 'symlink') await fs.symlink(target, f.file); else await fs.link(target, f.file); }
  const reader = readBackupPayload(f.options); await rejects(reader.next(), 'UNSAFE_PATH');
});

for (const kind of ['hardlink', 'wide permissions', 'replacement']) test(`writer refuses ${kind} after open before appending plaintext rows`, async t => {
  const f = await fixture(t); const writer = await f.create(); const before = await fs.readFile(f.file);
  const target = path.join(f.root, 'target');
  if (kind === 'hardlink') await fs.link(f.file, target);
  else if (kind === 'wide permissions') await fs.chmod(f.file, 0o644);
  else { await fs.rename(f.file, target); await fs.writeFile(f.file, before, { mode: 0o600 }); }
  await rejects(writer.writeRow(user()), 'UNSAFE_PATH');
  assert.deepEqual(await fs.readFile(kind === 'wide permissions' ? f.file : target), before);
});

test('finish refuses a late hardlink instead of issuing a successful private payload receipt', async t => {
  const f = await fixture(t); const writer = await f.create(); await writer.writeDatabase(summary([]));
  const before = await fs.readFile(f.file); await fs.link(f.file, path.join(f.root, 'target'));
  await rejects(writer.finish(), 'UNSAFE_PATH'); assert.deepEqual(await fs.readFile(f.file), before);
});

for (const point of ['before row write', 'before finish']) test(`writer detects same-inode content mutation ${point}`, async t => {
  const f = await fixture(t); const writer = await f.create();
  if (point === 'before finish') await writer.writeDatabase(summary([]));
  const before = await fs.readFile(f.file); const identity = await fs.stat(f.file, { bigint: true });
  const changed = Buffer.from(before); changed[10] ^= 1;
  const handle = await fs.open(f.file, 'r+'); await handle.write(changed, 0, changed.length, 0); await handle.close();
  assert.equal((await fs.stat(f.file, { bigint: true })).ino, identity.ino);
  assert.equal((await fs.stat(f.file)).size, before.length);
  await rejects(point === 'before finish' ? writer.finish() : writer.writeRow(user()), 'CHANGED');
  assert.deepEqual(await fs.readFile(f.file), changed);
});

for (const kind of ['append', 'in-place mutation', 'replacement', 'root replacement', 'permissions']) test(`reader detects ${kind} between yielded records and final EOF`, async t => {
  const f = await fixture(t); await f.raw(complete()); const reader = readBackupPayload(f.options);
  assert.equal((await reader.next()).value.kind, 'HEADER');
  if (kind === 'append') await fs.appendFile(f.file, Buffer.from([0]));
  else if (kind === 'in-place mutation') { const handle = await fs.open(f.file, 'r+'); await handle.write(Buffer.from('X'), 0, 1, 5); await handle.close(); }
  else if (kind === 'replacement') { const bytes = await fs.readFile(f.file); await fs.rename(f.file, path.join(f.root, 'old')); await fs.writeFile(f.file, bytes, { mode: 0o600 }); }
  else if (kind === 'permissions') await fs.chmod(f.file, 0o644);
  else { const displaced = f.root + '-displaced'; await fs.rename(f.root, displaced); await fs.mkdir(f.root, { mode: 0o700 });
    t.after(() => fs.rm(displaced, { recursive: true, force: true })); }
  await rejects((async () => { for await (const record of reader) void record; })());
});

test('roots must be canonical private directories and initial failures have static errors', async t => {
  const f = await fixture(t); const alias = path.join(f.root, 'alias'); await fs.symlink(f.root, alias);
  await rejects(createBackupPayload({ root: alias, installationId: INSTALLATION, minimumVersion: BUILD }), 'UNSAFE_PATH');
  await rejects(createBackupPayload({ root: f.root + '/', installationId: INSTALLATION, minimumVersion: BUILD }), 'UNSAFE_PATH');
  await rejects(createBackupPayload({ root: path.join(f.root, 'missing'), installationId: INSTALLATION, minimumVersion: BUILD }));
  await fs.chmod(f.root, 0o755); await rejects(f.create(), 'UNSAFE_PATH'); await fs.chmod(f.root, 0o700);
});

for (const extra of [{ installationId: '../invalid' }, { minimumVersion: '-1' }, { minimumVersion: '9223372036854775808' }]) {
  test('invalid writer configuration is rejected before creating a file or acquiring a descriptor', async t => {
    const f = await fixture(t); await rejects(f.create(extra)); assert.deepEqual(await fs.readdir(f.root), []);
  });
}

test('writer never replaces an existing payload and returns a static initialization error', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, 'preserve existing bytes', { mode: 0o600 });
  await rejects(f.create()); assert.equal(await fs.readFile(f.file, 'utf8'), 'preserve existing bytes');
});

test('unfinished, poisoned and closed writers cannot claim completion or accept more rows', async t => {
  const f = await fixture(t); const writer = await f.create(); await rejects(writer.finish());
  await rejects(writer.writeRow({ table: 'future_table', values: {} }), 'CLOSED');
  await rejects(writer.writeRow(user()), 'CLOSED'); await writer.close(); await writer.close();
  await rejects(writer.writeDatabase(summary([])), 'CLOSED'); await rejects(inspectBackupPayload(f.options));
});

test('invalid row poisons the writer before any subsequent valid row or receipt', async t => {
  const f = await fixture(t); const writer = await f.create(); const before = await fs.readFile(f.file);
  await rejects(writer.writeRow({ table: 'future_table', values: {} }), 'ROW');
  await rejects(writer.writeRow(user()), 'CLOSED'); await rejects(writer.finish());
  assert.deepEqual(await fs.readFile(f.file), before);
});

test('mutating a yielded BEGIN receipt cannot bless an originally inconsistent END', async t => {
  const f = await fixture(t); const records = source(); const correct = records[0].receipt.objectCount;
  records[0].receipt.objectCount++;
  await f.raw(complete([user()], records));
  await rejects((async () => {
    for await (const record of readBackupPayload(f.options)) {
      if (record.kind === 'SOURCE_BEGIN') {
        try { record.receipt.objectCount = correct; } catch (error) { assert.ok(error instanceof TypeError); }
      }
    }
  })(), 'SOURCE');
});

test('only one write is accepted concurrently and final finish closes the writer', async t => {
  const f = await fixture(t); const writer = await f.create(); const pending = writer.writeRow(user());
  await rejects(writer.writeRow(user()), 'CLOSED'); await pending;
  await writer.writeDatabase(summary([user()])); await writer.finish();
  await rejects(writer.writeRow(user()), 'CLOSED'); await rejects(writer.finish());
  assert.deepEqual(await f.read(), complete());
});

test('frame, total file and nesting limits are checked without consuming a huge payload', async t => {
  const f = await fixture(t); assert.equal(LIMITS.payloadBytes, 10 * 1024 * 1024 * 1024);
  for (const length of [0, LIMITS.frameBytes + 1, 0xffffffff]) {
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(length); await f.raw([prefix]); await rejects(f.read(), 'LIMIT');
  }
  let deep = null; for (let i = 0; i < LIMITS.depth + 2; i++) deep = [deep];
  await f.raw([framed(deep)]); await rejects(f.read(), 'LIMIT');
  // A sparse file has no data allocation proportional to its logical 10GiB length.
  await fs.truncate(f.file, LIMITS.payloadBytes + 1);
  assert.ok((await fs.stat(f.file)).blocks * 512 < 1024 * 1024);
  await rejects(f.read(), 'LIMIT');
});

test('beforeWrite meters every whole framed byte before HEADER, rows, database, sources and FOOTER writes', async t => {
  const f = await fixture(t); const rows = ordered([user(), note()]);
  const sources = [...source(), vaultObject()]; const expected = complete(rows, sources); const amounts = [];
  let approved = 0n;
  const writer = await f.create({ beforeWrite: async function (bytes) {
    assert.equal(this, undefined); assert.equal(arguments.length, 1); assert.match(bytes, /^(0|[1-9][0-9]*)$/);
    assert.equal((await fs.stat(f.file, { bigint: true })).size, approved);
    amounts.push(bytes); approved += BigInt(bytes);
  } });
  for (const row of rows) await writer.writeRow(row);
  await writer.writeDatabase(summary(rows)); for (const record of sources) await writer.writeSource(record);
  const result = await writer.finish();
  assert.deepEqual(amounts, expected.map(record => String(framed(record).length)));
  assert.equal(approved, BigInt(result.payloadBytes)); assert.deepEqual(await f.read(), expected);
});

test('beforeWrite is captured from caller options and an unresolved promise permits zero output bytes', async t => {
  const f = await fixture(t); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const options = { root: f.root, installationId: INSTALLATION, minimumVersion: BUILD,
    beforeWrite: async bytes => { assert.match(bytes, /^[1-9][0-9]*$/); calls++; entered(); await gate; } };
  const pending = createBackupPayload(options);
  options.beforeWrite = async () => { throw new Error('replaced callback must not run'); };
  await started; assert.equal((await fs.stat(f.file)).size, 0);
  release(); const writer = await pending;
  try { await writer.writeDatabase(summary([])); await writer.finish(); assert.equal(calls, 3); }
  finally { await writer.close(); }
});

for (const kind of ['HEADER', 'ROW', 'DATABASE', 'SOURCE_BEGIN', 'GIT_OBJECT', 'SOURCE_END', 'VAULT_OBJECT', 'FOOTER']) {
  test(`beforeWrite rejection at ${kind} preserves only the approved prefix and poisons the payload writer`, async t => {
    const f = await fixture(t); const rows = [user()]; const sources = [...source(), vaultObject()];
    const expected = complete(rows, sources); const blocked = expected.findIndex(record => record.kind === kind);
    let calls = 0; let writer;
    const operation = (async () => {
      writer = await f.create({ beforeWrite: async () => { if (calls++ === blocked) throw new Error('injected-error private-password'); } });
      for (const row of rows) await writer.writeRow(row);
      await writer.writeDatabase(summary(rows)); for (const record of sources) await writer.writeSource(record);
      await writer.finish();
    })();
    await rejects(operation, 'IO'); assert.equal(calls, blocked + 1);
    assert.deepEqual(await fs.readFile(f.file), Buffer.concat(expected.slice(0, blocked).map(record => framed(record))));
    if (writer) { await rejects(writer.writeRow(user()), 'CLOSED'); await writer.close(); }
    assert.deepEqual(await fs.readdir(f.root), ['payload.bin']);
  });
}

for (const beforeWrite of [null, false, 1, 'function', {}]) {
  test(`invalid beforeWrite type ${typeof beforeWrite}/${String(beforeWrite)} rejects before payload creation`, async t => {
    const f = await fixture(t); await rejects(f.create({ beforeWrite }), 'INVALID');
    assert.deepEqual(await fs.readdir(f.root), []);
  });
}

test('beforeWrite frame reservation is not double-counted when the OS performs short writes', async t => {
  const f = await fixture(t); const probe = await fs.open(path.join(f.root, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe); await probe.close(); await fs.unlink(path.join(f.root, 'probe'));
  const original = prototype.write; const amounts = []; let syscalls = 0; let writer;
  prototype.write = function (bytes, offset, length, position) {
    syscalls++; return original.call(this, bytes, offset, Math.min(length, 71), position);
  };
  try {
    writer = await f.create({ beforeWrite: async bytes => { amounts.push(BigInt(bytes)); } });
    await writer.writeDatabase(summary([])); const receipt = await writer.finish();
    assert.equal(amounts.length, 3); assert.ok(syscalls > 3);
    assert.equal(amounts.reduce((a, b) => a + b, 0n), BigInt(receipt.payloadBytes));
    assert.deepEqual(await f.read(), complete([]));
  } finally { prototype.write = original; await writer?.close(); }
});

test('a delayed beforeWrite cannot bypass file identity checks or write to a replacement payload', async t => {
  const f = await fixture(t); let armed = false;
  const writer = await f.create({ beforeWrite: async () => {
    if (armed) { await fs.rename(f.file, path.join(f.root, 'original')); await fs.writeFile(f.file, 'replacement', { mode: 0o600 }); }
  } });
  const before = await fs.readFile(f.file); armed = true;
  await rejects(writer.writeRow(user()), 'UNSAFE_PATH'); await writer.close();
  assert.deepEqual(await fs.readFile(path.join(f.root, 'original')), before);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'replacement');
});
