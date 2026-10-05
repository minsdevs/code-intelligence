'use strict';

// Called only by the opt-in parent test. Synthetic private installation, public fixture wrapper,
// no Electron, real OS keychain, provider transport or caller-supplied database connection.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, OWNER, PROJECT, REQUESTS, ORIGINAL, sha } = require('../backup-runtime-postgres.test.cjs');
const PREVIOUS_NOTE = 'Synthetic newest product before owner SIGKILL';
let stage = 'INPUT';
let intentionalDisconnect = false;

async function input() {
  assert.equal(typeof process.send, 'function'); assert.equal(process.connected, true);
  const chunks = []; let size = 0;
  for await (const bytes of process.stdin) {
    size += bytes.length; assert(size <= 4100); chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  assert(bytes.length >= 6 && bytes.readUInt32BE(0) === bytes.length - 4);
  const value = JSON.parse(bytes.subarray(4).toString('utf8')); bytes.fill(0);
  assert.deepEqual(Object.keys(value).sort(), ['mode', 'nonce', 'point', 'root', 'version']);
  assert.equal(value.version, 1); assert(['INITIAL', 'RESUME'].includes(value.mode));
  assert(['STAGED', 'B_COMPLETED'].includes(value.point)); assert(/^[0-9a-f]{64}$/.test(value.nonce));
  assert(path.isAbsolute(value.root) && path.resolve(value.root) === value.root);
  return value;
}
function send(value) {
  return new Promise((resolve, reject) => {
    if (!process.connected) { reject(new Error('Synthetic parent disconnected')); return; }
    process.send(value, error => error ? reject(new Error('Synthetic parent channel failed')) : resolve());
  });
}
async function persist(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
}
async function markers(f) {
  const result = {};
  for (const name of ['purpose-keyring/owner.lock', 'ai-journal/writer.lock']) {
    const file = path.join(f.userData, 'safety', name), stat = await fs.lstat(file, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && (stat.mode & 0o7777n) === 0o600n);
    const bytes = await fs.readFile(file); assert.match(bytes.toString('utf8'), /^CI-NATIVE-OWNER-2\n/);
    result[name] = { device: String(stat.dev), inode: String(stat.ino), sha256: sha(bytes) };
  }
  return result;
}
async function image(f) {
  const database = await f.sqlJson("select jsonb_build_object('oid',oid::text) from pg_database where datname='codeintel';", 'postgres');
  const product = await f.product();
  return { databaseOid: database.oid, repos: await f.inode(f.repos), sources: await f.inode(path.join(f.dataRoot, 'sources')),
    noteSha256: sha(product.note) };
}
function costs(snapshot) {
  return { sequence: snapshot.sequence, headHash: snapshot.headHash, aiOff: snapshot.aiOff,
    requestIds: snapshot.requests.map(row => row.requestId).sort(), totalLiabilityMicroUsd: snapshot.totalLiabilityMicroUsd,
    pendingMaintenance: snapshot.pendingMaintenance, maintenanceReceipt: snapshot.maintenanceReceipt };
}
async function owner(config) {
  let shutdown; const lifecycle = { after(action) { assert.equal(shutdown, undefined); shutdown = action; }, diagnostic() {} };
  stage = 'FIXTURE';
  try {
  const f = await fixture(lifecycle, { root: config.root, nonce: config.nonce, resume: config.mode === 'RESUME',
    guardedServices: true, preserve: true,
    onProcess: value => { void send({ kind: 'PROCESS', nonce: config.nonce, ...value }).catch(() => {}); },
  });
    if (config.mode === 'INITIAL') {
      stage = 'BACKUP';
      const keyInfo = await f.keyring.info(), archive = await f.runtime.backup(f.destination);
      assert(archive.startsWith(f.destination + path.sep));
      await f.credentials(PREVIOUS_NOTE, 19); await f.addObligation(1, 73);
      await fs.writeFile(path.join(f.repos, 'changed-after-backup'), 'public synthetic prior source marker', { mode: 0o600 });
      assert.equal(await f.redisRequest(['SET', 'synthetic-crash-session', 'present']), '+OK\r\n');
      const previous = await image(f), artifact = await f.artifact();
      const checkpoint = async (point, value) => {
        if (point !== config.point || value.kind && value.kind !== 'RESTORE') return;
        stage = point;
        const pending = await f.runtime.pendingRecovery();
        assert.equal(pending.kind, 'RESTORE');
        assert.equal(pending.phase, point === 'STAGED' ? 'STAGED' : 'HEALTH_VERIFIED');
        const snapshot = f.journal.snapshot(), current = await image(f), processProof = f.processEvidence();
        assert.deepEqual(snapshot.requests.map(row => row.requestId).sort(), REQUESTS.slice(0, 2));
        assert.equal(snapshot.totalLiabilityMicroUsd, '173'); assert.equal(snapshot.aiOff, true);
        if (point === 'STAGED') {
          assert.equal(snapshot.pendingMaintenance.transactionId, value.transactionId);
          assert.deepEqual(current, previous);
        } else {
          assert.equal(snapshot.pendingMaintenance, null);
          assert.equal(snapshot.maintenanceReceipt.transactionId, value.transactionId);
          assert.equal(snapshot.maintenanceReceipt.kind, 'RESTORE');
          assert.equal(current.noteSha256, sha(ORIGINAL)); assert.notEqual(current.databaseOid, previous.databaseOid);
          assert.notEqual(current.repos, previous.repos);
          assert.equal(await f.publicProjects(), 503, 'Actual healthy backend must still deny public API');
          assert.equal(f.controls.verifiedHealth, 2, 'Backup and restore each performed actual health');
        }
        assert.equal(f.controls.providerCalls, 0);
        assert.equal(processProof.services.some(item => item.name === 'postgres' && !item.stopped), true);
        assert.equal(processProof.services.some(item => item.name === 'redis' && !item.stopped), true);
        assert.equal(processProof.services.some(item => item.name === 'backend' && !item.stopped), point === 'B_COMPLETED');
        assert.equal(processProof.leases.filter(item => !item.stopped).length, point === 'B_COMPLETED' ? 3 : 2);
        const prefix = await fs.readFile(f.logPath);
        const expected = { version: 1, nonce: config.nonce, point, transactionId: value.transactionId, previous,
          current, keyInfo, markers: await markers(f), costs: costs(snapshot), processProof, pending,
          journalPrefixBytes: prefix.length, journalPrefixSha256: sha(prefix), backendArtifactSha256: artifact };
        await persist(path.join(f.root, 'crash-journal-prefix.bin'), prefix); prefix.fill(0);
        await persist(path.join(f.root, 'crash-expected.json'), expected);
        await send({ kind: 'CHECKPOINT', nonce: config.nonce, point, transactionId: value.transactionId,
          pendingPhase: pending.phase, processProof, journalSequence: snapshot.sequence,
          maintenancePending: Boolean(snapshot.pendingMaintenance), healthyButBlocked: point === 'B_COMPLETED' });
        await new Promise(() => {}); // Parent SIGKILLs this exact owned Node; no catch/finally rollback.
      };
      f.controls.afterStaged = value => checkpoint('STAGED', value);
      f.controls.afterComplete = value => checkpoint('B_COMPLETED', value);
      stage = 'RESTORE'; await f.runtime.restore(archive);
      assert.fail('The selected crash checkpoint was not reached');
    } else {
      stage = 'RESUME_VERIFY';
      const expected = JSON.parse(await fs.readFile(path.join(f.root, 'crash-expected.json'), 'utf8'));
      assert.equal(expected.nonce, config.nonce); assert.equal(expected.point, config.point);
      assert.deepEqual(await markers(f), expected.markers, 'Native lease must reuse the same enrolled inodes');
      assert.deepEqual(await f.keyring.info(), expected.keyInfo);
      assert.deepEqual(await f.runtime.pendingRecovery(), expected.pending);
      assert.equal(f.processEvidence().services.some(item => item.name !== 'postgres' && !item.stopped), false);
      const before = f.journal.snapshot();
      assert.equal(before.aiOff, true); assert.equal(before.totalLiabilityMicroUsd, '173');
      assert.deepEqual(before.requests.map(row => row.requestId).sort(), REQUESTS.slice(0, 2));
      stage = 'RECOVER';
      const outcome = await f.runtime.recover();
      const expectedOutcome = config.point === 'STAGED' ? 'VERIFIED_PREVIOUS' : 'VERIFIED_RESTORED';
      assert.deepEqual(outcome, { recovered: true, outcome: expectedOutcome });
      assert.equal(await f.runtime.pendingRecovery(), null);
      const current = await image(f), target = config.point === 'STAGED' ? expected.previous : expected.current;
      assert.deepEqual(current, target, 'Recovery must select the recorded database and source identities');
      const data = await f.product();
      assert.equal(data.owner, OWNER); assert.equal(data.identity, 'LOCAL_LINKED');
      assert.equal(data.note, config.point === 'STAGED' ? PREVIOUS_NOTE : ORIGINAL);
      for (const field of ['github', 'ai', 'approvals', 'inputs']) assert.equal(data[field], '0');
      assert.equal(data.state, 'OFF'); assert(BigInt(data.revision) > 19n);
      assert.equal(data.local, null); assert.equal(data.clone, path.join(f.repos, PROJECT));
      const snapshot = f.journal.snapshot(), projection = await f.adapter.readProjection();
      assert.equal(snapshot.aiOff, true); assert.equal(snapshot.pendingMaintenance, null);
      assert.equal(snapshot.maintenanceReceipt.transactionId, expected.transactionId);
      assert.deepEqual(snapshot.requests.map(row => row.requestId).sort(), REQUESTS.slice(0, 2));
      assert.equal(snapshot.totalLiabilityMicroUsd, '173');
      assert.equal(projection.gate.journalSequence, String(snapshot.sequence)); assert.equal(projection.gate.journalHash, snapshot.headHash);
      assert.deepEqual(projection.requests.map(row => row.requestId).sort(), REQUESTS.slice(0, 2));
      if (config.point === 'B_COMPLETED') {
        assert.deepEqual(snapshot.maintenanceReceipt, expected.costs.maintenanceReceipt);
        assert.equal(f.trace.includes('database.rollback'), false); assert.equal(f.trace.includes('journal.complete'), false);
      } else assert.equal(f.trace.includes('database.rollback'), true);
      const bytes = await fs.readFile(f.logPath), prefix = await fs.readFile(path.join(f.root, 'crash-journal-prefix.bin'));
      assert.equal(sha(prefix), expected.journalPrefixSha256); assert(bytes.subarray(0, prefix.length).equals(prefix));
      bytes.fill(0); prefix.fill(0);
      for (const name of ['checkpoint', 'incoming']) await assert.rejects(
        fs.lstat(path.join(f.userData, 'recovery', expected.transactionId, name, 'payload.bin')), { code: 'ENOENT' });
      await f.checkSource();
      assert.equal(f.controls.verifiedHealth, 1); assert.equal(f.controls.publicResumes, 0);
      assert.equal(f.processEvidence().services.some(item => ['backend', 'redis'].includes(item.name) && !item.stopped), false);
      stage = 'NORMAL_REOPEN';
      await f.reopenNormal(); assert.equal(await f.publicProjects(), 200);
      assert.equal(await f.redisRequest(['GET', 'synthetic-crash-session']), '$-1\r\n');
      assert.equal(f.gateway.diagnostics().aiOff, true); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '173');
      assert.notEqual(await f.artifact(), expected.backendArtifactSha256);
      assert.deepEqual(await markers(f), expected.markers); assert.deepEqual(await f.keyring.info(), expected.keyInfo);
      assert.equal(f.controls.providerCalls, 0); assert.equal(f.controls.ownerLost, undefined);
      const report = { version: 1, nonce: config.nonce, point: config.point, transactionId: expected.transactionId,
        outcome: expectedOutcome, preservedIdentity: true, appendOnlyB: true, newerCostHolds: '173', aiOff: true,
        credentialsRevoked: true, actualHealthBlockedUntilReopen: true, normalHttpStatus: 200,
        leaseMarkerInodesRetained: true, processProof: f.processEvidence(), providerCalls: 0 };
      await persist(path.join(f.root, 'resume-result.json'), report);
      f.markSuccess(); await send({ kind: 'RESULT', ...report });
    }
  } finally { await shutdown?.(); }
}

process.once('disconnect', () => { if (!intentionalDisconnect) process.exit(3); });
// An unexpected parent loss closes every owned helper's stdin, never adopts arbitrary PIDs.
input().then(owner).then(() => {
  intentionalDisconnect = true; if (process.connected) process.disconnect();
}, async error => {
  const location = typeof error?.stack === 'string'
    ? error.stack.match(/backup-runtime-crash-owner\.cjs:[0-9]+:[0-9]+/)?.[0] : undefined;
  await send({ kind: 'FAILED', stage, code: typeof error?.code === 'string' ? error.code : error?.name || 'Error',
    ...(location ? { location } : {}) }).catch(() => {});
  process.exitCode = 2; intentionalDisconnect = true; if (process.connected) process.disconnect();
});
