'use strict';

// Current journal/keyring modules, fresh synthetic records and actual retained
// lease workers. No Electron, application database, real wrapper or provider call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { spawn, execFileSync } = require('node:child_process');
const { initializePurposeKeyring } = require('../../desktop/src/purpose-keyring.cjs');
const { initializeSafetyJournal, openSafetyJournal } = require('../../desktop/src/safety-journal.cjs');
const { createNativeOwnerLocks } = require('../../desktop/src/native-owner-locks.cjs');
const { CONTROL_JVM_OPTIONS } = require('../../desktop/src/jvm-options.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { dependencyInventory } = require('../../desktop/scripts/build-isolated.cjs');
const { ensureOutputParent, assertOutputPath } = require('./owned-output.cjs');
const { stopOwned, waitFor } = require('./owned-test-process.cjs');

const RECORD_COUNTS = Object.freeze([1, 65, 257]);
const METHODS = Object.freeze(['currentKeyId', 'getMacKey', 'isAvailable']);
const ROLES = Object.freeze(['purpose-keyring', 'ai-journal']);
const OPERATIONS = Object.freeze(['ACQUIRE', 'CHECK', 'RELEASE']);
const FAILURE_CODES = new Set(['ERR_ASSERTION', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC',
  'WRITER_LOCKED', 'WRITER_LOCK_CHANGED', 'KEY_UNAVAILABLE', 'IO_FAILURE', 'MAC_INVALID',
  'PURPOSE_KEYRING_LOCKED', 'PURPOSE_KEYRING_IO', 'PURPOSE_KEYRING_UNSAFE_PATH',
  'NATIVE_OWNER_MAIN_OWNERSHIP', 'NATIVE_OWNER_PROCESS', 'NATIVE_OWNER_TERMINATION']);
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = file => sha(fs.readFileSync(file));

function argumentsFor(argv) {
  assert(Array.isArray(argv) && argv.length === 3 && argv[0] === '--app'
    && argv[2] === '--journal-replay-probe', 'JOURNAL_PROBE_ARGUMENT');
  const app = argv[1];
  assert(typeof app === 'string' && path.isAbsolute(app) && path.normalize(app) === app
    && !/[\x00-\x1f\x7f]/.test(app), 'JOURNAL_PROBE_ARGUMENT');
  assert.equal(path.basename(app), 'Code Intelligence Validation.app', 'JOURNAL_PROBE_ARGUMENT');
  assert(/^\.native-product-[A-Za-z0-9]+$/.test(path.basename(path.dirname(app))), 'JOURNAL_PROBE_ARGUMENT');
  return { app };
}

function measurements(now = () => performance.now()) {
  let active = false;
  const calls = Object.fromEntries(METHODS.map(name => [name, { calls: 0, failed: 0, totalMs: 0 }]));
  const protocol = Object.fromEntries(ROLES.map(role => [role, Object.fromEntries(OPERATIONS.map(op => [op, 0]))]));
  return {
    start() { active = true; },
    stop() { active = false; },
    async invoke(name, operation) {
      assert(METHODS.includes(name), 'JOURNAL_PROBE_METRIC');
      const record = active;
      if (!record) return operation();
      const began = now();
      calls[name].calls++;
      try { return await operation(); }
      catch (error) { calls[name].failed++; throw error; }
      finally { calls[name].totalMs += Math.max(0, now() - began); }
    },
    command(role, operation) {
      assert(ROLES.includes(role) && OPERATIONS.includes(operation), 'JOURNAL_PROBE_METRIC');
      if (active) protocol[role][operation]++;
    },
    snapshot() { return JSON.parse(JSON.stringify({ calls, protocol })); },
  };
}

function syntheticWrapper(metrics) {
  const key = Buffer.alloc(32, 77), aad = Buffer.from('journal-replay-synthetic-wrapper-v1');
  return {
    isAvailable: () => metrics.invoke('isAvailable', async () => true),
    async wrap(plain) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    async unwrap(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
    },
  };
}

function countFrames(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length <= MAX_LOG_BYTES, 'JOURNAL_PROBE_LOG');
  let offset = 0, count = 0;
  while (offset < bytes.length) {
    assert(bytes.length - offset >= 4, 'JOURNAL_PROBE_LOG');
    const size = bytes.readUInt32BE(offset);
    assert(size > 0 && size <= 16384 && size <= bytes.length - offset - 4, 'JOURNAL_PROBE_LOG');
    offset += size + 4;
    assert(++count <= 1024, 'JOURNAL_PROBE_LOG');
  }
  return count;
}

function readSyntheticLog(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_LOG_BYTES, 'JOURNAL_PROBE_LOG');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0, count;
    while ((count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset))) {
      offset += count;
      assert(offset <= stat.size, 'JOURNAL_PROBE_LOG');
    }
    assert.equal(offset, stat.size, 'JOURNAL_PROBE_LOG');
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}

async function runCase(evidence, records, supply) {
  assert(RECORD_COUNTS.includes(records), 'JOURNAL_PROBE_RECORD_COUNT');
  const root = fs.mkdtempSync(path.join(evidence, 'fixture-'));
  const rootStat = fs.lstatSync(root);
  const assertRoot = () => {
    const stat = fs.lstatSync(root);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === rootStat.dev
      && stat.ino === rootStat.ino && fs.realpathSync(root) === root, 'JOURNAL_PROBE_OWNER');
    return true;
  };
  const home = path.join(root, 'home'), temporary = path.join(root, 'tmp');
  for (const dir of [home, temporary, path.join(root, 'data')]) fs.mkdirSync(dir, { mode: 0o700 });
  const safetyRoot = path.join(root, 'safety'), installationId = crypto.randomUUID();
  const metrics = measurements(), children = [], copies = [];
  let provider, keyring, journal, lost = false, measuring = false;
  const result = { records, status: 'RUNNING', stage: 'PROVIDER', cleanupConfirmed: false, fixture: path.basename(root) };
  try {
    provider = await createNativeOwnerLocks({ javaPath: supply.java, jarPath: supply.jar,
      safetyRoot, installationId, assertMainOwnership: assertRoot, onLost() { lost = true; },
      spawnImpl(command, args, config) {
        assertRoot();
        assert.equal(command, supply.java);
        assert.deepEqual(args, [...CONTROL_JVM_OPTIONS, '-jar', supply.jar, '--ci-desktop-lease']);
        const child = spawn(command, [...CONTROL_JVM_OPTIONS, '-Duser.home=' + home,
          '-Djava.io.tmpdir=' + temporary, '-jar', supply.jar, '--ci-desktop-lease'], {
          ...config, cwd: root, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: temporary,
            LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }, shell: false,
        });
        const item = { child, result: null, originalWrite: child.stdin.write };
        item.closed = new Promise(resolve => child.once('close', (code, signal) => {
          item.result = { code, signal }; resolve(item.result);
        }));
        children.push(item);
        let role;
        child.stdin.write = function (...values) {
          const line = values[0];
          // Count the existing trusted protocol, never serialize its arguments.
          if (typeof line === 'string') {
            const operation = line.slice(0, line.indexOf('\t'));
            if (operation === 'ACQUIRE') role = line.split('\t')[3];
            if (ROLES.includes(role) && OPERATIONS.includes(operation)) metrics.command(role, operation);
          }
          return Reflect.apply(item.originalWrite, this, values);
        };
        return child;
      },
    });
    result.stage = 'KEYRING';
    keyring = await initializePurposeKeyring({ safetyRoot, restoreRoots: [path.join(root, 'data')],
      installationId, ownerLocks: provider, wrapper: syntheticWrapper(metrics) });
    const keyProvider = {
      currentKeyId: purpose => metrics.invoke('currentKeyId', () => keyring.currentKeyId(purpose)),
      getMacKey: (id, purpose) => metrics.invoke('getMacKey', async () => {
        const bytes = await keyring.getMacKey(id, purpose);
        if (measuring) copies.push(bytes);
        return bytes;
      }),
    };
    const options = { safetyRoot, restoreRoots: [path.join(root, 'data')], installationId,
      runningBuild: '100', ownerLocks: provider, keyProvider,
      verifyCommittedReservation: async () => { throw new Error('JOURNAL_PROBE_PROVIDER_FORBIDDEN'); },
      verifySettlement: async () => { throw new Error('JOURNAL_PROBE_PROVIDER_FORBIDDEN'); },
      verifyActivation: async () => { throw new Error('JOURNAL_PROBE_PROVIDER_FORBIDDEN'); },
    };
    result.stage = 'SEED';
    journal = await initializeSafetyJournal(options);
    for (let index = 1; index < records; index++) await journal.latch('USER_OFF');
    assert.equal(journal.snapshot().sequence, records);
    await journal.close(); journal = undefined;
    const log = path.join(safetyRoot, 'ai-journal/events.log'), before = readSyntheticLog(log);
    assert.equal(countFrames(before), records);
    result.stage = 'OPEN';
    assertRoot(); measuring = true; metrics.start();
    const started = performance.now();
    try { journal = await openSafetyJournal(options); }
    finally { result.openDurationMs = performance.now() - started; metrics.stop(); measuring = false; }
    result.stage = 'VERIFY';
    const state = journal.snapshot(), after = readSyntheticLog(log);
    result.measurements = metrics.snapshot();
    assert.equal(result.measurements.calls.currentKeyId.calls, 2);
    assert.equal(result.measurements.calls.getMacKey.calls, records + 4);
    assert.equal(result.measurements.calls.isAvailable.calls, records + 6);
    assert.equal(result.measurements.protocol['purpose-keyring'].CHECK, 2 * (records + 6));
    assert(METHODS.every(name => result.measurements.calls[name].failed === 0));
    assert.equal(state.sequence, records + 1);
    assert.equal(countFrames(after), records + 1);
    assert(after.subarray(0, before.length).equals(before));
    assert.equal(state.aiOff, true); assert.equal(state.recoveryOnly, false);
    assert.equal(state.totalLiabilityMicroUsd, '0'); assert.equal(state.requests.length, 0);
    assert.equal(copies.length, result.measurements.calls.getMacKey.calls);
    assert(copies.every(bytes => Buffer.isBuffer(bytes) && bytes.length === 32 && bytes.every(value => value === 0)));
    result.keyCopiesCleared = true;
    result.journal = { beforeRecords: records, afterRecords: records + 1, beforeBytes: before.length,
      afterBytes: after.length, beforeSha256: sha(before), afterSha256: sha(after), previousPrefixPreserved: true };
    result.aiOff = state.aiOff; result.nonzeroObligations = false;
    result.status = 'PASS'; result.stage = 'COMPLETE';
  } catch (error) {
    result.status = 'FAIL'; result.failure = 'JOURNAL_PROBE_CASE_FAILED';
    let code; try { code = error?.code; } catch { /* Only fixed codes leave the fixture. */ }
    if (FAILURE_CODES.has(code)) result.failureCode = code;
  }
  finally {
    metrics.stop(); measuring = false;
    let cleanupFailed = false;
    for (const resource of [journal, keyring, provider]) {
      if (resource) try { await resource.close(); } catch { cleanupFailed = true; }
    }
    for (const item of children) {
      const closed = await waitFor(item.closed, 0);
      if (!closed.completed) {
        cleanupFailed = true;
        item.forcedStop = await stopOwned(item.child, item.closed, 5000);
      }
      item.child.stdin.write = item.originalWrite;
      if (item.result?.code !== 0 || item.result?.signal !== null) cleanupFailed = true;
    }
    copies.forEach(bytes => bytes.fill(0));
    result.childExits = children.map(item => ({ ...item.result, forcedStop: Boolean(item.forcedStop) }));
    result.cleanupConfirmed = !cleanupFailed && !lost && children.length === 3;
    if (!result.cleanupConfirmed) { result.status = 'FAIL'; result.cleanupFailure = 'JOURNAL_PROBE_CLEANUP_FAILED'; }
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert(process.getuid() > 0);
  process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(options.app);
  assert.equal(app, options.app); assert.equal(path.dirname(path.dirname(app)), repo);
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  await validateRuntimeManifest(runtime, manifest); assert.equal(manifest.controlProtocol, 1);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 30000 });
  const supply = { java: fs.realpathSync(path.join(runtime, 'jre/bin/java')),
    jar: fs.realpathSync(path.join(runtime, 'backend/code-intelligence-control.jar')) };
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/journal-replay'), 'probe-'));
  const sourceFingerprint = dependencyInventory(path.join(repo, 'desktop/src')).sha256;
  const identities = Object.fromEntries([manifestFile, path.join(app, 'Contents/Resources/app.asar'), supply.java, supply.jar]
    .map(file => [path.relative(repo, file), hash(file)]));
  const runnerSha256 = hash(__filename);
  const report = { format: 1, status: 'RUNNING', scope: 'current-node-journal-keyring-with-retained-native-lease-workers',
    acceptanceGate: false, releaseVerdict: 'NO_GO', observedAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceFingerprint, runnerSha256, identities, app: path.relative(repo, app), buildSequence: manifest.buildSequence,
    recordCounts: RECORD_COUNTS, samples: RECORD_COUNTS.map(records => ({ records, status: 'NOT_RUN' })),
    syntheticWrapper: true, electronExecuted: false, applicationDatabaseUsed: false,
    existingProfileAccessed: false, paidProviderCalls: false, newCandidateBuilt: false,
    interpretation: 'One fresh synthetic history per size. Open includes native lease acquisition, latch authentication, replay and restart-latch writes; key API times are inclusive and nested wrapper times must not be added.',
    limitations: ['No precise replay-only timer or filesystem-call instrumentation.',
      'Zero-liability USER_OFF histories do not represent all real workloads, full gateway startup or whole-app SLOs.',
      'Fixed public synthetic wrapping material; actual Keychain behavior is not measured.',
      'The synthetic owner assertion includes directory-identity reads, so its cost differs from Electron singleton checks.',
      'Fresh synthetic directories remain under this evidence root; no prior app or profile is changed.'] };
  const save = () => fs.writeFileSync(assertOutputPath(evidence, path.join(evidence, 'result.json')),
    JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: report.status, evidence }));
  try {
    for (let index = 0; index < RECORD_COUNTS.length; index++) {
      report.samples[index] = { records: RECORD_COUNTS[index], status: 'RUNNING' }; save();
      report.samples[index] = await runCase(evidence, RECORD_COUNTS[index], supply); save();
      console.log(JSON.stringify(report.samples[index]));
      if (report.samples[index].status !== 'PASS') break;
    }
    for (const [name, expected] of Object.entries(identities)) assert.equal(hash(path.join(repo, name)), expected);
    assert.equal(dependencyInventory(path.join(repo, 'desktop/src')).sha256, sourceFingerprint);
    assert.equal(hash(__filename), runnerSha256);
    report.sourceAndSupplyUnchanged = true;
    report.status = report.samples.every(sample => sample.status === 'PASS') ? 'COMPLETE_DIAGNOSTIC' : 'INCOMPLETE_DIAGNOSTIC';
  } catch { report.status = 'INCOMPLETE_DIAGNOSTIC'; report.failure = 'JOURNAL_PROBE_FINAL_CHECK_FAILED'; }
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: report.status, evidence }));
  if (report.status !== 'COMPLETE_DIAGNOSTIC') process.exitCode = 1;
  return report;
}

module.exports = { argumentsFor, measurements, countFrames, syntheticWrapper, main };
if (require.main === module) main().catch(() => { console.error('JOURNAL_PROBE_PREFLIGHT_FAILED'); process.exitCode = 1; });
