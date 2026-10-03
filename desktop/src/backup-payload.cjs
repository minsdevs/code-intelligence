'use strict';

// Typed, credential-free payload inside backup-archive's authenticated container. No SQL,
// archive-selected filesystem paths, key material, network, or live database writes are accepted.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { createBackupExportPolicy, REVIEWED_SCHEMA } = require('./backup-export-policy.cjs');
const { validateBackupSummary } = require('./backup-postgres.cjs');
const { sourceSelectionSha256 } = require('./backup-source-selection.cjs');
const POLICY = createBackupExportPolicy(REVIEWED_SCHEMA);
const LIMITS = Object.freeze({ frameBytes: 16 * 1024 * 1024, payloadBytes: 10 * 1024 * 1024 * 1024,
  records: 1_000_000, depth: 64, metadataBytes: 64 * 1024 * 1024 });
const TABLES = REVIEWED_SCHEMA.tables.map(table => table.name);
const HASH = /^[a-f0-9]{64}$/;
const SECRETS = [ /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /github_pat_[A-Za-z0-9_]{20,}/i,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/i, /AKIA[0-9A-Z]{16}/,
  /bearer\s+[A-Za-z0-9._\-+/=]{8,}/i, /sk-[A-Za-z0-9_-]{20,}/i, /AIza[0-9A-Za-z_-]{20,}/,
  /(?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}]+)/i ];
class BackupPayloadError extends Error {
  constructor(code = 'INVALID') { super(`Backup payload: ${code}`); this.name = 'BackupPayloadError'; this.code = `BACKUP_PAYLOAD_${code}`; }
}
function fail(code) { throw new BackupPayloadError(code); }
function exact(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== names.length
      || names.some(name => !Object.hasOwn(value, name))) fail('INVALID');
}
function canonical(value, depth = 0) {
  if (depth > LIMITS.depth) fail('LIMIT');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value)))) fail('INVALID');
  const result = JSON.stringify(value); if (result === undefined) fail('INVALID'); return result;
}
function scan(value, depth = 0) {
  if (depth > LIMITS.depth) fail('LIMIT');
  if (typeof value === 'string') {
    if (SECRETS.some(pattern => pattern.test(value))) fail('SECRET_DETECTED');
  } else if (value && typeof value === 'object') {
    if (!Array.isArray(value)) for (const [key, item] of Object.entries(value)) {
      scan(key, depth + 1);
      // JSONB often stores a secret as two separate tokens. Inspect that context as well as text.
      if (/(?:password|secret|token|api[_-]?key)$/i.test(key) && item !== null && item !== '') fail('SECRET_DETECTED');
    }
    for (const item of Object.values(value)) scan(item, depth + 1);
  }
}
function decimal(value) { if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)
  || BigInt(value) > 9223372036854775807n) fail('INVALID'); return value; }
function project(value) { decimal(value); if (value === '0') fail('INVALID'); }
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function hash(value) { if (typeof value !== 'string' || value.length !== 64 || !HASH.test(value)) fail('INVALID'); }
function identity(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('INVALID'); return sha(value); }
function privateStat(value, directory) {
  if ((directory ? !value.isDirectory() : !value.isFile()) || value.isSymbolicLink()
      || value.uid !== BigInt(process.getuid()) || (value.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
      || (!directory && value.nlink !== 1n)) fail('UNSAFE_PATH');
}
const same = (a, b) => a.ino === b.ino && a.dev === b.dev;
const unchanged = (a, b) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
async function rootState(root, expected) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root) fail('UNSAFE_PATH');
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep)) {
    current = path.join(current, part); const info = await fs.lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH');
  }
  const value = await fs.lstat(root, { bigint: true }); privateStat(value, true);
  if (expected && !same(value, expected)) fail('UNSAFE_PATH'); return value;
}
async function syncRoot(root, expected) {
  await rootState(root, expected);
  const fd = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { if (!same(await fd.stat({ bigint: true }), expected)) fail('UNSAFE_PATH'); await fd.sync(); }
  finally { await fd.close(); }
}
function validateRow(row) {
  let expected;
  try { expected = POLICY.projectRow(row?.table, row?.values); } catch { fail('ROW'); }
  if (canonical(expected) !== canonical(row)) fail('ROW'); scan(row.values); return row;
}
function validateReceipt(value, kind, projectId) {
  exact(value, ['version', 'kind', 'projectId', 'selectionSha256', 'objectCount', 'totalObjectBytes', 'objectsSha256']);
  if (value.version !== 1 || value.kind !== kind || value.projectId !== projectId) fail('SOURCE');
  hash(value.selectionSha256); hash(value.objectsSha256);
  for (const key of ['objectCount', 'totalObjectBytes']) if (!Number.isSafeInteger(value[key]) || value[key] < 0
      || value[key] > LIMITS.payloadBytes) fail('SOURCE');
}
function sourceRecord(value) {
  project(value.projectId);
  if (value.kind === 'SOURCE_BEGIN') {
    exact(value, ['kind', 'projectId', 'selection', 'receipt']); validateReceipt(value.receipt, 'BEGIN', value.projectId);
    try { if (sourceSelectionSha256(value.selection) !== value.receipt.selectionSha256) fail('SOURCE'); }
    catch { fail('SOURCE'); } scan(value.selection);
  } else if (value.kind === 'GIT_OBJECT') {
    exact(value, ['kind', 'projectId', 'object']); const o = value.object;
    exact(o, ['version', 'kind', 'objectType', 'gitOid', 'rawSha256', 'byteSize', 'bytesBase64']);
    if (o.version !== 1 || o.kind !== 'OBJECT' || !['COMMIT', 'TREE', 'BLOB'].includes(o.objectType)
        || typeof o.gitOid !== 'string' || !/^[a-f0-9]{40}$/.test(o.gitOid)) fail('SOURCE');
    hash(o.rawSha256);
    if (!Number.isSafeInteger(o.byteSize) || o.byteSize < 0 || o.byteSize > 2 * 1024 * 1024
        || typeof o.bytesBase64 !== 'string' || o.bytesBase64.length > 2796204) fail('SOURCE');
    const bytes = Buffer.from(o.bytesBase64, 'base64');
    try {
      if (bytes.length !== o.byteSize || bytes.toString('base64') !== o.bytesBase64 || sha(bytes) !== o.rawSha256
          || crypto.createHash('sha1').update(`${o.objectType.toLowerCase()} ${bytes.length}\0`).update(bytes).digest('hex') !== o.gitOid) fail('SOURCE');
      if (o.objectType !== 'TREE') scan(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally { bytes.fill(0); }
  } else if (value.kind === 'SOURCE_END') {
    exact(value, ['kind', 'projectId', 'receipt']); validateReceipt(value.receipt, 'END', value.projectId);
  } else if (value.kind === 'VAULT_OBJECT') {
    exact(value, ['kind', 'projectId', 'format', 'sha256', 'byteSize', 'keyId', 'cipherSha256', 'envelopeBase64']);
    if (value.format !== 1 || typeof value.keyId !== 'string' || !/^[a-f0-9]{32}$/.test(value.keyId)
        || !Number.isSafeInteger(value.byteSize) || value.byteSize < 0 || value.byteSize > 2097152
        || typeof value.envelopeBase64 !== 'string' || value.envelopeBase64.length > 2800000) fail('SOURCE');
    hash(value.sha256); hash(value.cipherSha256);
    const bytes = Buffer.from(value.envelopeBase64, 'base64');
    try { if (bytes.toString('base64') !== value.envelopeBase64 || sha(bytes) !== value.cipherSha256) fail('SOURCE'); }
    finally { bytes.fill(0); }
  } else fail('SOURCE');
}
function stateMachine(installationId, runningBuild) {
  const identityHash = identity(installationId); decimal(runningBuild);
  let header, summary, tableIndex = -1, source = null, records = 0, rows = 0, sources = 0, ended = false, metadataBytes = 0;
  const counts = Object.fromEntries(TABLES.map(name => [name, 0]));
  const hashes = Object.fromEntries(TABLES.map(name => [name, crypto.createHash('sha256')]));
  const content = crypto.createHash('sha256'); const projects = new Set(); const vault = new Set();
  const machine = {
    accept(record, bytes) {
      if (ended || ++records > LIMITS.records) fail('ORDER');
      if (!header) {
        exact(record, ['kind', 'format', 'version', 'installationSha256', 'minimumVersion']);
        if (record.kind !== 'HEADER' || record.format !== 'code-intelligence-backup-payload' || record.version !== 1
            || record.installationSha256 !== identityHash || BigInt(decimal(record.minimumVersion)) > BigInt(runningBuild)) fail('HEADER');
        header = record;
      } else if (record.kind === 'ROW') {
        if (summary) fail('ORDER'); exact(record, ['kind', 'row']); validateRow(record.row);
        const index = TABLES.indexOf(record.row.table); if (index < tableIndex) fail('ORDER'); tableIndex = index;
        counts[record.row.table]++; rows++; hashes[record.row.table].update(canonical(record.row)).update('\n');
      } else if (record.kind === 'DATABASE') {
        if (summary) fail('ORDER'); exact(record, ['kind', 'summary']); const s = record.summary;
        try { validateBackupSummary(s); } catch { fail('SUMMARY'); }
        if (s.rowCount !== String(rows)) fail('SUMMARY');
        for (const name of TABLES) if (s.tableCounts?.[name] !== String(counts[name])
            || s.tableSha256?.[name] !== hashes[name].digest('hex')) fail('SUMMARY');
        hash(s.catalogSha256); project(s.ownerUserId); summary = s;
      } else if (record.kind === 'FOOTER') {
        if (!summary || source) fail('ORDER'); exact(record, ['kind', 'rowCount', 'sourceCount', 'recordsSha256']);
        if (record.rowCount !== rows || record.sourceCount !== sources || record.recordsSha256 !== content.digest('hex')) fail('INTEGRITY');
        ended = true; return;
      } else {
        if (!summary) fail('ORDER'); sourceRecord(record);
        if (record.kind === 'SOURCE_BEGIN') {
          metadataBytes += 256 + Buffer.byteLength(record.projectId); if (metadataBytes > LIMITS.metadataBytes) fail('LIMIT');
          if (source || projects.has(record.projectId)) fail('ORDER'); projects.add(record.projectId);
          source = { projectId: record.projectId, receipt: record.receipt, count: 0, bytes: 0, lastOid: '',
            digest: crypto.createHash('sha256').update('CI_BACKUP_OBJECTS_V1\n') };
        } else if (record.kind === 'GIT_OBJECT') {
          if (!source || source.projectId !== record.projectId || record.object.gitOid <= source.lastOid) fail('ORDER');
          const o = record.object; source.lastOid = o.gitOid;
          source.digest.update(`${o.objectType}\0${o.gitOid}\0${o.rawSha256}\0${o.byteSize}\n`);
          source.count++; source.bytes += o.byteSize;
        } else if (record.kind === 'SOURCE_END') {
          if (!source || source.projectId !== record.projectId || source.count !== record.receipt.objectCount
              || source.bytes !== record.receipt.totalObjectBytes || source.digest.digest('hex') !== record.receipt.objectsSha256
              || canonical({ ...source.receipt, kind: 'END' }) !== canonical(record.receipt)) fail('SOURCE');
          source = null; sources++;
        } else {
          if (source) fail('ORDER'); const key = `${record.projectId}:${record.sha256}`;
          metadataBytes += 256 + Buffer.byteLength(key); if (metadataBytes > LIMITS.metadataBytes) fail('LIMIT');
          if (vault.has(key)) fail('SOURCE'); vault.add(key); sources++;
        }
      }
      content.update(bytes);
    },
    footer() { if (!summary || source || ended) fail('ORDER'); return { kind: 'FOOTER', rowCount: rows, sourceCount: sources,
      recordsSha256: content.copy().digest('hex') }; },
    result() { if (!ended) fail('TRUNCATED'); return { header, summary, rowCount: rows, sourceCount: sources }; },
  };
  return machine;
}
function frame(value) {
  const body = Buffer.from(canonical(value)); if (!body.length || body.length > LIMITS.frameBytes) fail('LIMIT');
  const bytes = Buffer.alloc(4 + body.length); bytes.writeUInt32BE(body.length); body.copy(bytes, 4); body.fill(0); return bytes;
}
async function createBackupPayload({ root, installationId, minimumVersion, beforeWrite }) {
  // Capture this trusted-main hook once. One approval covers a complete frame, including
  // its length prefix; OS short-write retries consume that same approved buffer.
  if (beforeWrite !== undefined && typeof beforeWrite !== 'function') fail('INVALID');
  // Validate identity/build before creating any plaintext object.
  const machine = stateMachine(installationId, minimumVersion);
  let before, filePath, fd, owned;
  try {
    before = await rootState(root); filePath = path.join(root, 'payload.bin');
    fd = await fs.open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    owned = await fd.stat({ bigint: true }); privateStat(owned, false);
  } catch (error) { await fd?.close(); throw error instanceof BackupPayloadError ? error : new BackupPayloadError('IO'); }
  let total = 0, closed = false, busy = false, poisoned = false, lastState = owned;
  async function checkOwned() {
    await rootState(root, before);
    const named = await fs.lstat(filePath, { bigint: true }), opened = await fd.stat({ bigint: true });
    privateStat(named, false); privateStat(opened, false);
    if (!same(named, owned) || !same(opened, owned)) fail('UNSAFE_PATH');
    if (!unchanged(named, lastState) || !unchanged(opened, lastState)) fail('CHANGED');
  }
  async function write(value) {
    if (closed || poisoned || busy) fail('CLOSED'); busy = true; let bytes;
    try {
      bytes = frame(value); machine.accept(JSON.parse(bytes.subarray(4).toString('utf8')), bytes); total += bytes.length;
      if (total > LIMITS.payloadBytes) fail('LIMIT'); await checkOwned();
      if (beforeWrite) { await beforeWrite(String(bytes.length)); await checkOwned(); }
      for (let at = 0; at < bytes.length;) { const result = await fd.write(bytes, at, bytes.length - at); if (!result.bytesWritten) fail('IO'); at += result.bytesWritten; }
      lastState = await fd.stat({ bigint: true }); if (lastState.size !== BigInt(total)) fail('CHANGED');
      await checkOwned();
    } catch (error) { poisoned = true; throw error instanceof BackupPayloadError ? error : new BackupPayloadError('IO'); }
    finally { bytes?.fill(0); busy = false; }
  }
  try { await write({ kind: 'HEADER', format: 'code-intelligence-backup-payload', version: 1,
    installationSha256: identity(installationId), minimumVersion }); }
  catch (error) { await fd.close(); throw error; }
  return Object.freeze({ filePath,
    writeRow(row) { return write({ kind: 'ROW', row }); },
    writeDatabase(summary) { return write({ kind: 'DATABASE', summary }); },
    writeSource: write,
    async finish() {
      try { await write(machine.footer()); await checkOwned(); await fd.sync(); await checkOwned();
        await syncRoot(root, before); await fd.close(); closed = true;
        // A successful receipt requires reading the entire persisted stream, including its EOF.
        await inspectBackupPayload({ root, installationId, runningBuild: minimumVersion });
        if (!unchanged(lastState, await fs.lstat(filePath, { bigint: true }))) fail('CHANGED');
        return { ...machine.result(), filePath, payloadBytes: total };
      } catch (error) { poisoned = true; throw error instanceof BackupPayloadError ? error : new BackupPayloadError('IO'); }
    },
    async close() { if (!closed) { closed = true; await fd.close(); } },
  });
}
async function* readBackupPayload({ root, installationId, runningBuild }) {
  let fd;
  try {
    const before = await rootState(root); const filePath = path.join(root, 'payload.bin');
    const info = await fs.lstat(filePath, { bigint: true }); privateStat(info, false);
    if (info.size > BigInt(LIMITS.payloadBytes)) fail('LIMIT');
    fd = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!unchanged(info, await fd.stat({ bigint: true }))) fail('CHANGED');
    const machine = stateMachine(installationId, runningBuild); let offset = 0;
    async function read(length) {
      if (offset + length > Number(info.size)) fail('TRUNCATED'); const bytes = Buffer.alloc(length);
      for (let at = 0; at < length;) { const result = await fd.read(bytes, at, length - at, offset + at);
        if (!result.bytesRead) fail('TRUNCATED'); at += result.bytesRead; }
      offset += length; return bytes;
    }
    while (offset < Number(info.size)) {
      const prefix = await read(4); const length = prefix.readUInt32BE(); if (!length || length > LIMITS.frameBytes) fail('LIMIT');
      const bytes = await read(length); let record;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); record = JSON.parse(text);
        if (canonical(record) !== text) fail('INVALID'); machine.accept(JSON.parse(text), Buffer.concat([prefix, bytes]));
      } finally { bytes.fill(0); }
      yield record;
    }
    const probe = Buffer.alloc(1); if ((await fd.read(probe, 0, 1, offset)).bytesRead) fail('CHANGED');
    if (!unchanged(info, await fd.stat({ bigint: true })) || !unchanged(info, await fs.lstat(filePath, { bigint: true }))) fail('CHANGED');
    await rootState(root, before); machine.result();
  } catch (error) { throw error instanceof BackupPayloadError ? error : new BackupPayloadError('INVALID'); }
  finally { await fd?.close(); }
}
async function inspectBackupPayload(options) {
  let header, summary, footer;
  for await (const record of readBackupPayload(options)) {
    if (record.kind === 'HEADER') header = record;
    else if (record.kind === 'DATABASE') summary = record.summary;
    else if (record.kind === 'FOOTER') footer = record;
  }
  return { header, summary, footer };
}
module.exports = Object.freeze({ createBackupPayload, readBackupPayload, inspectBackupPayload, BackupPayloadError, LIMITS });
