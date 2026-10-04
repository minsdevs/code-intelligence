'use strict';

// Coordinator integration only: actual private filesystem, encrypted archive, typed payload,
// encrypted recovery records and source renames; journal/gateway/PG/helper ports are synthetic.
// No server, provider, user database, OS key store, or child process is started.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDesktopBackupRuntime, BackupRuntimeError } = require('../src/backup-runtime.cjs');
const { createBackupPayload, readBackupPayload } = require('../src/backup-payload.cjs');
const { encryptFile, decryptFile } = require('../src/backup-archive.cjs');
const { createBackupRecoveryRecords } = require('../src/backup-recovery-records.cjs');
const { createBackupExportPolicy, upgradeV26FileRow, REVIEWED_SCHEMA, REVIEWED_V26_SCHEMA } = require('../src/backup-export-policy.cjs');
const { createMaintenanceVerifier } = require('../src/backup-cost-state.cjs');

const POLICY = createBackupExportPolicy(REVIEWED_SCHEMA);
const TABLES = REVIEWED_SCHEMA.tables.map(t => t.name);
const INSTALL = 'synthetic-backup-runtime-installation', BUILD = '20261003';
const OWNER = '9007199254740993', KEY_ID = 'a'.repeat(32), KEY = Buffer.alloc(32, 81);
const STAMP = '2026-10-03T00:00:00.123456Z', UUID = '11111111-2222-4333-8444-555555555555';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const immediate = () => new Promise(resolve => setImmediate(resolve));
function frame(value) { const bytes = Buffer.from(canonical(value)), header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); return Buffer.concat([header, bytes]); }
async function identity(file) { const s = await fs.lstat(file, { bigint: true }); return `${s.dev}:${s.ino}`; }
async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }
async function privateDir(file) { await fs.mkdir(file, { mode: 0o700 }); return file; }
async function regular(file, value) { await fs.writeFile(file, value, { mode: 0o600 }); }
function row(table, changes) {
  const values = {};
  for (const c of REVIEWED_SCHEMA.tables.find(t => t.name === table).columns.filter(c => POLICY.columnsFor(table).includes(c.name))) {
    values[c.name] = c.name === 'analysis_status' ? 'LEGACY_UNMEASURED' : c.type === 'boolean' ? false : c.nullable ? null : c.type === 'bigint' ? '1' : c.type === 'integer' ? 1 : c.type === 'timestamptz' ? STAMP
      : c.type === 'uuid' ? UUID : c.type.startsWith('char(') ? 'a'.repeat(Number(c.type.slice(5, -1))) : 'synthetic';
  }
  return POLICY.projectRow(table, Object.assign(values, changes));
}
function summary(rows) {
  return { version: 1, schema: REVIEWED_SCHEMA, ownerUserId: OWNER, catalogSha256: sha('synthetic reviewed catalog'),
    sequenceHighWater: Object.fromEntries(REVIEWED_SCHEMA.tables.flatMap(t => t.columns.filter(c => c.generation !== 'none')
      .map(c => [`${t.name}.${c.name}`, t.name === 'users' ? OWNER : '99']))), preferenceRevisionHighWater: {},
    tableCounts: Object.fromEntries(TABLES.map(name => [name, String(rows.filter(r => r.table === name).length)])),
    tableSha256: Object.fromEntries(TABLES.map(name => [name, sha(rows.filter(r => r.table === name).map(r => `${canonical(r)}\n`).join(''))])),
    rowCount: String(rows.length) };
}
function gitObject(objectType, bytes) {
  return { version: 1, kind: 'OBJECT', objectType, byteSize: bytes.length, rawSha256: sha(bytes),
    gitOid: crypto.createHash('sha1').update(`${objectType.toLowerCase()} ${bytes.length}\0`).update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') };
}
function selectionDigest(selection) {
  // Payload JSON uses sorted object keys; the helper digest uses this explicit wire field order.
  return sha(JSON.stringify({ snapshots: selection.snapshots.map(s => ({ snapshotId: s.snapshotId, commitOid: s.commitOid,
    files: s.files.map(f => ({ path: f.path, gitOid: f.gitOid, byteSize: f.byteSize })) })),
  commits: selection.commits, branches: selection.branches.map(b => ({ name: b.name, headOid: b.headOid })), headOid: selection.headOid }));
}
function sourceGraph(projectId, snapshotId, input, branch = false) {
  const files = input.map(({ path, bytes }) => ({ path, blob: gitObject('BLOB', bytes) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const tree = gitObject('TREE', Buffer.concat(files.flatMap(({ path, blob }) => [Buffer.from(`100644 ${path}\0`), Buffer.from(blob.gitOid, 'hex')])));
  const commit = gitObject('COMMIT', Buffer.from(`tree ${tree.gitOid}\nauthor Synthetic <fixture@example.invalid> 0 +0000\ncommitter Synthetic <fixture@example.invalid> 0 +0000\n\nsynthetic\n`));
  const objects = [...new Map([...files.map(f => f.blob), tree, commit].map(o => [o.gitOid, o])).values()]
    .sort((a, b) => a.gitOid.localeCompare(b.gitOid));
  const selection = { snapshots: [{ snapshotId, commitOid: commit.gitOid,
    files: files.map(({ path, blob }) => ({ path, gitOid: blob.gitOid, byteSize: blob.byteSize })) }],
    commits: [], branches: branch ? [{ name: 'main', headOid: commit.gitOid }] : [], headOid: commit.gitOid };
  const receipt = { version: 1, kind: 'BEGIN', projectId, selectionSha256: selectionDigest(selection), objectCount: objects.length,
    totalObjectBytes: objects.reduce((n, o) => n + o.byteSize, 0),
    objectsSha256: sha('CI_BACKUP_OBJECTS_V1\n' + objects.map(o => `${o.objectType}\0${o.gitOid}\0${o.rawSha256}\0${o.byteSize}\n`).join('')) };
  return { projectId, files, tree, commit, objects, selection, receipt,
    records: [{ kind: 'SOURCE_BEGIN', projectId, selection, receipt }, ...objects.map(object => ({ kind: 'GIT_OBJECT', projectId, object })),
      { kind: 'SOURCE_END', projectId, receipt: { ...receipt, kind: 'END' } }] };
}
function manifestHash(entries, policyVersion, limitsSha256) {
  const digest = crypto.createHash('sha256');
  const text = value => { const bytes = Buffer.from(value), prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length); digest.update(prefix).update(bytes); };
  const number = value => { const bytes = Buffer.alloc(8); bytes.writeBigInt64BE(BigInt(value)); digest.update(bytes); };
  text('code-intelligence-local-manifest-v1'); text(policyVersion); text(limitsSha256);
  for (const entry of entries) { digest.update(Buffer.from([1])); text(entry.path); text('REGULAR_FILE'); number(entry.byteSize); digest.update(Buffer.from(entry.rawSha256, 'hex')); }
  digest.update(Buffer.from([0])); number(entries.length); number(entries.reduce((sum, e) => sum + e.byteSize, 0)); return digest.digest('hex');
}
function vaultObject(retained, nonceByte) {
  const metadata = { format: 'code-intelligence-source-blob', major: 1, installationId: INSTALL, projectId: '8',
    keyId: 'b'.repeat(32), sha256: sha(retained), byteSize: retained.length };
  const nonce = Buffer.alloc(12, nonceByte), sourceKey = Buffer.alloc(32, 92), cipher = crypto.createCipheriv('aes-256-gcm', sourceKey, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(metadata)));
  const ciphertext = Buffer.concat([cipher.update(retained), cipher.final()]); sourceKey.fill(0);
  const header = Buffer.from(JSON.stringify({ ...metadata, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') }));
  const prefix = Buffer.alloc(12); prefix.write('CISRCBLB'); prefix.writeUInt32BE(header.length, 8);
  const envelope = Buffer.concat([prefix, header, ciphertext]);
  return { kind: 'VAULT_OBJECT', format: 1, projectId: '8', sha256: metadata.sha256, byteSize: retained.length,
    keyId: metadata.keyId, cipherSha256: sha(envelope), envelopeBase64: envelope.toString('base64') };
}
function dataset(label = 'archived source A') {
  const legacy = sourceGraph('7', '9', [{ path: 'index.ts', bytes: Buffer.from(`export const message = ${JSON.stringify(label)};\n`) }], true);
  const retained = sourceGraph('8', '10', [{ path: 'retained.ts', bytes: Buffer.from(`retained ${label}`) },
    { path: 'skipped.txt', bytes: Buffer.from(`not analyzed: ${label}\n`) }]);
  const blob = legacy.files[0].blob, retainedBlob = retained.files[0].blob;
  const policyVersion = 'local-ingest-v1', limitsSha256 = sha('synthetic reviewed local limits');
  const entries = retained.files.map(({ path, blob }) => ({ path, gitOid: blob.gitOid, rawSha256: blob.rawSha256, byteSize: blob.byteSize }));
  const descriptor = { projectId: '8', snapshotId: '10', commitOid: retained.commit.gitOid, commitEpochSecond: null,
    policyVersion, limitsSha256, manifestSha256: manifestHash(entries, policyVersion, limitsSha256), fileCount: entries.length,
    totalBytes: entries.reduce((sum, e) => sum + e.byteSize, 0), entries };
  const vaults = retained.files.map(({ blob }, i) => vaultObject(Buffer.from(blob.bytesBase64, 'base64'), i + 7))
    .sort((a, b) => a.sha256.localeCompare(b.sha256));
  const vault = vaults.find(v => v.sha256 === retainedBlob.rawSha256), envelope = Buffer.from(vault.envelopeBase64, 'base64');
  const rows = [row('users', { id: OWNER, github_id: null, login: 'synthetic-local', identity_type: 'LOCAL' }),
    row('projects', { id: '7', user_id: OWNER, source_type: 'LOCAL', current_snapshot_id: '9' }),
    row('projects', { id: '8', user_id: OWNER, source_type: 'LOCAL', current_snapshot_id: '10' }),
    row('snapshots', { id: '9', project_id: '7', commit_sha: legacy.commit.gitOid, status: 'READY', source_contract_version: 0 }),
    row('snapshots', { id: '10', project_id: '8', commit_sha: retained.commit.gitOid, status: 'READY', source_contract_version: 1 }),
    row('files', { id: '11', snapshot_id: '9', path: 'index.ts', size: String(blob.byteSize), content_hash: blob.gitOid }),
    row('files', { id: '12', snapshot_id: '10', path: 'retained.ts', size: String(retainedBlob.byteSize), content_hash: retainedBlob.gitOid }),
    row('branches', { id: '13', project_id: '7', name: 'main', head_sha: legacy.commit.gitOid }),
    ...vaults.map(v => row('source_blobs', { project_id: '8', sha256: v.sha256, byte_size: String(v.byteSize), key_id: v.keyId })),
    row('source_manifests', { id: UUID, project_id: '8', snapshot_id: '10', source_kind: 'LOCAL', file_count: descriptor.fileCount,
      byte_size: String(descriptor.totalBytes), sealed_at: STAMP, policy_version: policyVersion,
      limits_sha256: limitsSha256, approval_manifest_sha256: descriptor.manifestSha256 }),
    ...entries.map(e => row('source_manifest_entries', { manifest_id: UUID, project_id: '8', path: e.path, blob_sha256: e.rawSha256,
      git_oid: e.gitOid, byte_size: String(e.byteSize) }))].sort((a, b) => TABLES.indexOf(a.table) - TABLES.indexOf(b.table));
  return { rows, sources: [legacy, retained], retained: [descriptor], vaults, vault, blob, envelope,
    records: [...legacy.records, ...retained.records, ...vaults] };
}
async function rejects(promise, code = 'RECOVERY_REQUIRED') {
  await assert.rejects(promise, error => { assert.ok(error instanceof BackupRuntimeError, `unexpected ${error?.name}`);
    assert.equal(error.code, `BACKUP_RUNTIME_${code}`); assert.equal(error.recoveryRequired, !['INPUT', 'BUSY'].includes(code));
    assert.equal(error.cause, undefined); assert.doesNotMatch(String(error), /synthetic-private|credential-sentinel|SELECT|\/private\/|ENOENT/); return true; });
}
function before(trace, a, b) { assert.ok(trace.includes(a), `missing ${a}`); assert.ok(trace.indexOf(a) < trace.indexOf(b), `${a} must precede ${b}: ${trace.join(', ')}`); }
function allExportsClosed(f) { assert.ok(f.exportConnections.length > 0); assert.ok(f.exportConnections.every(c => c.closed), 'each export or measurement connection must close'); }

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ci-backup-runtime-'))); await fs.chmod(root, 0o700);
  const userData = await privateDir(path.join(root, 'synthetic-user-data'));
  await privateDir(path.join(userData, 'postgres'));
  const dataRoot = await privateDir(path.join(userData, 'data')), destination = await privateDir(path.join(root, 'chosen-destination'));
  const safety = await privateDir(path.join(root, 'synthetic-independent-B')); await regular(path.join(safety, 'keep'), 'synthetic immutable B key sentinel');
  const originals = {};
  for (const name of ['repos', 'sources']) { const dir = await privateDir(path.join(dataRoot, name)); await regular(path.join(dir, 'original.txt'), `original ${name}`); originals[name] = await identity(dir); }
  const trace = [], events = [], hooks = new Map(), failures = new Map(), issuedKeys = [], cipherBuffers = [], importBuffers = [], publications = [];
  const sourceExports = [], sourceRestores = [], retainedReads = [], plaintextBuffers = [], admissions = [], mergeAttempts = [], exportConnections = [];
  const day = new Date().toISOString().slice(0, 10);
  const state = { major: 1, installationId: INSTALL, sequence: 0, headHash: sha('initial-head'), projectionDigest: sha('initial-projection'),
    clockHighWaterMs: Date.now(), aiOff: false, budgetDay: day, minimumVersion: BUILD, pendingRestore: null,
    pendingMaintenance: null, maintenanceReceipt: null, recoveryOnly: false, legacyLiabilityUnresolved: false, requests: [] };
  let runtime, currentData = dataset('current source B'), databaseImage = 'original', preparedStage, exportedSummary, loadedRows;
  let stagedData, exportingData = currentData;
  const knownData = [currentData], databaseSlots = { codeintel: { oid: '100', owner: 'synthetic', allowConnections: true, bytes: '1024' } };
  let drained = false, released = false, authority = true, credentials = true, reconciliationRequired = true;
  const options = {};
  async function step(name, argument) { trace.push(name); if (hooks.has(name)) await hooks.get(name)(argument);
    if ((failures.get(name) || 0) > 0) { failures.set(name, failures.get(name) - 1); throw new Error(`synthetic-private failure ${name}`); } }
  function advance(name) { state.sequence++; state.headHash = sha(`${state.headHash}\n${name}\n${state.sequence}`);
    state.projectionDigest = sha(canonical({ requests: state.requests, sequence: state.sequence })); events.push({ name, sequence: state.sequence, hash: state.headHash }); }
  function currentProjection() { return { version: 1, complete: true, gate: { installationId: INSTALL, ownerUserId: OWNER,
    policyRevision: '1', policySha256: sha('policy'), dailyLimitMicroUsd: '100000', monthlyLimitMicroUsd: '9007199254740993',
    reconciliationRequired, legacyLiabilityUnresolved: state.legacyLiabilityUnresolved, journalSequence: String(state.sequence),
    journalHash: state.headHash, journalProjectionSha256: state.projectionDigest, clockHighWaterMs: String(state.clockHighWaterMs) }, requests: [], evidence: [] }; }
  let committedProjection = currentProjection();
  // PG changes only when a publication happens. Advancing B alone must leave PG stale.
  function projection() { return copy(committedProjection); }
  function reconcile() {
    // Mirrors publishSql's RECONCILE branch for this fixture's empty, conflict-free ledger.
    // AI OFF remains an independent journal/admission condition after maintenance completes.
    reconciliationRequired = state.legacyLiabilityUnresolved || state.pendingRestore !== null || Boolean(state.pendingMaintenance);
    committedProjection = currentProjection();
    publications.push({ sequence: state.sequence, pendingMaintenance: Boolean(state.pendingMaintenance), reconciliationRequired });
    return projection();
  }
  const verifyMaintenance = createMaintenanceVerifier({ installationId: INSTALL, readProjection: async () => projection() });
  const keyProvider = { async currentKeyId(purpose) { assert.equal(purpose, 'backup'); return KEY_ID; }, async getBackupKey(id) {
    assert.equal(id, KEY_ID); const key = Buffer.from(KEY); issuedKeys.push(key); return key;
  } };
  const journal = { snapshot: () => copy(state), async sealMaintenance(value) {
    await step('journal.seal', value); assert.equal(state.aiOff, true); assert.equal(state.pendingMaintenance, null);
    await verifyMaintenance(copy(state), value);
    state.pendingMaintenance = copy(value); advance('SEALED');
  }, async completeMaintenance(value) { await step('journal.complete', value); assert.equal(state.pendingMaintenance.transactionId, value.transactionId);
    await verifyMaintenance(copy(state), value);
    state.pendingMaintenance = null; state.maintenanceReceipt = copy(value); advance('COMPLETED');
  } };
  const handle = { async waitForDrain(value) { assert.equal(value.timeoutMs, 120000); await step('drain'); drained = true; },
    async mergeAndCommit({ mergeInput }) { assert.equal(drained, true); mergeAttempts.push(copy(mergeInput)); await step('merge', mergeInput);
      state.budgetDay = mergeInput.budgetDay; state.minimumVersion = mergeInput.minimumVersion; advance('MERGED'); return reconcile(); },
    async refreshProjection() { await step('refresh'); return reconcile(); },
    async rotateBackendChannel() { await step('channel.rotate'); assert.equal(authority, false); },
    async release() { await step('handle.release'); assert.equal(state.pendingMaintenance, null); assert.ok(state.maintenanceReceipt); released = true; }
  };
  const gateway = { async beginMaintenance(value) { await step('gateway.begin', value); admissions.push(copy(value));
    drained = false; released = false; state.aiOff = true; advance('OFF');
    await step('gateway.acquired'); return handle; } };
  const adapter = { async readProjection() { await step('pg.read'); return projection(); },
    async prepareMaintenanceGate(value) { await step('pg.prepare', value); assert.equal(value.ownerUserId, OWNER); reconciliationRequired = true;
      committedProjection = currentProjection(); return projection(); },
    async createMaintenanceStage({ database }) { await step('finance.open', database); assert.equal(database, preparedStage.stageDatabase);
      return { async seedMaintenanceProjection(value) { await step('finance.seed', value); assert.equal(value.journalSnapshot.aiOff, true); },
        async close() { await step('finance.close'); } }; }
  };
  const database = { async verifyQuiescent() { await step('db.quiescent'); assert.equal(drained, true); },
    async inspect(transactionId) { await step('db.inspect'); assert.equal(drained, true); const suffix = transactionId.replaceAll('-', '');
      const names = { live: 'codeintel', stage: `ci_backup_stage_${suffix}`, previous: `ci_backup_previous_${suffix}`, failed: `ci_backup_failed_${suffix}` };
      return { names, databases: copy(Object.fromEntries(Object.entries(databaseSlots).filter(([name]) => Object.values(names).includes(name)))) }; },
    async readSizes({ transactionId }) { await step('db.sizes'); const suffix = transactionId.replaceAll('-', '');
      const names = { live: 'codeintel', stage: `ci_backup_stage_${suffix}`, previous: `ci_backup_previous_${suffix}`, failed: `ci_backup_failed_${suffix}` };
      return { version: 1, liveDatabaseBytes: databaseSlots.codeintel.bytes,
        databases: Object.fromEntries(Object.entries(names).map(([slot, name]) => [slot,
          databaseSlots[name] ? { oid: databaseSlots[name].oid, bytes: databaseSlots[name].bytes } : null])) }; },
    async createStage({ transactionId }) { await step('db.createStage'); preparedStage = { transactionId,
      stageDatabase: `ci_backup_stage_${transactionId.replaceAll('-', '')}`, liveOid: '100', stageOid: '101' };
      databaseSlots[preparedStage.stageDatabase] = { oid: '101', owner: 'synthetic', allowConnections: true, bytes: '1024' }; return copy(preparedStage); },
    async swap(value) { await step('db.swap.before', value); assert.equal(authority, false);
      assert.equal(databaseSlots.codeintel.oid, value.liveOid); assert.equal(databaseSlots[preparedStage.stageDatabase].oid, value.stageOid);
      databaseSlots[`ci_backup_previous_${value.transactionId.replaceAll('-', '')}`] = { ...databaseSlots.codeintel, allowConnections: false };
      databaseSlots.codeintel = databaseSlots[preparedStage.stageDatabase]; delete databaseSlots[preparedStage.stageDatabase];
      databaseImage = 'restored'; await step('db.swap.after'); },
    async rollback(value) { await step('db.rollback', value); const suffix = value.transactionId.replaceAll('-', '');
      if (databaseSlots.codeintel.oid !== value.liveOid) {
        assert.equal(databaseSlots.codeintel.oid, value.stageOid); assert.equal(databaseSlots[`ci_backup_previous_${suffix}`].oid, value.liveOid);
        databaseSlots[`ci_backup_failed_${suffix}`] = { ...databaseSlots.codeintel, allowConnections: false };
        databaseSlots.codeintel = { ...databaseSlots[`ci_backup_previous_${suffix}`], allowConnections: true };
        delete databaseSlots[`ci_backup_previous_${suffix}`];
      }
      databaseImage = 'original'; }, async close() { await step('db.close'); }
  };
  const product = { async verifyOrigin() { await step('product.origin'); },
    async rebindClonePaths(value) { await step('product.rebind', value); assert.deepEqual(value, { database: preparedStage.stageDatabase, confirmedGitProjectIds: ['7', '8'] }); },
    async revokeCredentials(value) { await step('product.revoke', value); assert.deepEqual(value, { database: 'codeintel' }); credentials = false; },
    async close() { await step('product.close'); }
  };
  const ports = { async pause({ waitForAiDrain }) { await step('pause'); await waitForAiDrain(); await step('writers.stopped'); },
    async prepareResume(value) { await step('prepareResume', value); assert.equal(released, false);
      assert.ok(state.pendingMaintenance || value.recovery === true && state.maintenanceReceipt); assert.equal(state.aiOff, true); },
    async resume(value) { await step('resume', value); assert.equal(released, true); assert.equal(state.aiOff, true); },
    async failure(value) { await step('failure', value); }, async database() { await step('db.open'); return database; },
    async productState() { await step('product.open'); return product; }, async invalidateAuthority(value) { await step('authority.invalidate', value); authority = false; },
    async openExport() { await step('export.open'); const connection = { closed: false }; exportConnections.push(connection);
      exportingData = databaseImage === 'restored' ? stagedData : currentData;
      assert.ok(exportingData, 'export must reflect the active database image'); return { async exportRows({ writeRow }) { connection.purpose = 'data'; await step('export.rows');
      for (const row of exportingData.rows) await writeRow(copy(row)); exportedSummary = summary(exportingData.rows); await step('export.done'); return copy(exportedSummary); },
      async measureExport() { connection.purpose = 'measure'; await step('export.measure'); const measured = summary(exportingData.rows);
        const rowFrameBytes = exportingData.rows.reduce((n, row) => n + BigInt(frame({ kind: 'ROW', row }).length), 0n);
        const databaseFrameBytes = BigInt(frame({ kind: 'DATABASE', summary: measured }).length);
        return { version: 1, rowCount: measured.rowCount, rowFrameBytes: String(rowFrameBytes), databaseFrameBytes: String(databaseFrameBytes),
          databasePayloadBytes: String(rowFrameBytes + databaseFrameBytes), summary: measured }; },
      async readRetainedCommitTimes(value) { await step('export.retainedTimes', value);
        assert.deepEqual(value, { snapshotIds: ['10'] }); return { '10': '0' }; },
      async close() { await step('export.close'); connection.closed = true; trace.push(`export.${connection.purpose}.close`); } }; },
    async openStage(name) { await step('stage.open', name); assert.equal(name, preparedStage.stageDatabase);
      return { async initializeStaging() { await step('stage.initialize'); },
        async loadRows(value) { await step('stage.load'); loadedRows = []; for await (const row of value.rows) loadedRows.push(row);
          const legacy = value.expected.schema.migrations.length === 26;
          assert.deepEqual(value.expected, legacy ? v26Summary(loadedRows) : summary(loadedRows)); assert.equal(value.liveOwnerUserId, OWNER);
          assert.deepEqual(value.liveSequenceHighWater, exportedSummary.sequenceHighWater);
          assert.deepEqual(value.livePreferenceRevisionHighWater, exportedSummary.preferenceRevisionHighWater);
          const restoredRows = legacy ? loadedRows.map(row => row.table === 'files' ? upgradeV26FileRow(row.values) : row) : loadedRows;
          stagedData = knownData.find(data => canonical(data.rows) === canonical(restoredRows)); assert.ok(stagedData); await value.writeAccounting(); },
        async close() { await step('stage.close'); } }; },
    async sourceWorker() { await step('worker.open'); return {
      async exportProject(argument) { const { reposRoot, projectId, selection, writeRecord } = argument; await step('worker.export', argument);
        const source = exportingData.sources.find(s => s.projectId === projectId); assert.ok(source, 'export project must be DB-selected');
        assert.equal(reposRoot, path.join(dataRoot, 'repos')); assert.deepEqual(selection, source.selection);
        sourceExports.push(projectId); trace.push(`worker.export.${projectId}`);
        if (Object.hasOwn(argument, 'retained')) {
          assert.equal(projectId, '8'); const { projectId: ignored, ...descriptor } = exportingData.retained[0];
          assert.deepEqual(argument.retained, [{ ...descriptor, commitEpochSecond: '0' }]);
          assert.ok(argument.scratchRoot.startsWith(path.join(userData, 'recovery') + path.sep));
          assert.notEqual(argument.scratchRoot, reposRoot); assert.equal((await fs.stat(argument.scratchRoot)).mode & 0o777, 0o700);
          for (const entry of descriptor.entries) { let bytes;
            try { bytes = await argument.readRetainedBlob({ projectId, sha256: entry.rawSha256, byteSize: entry.byteSize });
              assert.deepEqual(bytes, Buffer.from(source.files.find(f => f.path === entry.path).blob.bytesBase64, 'base64')); }
            finally { bytes?.fill(0); }
          }
        }
        if (!options.omitGitExport && !(options.omitRetainedGitExport && projectId === '8')) {
          await writeRecord(copy(source.receipt)); for (const o of source.objects) await writeRecord(copy(o)); await writeRecord({ ...copy(source.receipt), kind: 'END' }); } },
      async restoreProject({ stageRoot, projectId, selection, expected, objects }) { await step('worker.restore'); assert.ok(['7', '8'].includes(projectId));
        sourceRestores.push(projectId);
        assert.equal(expected.selectionSha256, selectionDigest(selection)); const restored = await privateDir(path.join(stageRoot, projectId));
        const received = []; for await (const object of objects) { received.push(object); await regular(path.join(restored, object.gitOid), Buffer.from(object.bytesBase64, 'base64')); }
        assert.equal(received.length, expected.objectCount); await regular(path.join(restored, 'selection.json'), canonical(selection)); },
      async close() { await step('worker.close'); }
    }; },
    async sourceReader() { await step('vault.reader.open'); let closed = false; return {
      async read(ref) { await step('vault.readRetained', ref); assert.equal(closed, false); retainedReads.push(copy(ref));
        assert.equal(ref.projectId, '8'); const source = exportingData.sources.find(s => s.projectId === ref.projectId);
        const object = source.files.find(f => f.blob.rawSha256 === ref.sha256)?.blob;
        assert.ok(object, 'retained reads must be selected by manifest'); assert.equal(ref.byteSize, object.byteSize);
        if (options.missingRetainedBlob) throw new Error('synthetic-private retained source unavailable');
        const bytes = Buffer.from(object.bytesBase64, 'base64'); plaintextBuffers.push(bytes); return bytes; },
      async close() { await step('vault.reader.close'); closed = true; }
    }; },
    async exportVault(refs, writePacket) { await step('vault.export'); assert.deepEqual(refs, exportingData.vaults.map(v => ({ projectId: v.projectId,
      sha256: v.sha256, byteSize: v.byteSize, keyId: v.keyId }))); if (options.omitVaultExport) return;
      for (const packet of exportingData.vaults) { const { kind, envelopeBase64, ...metadata } = packet;
        const envelope = Buffer.from(envelopeBase64, 'base64'); cipherBuffers.push(envelope); await writePacket({ ...metadata, envelope }); } },
    async restoreVault(stageRoot, packets) { await step('vault.restore'); for await (const packet of packets) {
      importBuffers.push(packet.envelope); assert.equal(sha(packet.envelope), packet.cipherSha256);
      await regular(path.join(stageRoot, `${packet.sha256}.enc`), packet.envelope); } }
  };
  const args = { userData, installationId: INSTALL, runningBuild: BUILD, keyProvider, journal, gateway, adapter, ports };
  t.after(async () => { await runtime?.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  async function open(recoveryMode = false) { runtime = await createDesktopBackupRuntime({ ...args, recoveryMode }); return runtime; }
  await open();
  return { root, userData, dataRoot, destination, safety, originals, trace, state, events, hooks, options, issuedKeys, cipherBuffers, importBuffers, publications,
    sourceExports, sourceRestores, retainedReads, plaintextBuffers, admissions, mergeAttempts, databaseSlots, exportConnections,
    args, keyProvider, get runtime() { return runtime; }, get databaseImage() { return databaseImage; }, get loadedRows() { return loadedRows; },
    get currentData() { return currentData; }, get authority() { return authority; }, get credentials() { return credentials; },
    fail(name, count = 1) { failures.set(name, count); }, setData(value) { currentData = value; knownData.push(value); },
    restartJournalOnly() { state.aiOff = true; advance('RESTART_OFF'); },
    async reopen(recoveryMode = false) { await runtime.close(); return open(recoveryMode); },
    async withRecords(operation) { await runtime.close(); const r = await createBackupRecoveryRecords({ root: path.join(userData, 'backup-maintenance'),
      installationId: INSTALL, runningBuild: BUILD, keyProvider }); try { return await operation(r); } finally { await r.close(); } },
    async recordState() { await runtime.close(); const r = await createBackupRecoveryRecords({ root: path.join(userData, 'backup-maintenance'),
      installationId: INSTALL, runningBuild: BUILD, keyProvider }); try { return await r.read(); } finally { await r.close(); } },
    async transactions() { try { return (await fs.readdir(path.join(userData, 'recovery'))).sort().map(name => path.join(userData, 'recovery', name)); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; } },
    async intact() { for (const name of ['repos', 'sources']) { assert.equal(await identity(path.join(dataRoot, name)), originals[name]);
      assert.equal(await fs.readFile(path.join(dataRoot, name, 'original.txt'), 'utf8'), `original ${name}`); }
      assert.equal(await fs.readFile(path.join(safety, 'keep'), 'utf8'), 'synthetic immutable B key sentinel'); },
    async archive(data = dataset(), mutate = () => {}) {
      knownData.push(data);
      const dir = await privateDir(path.join(root, `input-${crypto.randomUUID()}`)); const payloadRoot = await privateDir(path.join(dir, 'plain'));
      const writer = await createBackupPayload({ root: payloadRoot, installationId: INSTALL, minimumVersion: BUILD });
      try { for (const row of data.rows) await writer.writeRow(row); await writer.writeDatabase(summary(data.rows));
        const records = copy(data.records); mutate(records); for (const record of records) await writer.writeSource(record); await writer.finish(); }
      finally { await writer.close(); }
      const destinationPath = path.join(dir, 'archive.cibackup');
      await encryptFile({ sourceRoot: payloadRoot, sourcePath: path.join(payloadRoot, 'payload.bin'), destinationRoot: dir, destinationPath, installationId: INSTALL, keyProvider });
      return destinationPath;
    },
    async legacyArchive(data = dataset()) {
      knownData.push(data);
      const rows = copy(data.rows).map(row => {
        if (row.table === 'files') for (const key of ['analysis_status', 'analysis_reason', 'analysis_targeted']) delete row.values[key];
        return row;
      });
      const records = [{ kind: 'HEADER', format: 'code-intelligence-backup-payload', version: 1,
        installationSha256: sha(INSTALL), minimumVersion: BUILD }, ...rows.map(row => ({ kind: 'ROW', row })),
      { kind: 'DATABASE', summary: v26Summary(rows) }, ...data.records];
      records.push({ kind: 'FOOTER', rowCount: rows.length, sourceCount: data.sources.length + data.vaults.length,
        recordsSha256: sha(Buffer.concat(records.map(frame))) });
      const dir = await privateDir(path.join(root, `legacy-${crypto.randomUUID()}`));
      await regular(path.join(dir, 'payload.bin'), Buffer.concat(records.map(frame)));
      const destinationPath = path.join(dir, 'archive.cibackup');
      await encryptFile({ sourceRoot: dir, sourcePath: path.join(dir, 'payload.bin'), destinationRoot: dir, destinationPath,
        installationId: INSTALL, keyProvider }); return destinationPath;
    },
    async untypedArchive() {
      const data = dataset(); const bad = copy(data.rows); bad[0].values.local_key = 'credential-sentinel';
      const records = [{ kind: 'HEADER', format: 'code-intelligence-backup-payload', version: 1,
        installationSha256: sha(INSTALL), minimumVersion: BUILD }, ...bad.map(row => ({ kind: 'ROW', row })),
      { kind: 'DATABASE', summary: summary(bad) }, ...data.records];
      records.push({ kind: 'FOOTER', rowCount: bad.length, sourceCount: data.sources.length + data.vaults.length, recordsSha256: sha(Buffer.concat(records.map(frame))) });
      const dir = await privateDir(path.join(root, `untyped-${crypto.randomUUID()}`)); await regular(path.join(dir, 'payload.bin'), Buffer.concat(records.map(frame)));
      const destinationPath = path.join(dir, 'archive.cibackup');
      await encryptFile({ sourceRoot: dir, sourcePath: path.join(dir, 'payload.bin'), destinationRoot: dir, destinationPath, installationId: INSTALL, keyProvider });
      return destinationPath;
    },
    async readArchive(file) { const plain = await privateDir(path.join(root, `read-${crypto.randomUUID()}`));
      await decryptFile({ sourceRoot: path.dirname(file), sourcePath: file, destinationRoot: plain,
        destinationPath: path.join(plain, 'payload.bin'), installationId: INSTALL, keyProvider });
      const result = []; for await (const record of readBackupPayload({ root: plain, installationId: INSTALL, runningBuild: BUILD })) result.push(record); return result; }
  };
}

test('backup uses a drained OFF checkpoint and produces an independently readable typed encrypted archive', async t => {
  const f = await fixture(t), original = copy(f.currentData); const file = await f.runtime.backup(f.destination);
  assert.equal(path.basename(file), 'backup.cibackup'); const records = await f.readArchive(file);
  assert.deepEqual(records.filter(r => r.kind === 'ROW').map(r => r.row), original.rows);
  assert.deepEqual(records.filter(r => ['SOURCE_BEGIN', 'GIT_OBJECT', 'SOURCE_END', 'VAULT_OBJECT'].includes(r.kind)), original.records);
  assert.equal(f.state.aiOff, true); assert.equal(f.state.pendingMaintenance, null); assert.equal(f.state.maintenanceReceipt.kind, 'BACKUP');
  before(f.trace, 'drain', 'export.rows'); before(f.trace, 'export.data.close', 'journal.seal'); before(f.trace, 'journal.complete', 'handle.release'); before(f.trace, 'handle.release', 'resume');
  assert.equal(f.trace.includes('db.swap.before'), false); await f.intact();
  const raw = await fs.readFile(file); assert.equal(raw.includes('current source B'), false); assert.equal(raw.includes('synthetic-local'), false);
  assert.equal(raw.includes(KEY), false); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  for (const buffer of [...f.issuedKeys, ...f.cipherBuffers]) assert.ok(buffer.every(byte => byte === 0));
  const state = await f.recordState(); assert.equal(state.active, null); assert.equal(state.completed.length, 1);
});

test('restore publishes actual staged source directories only after seal and authority invalidation', async t => {
  const f = await fixture(t), archived = dataset(), archive = await f.archive(archived);
  const originalArchive = await fs.readFile(archive); const result = await f.runtime.restore(archive);
  assert.equal(result.restored, true); assert.equal(f.databaseImage, 'restored'); assert.deepEqual(f.loadedRows, archived.rows);
  const tx = path.dirname(result.recoveryBackup);
  for (const name of ['repos', 'sources']) { assert.notEqual(await identity(path.join(f.dataRoot, name)), f.originals[name]);
    assert.equal(await identity(path.join(tx, `previous-${name}`)), f.originals[name]); }
  assert.deepEqual(await fs.readFile(path.join(f.dataRoot, 'repos', '7', archived.blob.gitOid)), Buffer.from(archived.blob.bytesBase64, 'base64'));
  assert.deepEqual(await fs.readFile(path.join(f.dataRoot, 'sources', `${archived.vault.sha256}.enc`)), archived.envelope);
  assert.deepEqual(await fs.readFile(archive), originalArchive);
  const checkpoint = await f.readArchive(result.recoveryBackup); assert.deepEqual(checkpoint.filter(r => r.kind === 'ROW').map(r => r.row), f.currentData.rows);
  for (const [a, b] of [['journal.seal', 'stage.load'], ['stage.close', 'product.rebind'], ['finance.close', 'authority.invalidate'],
    ['authority.invalidate', 'db.swap.before'], ['db.swap.after', 'product.revoke'], ['product.revoke', 'channel.rotate'], ['channel.rotate', 'prepareResume'],
    ['prepareResume', 'journal.complete'], ['handle.release', 'resume']]) before(f.trace, a, b);
  assert.equal(f.authority, false); assert.equal(f.credentials, false); assert.equal(f.state.aiOff, true);
  assert.equal(f.state.pendingMaintenance, null); assert.equal(f.state.maintenanceReceipt.kind, 'RESTORE');
  for (const buffer of f.importBuffers) assert.ok(buffer.every(byte => byte === 0));
  const records = await f.recordState(); assert.equal(records.active, null); assert.equal(records.completed.length, 1);
  assert.ok(records.completed[0].receipt.payloadSha256); assert.equal(await fs.readFile(path.join(f.safety, 'keep'), 'utf8'), 'synthetic immutable B key sentinel');
});

test('source closure backup includes distinct retained Git history and analyzer-skipped manifest files without a shared clone', async t => {
  const f = await fixture(t); await absent(path.join(f.dataRoot, 'repos', '8'));
  const file = await f.runtime.backup(f.destination), records = await f.readArchive(file);
  const selections = records.filter(r => r.kind === 'SOURCE_BEGIN');
  assert.deepEqual(selections.map(r => r.projectId), ['7', '8']);
  assert.notEqual(selections[0].selection.headOid, selections[1].selection.headOid);
  assert.deepEqual(selections[1].selection.snapshots[0].files.map(x => x.path), ['retained.ts', 'skipped.txt']);
  assert.equal(f.currentData.rows.some(r => r.table === 'files' && r.values.path === 'skipped.txt'), false);
  const source = f.currentData.sources[1], received = records.filter(r => r.kind === 'GIT_OBJECT' && r.projectId === '8');
  assert.deepEqual(received.map(r => r.object), source.objects);
  const commit = Buffer.from(source.commit.bytesBase64, 'base64').toString('utf8');
  assert.equal(commit.split('\n')[0], `tree ${source.tree.gitOid}`);
  const tree = Buffer.from(source.tree.bytesBase64, 'base64');
  for (const { path: name, blob } of source.files) assert.ok(tree.includes(Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob.gitOid, 'hex')])));
  assert.deepEqual(records.filter(r => r.kind === 'VAULT_OBJECT').map(r => r.sha256), f.currentData.vaults.map(v => v.sha256));
  assert.deepEqual(f.sourceExports, ['7', '8']); before(f.trace, 'export.retainedTimes', 'worker.export.8');
  before(f.trace, 'vault.reader.close', 'vault.export');
  assert.deepEqual(f.retainedReads, f.currentData.retained[0].entries.map(e => ({ projectId: '8', sha256: e.rawSha256, byteSize: e.byteSize })));
  assert.equal(f.plaintextBuffers.length, 2); for (const bytes of f.plaintextBuffers) assert.ok(bytes.every(b => b === 0));
  await absent(path.join(f.dataRoot, 'repos', '8')); await f.intact();
});

test('source closure restore publishes the retained snapshot own commit and skipped file objects alongside exact ciphertext', async t => {
  const f = await fixture(t), archived = dataset(), selected = await f.archive(archived);
  assert.notEqual(archived.sources[1].commit.gitOid, f.currentData.sources[1].commit.gitOid);
  await f.runtime.restore(selected); assert.deepEqual(f.sourceRestores, ['7', '8']);
  const repo = path.join(f.dataRoot, 'repos', '8'), source = archived.sources[1];
  for (const object of source.objects) assert.deepEqual(await fs.readFile(path.join(repo, object.gitOid)), Buffer.from(object.bytesBase64, 'base64'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(repo, 'selection.json'), 'utf8')), source.selection);
  for (const v of archived.vaults) assert.deepEqual(await fs.readFile(path.join(f.dataRoot, 'sources', `${v.sha256}.enc`)), Buffer.from(v.envelopeBase64, 'base64'));
  assert.deepEqual(f.loadedRows.filter(r => r.table === 'source_manifest_entries').map(r => r.values.path), ['retained.ts', 'skipped.txt']);
  assert.equal(f.state.aiOff, true); assert.equal(f.state.pendingMaintenance, null);
});

test('source closure backup refuses missing retained Git records even when legacy Git and every ciphertext reference were exported', async t => {
  const f = await fixture(t); f.options.omitRetainedGitExport = true; await rejects(f.runtime.backup(f.destination));
  assert.deepEqual(f.sourceExports, ['7', '8']); assert.equal(f.trace.includes('vault.export'), true);
  assert.equal(f.cipherBuffers.length, 2); assert.equal(f.trace.includes('journal.seal'), false);
  assert.equal(f.state.maintenanceReceipt, null); assert.equal(f.trace.includes('resume'), false); await f.intact();
});

test('source closure retained blob read failure cannot fall back to a live clone or publish an incomplete backup', async t => {
  const f = await fixture(t); f.options.missingRetainedBlob = true;
  await absent(path.join(f.dataRoot, 'repos', '8')); await rejects(f.runtime.backup(f.destination));
  assert.equal(f.retainedReads.length, 1); assert.equal(f.trace.includes('journal.seal'), false);
  assert.equal(f.trace.includes('vault.export'), false); assert.equal(f.trace.filter(x => x === 'worker.close').length, 1);
  assert.equal(f.trace.filter(x => x === 'vault.reader.close').length, 1);
  allExportsClosed(f); assert.equal(f.trace.includes('resume'), false);
  assert.equal(f.state.maintenanceReceipt, null); assert.equal(f.state.aiOff, true); await f.intact();
});

for (const variant of ['retained Git group missing', 'skipped manifest file missing', 'other historical commit']) {
  test(`source closure restore refuses ${variant} before maintenance despite valid archive and object receipts`, async t => {
    const f = await fixture(t), data = dataset(); let replacement = [];
    if (variant === 'skipped manifest file missing') replacement = sourceGraph('8', '10', [
      { path: 'retained.ts', bytes: Buffer.from(data.sources[1].files[0].blob.bytesBase64, 'base64') }]).records;
    if (variant === 'other historical commit') replacement = dataset('different retained history').sources[1].records;
    const file = await f.archive(data, records => {
      const begin = records.findIndex(r => r.kind === 'SOURCE_BEGIN' && r.projectId === '8');
      const end = records.findIndex(r => r.kind === 'SOURCE_END' && r.projectId === '8');
      records.splice(begin, end - begin + 1, ...copy(replacement));
    });
    // This proves framing/AEAD/object receipts accept the deliberately DB-incomplete input.
    const decoded = await f.readArchive(file); assert.equal(decoded.filter(r => r.kind === 'VAULT_OBJECT').length, 2);
    const previous = copy(f.state); await rejects(f.runtime.restore(file), 'INPUT'); assert.deepEqual(f.state, previous);
    assert.equal(f.trace.includes('gateway.begin'), false); assert.equal(f.trace.includes('stage.open'), false);
    assert.equal(f.trace.includes('worker.restore'), false); assert.equal((await f.transactions()).length, 0); await f.intact();
  });
}

for (const kind of ['backup', 'restore']) test(`completion transition ${kind} clears the derived PG flag without losing the durable receipt or turning AI on`, async t => {
  const f = await fixture(t), selected = kind === 'restore' ? await f.archive() : f.destination;
  await f.runtime[kind](selected);
  assert.ok(f.publications.some(p => p.pendingMaintenance && p.reconciliationRequired));
  assert.deepEqual(f.publications.at(-1), { sequence: f.state.sequence, pendingMaintenance: false, reconciliationRequired: false });
  assert.equal(f.state.aiOff, true); assert.equal(f.state.pendingMaintenance, null); assert.equal(f.state.maintenanceReceipt.kind, kind.toUpperCase());
  before(f.trace, 'journal.complete', 'pg.read'); before(f.trace, 'pg.read', 'handle.release'); before(f.trace, 'handle.release', 'resume');
  const records = await f.recordState(); assert.equal(records.active, null); assert.equal(records.completed.length, 1);
  assert.deepEqual(records.completed[0].receipt, f.state.maintenanceReceipt);
  await f.reopen(); assert.equal(f.state.aiOff, true); assert.equal(f.state.maintenanceReceipt.kind, kind.toUpperCase());
});

for (const kind of ['backup', 'restore']) test(`${kind} success removes only owned plaintext payload scratch and keeps encrypted recovery`, async t => {
  const f = await fixture(t); const selected = kind === 'restore' ? await f.archive() : f.destination;
  f.hooks.set('journal.complete', async () => { for (const tx of await f.transactions()) await regular(path.join(tx, 'verification', 'unrelated-owned.txt'), 'do not delete'); });
  await f.runtime[kind](selected);
  for (const tx of await f.transactions()) { await absent(path.join(tx, 'checkpoint', 'payload.bin'));
    if (kind === 'restore') await absent(path.join(tx, 'incoming', 'payload.bin'));
    assert.ok((await fs.stat(path.join(tx, 'checkpoint.cibackup'))).size > 0);
    assert.equal(await fs.readFile(path.join(tx, 'verification', 'unrelated-owned.txt'), 'utf8'), 'do not delete'); }
});

test('concurrent calls are BUSY and close drains the admitted operation rather than a refused call', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.hooks.set('drain', async () => { entered.resolve(); await release.promise; });
  const operation = f.runtime.backup(f.destination); await entered.promise;
  await rejects(f.runtime.backup(f.destination), 'BUSY'); await rejects(f.runtime.restore('/synthetic-private/missing'), 'BUSY');
  let settled = false; const closing = f.runtime.close().then(() => { settled = true; }); await immediate();
  assert.equal(settled, false); assert.equal(f.trace.filter(x => x === 'gateway.begin').length, 1);
  release.resolve(); await operation; await closing; assert.equal(settled, true); assert.equal((await f.transactions()).length, 1);
  await rejects(f.runtime.backup(f.destination));
});

test('maintenance acquisition failure after durable OFF is recovery-required and stops writers even without a returned handle', async t => {
  const f = await fixture(t); f.fail('gateway.acquired'); await rejects(f.runtime.backup(f.destination));
  assert.equal(f.state.aiOff, true); assert.equal(f.events.at(-1).name, 'OFF'); assert.equal(f.trace.filter(x => x === 'failure').length, 1);
  assert.equal(f.trace.includes('pause'), false); assert.equal(f.trace.includes('export.open'), false); assert.equal(f.trace.includes('resume'), false);
  assert.equal(f.state.maintenanceReceipt, null); await f.intact();
});

for (const where of ['drain', 'db.quiescent', 'product.origin', 'export.rows', 'pg.prepare', 'merge', 'journal.seal']) {
  test(`failure at ${where} leaves live sources and DB intact, OFF, without a completion or automatic resume`, async t => {
    const f = await fixture(t); f.fail(where); await rejects(f.runtime.backup(f.destination)); await f.intact();
    assert.equal(f.databaseImage, 'original'); assert.equal(f.state.aiOff, true); assert.equal(f.state.maintenanceReceipt, null);
    assert.equal(f.trace.includes('resume'), false); assert.equal(f.trace.includes('db.swap.before'), false); assert.equal(f.trace.filter(x => x === 'failure').length, 1);
    if (['pg.prepare', 'merge', 'journal.seal'].includes(where)) {
      const tx = (await f.transactions())[0]; assert.ok((await fs.stat(path.join(tx, 'checkpoint.cibackup'))).size > 0);
      assert.ok((await fs.stat(path.join(tx, 'checkpoint', 'payload.bin'))).size > 0);
    }
    const beforeClose = copy(f.events); const records = await f.recordState(); assert.deepEqual(f.events, beforeClose);
    if (['merge', 'journal.seal'].includes(where)) assert.ok(records.active);
  });
}

for (const where of ['db.swap.after', 'product.revoke', 'channel.rotate', 'prepareResume', 'journal.complete']) {
  test(`restore failure at ${where} rolls back A identities while preserving B seal, checkpoint and both images`, async t => {
    const f = await fixture(t), archive = await f.archive(); f.fail(where); await rejects(f.runtime.restore(archive));
    await f.intact(); assert.equal(f.databaseImage, 'original'); assert.equal(f.state.aiOff, true);
    assert.ok(f.state.pendingMaintenance); assert.equal(f.state.maintenanceReceipt, null); assert.equal(f.trace.includes('resume'), false);
    before(f.trace, 'authority.invalidate', 'db.swap.before'); before(f.trace, 'failure', 'db.rollback');
    assert.ok(f.trace.lastIndexOf('product.revoke') > f.trace.indexOf('db.rollback'));
    assert.equal(f.authority, false); assert.equal(f.credentials, false);
    const tx = (await f.transactions())[0]; assert.ok((await fs.stat(path.join(tx, 'checkpoint.cibackup'))).size > 0);
    for (const name of ['repos', 'sources']) assert.notEqual(await identity(path.join(tx, `failed-${name}`)), f.originals[name]);
    const eventPrefix = copy(f.events), records = await f.recordState(); assert.deepEqual(f.events, eventPrefix);
    assert.equal(records.active.phase, 'ROLLED_BACK'); assert.equal(records.completed.length, 0);
    assert.ok(eventPrefix.some(e => e.name === 'SEALED')); assert.deepEqual(eventPrefix.map(e => e.sequence), eventPrefix.map((_, i) => i + 1));
  });
}

test('a failure between real source renames restores original directory inodes without rolling back B', async t => {
  const f = await fixture(t), archive = await f.archive(), rename = fs.rename; let injected = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!injected && String(to) === path.join(f.dataRoot, 'repos') && path.basename(String(from)) === 'repos') {
      injected = true; throw new Error('synthetic-private rename failure');
    }
    return rename(from, to);
  });
  await rejects(f.runtime.restore(archive)); assert.equal(injected, true); await f.intact();
  assert.equal(f.databaseImage, 'original'); assert.ok(f.state.pendingMaintenance); assert.equal(f.state.aiOff, true);
  const tx = (await f.transactions())[0]; for (const name of ['repos', 'sources']) assert.ok((await fs.stat(path.join(tx, `failed-${name}`))).isDirectory());
  assert.equal((await f.recordState()).active.phase, 'ROLLED_BACK');
});

test('failed rollback keeps the outstanding recovery state and never claims normal restart', async t => {
  const f = await fixture(t), archive = await f.archive(); f.fail('channel.rotate'); f.fail('db.rollback');
  await rejects(f.runtime.restore(archive)); await f.intact(); assert.equal(f.databaseImage, 'restored');
  assert.ok(f.state.pendingMaintenance); assert.equal(f.state.maintenanceReceipt, null); assert.equal(f.state.aiOff, true);
  assert.equal(f.trace.includes('resume'), false); const records = await f.recordState(); assert.ok(records.active); assert.notEqual(records.active.phase, 'ROLLED_BACK');
  await rejects(f.reopen());
});

test('unconfirmed child exit prevents rollback, retaining both source images and the outstanding B seal', async t => {
  const f = await fixture(t), archive = await f.archive(); f.fail('prepareResume'); f.fail('failure');
  await rejects(f.runtime.restore(archive)); assert.equal(f.databaseImage, 'restored'); assert.equal(f.trace.includes('db.rollback'), false);
  assert.ok(f.state.pendingMaintenance); assert.equal(f.state.maintenanceReceipt, null); assert.equal(f.state.aiOff, true);
  assert.equal(f.trace.includes('resume'), false); const tx = (await f.transactions())[0];
  for (const name of ['repos', 'sources']) assert.equal(await identity(path.join(tx, `previous-${name}`)), f.originals[name]);
  const records = await f.recordState(); assert.ok(records.active); assert.notEqual(records.active.phase, 'ROLLED_BACK');
});

test('pending maintenance rejects a repeated call as recovery-required without changing B or its durable recovery records', async t => {
  const f = await fixture(t); f.fail('prepareResume'); await rejects(f.runtime.backup(f.destination));
  assert.ok(f.state.pendingMaintenance); const previousState = copy(f.state), previousEvents = copy(f.events);
  const previousTransactions = await f.transactions(), recordsRoot = path.join(f.userData, 'backup-maintenance');
  async function storedRecords() { const output = []; for (const name of (await fs.readdir(recordsRoot)).sort()) {
    const file = path.join(recordsRoot, name); output.push({ name, identity: await identity(file), sha256: sha(await fs.readFile(file)) });
  } return output; }
  const previousRecords = await storedRecords(); await rejects(f.runtime.backup(f.destination));
  assert.deepEqual(f.state, previousState); assert.deepEqual(f.events, previousEvents);
  assert.deepEqual(await storedRecords(), previousRecords); assert.deepEqual(await f.transactions(), previousTransactions);
  assert.equal(f.trace.filter(x => x === 'gateway.begin').length, 1); assert.equal(f.trace.filter(x => x === 'failure').length, 1);
  assert.equal(f.trace.includes('resume'), false); await f.intact();
});

for (const where of ['stage.load', 'worker.restore', 'product.rebind', 'finance.seed']) {
  test(`staging failure at ${where} preserves live images and recovery evidence before any swap`, async t => {
    const f = await fixture(t), archive = await f.archive(); f.fail(where); await rejects(f.runtime.restore(archive));
    await f.intact(); assert.equal(f.databaseImage, 'original'); assert.equal(f.trace.includes('db.swap.before'), false);
    assert.ok(f.state.pendingMaintenance); assert.equal(f.state.maintenanceReceipt, null); assert.equal(f.trace.includes('resume'), false);
    const tx = (await f.transactions())[0]; assert.ok((await fs.stat(path.join(tx, 'incoming', 'payload.bin'))).size > 0);
    assert.ok((await f.recordState()).active);
  });
}

for (const part of ['Git objects', 'retained ciphertext']) test(`restore refuses an authenticated archive missing DB-required ${part} before OFF or pause`, async t => {
  const f = await fixture(t); const archive = await f.archive(dataset(), records => {
    if (part === 'Git objects') records.splice(0, records.findIndex(r => r.kind === 'VAULT_OBJECT'));
    else records.pop();
  });
  const before = copy(f.state); await rejects(f.runtime.restore(archive), 'INPUT'); assert.deepEqual(f.state, before); await f.intact();
  assert.equal(f.trace.includes('gateway.begin'), false); assert.equal(f.trace.includes('stage.open'), false);
});

for (const part of ['omitGitExport', 'omitVaultExport']) test(`backup cannot succeed when the source port silently omits ${part}`, async t => {
  const f = await fixture(t); f.options[part] = true; await rejects(f.runtime.backup(f.destination));
  assert.equal(f.state.maintenanceReceipt, null); assert.equal(f.trace.includes('resume'), false); await f.intact();
});

test('unprojected credential rows from the export port fail closed and cannot become an archive', async t => {
  const f = await fixture(t); const data = dataset(); data.rows.unshift({ table: 'github_credentials', values: { encrypted_token: 'credential-sentinel' } });
  f.setData(data); await rejects(f.runtime.backup(f.destination)); assert.equal(f.trace.includes('journal.seal'), false);
  allExportsClosed(f); assert.equal(f.state.maintenanceReceipt, null); await f.intact();
});

test('an authenticated but untyped selected payload is an input error without acquiring maintenance authority', async t => {
  const f = await fixture(t), archive = await f.untypedArchive(), before = copy(f.state);
  await rejects(f.runtime.restore(archive), 'INPUT'); assert.deepEqual(f.state, before); assert.equal(f.trace.includes('gateway.begin'), false);
  assert.equal(f.trace.includes('failure'), false); await f.intact();
});

test('failed final archive publication keeps the existing product and encrypted checkpoint with an outstanding seal', async t => {
  const f = await fixture(t), link = fs.link; let injected = false;
  t.mock.method(fs, 'link', async (from, to) => { if (!injected && path.basename(String(to)) === 'backup.cibackup') {
    injected = true; throw new Error('synthetic-private output failure'); } return link(from, to); });
  await rejects(f.runtime.backup(f.destination)); assert.equal(injected, true); await f.intact(); assert.ok(f.state.pendingMaintenance);
  assert.equal(f.state.maintenanceReceipt, null); assert.equal(f.trace.includes('resume'), false);
  const tx = (await f.transactions())[0]; assert.ok((await fs.stat(path.join(tx, 'checkpoint.cibackup'))).size > 0);
  assert.equal((await f.recordState()).active.phase, 'SEALED');
});

test('worker close failure still closes the independent export connection', async t => {
  const f = await fixture(t); f.fail('worker.close'); await rejects(f.runtime.backup(f.destination));
  allExportsClosed(f); assert.equal(f.trace.includes('resume'), false); await f.intact();
});

test('post-commit resume failure preserves the committed restore instead of silently rolling back A', async t => {
  const f = await fixture(t), archive = await f.archive(); f.fail('resume'); await rejects(f.runtime.restore(archive));
  assert.equal(f.databaseImage, 'restored'); assert.equal(f.trace.includes('db.rollback'), false); assert.equal(f.state.aiOff, true);
  assert.equal(f.state.pendingMaintenance, null); assert.equal(f.state.maintenanceReceipt.kind, 'RESTORE');
  const records = await f.recordState(); assert.equal(records.active, null); assert.equal(records.completed.length, 1);
});

for (const kind of ['symlink', 'hardlink', 'ciphertext corruption']) test(`selected archive ${kind} is refused before acquiring maintenance authority`, async t => {
  const f = await fixture(t), archive = await f.archive(); let selected = archive;
  if (kind === 'symlink') { selected = path.join(f.root, 'selected-link'); await fs.symlink(archive, selected); }
  else if (kind === 'hardlink') { selected = path.join(f.root, 'selected-hardlink'); await fs.link(archive, selected); }
  else { const bytes = await fs.readFile(archive); bytes[bytes.length - 1] ^= 1; await fs.writeFile(archive, bytes); }
  await rejects(f.runtime.restore(selected), 'INPUT'); assert.equal(f.trace.includes('gateway.begin'), false); await f.intact();
});

test('a selected archive growing after admission cannot stream beyond its initial size or acquire maintenance authority', async t => {
  const f = await fixture(t), archive = await f.archive(), initialSize = (await fs.stat(archive)).size, open = fs.open;
  let injected = false, observedBytes = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file) === archive) { const createReadStream = handle.createReadStream.bind(handle);
      handle.createReadStream = options => {
        injected = true; fsSync.appendFileSync(archive, Buffer.alloc(128 * 1024, 19));
        const stream = createReadStream(options); stream.on('data', bytes => { observedBytes += bytes.length; }); return stream;
      };
    }
    return handle;
  });
  await rejects(f.runtime.restore(archive), 'INPUT'); assert.equal(injected, true); assert.equal(observedBytes, initialSize);
  assert.equal(f.trace.includes('gateway.begin'), false); assert.equal((await f.transactions()).length, 0); await f.intact();
});

test('backup destination cannot point inside application data', async t => {
  const f = await fixture(t); await rejects(f.runtime.backup(f.dataRoot), 'INPUT');
  assert.equal(f.trace.includes('gateway.begin'), false); await f.intact();
});

test('successful completion can reopen with the same receipt; deleted recovery enrollment cannot reset that history', async t => {
  const f = await fixture(t); await f.runtime.backup(f.destination); const before = copy(f.state);
  await f.reopen(); assert.deepEqual(f.state, before); await f.runtime.close();
  const records = path.join(f.userData, 'backup-maintenance'); await fs.rename(records, `${records}-preserved`);
  await rejects(f.reopen()); await absent(records); assert.deepEqual(f.state, before);
});

test('changed scratch inode is preserved and cannot be unlinked as an owned plaintext cleanup', async t => {
  const f = await fixture(t); let replacement;
  f.hooks.set('journal.complete', async () => { const tx = (await f.transactions())[0]; replacement = path.join(tx, 'checkpoint', 'payload.bin');
    const bytes = await fs.readFile(replacement); await fs.rename(replacement, `${replacement}.preserved`); await regular(replacement, bytes); });
  await rejects(f.runtime.backup(f.destination)); assert.ok((await fs.stat(replacement)).size > 0);
  assert.ok((await fs.stat(`${replacement}.preserved`)).size > 0); assert.equal(f.trace.includes('resume'), false);
});

async function interrupted(t, { kind = 'backup', point = 'merge', unconfirmedExit = false, completedInB = false } = {}) {
  const f = await fixture(t), selected = kind === 'restore' ? await f.archive() : f.destination;
  if (completedInB) f.hooks.set('journal.complete', () => { f.fail('refresh'); });
  else f.fail(point);
  if (unconfirmedExit) f.fail('failure');
  await rejects(f.runtime[kind](selected)); f.hooks.delete('journal.complete');
  const record = (await f.recordState()).active; assert.ok(record, 'interruption must leave authenticated pending records');
  const root = path.join(f.userData, 'recovery', record.transactionId);
  return { f, record, root, beforeEvents: copy(f.events) };
}
function noRecoveryResume(f, offset) {
  const trace = f.trace.slice(offset); assert.equal(trace.includes('prepareResume'), false); assert.equal(trace.includes('resume'), false);
  assert.equal(trace.includes('handle.release'), false); assert.equal(trace.includes('journal.complete'), false);
}

test('recovery with no pending transaction is an explicit read-only no-op and cannot run a new backup', async t => {
  const f = await fixture(t); await f.reopen(true); assert.equal(await f.runtime.pendingRecovery(), null);
  const previous = copy(f.state); assert.deepEqual(await f.runtime.recover(), { recovered: false });
  await rejects(f.runtime.backup(f.destination)); await rejects(f.runtime.restore('/synthetic-private/missing'));
  assert.deepEqual(f.state, previous); assert.deepEqual(f.admissions, []); assert.deepEqual(await f.transactions(), []);
  assert.equal(f.trace.includes('resume'), false); await f.intact();
});

test('recovery reopens PREPARED with the same transaction and deterministic merge input before verifying previous A', async t => {
  const { f, record, root, beforeEvents } = await interrupted(t);
  assert.equal(record.phase, 'PREPARED'); assert.equal(record.input.version, 2);
  assert.deepEqual(record.input.scratchPayloads, { checkpoint: { directoryIdentity: await identity(path.join(root, 'checkpoint')),
    payloadIdentity: await identity(path.join(root, 'checkpoint', 'payload.bin')), sha256: record.input.checkpointSha256 }, incoming: null });
  await rejects(f.reopen()); await f.reopen(true);
  assert.deepEqual(await f.runtime.pendingRecovery(), { kind: 'BACKUP', phase: 'PREPARED' });
  const offset = f.trace.length, outcome = await f.runtime.recover();
  assert.deepEqual(outcome, { recovered: true, outcome: 'VERIFIED_PREVIOUS' }); await f.intact();
  assert.deepEqual(f.admissions.map(a => a.transactionId), [record.transactionId, record.transactionId]);
  assert.deepEqual(f.mergeAttempts, [record.input.mergeInputs[0], record.input.mergeInputs[0]]);
  assert.deepEqual(f.events.slice(0, beforeEvents.length), beforeEvents); assert.equal(f.state.aiOff, true);
  assert.equal(f.state.pendingMaintenance, null); assert.equal(f.state.maintenanceReceipt.transactionId, record.transactionId);
  const resumed = f.trace.slice(offset); before(resumed, 'export.data.close', 'prepareResume'); before(resumed, 'prepareResume', 'journal.complete'); before(resumed, 'handle.release', 'resume');
  assert.equal(resumed.includes('db.createStage'), false); assert.equal(resumed.includes('db.swap.before'), false);
  assert.deepEqual(await f.transactions(), [root]);
  const stored = await f.recordState(); assert.equal(stored.active, null); assert.equal(stored.completed.length, 1);
  assert.equal(stored.completed[0].transactionId, record.transactionId); await f.reopen();
});

test('recovery rolls back published restored A while B is pending and preserves every previous B event', async t => {
  const { f, record, root, beforeEvents } = await interrupted(t, { kind: 'restore', point: 'prepareResume', unconfirmedExit: true });
  assert.equal(f.databaseImage, 'restored'); assert.ok(f.state.pendingMaintenance);
  for (const name of ['repos', 'sources']) assert.equal(await identity(path.join(root, `previous-${name}`)), f.originals[name]);
  await f.reopen(true); const offset = f.trace.length;
  assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_PREVIOUS' });
  await f.intact(); assert.equal(f.databaseImage, 'original');
  for (const name of ['repos', 'sources']) assert.notEqual(await identity(path.join(root, `failed-${name}`)), f.originals[name]);
  assert.deepEqual(f.events.slice(0, beforeEvents.length), beforeEvents); assert.equal(f.state.aiOff, true);
  assert.deepEqual(f.admissions.map(a => a.transactionId), [record.transactionId, record.transactionId]);
  const resumed = f.trace.slice(offset); before(resumed, 'db.rollback', 'export.rows'); before(resumed, 'export.data.close', 'prepareResume');
  assert.equal(resumed.includes('merge'), false); assert.equal(resumed.includes('journal.seal'), false);
  const records = await f.recordState(); assert.equal(records.active, null); assert.equal(records.completed[0].transactionId, record.transactionId);
});

test('recovery of an already rolled-back transaction verifies old A without repeating a DB rollback', async t => {
  const { f, record } = await interrupted(t, { kind: 'restore', point: 'prepareResume' });
  assert.equal(record.phase, 'ROLLED_BACK'); await f.intact(); await f.reopen(true); const offset = f.trace.length;
  assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_PREVIOUS' });
  assert.equal(f.trace.slice(offset).includes('db.rollback'), false); await f.intact();
  assert.equal((await f.recordState()).active, null);
});

test('recovery after B completion preserves restored A and the same receipt without another B completion', async t => {
  const { f, record, root, beforeEvents } = await interrupted(t, { kind: 'restore', completedInB: true });
  assert.equal(f.databaseImage, 'restored'); assert.equal(f.state.pendingMaintenance, null);
  const receipt = copy(f.state.maintenanceReceipt), restoredIdentities = {};
  for (const name of ['repos', 'sources']) restoredIdentities[name] = await identity(path.join(f.dataRoot, name));
  await f.reopen(true); const offset = f.trace.length;
  assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_RESTORED' });
  assert.equal(f.databaseImage, 'restored'); assert.deepEqual(f.state.maintenanceReceipt, receipt);
  assert.deepEqual(f.events.slice(0, beforeEvents.length), beforeEvents); assert.equal(f.state.aiOff, true);
  const resumed = f.trace.slice(offset);
  for (const name of ['db.rollback', 'merge', 'journal.seal', 'journal.complete']) assert.equal(resumed.includes(name), false, name);
  for (const name of ['repos', 'sources']) { assert.equal(await identity(path.join(f.dataRoot, name)), restoredIdentities[name]);
    assert.equal(await identity(path.join(root, `previous-${name}`)), f.originals[name]); }
  const records = await f.recordState(); assert.equal(records.active, null); assert.equal(records.completed[0].transactionId, record.transactionId);
});

for (const variant of ['receipt write', 'active marker unlink']) test(`recovery finishes durable COMPLETED after ${variant} failure without rolling back restored A`, async t => {
  const f = await fixture(t), selected = await f.archive(), recordsRoot = path.join(f.userData, 'backup-maintenance');
  let injected = false;
  if (variant === 'receipt write') { const open = fs.open;
    t.mock.method(fs, 'open', async (file, flags, ...args) => {
      if (!injected && path.dirname(String(file)) === recordsRoot && /^receipt-[0-9]{8}\.enc$/.test(path.basename(String(file)))
          && (flags & fsSync.constants.O_CREAT)) { injected = true; throw new Error('synthetic-private receipt write interruption'); }
      return open(file, flags, ...args);
    });
  } else { const unlink = fs.unlink;
    t.mock.method(fs, 'unlink', async file => { if (!injected && String(file) === path.join(recordsRoot, 'active.enc')) {
      injected = true; throw new Error('synthetic-private marker unlink interruption'); } return unlink(file); });
  }
  await rejects(f.runtime.restore(selected)); assert.equal(injected, true); assert.equal(f.databaseImage, 'restored');
  const receipt = copy(f.state.maintenanceReceipt), record = (await f.recordState()).active;
  assert.equal(record.phase, 'COMPLETED'); assert.equal(record.markerPresent, true);
  assert.equal(record.completionReceiptPresent, variant === 'active marker unlink');
  const current = {}; for (const name of ['repos', 'sources']) current[name] = await identity(path.join(f.dataRoot, name));
  await f.reopen(true); const offset = f.trace.length;
  assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_RESTORED' });
  assert.deepEqual(f.state.maintenanceReceipt, receipt); assert.equal(f.state.aiOff, true);
  for (const name of ['repos', 'sources']) assert.equal(await identity(path.join(f.dataRoot, name)), current[name]);
  for (const action of ['db.rollback', 'journal.complete', 'journal.seal', 'merge']) assert.equal(f.trace.slice(offset).includes(action), false);
  const completed = await f.recordState(); assert.equal(completed.active, null); assert.equal(completed.completed[0].transactionId, record.transactionId);
});

test('recovery refuses an authenticated legacy v1 record without treating its envelope as publication authority', async t => {
  const f = await fixture(t), transactionId = crypto.randomUUID();
  await f.withRecords(r => r.begin({ transactionId, kind: 'BACKUP', input: { version: 1, transactionId, kind: 'BACKUP',
    payloadSha256: sha('legacy payload'), mergeInputs: [], liveProjection: null, archivedProjection: null } }));
  await f.reopen(true); const previous = copy(f.state), offset = f.trace.length;
  assert.deepEqual(await f.runtime.pendingRecovery(), { kind: 'BACKUP', phase: 'PREPARED' });
  await rejects(f.runtime.recover()); assert.deepEqual(f.state, previous); noRecoveryResume(f, offset);
  assert.equal(f.trace.includes('gateway.begin'), false); assert.equal((await f.recordState()).active.transactionId, transactionId);
});

for (const variant of ['missing', 'corrupt', 'different authenticated payload']) test(`recovery refuses ${variant} checkpoint proof before re-export or health`, async t => {
  const { f, record, root } = await interrupted(t), checkpoint = path.join(root, 'checkpoint.cibackup');
  if (variant === 'missing') await fs.rename(checkpoint, `${checkpoint}.preserved`);
  else if (variant === 'corrupt') { const bytes = await fs.readFile(checkpoint); bytes[bytes.length - 1] ^= 1; await fs.writeFile(checkpoint, bytes); }
  else { const other = await f.archive(dataset('a different authenticated checkpoint')); await fs.writeFile(checkpoint, await fs.readFile(other)); }
  await f.reopen(true); const offset = f.trace.length; await rejects(f.runtime.recover()); noRecoveryResume(f, offset);
  assert.equal(f.trace.slice(offset).includes('export.rows'), false); assert.equal(f.trace.slice(offset).includes('merge'), false);
  assert.equal(f.state.maintenanceReceipt, null); assert.equal((await f.recordState()).active.transactionId, record.transactionId); await f.intact();
});

for (const variant of ['transaction root', 'source directory', 'live database OID']) test(`recovery refuses replaced ${variant} identity without acknowledging completion`, async t => {
  const { f, record, root } = await interrupted(t, { point: 'prepareResume' });
  if (variant === 'transaction root') { await fs.rename(root, `${root}.preserved`); await privateDir(root); }
  else if (variant === 'source directory') { const repos = path.join(f.dataRoot, 'repos'); await fs.rename(repos, `${repos}-preserved`);
    await privateDir(repos); await regular(path.join(repos, 'original.txt'), 'original repos'); }
  else f.databaseSlots.codeintel.oid = '300';
  await f.reopen(true); const offset = f.trace.length; await rejects(f.runtime.recover()); noRecoveryResume(f, offset);
  assert.equal(f.trace.slice(offset).includes('export.rows'), false); assert.equal(f.state.maintenanceReceipt, null);
  assert.equal((await f.recordState()).active.transactionId, record.transactionId);
});

for (const variant of ['pending old source', 'completed live source', 'completed DB OID']) test(`recovery refuses changed ${variant} identity in a staged restore`, async t => {
  const completedInB = variant.startsWith('completed');
  const { f, record, root } = await interrupted(t, { kind: 'restore', point: 'prepareResume', unconfirmedExit: !completedInB, completedInB });
  if (variant === 'completed DB OID') f.databaseSlots.codeintel.oid = '300';
  else {
    const target = variant === 'pending old source' ? path.join(root, 'previous-repos') : path.join(f.dataRoot, 'repos');
    await fs.rename(target, path.join(f.root, 'preserved-source-identity')); await privateDir(target);
  }
  const beforeReceipt = copy(f.state.maintenanceReceipt); await f.reopen(true); const offset = f.trace.length;
  await rejects(f.runtime.recover()); noRecoveryResume(f, offset);
  assert.equal(f.trace.slice(offset).includes('db.rollback'), false); assert.equal(f.databaseImage, 'restored');
  assert.deepEqual(f.state.maintenanceReceipt, beforeReceipt); assert.equal(f.state.aiOff, true);
  assert.equal((await f.recordState()).active.transactionId, record.transactionId);
});

for (const variant of ['maintenance transaction', 'maintenance payload', 'restore ID']) test(`recovery refuses a mismatched pending B ${variant} before acquiring a new handle`, async t => {
  const { f, record } = await interrupted(t, { point: 'prepareResume' });
  if (variant === 'maintenance transaction') f.state.pendingMaintenance.transactionId = crypto.randomUUID();
  else if (variant === 'maintenance payload') f.state.pendingMaintenance.payloadSha256 = sha('another payload');
  else f.state.pendingRestore = { restoreId: crypto.randomUUID() };
  const previous = copy(f.state); await f.reopen(true); const offset = f.trace.length;
  await rejects(f.runtime.recover()); assert.deepEqual(f.state, previous); noRecoveryResume(f, offset);
  assert.equal(f.trace.slice(offset).includes('gateway.begin'), false); assert.equal((await f.recordState()).active.transactionId, record.transactionId);
});

test('recovery re-export mismatch keeps the transaction pending and cannot reach health or public resume', async t => {
  const { f, record } = await interrupted(t, { point: 'prepareResume' }), changed = { ...f.currentData, rows: copy(f.currentData.rows) };
  changed.rows.find(r => r.table === 'users').values.login = 'changed-local-product'; f.setData(changed);
  await f.reopen(true); const offset = f.trace.length; await rejects(f.runtime.recover()); noRecoveryResume(f, offset);
  assert.equal(f.trace.slice(offset).includes('export.close'), true); assert.equal(f.state.maintenanceReceipt, null);
  assert.equal((await f.recordState()).active.transactionId, record.transactionId); await f.intact();
});

test('recovery health failure remains pending with no public resume and can be retried with the same transaction', async t => {
  const { f, record } = await interrupted(t, { point: 'prepareResume' }); await f.reopen(true);
  f.fail('prepareResume'); const offset = f.trace.length; await rejects(f.runtime.recover());
  const failed = f.trace.slice(offset); assert.equal(failed.includes('prepareResume'), true);
  assert.equal(failed.includes('resume'), false); assert.equal(failed.includes('handle.release'), false); assert.equal(failed.includes('journal.complete'), false);
  assert.equal((await f.recordState()).active.transactionId, record.transactionId); await f.reopen(true);
  assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_PREVIOUS' });
  assert.deepEqual(f.admissions.map(a => a.transactionId), [record.transactionId, record.transactionId, record.transactionId]); await f.intact();
});

test('recovery is BUSY while admitted and close waits for the same operation instead of a refused duplicate', async t => {
  const { f, record } = await interrupted(t); await f.reopen(true); const entered = deferred(), release = deferred();
  f.hooks.set('drain', async () => { entered.resolve(); await release.promise; });
  const operation = f.runtime.recover(); await entered.promise; await rejects(f.runtime.recover(), 'BUSY');
  await rejects(f.runtime.backup(f.destination), 'BUSY'); let closed = false;
  const closing = f.runtime.close().then(() => { closed = true; }); await immediate(); assert.equal(closed, false);
  release.resolve(); assert.deepEqual(await operation, { recovered: true, outcome: 'VERIFIED_PREVIOUS' });
  await closing; assert.equal(closed, true); assert.equal(f.admissions.at(-1).transactionId, record.transactionId); await f.intact();
});

for (const kind of ['backup', 'restore']) test(`recovery success removes original ${kind} plaintext scratch while preserving encrypted recovery inputs`, async t => {
  const { f, root } = await interrupted(t, { kind, point: 'prepareResume' });
  const expected = ['checkpoint/payload.bin', ...(kind === 'restore' ? ['incoming/payload.bin'] : [])];
  for (const name of expected) assert.ok((await fs.stat(path.join(root, name))).size > 0);
  await f.reopen(true); assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_PREVIOUS' });
  const leftovers = [];
  for (const name of expected) { try { await fs.lstat(path.join(root, name)); leftovers.push(name); } catch (error) { assert.equal(error.code, 'ENOENT'); } }
  assert.deepEqual(leftovers, [], 'completed recovery must not keep original plaintext scratch');
  assert.ok((await fs.stat(path.join(root, 'checkpoint.cibackup'))).size > 0);
  if (kind === 'restore') assert.ok((await fs.stat(path.join(root, 'input', 'archive.cibackup'))).size > 0);
  assert.equal((await f.recordState()).active, null); await f.intact();
});

for (const variant of ['payload inode', 'directory inode', 'payload hash', 'incoming payload inode', 'missing file under replaced directory']) {
  test(`recovery cleanup refuses changed ${variant} and preserves the replacement without public resume`, async t => {
    const kind = variant === 'incoming payload inode' ? 'restore' : 'backup';
    const { f, record, root } = await interrupted(t, { kind, point: 'prepareResume' });
    const parent = path.join(root, variant === 'incoming payload inode' ? 'incoming' : 'checkpoint'), file = path.join(parent, 'payload.bin');
    const bytes = await fs.readFile(file);
    if (variant.includes('payload inode')) { await fs.rename(file, `${file}.preserved`); await regular(file, bytes); }
    else if (variant === 'payload hash') { const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; await fs.writeFile(file, changed); }
    else { const preserved = path.join(f.root, 'preserved-scratch-directory'); await fs.rename(parent, preserved); await privateDir(parent);
      if (variant === 'directory inode') await fs.rename(path.join(preserved, 'payload.bin'), file); }
    const replacement = variant === 'missing file under replaced directory' ? null : { identity: await identity(file), sha256: sha(await fs.readFile(file)) };
    await f.reopen(true); const offset = f.trace.length; await rejects(f.runtime.recover());
    assert.equal(f.trace.slice(offset).includes('resume'), false); assert.equal(f.trace.slice(offset).includes('handle.release'), false);
    if (replacement) { assert.equal(await identity(file), replacement.identity); assert.equal(sha(await fs.readFile(file)), replacement.sha256); }
    else await absent(file);
    assert.equal((await f.recordState()).active.transactionId, record.transactionId); assert.equal(f.state.aiOff, true);
  });
}

for (const kind of ['backup', 'restore']) test(`recovery accepts already removed ${kind} scratch only with the original parent identities`, async t => {
  const { f, record, root } = await interrupted(t, { kind, point: 'prepareResume' });
  for (const name of ['checkpoint', ...(kind === 'restore' ? ['incoming'] : [])]) {
    assert.equal(await identity(path.join(root, name)), record.input.scratchPayloads[name].directoryIdentity);
    await fs.unlink(path.join(root, name, 'payload.bin'));
  }
  await f.reopen(true); assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_PREVIOUS' });
  assert.equal((await f.recordState()).active, null); await f.intact();
});

test('recovery retention keeps the latest two completed backup bundles and leaves selected encrypted backups intact', async t => {
  const f = await fixture(t), selected = [], transactions = [];
  for (let i = 0; i < 3; i++) { selected.push(await f.runtime.backup(f.destination)); transactions.push(f.admissions.at(-1).transactionId); }
  const recoveryRoot = path.join(f.userData, 'recovery'); await absent(path.join(recoveryRoot, transactions[0]));
  for (const transactionId of transactions.slice(1)) {
    const root = path.join(recoveryRoot, transactionId); assert.ok((await fs.stat(path.join(root, 'checkpoint.cibackup'))).size > 0);
    await absent(path.join(root, 'checkpoint', 'payload.bin'));
  }
  for (const file of selected) assert.ok((await fs.stat(file)).size > 0);
  assert.deepEqual((await f.transactions()).map(p => path.basename(p)).sort(), transactions.slice(1).sort());
  const records = await f.recordState(); assert.equal(records.active, null); assert.equal(records.completed.length, 3);
  assert.deepEqual(records.collections.map(c => [c.transactionId, c.state]), [[transactions[0], 'COMPLETED']]);
  assert.equal(f.state.maintenanceReceipt.transactionId, transactions[2]); assert.equal(f.state.aiOff, true);
  allExportsClosed(f); await f.intact(); await f.reopen();
});

test('review regression preserves a legitimate 0755 repository root through restore completion and retention evidence', async t => {
  const f = await fixture(t), selected = await f.archive(); await fs.chmod(path.join(f.dataRoot, 'repos'), 0o755);
  const result = await f.runtime.restore(selected), root = path.dirname(result.recoveryBackup);
  assert.equal(result.restored, true); assert.equal(f.databaseImage, 'restored');
  assert.equal(await identity(path.join(root, 'previous-repos')), f.originals.repos);
  assert.equal((await fs.stat(path.join(root, 'previous-repos'))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(root, 'previous-sources'))).mode & 0o777, 0o700);
  const records = await f.recordState(); assert.equal(records.active, null); assert.equal(records.completed.length, 1);
  assert.equal(f.state.pendingMaintenance, null); assert.equal(f.state.aiOff, true); await f.reopen();
});

test('review regression republishes a restarted B head before finishing an interrupted GC transaction', async t => {
  const f = await fixture(t); await f.runtime.backup(f.destination); await f.runtime.backup(f.destination);
  const oldest = f.admissions[0].transactionId, checkpoint = path.join(f.userData, 'recovery', oldest, 'checkpoint.cibackup');
  const unlink = fs.unlink; let injected = false;
  t.mock.method(fs, 'unlink', async file => { if (!injected && String(file) === checkpoint) {
    injected = true; throw new Error('synthetic-private interrupted GC unlink'); } return unlink(file); });
  await rejects(f.runtime.backup(f.destination)); assert.equal(injected, true);
  const records = await f.recordState(); assert.equal(records.active, null);
  assert.equal(records.collections[0].transactionId, oldest); assert.equal(records.collections[0].state, 'BEGUN');
  const pg = await f.args.adapter.readProjection(), receipt = copy(f.state.maintenanceReceipt); f.restartJournalOnly();
  assert.notEqual(pg.gate.journalSequence, String(f.state.sequence));
  assert.deepEqual(await f.args.adapter.readProjection(), pg, 'a B restart cannot silently update committed PG');
  await f.reopen(true); const offset = f.trace.length;
  assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_RETENTION' });
  const trace = f.trace.slice(offset); before(trace, 'refresh', 'pg.read'); before(trace, 'pg.read', 'handle.release');
  assert.equal(trace.includes('prepareResume'), false); assert.equal(trace.includes('resume'), false);
  assert.deepEqual(f.state.maintenanceReceipt, receipt); assert.equal(f.admissions.at(-1).transactionId, receipt.transactionId);
  const currentPg = await f.args.adapter.readProjection(); assert.equal(currentPg.gate.journalSequence, String(f.state.sequence));
  assert.equal(currentPg.gate.journalHash, f.state.headHash); await absent(path.dirname(checkpoint));
  const completed = await f.recordState(); assert.equal(completed.collections[0].state, 'COMPLETED');
  assert.equal(completed.completed.length, 3); assert.equal((await f.transactions()).length, 2); assert.equal(f.state.aiOff, true); await f.intact();
});

test('review regression remeasures financial stage growth and refuses A publication above the admitted allowance', async t => {
  const f = await fixture(t), selected = await f.archive();
  f.hooks.set('finance.seed', () => { const name = Object.keys(f.databaseSlots).find(key => key.startsWith('ci_backup_stage_'));
    assert.ok(name); f.databaseSlots[name].bytes = String(11n * 1024n ** 3n); });
  await rejects(f.runtime.restore(selected)); assert.equal(f.databaseImage, 'original'); await f.intact();
  const afterFinance = f.trace.slice(f.trace.indexOf('finance.seed'));
  assert.equal(afterFinance.includes('db.sizes'), true); assert.equal(f.trace.includes('db.swap.before'), false);
  assert.equal(f.trace.includes('prepareResume'), false); assert.equal(f.trace.includes('resume'), false);
  assert.equal(f.state.maintenanceReceipt, null); assert.ok(f.state.pendingMaintenance);
  assert.equal((await f.recordState()).active.phase, 'SEALED');
});

async function payloadFiles(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await payloadFiles(file));
    else if (entry.name === 'payload.bin') files.push(file);
  }
  return files.sort();
}

async function failedRecoveryAttempt(t, kind = 'backup') {
  const context = await interrupted(t, { kind, point: 'prepareResume' }), { f, record, root } = context;
  await f.reopen(true); f.fail('prepareResume'); const offset = f.trace.length;
  await rejects(f.runtime.recover());
  assert.equal(f.trace.slice(offset).includes('prepareResume'), true);
  assert.equal(f.trace.slice(offset).includes('resume'), false);
  assert.equal(f.trace.slice(offset).includes('handle.release'), false);
  const records = await f.recordState();
  assert.equal(records.active.transactionId, record.transactionId);
  const scratches = records.scratches.filter(item => item.transactionId === record.transactionId);
  assert.equal(scratches.length, kind === 'restore' ? 3 : 2);
  for (const item of scratches) {
    const parent = path.join(root, item.relativeDirectory), file = path.join(parent, 'payload.bin');
    assert.equal(await identity(parent), item.directoryIdentity);
    assert.equal(await identity(file), item.payloadIdentity);
    assert.equal(sha(await fs.readFile(file)), item.payloadSha256);
  }
  return { ...context, scratches };
}

for (const kind of ['backup', 'restore']) test(`review regression completed ${kind} retry removes plaintext from every registered recovery attempt`, async t => {
  const { f, root, record, scratches } = await failedRecoveryAttempt(t, kind);
  const verification = path.join(root, 'verification'), keep = path.join(verification, 'unrelated-owned.txt');
  await regular(keep, 'synthetic unrelated file');
  const originals = ['checkpoint/payload.bin', ...(kind === 'restore' ? ['incoming/payload.bin'] : [])];
  for (const name of originals) assert.ok((await fs.stat(path.join(root, name))).size > 0);
  assert.equal((await payloadFiles(verification)).length, scratches.length);
  await f.reopen(true);
  assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_PREVIOUS' });
  const completed = await f.recordState();
  assert.equal(completed.active, null); assert.equal(completed.completed.at(-1).transactionId, record.transactionId);
  assert.equal(completed.scratches.length, scratches.length * 2);
  assert.deepEqual(completed.scratches.slice(0, scratches.length), scratches);
  assert.deepEqual(await payloadFiles(root), [], 'COMPLETED must remove every owned plaintext attempt');
  assert.equal(await fs.readFile(keep, 'utf8'), 'synthetic unrelated file');
  assert.ok((await fs.stat(path.join(root, 'checkpoint.cibackup'))).size > 0);
  if (kind === 'restore') assert.ok((await fs.stat(path.join(root, 'input', 'archive.cibackup'))).size > 0);
  assert.equal(f.state.aiOff, true); await f.intact(); await f.reopen();
});

test('review regression rejects an older valid B and PG receipt against newer completed recovery history', async t => {
  const f = await fixture(t); await f.runtime.backup(f.destination);
  const older = copy(f.state), olderProjection = await f.args.adapter.readProjection();
  await f.runtime.backup(f.destination);
  const records = await f.recordState();
  assert.equal(records.completed.length, 2);
  assert.equal(records.completed[0].receipt.transactionId, older.maintenanceReceipt.transactionId);
  assert.notEqual(records.completed.at(-1).receipt.transactionId, older.maintenanceReceipt.transactionId);
  Object.assign(f.state, older); f.args.adapter.readProjection = async () => copy(olderProjection);
  const offset = f.trace.length;
  await rejects(f.reopen()); await rejects(f.reopen(true));
  assert.deepEqual(f.state, older); assert.equal(f.trace.slice(offset).includes('gateway.begin'), false);
  assert.equal(f.trace.slice(offset).includes('resume'), false); assert.deepEqual(await f.recordState(), records);
});

test('review regression accepts only the latest completed receipt on a normal and recovery reopen', async t => {
  const f = await fixture(t); await f.runtime.backup(f.destination); await f.runtime.backup(f.destination);
  const state = copy(f.state), records = await f.recordState();
  assert.deepEqual(records.completed.at(-1).receipt, state.maintenanceReceipt);
  await f.reopen(); assert.equal(await f.runtime.pendingRecovery(), null);
  await f.reopen(true); const offset = f.trace.length;
  assert.deepEqual(await f.runtime.recover(), { recovered: false });
  assert.deepEqual(f.state, state); assert.equal(f.trace.slice(offset).includes('gateway.begin'), false);
  assert.equal(f.trace.slice(offset).includes('resume'), false); assert.deepEqual(await f.recordState(), records);
});

test('review regression preserves an unregistered verification payload and refuses completion without deleting known scratch', async t => {
  const { f, root, record, scratches } = await failedRecoveryAttempt(t);
  const unknown = await privateDir(path.join(root, 'verification', `verify-checkpoint-${crypto.randomUUID()}`));
  const file = path.join(unknown, 'payload.bin'), original = path.join(root, 'checkpoint', 'payload.bin');
  await regular(file, await fs.readFile(original));
  const proof = { identity: await identity(file), sha256: sha(await fs.readFile(file)) };
  await f.reopen(true); const offset = f.trace.length; await rejects(f.runtime.recover());
  assert.equal(f.trace.slice(offset).includes('resume'), false); assert.equal(f.trace.slice(offset).includes('handle.release'), false);
  assert.equal(await identity(file), proof.identity); assert.equal(sha(await fs.readFile(file)), proof.sha256);
  assert.equal(await identity(original), record.input.scratchPayloads.checkpoint.payloadIdentity);
  for (const item of scratches) assert.equal(await identity(path.join(root, item.relativeDirectory, 'payload.bin')), item.payloadIdentity);
  const pending = await f.recordState(); assert.equal(pending.active.transactionId, record.transactionId);
  assert.equal(pending.completed.length, 0); assert.equal(f.state.aiOff, true); await f.intact();
});

for (const variant of ['payload inode', 'payload hash', 'parent inode', 'payload hardlink']) {
  test(`review regression preflights previous recovery ${variant} before removing any registered plaintext`, async t => {
    const { f, root, record, scratches } = await failedRecoveryAttempt(t), item = scratches.at(-1);
    const parent = path.join(root, item.relativeDirectory), file = path.join(parent, 'payload.bin');
    const bytes = await fs.readFile(file);
    if (variant === 'payload inode') { await fs.rename(file, path.join(f.root, 'preserved-payload.bin')); await regular(file, bytes); }
    else if (variant === 'payload hash') { const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; await fs.writeFile(file, changed); }
    else if (variant === 'parent inode') { await fs.rename(parent, path.join(f.root, 'preserved-verification')); await privateDir(parent); await regular(file, bytes); }
    else await fs.link(file, path.join(f.root, 'linked-payload.bin'));
    const replacement = { identity: await identity(file), sha256: sha(await fs.readFile(file)) };
    await f.reopen(true); const offset = f.trace.length; await rejects(f.runtime.recover());
    assert.equal(f.trace.slice(offset).includes('resume'), false); assert.equal(f.trace.slice(offset).includes('handle.release'), false);
    assert.equal(await identity(file), replacement.identity); assert.equal(sha(await fs.readFile(file)), replacement.sha256);
    const original = path.join(root, 'checkpoint', 'payload.bin');
    assert.equal(await identity(original), record.input.scratchPayloads.checkpoint.payloadIdentity);
    assert.equal(sha(await fs.readFile(original)), record.input.checkpointSha256);
    for (const other of scratches.slice(0, -1)) assert.equal(await identity(path.join(root, other.relativeDirectory, 'payload.bin')), other.payloadIdentity);
    assert.equal((await f.recordState()).active.transactionId, record.transactionId); assert.equal(f.state.aiOff, true); await f.intact();
  });
}

test('review regression refuses a replaced verification root before creating another recovery payload', async t => {
  const { f, root, record } = await interrupted(t, { point: 'prepareResume' }), verification = path.join(root, 'verification');
  assert.equal(await identity(verification), record.input.verificationIdentity);
  await fs.rename(verification, path.join(f.root, 'preserved-verification-root')); await privateDir(verification);
  await f.reopen(true); const offset = f.trace.length; await rejects(f.runtime.recover());
  noRecoveryResume(f, offset); assert.deepEqual(await fs.readdir(verification), []);
  assert.equal(f.trace.slice(offset).includes('export.rows'), false);
  assert.equal((await f.recordState()).active.transactionId, record.transactionId); await f.intact();
});

test('review regression accepts an already removed registered payload only under its original verification directory', async t => {
  const { f, root, record, scratches } = await failedRecoveryAttempt(t), item = scratches[0];
  const parent = path.join(root, item.relativeDirectory); await fs.unlink(path.join(parent, 'payload.bin'));
  assert.equal(await identity(parent), item.directoryIdentity);
  await f.reopen(true); assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_PREVIOUS' });
  const completed = await f.recordState(); assert.equal(completed.active, null);
  assert.equal(completed.completed.at(-1).transactionId, record.transactionId);
  assert.deepEqual(await payloadFiles(root), []); assert.equal(f.state.aiOff, true); await f.intact();
});

function v26Summary(rows) {
  const result = summary(rows); result.schema = REVIEWED_V26_SCHEMA;
  delete result.tableCounts.snapshot_inventory_measurements; delete result.tableSha256.snapshot_inventory_measurements;
  return result;
}
test('V26 encrypted archive restores retained sources without mutating the selected archive', async t => {
  const f = await fixture(t); const archive = await f.legacyArchive(); const before = await fs.readFile(archive);
  assert.equal((await f.runtime.restore(archive)).restored, true);
  assert.equal(f.databaseImage, 'restored'); assert.deepEqual(await fs.readFile(archive), before);
  assert.ok(f.loadedRows.some(row => row.table === 'files' && !Object.hasOwn(row.values, 'analysis_status')));
  assert.equal(f.state.aiOff, true);
});
test('completed V26 restore recovery compares upgraded hashes while keeping original payload identity', async t => {
  const f = await fixture(t); const archive = await f.legacyArchive();
  const recordsRoot = path.join(f.userData, 'backup-maintenance'); let injected = false;
  const unlink = fs.unlink;
  t.mock.method(fs, 'unlink', async file => {
    if (!injected && String(file) === path.join(recordsRoot, 'active.enc')) {
      injected = true; throw new Error('synthetic-private marker unlink interruption');
    }
    return unlink(file);
  });
  await rejects(f.runtime.restore(archive)); assert.equal(injected, true); assert.equal(f.databaseImage, 'restored');
  const receipt = copy(f.state.maintenanceReceipt); await f.reopen(true);
  assert.deepEqual(await f.runtime.recover(), { recovered: true, outcome: 'VERIFIED_RESTORED' });
  assert.deepEqual(f.state.maintenanceReceipt, receipt); assert.equal(f.state.aiOff, true);
  assert.equal((await f.recordState()).active, null);
});
