'use strict';

// OPT IN, ROOT-EXECUTED ONLY. Every process and directory originates in this parent. No existing
// userData, OS keyring, database connection, PID adoption or global process-kill command is used.
// Real components: coordinator, PostgreSQL, Redis, backend HTTP barrier, source worker, native
// FileLock leases and Java service guardians. The wrapping key and all product contents are public
// synthetic fixtures. SIGKILL of the owning Node is tested; power loss and guardian SIGKILL are not.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const enabled = process.env.CI_BACKUP_RUNTIME_CRASH_REAL === '1';
const helper = path.join(__dirname, 'fixtures/backup-runtime-crash-owner.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const alive = pid => {
  assert(Number.isSafeInteger(pid) && pid > 1);
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function poll(operation, description, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await operation()) return; await sleep(50); }
  throw new Error(`Owned synthetic fixture deadline: ${description}`);
}
async function descendantMetadata(ownerPid) {
  // Read only PID/PPID, never argv or environments. Only descendants of our own ChildProcess
  // are retained. This observation is evidence, not authority for registering or killing PIDs.
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 5000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
  const entries = stdout.trim().split('\n').map(line => {
    const values = line.trim().split(/\s+/).map(Number);
    assert.equal(values.length, 2); assert(values.every(value => Number.isSafeInteger(value) && value >= 0));
    return { pid: values[0], ppid: values[1] };
  });
  const owned = new Set([ownerPid]); let changed = true;
  while (changed) {
    changed = false;
    for (const row of entries) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  }
  return entries.filter(row => owned.has(row.pid));
}
async function markerProof(root) {
  const result = {};
  for (const name of ['purpose-keyring/owner.lock', 'ai-journal/writer.lock']) {
    const file = path.join(root, 'u', 'safety', name), stat = await fs.lstat(file, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && (stat.mode & 0o7777n) === 0o600n);
    result[name] = { device: String(stat.dev), inode: String(stat.ino), sha256: sha(await fs.readFile(file)) };
  }
  return result;
}
async function startOwner(root, nonce, mode, point) {
  const env = { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  for (const key of ['CI_BACKUP_RUNTIME_PG_BIN', 'CI_BACKUP_RUNTIME_JAVA', 'CI_BACKUP_RUNTIME_REDIS', 'CI_BACKUP_RUNTIME_JAR']) {
    assert(path.isAbsolute(process.env[key] || ''), `Explicit ${key} required`); env[key] = process.env[key];
  }
  if (process.env.CI_BACKUP_RUNTIME_PG_LIB) {
    assert(path.isAbsolute(process.env.CI_BACKUP_RUNTIME_PG_LIB)); env.CI_BACKUP_RUNTIME_PG_LIB = process.env.CI_BACKUP_RUNTIME_PG_LIB;
  }
  const child = spawn(process.execPath, [helper], { cwd: root, env, shell: false,
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const messages = [], processMessages = [], logs = { stdout: [], stderr: [] }, counts = { stdout: 0, stderr: 0 };
  let failed = null, ended = null;
  const done = new Promise(resolve => child.once('close', (code, signal) => { ended = { code, signal }; resolve(ended); }));
  child.on('error', () => { failed = new Error('Owned synthetic Node could not start'); });
  child.stdin.on('error', () => { failed ||= new Error('Owned synthetic input failed'); });
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on('error', () => { failed ||= new Error('Owned synthetic output failed'); });
    child[stream].on('data', bytes => {
      counts[stream] += bytes.length;
      if (counts[stream] <= 4 * 1024 * 1024) logs[stream].push(Buffer.from(bytes));
      else { failed ||= new Error('Owned synthetic output exceeded bound'); child.kill('SIGKILL'); }
    });
  }
  child.on('message', value => {
    if (!value || typeof value !== 'object' || !['PROCESS', 'CHECKPOINT', 'RESULT', 'FAILED'].includes(value.kind)
        || value.kind !== 'FAILED' && value.nonce !== nonce || messages.length >= 256
        || Buffer.byteLength(JSON.stringify(value)) > 65536) {
      failed ||= new Error('Owned synthetic control protocol rejected'); child.kill('SIGKILL'); return;
    }
    if (value.kind === 'PROCESS') {
      if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || value.helperPid !== null
          && (!Number.isSafeInteger(value.helperPid) || value.helperPid <= 1)) {
        failed ||= new Error('Owned synthetic PID metadata rejected'); child.kill('SIGKILL'); return;
      }
      processMessages.push(value);
    }
    if (value.kind === 'FAILED') failed ||= new Error(`Synthetic owner rejected at ${value.stage}: ${value.code}`
      + (/^backup-runtime-crash-owner\.cjs:[0-9]+:[0-9]+$/.test(value.location || '') ? ` (${value.location})` : ''));
    messages.push(value);
  });
  const body = Buffer.from(JSON.stringify({ version: 1, root, nonce, mode, point }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); const bytes = Buffer.concat([prefix, body]); body.fill(0);
  child.stdin.end(bytes, () => bytes.fill(0));
  return { child, done, messages, processMessages,
    get ended() { return ended; },
    async message(kind, timeout = 360000) {
      let result;
      await poll(() => {
        if (failed) throw failed;
        result = messages.find(value => value.kind === kind);
        if (result) return true;
        if (ended) throw new Error(`Synthetic owner exited before ${kind}`);
        return false;
      }, kind, timeout);
      return result;
    },
    async saveLogs() {
      for (const stream of ['stdout', 'stderr']) {
        const value = Buffer.concat(logs[stream]);
        await fs.writeFile(path.join(root, `${mode.toLowerCase()}-${stream}.log`), value, { mode: 0o600 }); value.fill(0);
        logs[stream].forEach(chunk => chunk.fill(0));
      }
    },
  };
}

for (const point of ['STAGED', 'B_COMPLETED']) {
  test(`opt-in real owner SIGKILL at ${point}: reap owned processes and resume the same private transaction`,
    { skip: !enabled, timeout: 720000 }, async t => {
      const base = await fs.realpath('/tmp'), root = await fs.mkdtemp(path.join(base, 'ci-backup-resume-real-'));
      await fs.chmod(root, 0o700);
      const nonce = crypto.randomBytes(32).toString('hex'), stat = await fs.lstat(root, { bigint: true });
      const claim = { version: 1, root, nonce, parentPid: process.pid, device: String(stat.dev), inode: String(stat.ino) };
      await fs.writeFile(path.join(root, 'fixture-claim.json'), JSON.stringify(claim), { flag: 'wx', mode: 0o600 });
      const owners = [], observed = new Set();
      const evidence = { point, root, realCoordinator: true, realNativeLease: true, realGuardianServices: true,
        realPostgres: true, realRedis: true, realBackendHttpBarrier: true, osKeychain: false,
        electronSingleton: false, installedApplication: false, powerLoss: false,
        hostileDaemonizationProven: false, initialReaped: false, resumed: false };
      t.diagnostic(`Private synthetic crash fixture: ${root}`);
      t.after(async () => {
        let failure;
        for (const owner of owners) {
          if (!owner.ended) owner.child.kill('SIGKILL'); // Only ChildProcess objects this test created.
          try { await poll(() => owner.ended !== null, 'owned Node teardown', 15000); } catch (error) { failure ||= error; }
          for (const value of owner.processMessages) { observed.add(value.pid); if (value.helperPid) observed.add(value.helperPid); }
          await owner.saveLogs();
        }
        try { await poll(() => [...observed].every(pid => !alive(pid)), 'guardian cleanup after fixture teardown', 20000); }
        catch (error) { failure ||= error; }
        evidence.teardownVerified = !failure;
        await fs.writeFile(path.join(root, 'parent-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
        if (failure) throw failure; // Preserve evidence; do not signal unowned PIDs or claim cleanup.
      });

      const initial = await startOwner(root, nonce, 'INITIAL', point); owners.push(initial);
      const checkpoint = await initial.message('CHECKPOINT');
      assert.equal(checkpoint.point, point);
      assert.equal(checkpoint.pendingPhase, point === 'STAGED' ? 'STAGED' : 'HEALTH_VERIFIED');
      assert.equal(checkpoint.maintenancePending, point === 'STAGED');
      assert.equal(checkpoint.healthyButBlocked, point === 'B_COMPLETED');
      assert.equal(checkpoint.processProof.leases.filter(item => !item.stopped).length, 2);
      const tree = await descendantMetadata(initial.child.pid), treePids = new Set(tree.map(row => row.pid));
      assert(treePids.has(initial.child.pid));
      for (const service of checkpoint.processProof.services.filter(item => !item.stopped)) {
        assert(treePids.has(service.pid), `Live ${service.name} must descend from the owned Node`);
        assert(treePids.has(service.helperPid), `Live ${service.name} guardian must descend from the owned Node`);
      }
      for (const lease of checkpoint.processProof.leases.filter(item => !item.stopped)) assert(treePids.has(lease.pid));
      const pg = checkpoint.processProof.services.find(item => item.name === 'postgres' && !item.stopped);
      assert(tree.some(row => row.ppid === pg.pid), 'Actual PostgreSQL descendants must be observed before SIGKILL');
      tree.filter(row => row.pid !== initial.child.pid).forEach(row => observed.add(row.pid));
      const beforeMarkers = await markerProof(root);
      assert.equal(initial.child.kill('SIGKILL'), true);
      const exit = await initial.done; assert.equal(exit.signal, 'SIGKILL');
      await poll(() => [...observed].every(pid => !alive(pid)), 'main SIGKILL must reap target services, PG descendants and native helpers');
      assert.deepEqual(await markerProof(root), beforeMarkers);
      evidence.initialReaped = true; evidence.observedOwnedProcessTree = tree;
      evidence.checkpoint = { transactionId: checkpoint.transactionId, phase: checkpoint.pendingPhase,
        maintenancePending: checkpoint.maintenancePending, healthyButBlocked: checkpoint.healthyButBlocked };

      // No inherited PID or arbitrary process identity is sent to the new owner: it creates fresh
      // guardians and acquires the same permanent B lease inodes using the original fixture claim.
      const resumed = await startOwner(root, nonce, 'RESUME', point); owners.push(resumed);
      const report = await resumed.message('RESULT');
      assert.equal(report.transactionId, checkpoint.transactionId);
      assert.equal(report.outcome, point === 'STAGED' ? 'VERIFIED_PREVIOUS' : 'VERIFIED_RESTORED');
      for (const field of ['preservedIdentity', 'appendOnlyB', 'aiOff', 'credentialsRevoked',
        'actualHealthBlockedUntilReopen', 'leaseMarkerInodesRetained']) assert.equal(report[field], true);
      assert.equal(report.newerCostHolds, '173'); assert.equal(report.normalHttpStatus, 200); assert.equal(report.providerCalls, 0);
      await poll(() => resumed.ended !== null, 'normal recovered owner shutdown', 30000);
      assert.deepEqual(resumed.ended, { code: 0, signal: null });
      assert.deepEqual(await markerProof(root), beforeMarkers);
      evidence.resumed = true; evidence.result = report;
    });
}
