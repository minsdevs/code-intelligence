'use strict';

// Main-only composition. The renderer supplies only a native-dialog selection; every database,
// source root, key and recovery operation below is supplied by fixed application code.
const posixFs = require('node:fs/promises');
const { createBackupPlatformIO } = require('./backup-platform-io.cjs');
const native = require('./backup-windows-io.cjs');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encryptFile, decryptFile } = require('./backup-archive.cjs');
const { createBackupPayload, readBackupPayload } = require('./backup-payload.cjs');
const { upgradeV26FileRow } = require('./backup-export-policy.cjs');
const { BackupPostgresError } = require('./backup-postgres.cjs');
const { createBackupSourceInventory } = require('./backup-source-selection.cjs');
const { createBackupCostCollector, buildMaintenanceMergeInputs, maintenanceProjectionDigest,
  createMaintenanceVerifier } = require('./backup-cost-state.cjs');
const { createBackupRecoveryRecords } = require('./backup-recovery-records.cjs');
const { createBackupSourceSwap } = require('./backup-source-swap.cjs');
const { createBackupRetention, validateRetentionManifest, retentionManifestSha256,
  isRetentionTopLevelName } = require('./backup-retention.cjs');
const { createBackupCapacity, planBackupCapacity, measureBackupTree } = require('./backup-capacity.cjs');
const MAX_BYTES = 10 * 1024 * 1024 * 1024 + 1024 * 1024;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const same = (a, b) => canonical(a) === canonical(b);
class BackupRuntimeError extends Error {
  constructor(code = 'RECOVERY_REQUIRED') {
    super(code === 'BUSY' ? 'Backup or restore is already running.'
      : code === 'INPUT' ? 'Choose an intact encrypted backup from this installation.'
        : code === 'INCOMPATIBLE' ? 'This backup is not compatible with this app. Restore was not started; existing data and the selected backup were preserved.'
        : code === 'CAPACITY' ? 'There is not enough free space to verify this backup safely.'
        : 'Backup or restore could not be verified. Preserved recovery data requires inspection before restarting.');
    this.name = 'BackupRuntimeError'; this.code = `BACKUP_RUNTIME_${code}`;
    this.recoveryRequired = !['BUSY', 'INPUT', 'CAPACITY', 'INCOMPATIBLE'].includes(code);
  }
}
function fail(code) { throw new BackupRuntimeError(code); }


async function createDesktopBackupRuntime(options) {
  const { userData, installationId, runningBuild, keyProvider, journal, gateway, adapter, ports, windowsBoundary } = options;
  const fs = windowsBoundary ? await createBackupPlatformIO(windowsBoundary, userData) : posixFs;
  try {
async function missing(file) {
  try { await fs.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function privateStat(stat, directory) {
  if (stat.platform === 'win32') { if (stat.kind !== (directory ? 'directory' : 'file')) fail(); return; }
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n)
      || (!directory && stat.nlink !== 1n)) fail();
}
const identity = stat => stat.platform === 'win32' ? stat.identity : `${stat.dev}:${stat.ino}`;
const state = stat => stat.platform === 'win32' ? stat.token : `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
async function directory(root, privateOnly = true) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root
      || await fs.realpath(root) !== root) fail('INPUT');
  const stat = await fs.lstat(root, { bigint: true });
  if (privateOnly) privateStat(stat, true);
  else if (stat.platform !== 'win32' && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid())
    || (stat.mode & 0o022n))) fail('INPUT');
  return stat;
}
async function sync(root, privateOnly = true) {
  const before = await directory(root, privateOnly);
  if (windowsBoundary) { if (identity(await fs.syncNamespace(root)) !== identity(before)) fail(); return; }
  const fd = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { if (identity(before) !== identity(await fd.stat({ bigint: true }))) fail(); await fd.sync(); }
  finally { await fd.close(); }
}
async function fresh(parent, name) {
  await directory(parent); const root = path.join(parent, name);
  await fs.mkdir(root, { mode: 0o700 }); await sync(parent); await directory(root); return root;
}
async function fileHash(file) {
  const before = await fs.lstat(file, { bigint: true }); privateStat(before, false);
  if (before.size > BigInt(MAX_BYTES)) fail();
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (state(before) !== state(await fd.stat({ bigint: true }))) fail();
    const hash = crypto.createHash('sha256');
    for await (const bytes of fd.createReadStream({ autoClose: false })) hash.update(bytes);
    if (state(before) !== state(await fd.stat({ bigint: true })) || state(before) !== state(await fs.lstat(file, { bigint: true }))) fail();
    return hash.digest('hex');
  } finally { await fd.close(); }
}
async function removeOwnedPayload(root, expected) {
  const file = path.join(root, 'payload.bin'); const parent = await directory(root);
  const before = await fs.lstat(file, { bigint: true }); privateStat(before, false);
  if (await fileHash(file) !== expected.sha256 || identity(before) !== expected.identity) fail();
  const current = await fs.lstat(file, { bigint: true }); privateStat(current, false);
  if (state(current) !== state(before) || identity(await directory(root)) !== identity(parent)) fail();
  await fs.unlink(file); await sync(root);
}
async function freeSpace(root, expectedBytes) {
  if (windowsBoundary) { if ((await fs.capacity(root)).available < (expectedBytes * 6n + 4n) / 5n + 64n * 1024n * 1024n) fail('CAPACITY'); return; }
  const stat = await fs.statfs(root, { bigint: true });
  if (stat.bavail * stat.bsize < (expectedBytes * 6n + 4n) / 5n + 64n * 1024n * 1024n) fail('CAPACITY');
}
async function cleanupOwnedScratch(owned) {
  // Preflight the entire small, code-created tree before removing any entry. An unrecognized
  // filename or changed inode is preserved for inspection, never recursively erased.
  for (const [file, expected] of owned) {
    const stat = await fs.lstat(file, { bigint: true }); privateStat(stat, expected.directory);
    if (identity(stat) !== expected.identity) fail();
    if (expected.directory) for (const name of await fs.readdir(file)) {
      if (!owned.has(path.join(file, name))) fail();
    }
  }
  for (const [file, expected] of [...owned].sort((a, b) => b[0].length - a[0].length)) {
    const stat = await fs.lstat(file, { bigint: true }); privateStat(stat, expected.directory);
    if (identity(stat) !== expected.identity) fail();
    if (expected.directory) await fs.rmdir(file); else await fs.unlink(file);
    await sync(path.dirname(file), false);
  }
}
async function copySelectedFile(selected, destination, created) {
  if (windowsBoundary) {
    const { stat: before, handle: source } = await fs.openSource(selected); let output;
    try {
      if (before.size < 12n || before.size > BigInt(MAX_BYTES)) fail('INPUT');
      await freeSpace(path.dirname(destination), before.size * 3n);
      output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      created(identity(await output.stat())); let copied = 0n;
      for await (const chunk of source.createReadStream()) { copied += BigInt(chunk.length); if (copied > before.size) fail('INPUT'); await output.write(chunk); }
      if (copied !== before.size || state(before) !== state(await source.stat())) fail('INPUT');
      await output.sync();
    } finally { await output?.close(); await source.close(); }
    return;
  }
  if (typeof selected !== 'string' || !path.isAbsolute(selected) || path.resolve(selected) !== selected
      || await fs.realpath(selected) !== selected) fail('INPUT');
  const before = await fs.lstat(selected, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 12n || before.size > BigInt(MAX_BYTES)
      || before.uid !== BigInt(process.getuid())) fail('INPUT');
  await freeSpace(path.dirname(destination), before.size * 3n);
  const source = await fs.open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    if (state(before) !== state(await source.stat({ bigint: true }))) fail('INPUT');
    output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const original = await output.stat({ bigint: true }); privateStat(original, false); created(identity(original));
    let copied = 0n;
    for await (const chunk of source.createReadStream({ autoClose: false, start: 0, end: Number(before.size) - 1 })) {
      copied += BigInt(chunk.length);
      if (copied > before.size || copied > BigInt(MAX_BYTES)) fail('INPUT');
      await output.writeFile(chunk);
    }
    if (copied !== before.size) fail('INPUT');
    if (state(before) !== state(await source.stat({ bigint: true })) || state(before) !== state(await fs.lstat(selected, { bigint: true }))) fail('INPUT');
    await output.sync();
  } finally { await output?.close(); await source.close(); }
  await sync(path.dirname(destination));
}
  const identityRecord = stat => stat.platform === 'win32' ? native.identity(stat) : { dev: String(stat.dev), ino: String(stat.ino) };
  const validIdentity = value => typeof value === 'string' && (windowsBoundary ? /^WI1:[0-9]+:[0-9]+:[0-9]+$/ : /^[0-9]+:[0-9]+$/).test(value);
  const recoveryMode = options.recoveryMode ?? false;
  if (typeof recoveryMode !== 'boolean') fail();
  await directory(userData);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(installationId) || typeof runningBuild !== 'string'
      || runningBuild.match(/^(0|[1-9][0-9]{0,18})$/)?.[0] !== runningBuild || BigInt(runningBuild) > 9223372036854775807n) fail();
  for (const key of ['pause', 'prepareResume', 'resume', 'failure', 'openExport', 'openStage', 'sourceWorker', 'database', 'productState',
    'exportVault', 'restoreVault', 'invalidateAuthority']) if (typeof ports?.[key] !== 'function') fail();
  const readOptions = root => ({ root, installationId, runningBuild, windowsBoundary });
  const recoveryRoot = path.join(userData, 'recovery'), recordsRoot = path.join(userData, 'backup-maintenance');
  const dataRoot = path.join(userData, 'data');
  const initial = journal.snapshot();
  const initialize = await missing(recordsRoot);
  if (initialize && (initial.pendingRestore || initial.pendingMaintenance || initial.maintenanceReceipt)) fail();
  const verifier = createMaintenanceVerifier({ installationId, readProjection: adapter.readProjection });
  const retentionHistory = new Map();
  const records = await createBackupRecoveryRecords({ root: recordsRoot, installationId, runningBuild, windowsBoundary,
    keyProvider, initialize, verifyCompletion: async (_record, { transactionId, receipt }) => {
      const snapshot = journal.snapshot();
      if (snapshot.pendingRestore || snapshot.pendingMaintenance || snapshot.aiOff !== true
          || receipt?.transactionId !== transactionId || !same(snapshot.maintenanceReceipt, receipt)) return false;
      await verifier(snapshot, receipt); return true;
    }, verifyCollection: async (snapshot, value) => {
      // This callback runs inside the record writer queue. Use authenticated immutable history
      // cached by readRetentionAuthority; re-entering records here would deadlock that queue.
      const state = journal.snapshot(), item = retentionHistory.get(value.transactionId);
      if (snapshot.active || state.pendingMaintenance || state.pendingRestore || state.aiOff !== true || !item
          || item.manifestSha256 !== value.manifestSha256
          || !snapshot.completed.some(row => row.transactionId === value.transactionId && row.sequence === item.sequence)
          || !same(snapshot.completed.at(-1)?.receipt, state.maintenanceReceipt)) return false;
      await verifier(state, state.maintenanceReceipt); return true;
    } });
  try {
    const previous = await records.read();
    if (previous.active && !recoveryMode) fail();
    if (previous.collections.some(item => item.state === 'BEGUN') && !recoveryMode) fail();
    if ((initial.pendingMaintenance || initial.pendingRestore) && !previous.active) fail();
    if (initial.maintenanceReceipt) {
      if (!same(previous.completed.at(-1)?.receipt, initial.maintenanceReceipt)
          && !(recoveryMode && previous.active?.transactionId === initial.maintenanceReceipt.transactionId)) fail();
    } else if (previous.completed.length && !previous.active) fail();
  } catch {
    try { await records.close(); } finally { if (windowsBoundary) await fs.close(); } fail();
  }
  let busy = false, closed = false, current;
  async function readRetentionAuthority() {
    const snapshot = await records.read(), state = journal.snapshot(), completed = [];
    if (!snapshot.active && snapshot.completed.length
        && !same(snapshot.completed.at(-1)?.receipt, state.maintenanceReceipt)) fail();
    for (const item of snapshot.completed) {
      let cached = retentionHistory.get(item.transactionId);
      if (!cached) {
        const transaction = await records.readTransaction({ transactionId: item.transactionId });
        const entry = transaction.records.findLast(row => row.phase === 'RETENTION_READY');
        // Historical completed backups without a retention manifest remain uncollectible.
        if (!entry) continue;
        const manifest = validateRetentionManifest(entry.data);
        cached = { transactionId: item.transactionId, sequence: item.sequence, manifest,
          manifestSha256: retentionManifestSha256(manifest) }; retentionHistory.set(item.transactionId, cached);
      }
      if (cached.sequence !== item.sequence) fail();
      completed.push({ transactionId: cached.transactionId, sequence: cached.sequence, manifest: cached.manifest });
    }
    return { active: snapshot.active?.transactionId || null,
      pendingMaintenance: state.pendingMaintenance?.transactionId || (state.pendingRestore ? snapshot.active?.transactionId : null) || null,
      completed, tombstones: snapshot.collections };
  }
  async function retentionManifest(root, transactionId, database) {
    const topLevel = [];
    for (const name of (await fs.readdir(root)).sort()) {
      if (!isRetentionTopLevelName(name)) fail();
      const stat = await fs.lstat(path.join(root, name), { bigint: true });
      if (/^(?:previous|failed)-(?:repos|sources)$/.test(name)) await directory(path.join(root, name), false);
      else privateStat(stat, name !== 'checkpoint.cibackup');
      topLevel.push({ name, type: name === 'checkpoint.cibackup' ? 'file' : 'directory', ...identityRecord(stat) });
    }
    const stat = await directory(root), checkpoint = path.join(root, 'checkpoint.cibackup');
    const db = await database.inspect(transactionId), databases = [];
    for (const slot of ['previous', 'failed']) {
      const value = db.databases[db.names[slot]];
      if (value) {
        if (value.allowConnections || value.oid === db.databases[db.names.live]?.oid) fail();
        databases.push({ slot, oid: value.oid });
      }
    }
    return validateRetentionManifest({ root: identityRecord(stat),
      checkpoint: { bytes: String((await fs.lstat(checkpoint, { bigint: true })).size), sha256: await fileHash(checkpoint) }, databases, topLevel });
  }
  async function collectCompleted(database, product) {
    const authority = await readRetentionAuthority();
    if (authority.completed.length < 3) return;
    await product.verifyOrigin();
    const retention = await createBackupRetention({ recoveryRoot, readAuthority: readRetentionAuthority, windowsBoundary,
      beginCollection: records.beginCollection, finishCollection: records.finishCollection,
      dropDatabase: value => database.dropRetained(value) });
    try { await retention.collect(); } finally { await retention.close(); }
  }
  async function sourceIdentities() {
    const result = {};
    for (const name of ['repos', 'sources']) {
      const file = path.join(dataRoot, name);
      result[name] = await missing(file) ? null : identity(await directory(file, false));
    }
    return result;
  }
  async function rememberScratch(transactionId, root, item) {
    await records.registerScratch({ transactionId, relativeDirectory: path.relative(root, item.root).split(path.sep).join('/'),
      directoryIdentity: identity(await directory(item.root)), payloadIdentity: item.value.payloadIdentity,
      payloadSha256: item.value.payloadSha256 });
  }
  async function cleanupRecoveryScratch(transactionId, root, input) {
    const plans = [];
    const inspect = async (parent, directoryIdentity, payloadIdentity, payloadSha256) => {
      if (identity(await directory(parent)) !== directoryIdentity) fail();
      const file = path.join(parent, 'payload.bin');
      if (await missing(file)) return;
      const stat = await fs.lstat(file, { bigint: true }); privateStat(stat, false);
      if (identity(stat) !== payloadIdentity || await fileHash(file) !== payloadSha256) fail();
      plans.push({ root: parent, sha256: payloadSha256, identity: payloadIdentity });
    };
    for (const name of ['checkpoint', 'incoming']) {
      const item = input.scratchPayloads[name];
      if (item) await inspect(path.join(root, name), item.directoryIdentity, item.payloadIdentity, item.sha256);
    }
    const registered = (await records.read()).scratches.filter(item => item.transactionId === transactionId);
    const known = new Set(registered.map(item => item.relativeDirectory));
    const verification = path.join(root, 'verification');
    if (identity(await directory(verification)) !== input.verificationIdentity) fail();
    for (const name of await fs.readdir(verification)) {
      if (!/^verify-(?:checkpoint|incoming|product)-[0-9a-f-]{36}$/.test(name)) continue;
      const relative = `verification/${name}`, parent = path.join(root, relative);
      await directory(parent);
      // A killed writer may leave an incomplete payload without a durable ownership ACK.
      // Preserve it and block completion; a plausible filename cannot grant deletion authority.
      if (!known.has(relative) && !await missing(path.join(parent, 'payload.bin'))) fail();
    }
    for (const item of registered) await inspect(path.join(root, item.relativeDirectory), item.directoryIdentity,
      item.payloadIdentity, item.payloadSha256);
    // Validate every old and current attempt before removing the first known plaintext file.
    for (const item of plans) await removeOwnedPayload(item.root, { sha256: item.sha256, identity: item.identity });
  }
  async function inspectPayload(root) {
    const inventory = createBackupSourceInventory(), costs = createBackupCostCollector(installationId);
    const git = [], vault = []; let summary;
    const upgradedFiles = crypto.createHash('sha256');
    for await (const record of readBackupPayload(readOptions(root))) {
      if (record.kind === 'ROW') {
        const row = record.row.table === 'files' && !Object.hasOwn(record.row.values, 'analysis_status')
          ? upgradeV26FileRow(record.row.values) : record.row;
        inventory.add(row); costs.add(row);
        if (row.table === 'files') upgradedFiles.update(`${canonical(row)}\n`);
      }
      else if (record.kind === 'DATABASE') summary = record.summary;
      else if (record.kind === 'SOURCE_BEGIN') git.push({ projectId: record.projectId, selection: record.selection,
        selectionSha256: record.receipt.selectionSha256 });
      else if (record.kind === 'VAULT_OBJECT') vault.push({ projectId: record.projectId, sha256: record.sha256,
        byteSize: record.byteSize, keyId: record.keyId });
    }
    const sources = inventory.finish();
    if (!same(sources.git, git) || !same(sources.vault, vault) || !summary) fail('INPUT');
    const file = path.join(root, 'payload.bin');
    const payloadSha256 = await fileHash(file);
    const restoredHashes = { ...summary.tableSha256 };
    if (summary.schema.migrations.length === 26) restoredHashes.files = upgradedFiles.digest('hex');
    return { summary, restoredHashes, sources, costs: costs.finish(), payloadSha256,
      payloadIdentity: identity(await fs.lstat(file, { bigint: true })) };
  }
  async function checkRestoreCompatibility(expected) {
    // Keep preflight resources out of perform()'s maintenance cleanup: a refused
    // archive must not call ports.failure, pause writers or append to the cost journal.
    let live, control;
    try {
      live = await ports.openExport();
      const owner = await live.readRestoreIdentity();
      control = await ports.database();
      await control.withCompatibilityStage(async name => {
        const probe = await ports.openStage(name);
        try {
          await probe.initializeStaging();
          try { probe.assertRestoreCompatibility({ expected, liveOwnerUserId: owner.ownerUserId }); }
          catch (error) {
            // Only the shared catalog/owner comparison produces the typed refusal.
            // An active job, failed initialization, timeout or cleanup is not a
            // claim that the archive is incompatible.
            if (error instanceof BackupPostgresError && ['BACKUP_PG_SCHEMA', 'BACKUP_PG_OWNER'].includes(error.code)) fail('INCOMPATIBLE');
            throw error;
          }
        } finally { await probe.close(); }
      });
      const after = await live.readRestoreIdentity();
      if (!same(after, owner)) fail('INPUT');
    } finally {
      let failure;
      for (const resource of [control, live]) try { await resource?.close(); } catch (error) { failure ||= error; }
      if (failure) throw failure;
    }
  }
  async function exportCurrent(root, lease) {
    const writer = await createBackupPayload({ root, installationId, minimumVersion: runningBuild, windowsBoundary,
      ...(lease ? { beforeWrite: bytes => lease.consume('checkpointPayload', bytes) } : {}) });
    const inventory = createBackupSourceInventory(); const costs = createBackupCostCollector(installationId);
    let db, worker, sourceReader;
    try {
      db = await ports.openExport();
      const summary = await db.exportRows({ writeRow: async row => { inventory.add(row); costs.add(row); await writer.writeRow(row); } });
      await writer.writeDatabase(summary); const sources = inventory.finish();
      const retained = sources.retained || [];
      const times = retained.length ? await db.readRetainedCommitTimes({ snapshotIds: retained.map(item => item.snapshotId) }) : {};
      if (retained.length) sourceReader = await ports.sourceReader();
      const scratch = retained.length ? await fresh(root, 'source-workspaces') : null;
      if (sources.git.length) {
        worker = await ports.sourceWorker();
        for (const project of sources.git) {
          const descriptors = retained.filter(item => item.projectId === project.projectId).map(({ projectId, ...item }) => {
            if (!Object.hasOwn(times, item.snapshotId)) fail();
            return { ...item, commitEpochSecond: times[item.snapshotId] };
          });
          await worker.exportProject({ reposRoot: path.join(dataRoot, 'repos'),
            ...(descriptors.length ? { scratchRoot: scratch, retained: descriptors,
              readRetainedBlob: value => sourceReader.read(value) } : {}),
            projectId: project.projectId, selection: project.selection, writeRecord: async record => {
            if (record.kind === 'BEGIN') await writer.writeSource({ kind: 'SOURCE_BEGIN', projectId: project.projectId,
              selection: project.selection, receipt: record });
            else if (record.kind === 'OBJECT') await writer.writeSource({ kind: 'GIT_OBJECT', projectId: project.projectId, object: record });
            else if (record.kind === 'END') await writer.writeSource({ kind: 'SOURCE_END', projectId: project.projectId, receipt: record });
            else fail();
          } });
        }
      }
      await sourceReader?.close(); sourceReader = undefined;
      if (sources.vault.length) await ports.exportVault(sources.vault, async packet => {
        try { await writer.writeSource({ kind: 'VAULT_OBJECT', projectId: packet.projectId, format: packet.format,
          sha256: packet.sha256, byteSize: packet.byteSize, keyId: packet.keyId, cipherSha256: packet.cipherSha256,
          envelopeBase64: packet.envelope.toString('base64') }); } finally { packet.envelope.fill(0); }
      });
      await writer.finish();
      const observed = await inspectPayload(root);
      if (!same(observed.summary, summary) || !same(observed.sources, sources) || !same(observed.costs, costs.finish())) fail();
      return observed;
    } finally {
      let failure;
      for (const resource of [writer, worker, sourceReader, db]) try { await resource?.close(); } catch (error) { failure ||= error; }
      if (failure) throw failure;
    }
  }
  async function encrypt(root, destinationRoot, name, lease, component) {
    return encryptFile({ windowsBoundary, sourceRoot: root, sourcePath: path.join(root, 'payload.bin'), destinationRoot,
      destinationPath: path.join(destinationRoot, name), installationId, keyProvider,
      ...(lease ? { beforeWrite: bytes => lease.consume(component, bytes) } : {}) });
  }
  async function beginCapacity(database, transactionId, { kind, root, destinationRoot, archived, recovery = false }) {
    const fixedRoots = typeof ports.capacityRoots === 'function' ? await ports.capacityRoots()
      : { postgres: path.join(userData, 'postgres'), source: dataRoot, bundle: recoveryRoot };
    if (!fixedRoots || Object.keys(fixedRoots).sort().join(',') !== 'bundle,postgres,source') fail();
    const sizes = await database.readSizes({ transactionId });
    const source = await measureBackupTree({ root: fixedRoots.source, windowsBoundary });
    const bundle = await measureBackupTree({ root: fixedRoots.bundle, windowsBoundary });
    const exported = await ports.openExport(); let measurement;
    try { measurement = await exported.measureExport(); } finally { await exported.close(); }
    const max = (...values) => values.reduce((a, b) => a > b ? a : b, 0n);
    const baseSource = max(BigInt(source.logicalBytes), BigInt(source.allocatedBytes));
    const baseBundle = max(BigInt(bundle.logicalBytes), BigInt(bundle.allocatedBytes));
    const live = BigInt(sizes.liveDatabaseBytes);
    // Compression and PG index/WAL growth have no constant expansion ratio. These are
    // admission allowances: serialized writes have hard caps; staged storage is measured
    // before A publication. Exceeding an allowance preserves A for a new inspection.
    const checkpointLimit = BigInt(measurement.databasePayloadBytes) * 2n + baseSource * 8n + 64n * 1024n ** 2n;
    const archiveBytes = async file => {
      const stat = await fs.lstat(file, { bigint: true }); privateStat(stat, false); return stat.size;
    };
    let incomingArchive = 0n, incomingPayload = 0n, stagedDatabase = 0n, stagedSource = 0n;
    if (recovery) {
      incomingPayload = await archiveBytes(path.join(root, 'checkpoint.cibackup'));
      if (kind === 'RESTORE') incomingPayload += await archiveBytes(path.join(root, 'input', 'archive.cibackup'));
    } else if (archived) {
      incomingArchive = await archiveBytes(path.join(root, 'input', 'archive.cibackup'));
      incomingPayload = await archiveBytes(path.join(root, 'incoming', 'payload.bin'));
      stagedDatabase = max(live * 2n, incomingPayload * 3n) + 64n * 1024n ** 2n;
      stagedSource = incomingPayload * 8n + 64n * 1024n ** 2n;
    }
    let capacity;
    try {
      const plan = planBackupCapacity({ kind: recovery ? 'RESTORE' : kind,
        liveDatabaseBytes: String(live), liveSourceBytes: String(baseSource), previousBundleBytes: String(baseBundle),
        checkpointPayloadLimitBytes: String(checkpointLimit), incomingArchiveBytes: String(incomingArchive),
        incomingPayloadBytes: String(incomingPayload), stagedDatabaseLimitBytes: String(stagedDatabase), stagedSourceLimitBytes: String(stagedSource) });
      capacity = await createBackupCapacity({ windowsBoundary, roots: { ...fixedRoots, recovery: recoveryRoot, destination: destinationRoot || null } });
      const lease = await capacity.begin(plan);
      if (archived && !recovery) {
        await lease.consume('incomingArchive', String(incomingArchive));
        await lease.consume('incomingPayload', String(incomingPayload));
      }
      return { capacity, lease };
    } catch { await capacity?.close().catch(() => {}); fail('CAPACITY'); }
  }
  async function restoreSources(root, stage, expected) {
    const iterator = readBackupPayload(readOptions(root))[Symbol.asyncIterator](); let worker;
    const vaultPackets = async function* () {
      for (;;) {
        const next = await iterator.next(); if (next.done) return; const record = next.value;
        if (record.kind === 'SOURCE_BEGIN') {
          worker ||= await ports.sourceWorker();
          const receipt = Object.fromEntries(['selectionSha256', 'objectCount', 'totalObjectBytes', 'objectsSha256'].map(key => [key, record.receipt[key]]));
          async function* objects() {
            for (;;) {
              const item = await iterator.next(); if (item.done) fail();
              if (item.value.kind === 'SOURCE_END' && item.value.projectId === record.projectId) return;
              if (item.value.kind !== 'GIT_OBJECT' || item.value.projectId !== record.projectId) fail();
              yield item.value.object;
            }
          }
          await worker.restoreProject({ stageRoot: path.join(stage, 'repos'), projectId: record.projectId,
            selection: record.selection, expected: receipt, objects: objects() });
        } else if (record.kind === 'VAULT_OBJECT') {
          const packet = { format: record.format, projectId: record.projectId, sha256: record.sha256,
            byteSize: record.byteSize, keyId: record.keyId, cipherSha256: record.cipherSha256,
            envelope: Buffer.from(record.envelopeBase64, 'base64') };
          try { yield packet; } finally { packet.envelope.fill(0); }
        }
      }
    };
    try {
      if (expected.vault.length) await ports.restoreVault(path.join(stage, 'sources'), vaultPackets());
      else for await (const _packet of vaultPackets()) fail();
    } finally { await iterator.return?.(); await worker?.close(); }
  }
  function metadata(transactionId, kind, payloadSha256, projection) {
    const snapshot = journal.snapshot();
    return { transactionId, kind, payloadSha256, pgProjectionDigest: maintenanceProjectionDigest(projection),
      legacyLiabilityUnresolved: projection.gate.legacyLiabilityUnresolved,
      budgetDay: snapshot.budgetDay, minimumVersion: snapshot.minimumVersion };
  }
  async function complete(handle, transactionId, kind, payloadSha256, finalize) {
    const projection = await handle.refreshProjection();
    await journal.completeMaintenance(metadata(transactionId, kind, payloadSha256, projection));
    await handle.refreshProjection();
    await finalize();
    await records.complete({ transactionId, receipt: journal.snapshot().maintenanceReceipt });
  }
  function checkedRecoveryInput(active) {
    const input = active?.input;
    const fields = ['version', 'transactionId', 'kind', 'payloadSha256', 'checkpointSha256',
      'rootIdentity', 'verificationIdentity', 'liveDatabaseOid', 'originalSources', 'scratchPayloads', 'mergeInputs', 'liveProjection', 'archivedProjection'];
    if (!input || Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))
        || input.version !== 2 || input.transactionId !== active.transactionId || input.kind !== active.kind
        || !['BACKUP', 'RESTORE'].includes(input.kind)
        || ['payloadSha256', 'checkpointSha256'].some(key => typeof input[key] !== 'string' || !/^[0-9a-f]{64}$/.test(input[key]))
        || !validIdentity(input.rootIdentity)
        || !validIdentity(input.verificationIdentity)
        || typeof input.liveDatabaseOid !== 'string' || !/^[1-9][0-9]{0,9}$/.test(input.liveDatabaseOid)
        || !input.originalSources || Object.keys(input.originalSources).sort().join(',') !== 'repos,sources'
        || Object.values(input.originalSources).some(id => id !== null && !validIdentity(id))
        || !Array.isArray(input.mergeInputs) || !input.mergeInputs.length || input.mergeInputs.length > 2) fail();
    if (!input.scratchPayloads || Object.keys(input.scratchPayloads).sort().join(',') !== 'checkpoint,incoming') fail();
    for (const name of ['checkpoint', 'incoming']) {
      const item = input.scratchPayloads[name];
      if (name === 'incoming' && input.kind === 'BACKUP') { if (item !== null) fail(); continue; }
      if (!item || Object.keys(item).sort().join(',') !== 'directoryIdentity,payloadIdentity,sha256'
          || ['directoryIdentity', 'payloadIdentity'].some(key => !validIdentity(item[key]))
          || item.sha256 !== (name === 'checkpoint' ? input.checkpointSha256 : input.payloadSha256)) fail();
    }
    const first = input.mergeInputs[0];
    const expected = buildMaintenanceMergeInputs({ transactionId: input.transactionId,
      liveProjection: input.liveProjection, archivedProjection: input.archivedProjection,
      snapshot: { installationId, budgetDay: first?.budgetDay, minimumVersion: first?.minimumVersion },
      budgetDay: first?.budgetDay, minimumVersion: first?.minimumVersion });
    if (!same(expected, input.mergeInputs)) fail();
    return input;
  }
  async function recoverPayload(root, archiveRoot, archiveName, expectedHash, scratchName, lease) {
    const scratch = await fresh(root, `${scratchName}-${crypto.randomUUID()}`);
    const result = await decryptFile({ windowsBoundary, sourceRoot: archiveRoot, sourcePath: path.join(archiveRoot, archiveName),
      destinationRoot: scratch, destinationPath: path.join(scratch, 'payload.bin'), installationId, keyProvider,
      beforeWrite: bytes => lease.consume('incomingPayload', bytes) });
    await freeSpace(root, BigInt(result.payloadBytes) * 3n);
    const inspected = await inspectPayload(scratch);
    if (inspected.payloadSha256 !== expectedHash) fail();
    return { root: scratch, value: inspected };
  }
  async function recover() {
    if (closed || !recoveryMode) fail(); if (busy) fail('BUSY'); busy = true;
    let database, product, sourceSwap, handle, transactionId, root, input;
    let checkpoint, incoming, observed, capacity, lease, completedInB = false;
    try {
      const state = await records.read(), active = state.active;
      if (!active) {
        const snapshot = journal.snapshot();
        if (snapshot.pendingMaintenance || snapshot.pendingRestore) fail();
        if (state.collections.some(item => item.state === 'BEGUN')) {
          const receipt = snapshot.maintenanceReceipt;
          if (!receipt || !same(state.completed.at(-1)?.receipt, receipt)) fail();
          handle = await gateway.beginMaintenance({ transactionId: receipt.transactionId, kind: receipt.kind });
          await ports.pause({ transactionId: receipt.transactionId, kind: receipt.kind, recovery: true,
            waitForAiDrain: () => handle.waitForDrain({ timeoutMs: 120000 }) });
          database = await ports.database({ readRetentionAuthority }); product = await ports.productState();
          await product.verifyOrigin(); await database.verifyQuiescent();
          // Opening B and entering this barrier append OFF records. Publish that new head
          // before GC callbacks demand an exact durable PG/B match.
          await handle.refreshProjection();
          await collectCompleted(database, product);
          await handle.release();
          return { recovered: true, outcome: 'VERIFIED_RETENTION' };
        }
        return { recovered: false };
      }
      input = checkedRecoveryInput(active); transactionId = input.transactionId;
      root = path.join(recoveryRoot, transactionId);
      if (identity(await directory(root)) !== input.rootIdentity) fail();
      const initial = journal.snapshot();
      if (initial.pendingMaintenance && (initial.pendingMaintenance.transactionId !== transactionId
          || initial.pendingMaintenance.kind !== input.kind || initial.pendingMaintenance.payloadSha256 !== input.payloadSha256)) fail();
      if (initial.pendingRestore && !input.mergeInputs.some(item => item.restoreId === initial.pendingRestore.restoreId)) fail();
      completedInB = initial.maintenanceReceipt?.transactionId === transactionId;
      if (completedInB && (initial.pendingMaintenance || initial.pendingRestore
          || initial.maintenanceReceipt.kind !== input.kind || initial.maintenanceReceipt.payloadSha256 !== input.payloadSha256)) fail();
      handle = await gateway.beginMaintenance({ transactionId, kind: input.kind });
      await ports.pause({ transactionId, kind: input.kind, recovery: true,
        waitForAiDrain: () => handle.waitForDrain({ timeoutMs: 120000 }) });
      database = await ports.database({ readRetentionAuthority }); product = await ports.productState();
      await product.verifyOrigin(); await database.verifyQuiescent();
      ({ capacity, lease } = await beginCapacity(database, transactionId, { kind: input.kind, root, recovery: true }));
      const verification = path.join(root, 'verification');
      if (identity(await directory(verification)) !== input.verificationIdentity) fail();
      checkpoint = await recoverPayload(verification, root, 'checkpoint.cibackup', input.checkpointSha256, 'verify-checkpoint', lease);
      await rememberScratch(transactionId, root, checkpoint);
      if (checkpoint.value.summary.ownerUserId !== input.liveProjection.gate.ownerUserId) fail();
      if (input.kind === 'RESTORE') {
        incoming = await recoverPayload(verification, path.join(root, 'input'), 'archive.cibackup', input.payloadSha256, 'verify-incoming', lease);
        await rememberScratch(transactionId, root, incoming);
        if (!same(incoming.value.costs.projection, input.archivedProjection)
            || incoming.value.summary.ownerUserId !== checkpoint.value.summary.ownerUserId) fail();
      } else if (input.payloadSha256 !== input.checkpointSha256 || input.archivedProjection !== null) fail();

      // The recorded inputs, not a new archive selection or a new UUID, finish any interrupted
      // monotonic B merge. An outstanding later merge must never be replaced with the first one.
      if (!completedInB && !journal.snapshot().pendingMaintenance) {
        const pending = journal.snapshot().pendingRestore;
        const start = pending ? input.mergeInputs.findIndex(item => item.restoreId === pending.restoreId) : 0;
        if (start < 0) fail();
        for (const mergeInput of input.mergeInputs.slice(start)) await handle.mergeAndCommit({ mergeInput });
        const projection = await handle.refreshProjection();
        await journal.sealMaintenance(metadata(transactionId, input.kind, input.payloadSha256, projection));
        await handle.refreshProjection();
        await records.append({ transactionId, phase: 'SEALED', data: { receipt: journal.snapshot().pendingMaintenance } });
      }
      const stagedRecords = active.records.filter(item => item.phase === 'STAGED');
      if (stagedRecords.length > 1) fail();
      const staged = stagedRecords[0]?.data;
      const rolledBack = active.records.some(item => item.phase === 'ROLLED_BACK');
      let expected = checkpoint.value;
      if (staged) {
        const plan = staged.database;
        if (input.kind !== 'RESTORE' || !plan || plan.transactionId !== transactionId
            || plan.liveOid !== input.liveDatabaseOid || typeof plan.stageOid !== 'string'
            || !/^[1-9][0-9]{0,9}$/.test(plan.stageOid) || plan.stageOid === plan.liveOid
            || plan.stageDatabase !== `ci_backup_stage_${transactionId.replaceAll('-', '')}`) fail();
        sourceSwap = await createBackupSourceSwap({ windowsBoundary, dataRoot, stageRoot: root, transactionId, resumePlan: staged.sources,
          onTransition: transition => records.append({ transactionId, phase: 'SOURCES_SWAPPED', data: transition }) });
        if (!completedInB && !rolledBack) {
          // No backend is running here. Preserve both images and restore only the captured A
          // identities. Cost journal B remains merged, OFF and pending through this operation.
          await sourceSwap.rollback();
          await database.rollback({ transactionId, liveOid: plan.liveOid, stageOid: plan.stageOid });
          await records.append({ transactionId, phase: 'ROLLED_BACK', data: { liveOid: plan.liveOid } });
        } else {
          const sourceState = await sourceSwap.inspect(), db = await database.inspect(transactionId);
          const expectedOid = rolledBack ? plan.liveOid : plan.stageOid;
          if (sourceState.phase !== (rolledBack ? 'ROLLED_BACK' : 'PUBLISHED')
              || db.databases[db.names.live]?.oid !== expectedOid || !db.databases[db.names.live].allowConnections) fail();
          if (!rolledBack) expected = incoming.value;
        }
      } else {
        // A crash during staging can leave an unacknowledged staging DB. It is not adopted or
        // deleted. Before STAGED no A publication is permitted by this coordinator.
        const db = await database.inspect(transactionId);
        if (db.databases[db.names.live]?.oid !== input.liveDatabaseOid || !db.databases[db.names.live].allowConnections
            || db.databases[db.names.previous] || db.databases[db.names.failed]
            || !same(await sourceIdentities(), input.originalSources)) fail();
      }
      await product.verifyOrigin(); await database.verifyQuiescent();
      await ports.invalidateAuthority({ transactionId, checkpointRoot: root, recovery: true });
      await product.revokeCredentials({ database: 'codeintel' });
      await handle.refreshProjection(); await handle.rotateBackendChannel();
      const verifyRoot = await fresh(verification, `verify-product-${crypto.randomUUID()}`);
      observed = { root: verifyRoot, value: await exportCurrent(verifyRoot, lease) };
      await rememberScratch(transactionId, root, observed);
      const derived = new Set(['ai_budget_gate', 'ai_request_ledger', 'ai_usage_evidence', 'user_ai_settings', 'user_ai_preferences']);
      if (observed.value.summary.ownerUserId !== expected.summary.ownerUserId
          || !same(observed.value.sources, expected.sources)) fail();
      for (const table of Object.keys(expected.summary.tableCounts)) if (!derived.has(table)
          && (observed.value.summary.tableCounts[table] !== expected.summary.tableCounts[table]
          || observed.value.summary.tableSha256[table] !== (expected.restoredHashes || expected.summary.tableSha256)[table])) fail();
      if (expected.summary.schema.migrations.length === 26
          && (observed.value.summary.tableCounts.snapshot_inventory_measurements !== '0'
          || observed.value.summary.tableSha256.snapshot_inventory_measurements !== crypto.createHash('sha256').digest('hex'))) fail();
      await ports.prepareResume({ transactionId, restored: true, recovery: true });
      if (active.phase !== 'COMPLETED') await records.append({ transactionId, phase: 'HEALTH_VERIFIED', data: { checked: true } });
      const finalize = async () => {
        await cleanupRecoveryScratch(transactionId, root, input);
        if (active.phase !== 'COMPLETED') await records.append({ transactionId, phase: 'RETENTION_READY',
          data: await retentionManifest(root, transactionId, database) });
      };
      if (completedInB) {
        await handle.refreshProjection();
        await finalize();
        await records.complete({ transactionId, receipt: journal.snapshot().maintenanceReceipt });
      } else await complete(handle, transactionId, input.kind, input.payloadSha256, finalize);
      await collectCompleted(database, product);
      await handle.release();
      await ports.resume({ transactionId, restored: true, recovery: true });
      return { recovered: true, outcome: completedInB && staged && !rolledBack ? 'VERIFIED_RESTORED' : 'VERIFIED_PREVIOUS' };
    } catch {
      await ports.failure({ transactionId, prepared: true, sealed: Boolean(journal.snapshot().pendingMaintenance) }).catch(() => {});
      fail();
    } finally {
      let failed = false;
      for (const resource of [sourceSwap, product, database, lease, capacity]) try { await resource?.close(); } catch { failed = true; }
      busy = false;
      if (failed) { await ports.failure({ transactionId, prepared: true, sealed: true }).catch(() => {}); fail(); }
    }
  }
  async function perform(kind, selected) {
    if (closed) fail(); if (busy) fail('BUSY'); busy = true;
    const transactionId = crypto.randomUUID(); let handle, database, product, dbPlan, sourceSwap, capacity, lease;
    let root, payload, currentExport, archived, liveProjection, prepared = false, sealed = false, swapAttempted = false;
    let maintenanceAttempted = false;
    let destinationRoot;
    const owned = new Map();
    const ownDirectory = async (parent, name) => {
      const result = await fresh(parent, name);
      owned.set(result, { directory: true, identity: identity(await directory(result)) }); return result;
    };
    try {
      if (recoveryMode) fail();
      if (await missing(recoveryRoot)) { await fs.mkdir(recoveryRoot, { mode: 0o700 }); await sync(userData); }
      await directory(recoveryRoot); root = await ownDirectory(recoveryRoot, transactionId);
      await ownDirectory(root, 'verification');
      if (kind === 'RESTORE') {
        const input = await ownDirectory(root, 'input'); payload = await ownDirectory(root, 'incoming');
        const selectedCopy = path.join(input, 'archive.cibackup');
        await copySelectedFile(selected, selectedCopy, fileIdentity => owned.set(selectedCopy, { directory: false, identity: fileIdentity }));
        let remainingInput = (await fs.lstat(selectedCopy, { bigint: true })).size;
        const decoded = await decryptFile({ windowsBoundary, sourceRoot: input, sourcePath: selectedCopy, destinationRoot: payload,
          destinationPath: path.join(payload, 'payload.bin'), installationId, keyProvider,
          beforeWrite: async bytes => {
            if (BigInt(bytes) > remainingInput) fail('INPUT');
            await freeSpace(root, remainingInput * 2n); remainingInput -= BigInt(bytes);
          } });
        owned.set(path.join(payload, 'payload.bin'), { directory: false,
          identity: identity(await fs.lstat(path.join(payload, 'payload.bin'), { bigint: true })) });
        await freeSpace(root, BigInt(decoded.payloadBytes) * 5n);
        archived = await inspectPayload(payload);
        await checkRestoreCompatibility(archived.summary);
        if (closed || identity(await fs.lstat(path.join(payload, 'payload.bin'), { bigint: true })) !== archived.payloadIdentity
            || await fileHash(path.join(payload, 'payload.bin')) !== archived.payloadSha256) fail('INPUT');
      } else {
        const parent = await fs.realpath(selected); await directory(parent, false);
        // Even an encrypted output must not enter application storage or source staging.
        if (parent === userData || parent.startsWith(`${userData}${path.sep}`)) fail('INPUT');
        destinationRoot = path.join(parent, `CodeIntelligence-${transactionId}`);
        await fs.mkdir(destinationRoot, { mode: 0o700 }); await sync(parent, false); await directory(destinationRoot);
        owned.set(destinationRoot, { directory: true, identity: identity(await directory(destinationRoot)) });
      }
      const before = journal.snapshot();
      if (before.pendingRestore || before.pendingMaintenance || before.recoveryOnly || (await records.read()).active) fail();
      maintenanceAttempted = true;
      handle = await gateway.beginMaintenance({ transactionId, kind });
      await ports.pause({ transactionId, kind, waitForAiDrain: () => handle.waitForDrain({ timeoutMs: 120000 }) });
      database = await ports.database({ readRetentionAuthority }); await database.verifyQuiescent();
      product = await ports.productState(); await product.verifyOrigin();
      const originalDatabases = await database.inspect(transactionId);
      const liveDatabaseOid = originalDatabases.databases[originalDatabases.names.live]?.oid;
      if (typeof liveDatabaseOid !== 'string' || !/^[1-9][0-9]{0,9}$/.test(liveDatabaseOid)) fail();
      const originalSources = await sourceIdentities();
      ({ capacity, lease } = await beginCapacity(database, transactionId, { kind, root, destinationRoot, archived }));
      const checkpoint = await fresh(root, 'checkpoint');
      currentExport = await exportCurrent(checkpoint, lease);
      await encrypt(checkpoint, root, 'checkpoint.cibackup', lease, 'checkpointArchive');
      payload ||= checkpoint;
      const payloadSha256 = (archived || currentExport).payloadSha256;
      liveProjection = await adapter.prepareMaintenanceGate({ ownerUserId: currentExport.summary.ownerUserId,
        legacyLiabilityUnresolved: currentExport.costs.legacyLiabilityUnresolved || Boolean(archived?.costs.legacyLiabilityUnresolved) });
      const mergeInputs = buildMaintenanceMergeInputs({ transactionId, liveProjection,
        archivedProjection: archived?.costs.projection || null, snapshot: journal.snapshot(),
        budgetDay: new Date().toISOString().slice(0, 10), minimumVersion: runningBuild });
      await records.begin({ transactionId, kind, input: { version: 2, transactionId, kind, payloadSha256,
        checkpointSha256: currentExport.payloadSha256, rootIdentity: identity(await directory(root)),
        verificationIdentity: identity(await directory(path.join(root, 'verification'))),
        liveDatabaseOid, originalSources,
        scratchPayloads: {
          checkpoint: { directoryIdentity: identity(await directory(checkpoint)), payloadIdentity: currentExport.payloadIdentity,
            sha256: currentExport.payloadSha256 },
          incoming: archived ? { directoryIdentity: identity(await directory(payload)), payloadIdentity: archived.payloadIdentity,
            sha256: archived.payloadSha256 } : null,
        },
        mergeInputs, liveProjection, archivedProjection: archived?.costs.projection || null } }); prepared = true;
      for (const mergeInput of mergeInputs) await handle.mergeAndCommit({ mergeInput });
      await records.append({ transactionId, phase: 'MERGED', data: { journalSequence: journal.snapshot().sequence } });
      const pg = await handle.refreshProjection();
      await journal.sealMaintenance(metadata(transactionId, kind, payloadSha256, pg)); sealed = true;
      await handle.refreshProjection();
      await records.append({ transactionId, phase: 'SEALED', data: { receipt: journal.snapshot().pendingMaintenance } });
      if (kind === 'BACKUP') {
        await encrypt(payload, destinationRoot, 'backup.cibackup', lease, 'externalOutput');
      } else {
        await lease.check();
        const stage = root; await fresh(stage, 'repos'); await fresh(stage, 'sources');
        dbPlan = await database.createStage({ transactionId });
        const db = await ports.openStage(dbPlan.stageDatabase);
        try {
          await db.initializeStaging();
          const rows = async function* () {
            for await (const record of readBackupPayload(readOptions(payload))) if (record.kind === 'ROW') yield record.row;
          };
          await db.loadRows({ rows: rows(), expected: archived.summary, writeAccounting: async () => {},
            liveOwnerUserId: currentExport.summary.ownerUserId,
            livePreferenceRevisionHighWater: currentExport.summary.preferenceRevisionHighWater,
            liveSequenceHighWater: currentExport.summary.sequenceHighWater });
        } finally { await db.close(); }
        const stagedSizes = await database.readSizes({ transactionId });
        if (stagedSizes.databases.stage?.oid !== dbPlan.stageOid) fail();
        await lease.consume('stagedDatabase', stagedSizes.databases.stage.bytes);
        await lease.check();
        await restoreSources(payload, stage, archived.sources);
        const treeBytes = async name => {
          const measured = await measureBackupTree({ root: path.join(stage, name), windowsBoundary });
          return BigInt(measured.logicalBytes) > BigInt(measured.allocatedBytes)
            ? BigInt(measured.logicalBytes) : BigInt(measured.allocatedBytes);
        };
        await lease.consume('stagedSource', String(await treeBytes('repos') + await treeBytes('sources')));
        await product.rebindClonePaths({ database: dbPlan.stageDatabase, confirmedGitProjectIds: archived.sources.git.map(p => p.projectId) });
        const finance = await adapter.createMaintenanceStage({ database: dbPlan.stageDatabase });
        try { await finance.seedMaintenanceProjection({ liveProjection, archivedProjection: archived.costs.projection,
          journalSnapshot: journal.snapshot() }); } finally { await finance.close(); }
        const finalStage = (await database.readSizes({ transactionId })).databases.stage;
        if (finalStage?.oid !== dbPlan.stageOid) fail();
        if (BigInt(finalStage.bytes) > BigInt(stagedSizes.databases.stage.bytes)) {
          await lease.consume('stagedDatabase', String(BigInt(finalStage.bytes) - BigInt(stagedSizes.databases.stage.bytes)));
        }
        sourceSwap = await createBackupSourceSwap({ windowsBoundary, dataRoot, stageRoot: stage, transactionId,
          onTransition: async transition => records.append({ transactionId, phase: 'SOURCES_SWAPPED', data: transition }) });
        const sourcePlan = await sourceSwap.plan();
        await records.append({ transactionId, phase: 'STAGED', data: { database: dbPlan, sources: sourcePlan } });
        await product.verifyOrigin(); await database.verifyQuiescent();
        await lease.check();
        await ports.invalidateAuthority({ transactionId, checkpointRoot: root });
        swapAttempted = true;
        await database.swap({ transactionId, liveOid: dbPlan.liveOid, stageOid: dbPlan.stageOid });
        await records.append({ transactionId, phase: 'DATABASE_SWAPPED', data: { liveOid: dbPlan.stageOid } });
        await sourceSwap.publish();
        await product.revokeCredentials({ database: 'codeintel' });
        await handle.rotateBackendChannel();
      }
      await ports.prepareResume({ transactionId, restored: kind === 'RESTORE' });
      await records.append({ transactionId, phase: 'HEALTH_VERIFIED', data: { checked: true } });
      // Only owned scratch plaintext is removed. The encrypted checkpoint and both source/DB
      // images remain available for inspection; failed/incomplete operations keep their inputs.
      await complete(handle, transactionId, kind, payloadSha256, async () => {
        await removeOwnedPayload(checkpoint, { sha256: currentExport.payloadSha256, identity: currentExport.payloadIdentity });
        if (archived) await removeOwnedPayload(payload, { sha256: archived.payloadSha256, identity: archived.payloadIdentity });
        await records.append({ transactionId, phase: 'RETENTION_READY', data: await retentionManifest(root, transactionId, database) });
      });
      await collectCompleted(database, product);
      await handle.release();
      await ports.resume({ transactionId, restored: kind === 'RESTORE' });
      return kind === 'BACKUP' ? path.join(destinationRoot, 'backup.cibackup')
        : { restored: true, recoveryBackup: path.join(root, 'checkpoint.cibackup') };
    } catch (error) {
      // Failed imports never authorize a rollback of B. A rollback uses the captured DB and inode
      // identities and still revokes old credentials, sessions and folder authority.
      // A health check may already have started fresh child processes. Confirm their real exit
      // before attempting any rollback, even though their admission barrier should still be on.
      if (!maintenanceAttempted) {
        try { await cleanupOwnedScratch(owned); } catch { fail(); }
        if (error instanceof BackupRuntimeError && ['BACKUP_RUNTIME_RECOVERY_REQUIRED', 'BACKUP_RUNTIME_CAPACITY', 'BACKUP_RUNTIME_INCOMPATIBLE'].includes(error.code)) throw error;
        throw new BackupRuntimeError('INPUT');
      }
      let stopped = false;
      try { await ports.failure({ transactionId, prepared, sealed }); stopped = true; } catch {}
      const pending = journal.snapshot().pendingMaintenance;
      if (stopped && swapAttempted && sourceSwap && dbPlan && sealed && pending?.transactionId === transactionId) {
        try {
          await sourceSwap.rollback();
          await product.verifyOrigin();
          await database.rollback({ transactionId, liveOid: dbPlan.liveOid, stageOid: dbPlan.stageOid });
          await product.revokeCredentials({ database: 'codeintel' });
          await handle.refreshProjection();
          await records.append({ transactionId, phase: 'ROLLED_BACK', data: { liveOid: dbPlan.liveOid } });
        } catch { /* Keep both images and the outstanding B seal. Normal startup stays blocked. */ }
      }
      throw new BackupRuntimeError();
    } finally {
      let failed = false;
      for (const resource of [sourceSwap, product, database, lease, capacity]) try { await resource?.close(); } catch { failed = true; }
      busy = false;
      if (failed) { await ports.failure({ transactionId, prepared, sealed }).catch(() => {}); fail(); }
    }
  }
  return Object.freeze({
    async pendingRecovery() {
      const state = await records.read(), active = state.active;
      return active ? { kind: active.kind, phase: active.phase }
        : state.collections.some(item => item.state === 'BEGUN') ? { kind: 'COLLECTION', phase: 'GC_BEGIN' } : null;
    },
    recover() { if (busy) return Promise.reject(new BackupRuntimeError('BUSY'));
      const task = recover(); current = task; return task; },
    backup(selected) { if (busy) return Promise.reject(new BackupRuntimeError('BUSY'));
      const task = perform('BACKUP', selected); current = task; return task; },
    restore(selected) { if (busy) return Promise.reject(new BackupRuntimeError('BUSY'));
      const task = perform('RESTORE', selected); current = task; return task; },
    async close() { closed = true; await current?.catch(() => {}); if (busy) fail(); try { await records.close(); } finally { if (windowsBoundary) await fs.close(); } },
  });
  } catch (error) { if (windowsBoundary) await fs.close().catch(() => {}); throw error; }
}
module.exports = Object.freeze({ createDesktopBackupRuntime, BackupRuntimeError });
