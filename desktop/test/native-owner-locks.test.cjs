'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const execFile = promisify(cp.execFile);
const { once } = require('node:events');
const { createNativeOwnerLocks, acquireNativeOwnerLock } = require('../src/native-owner-locks.cjs');
const { initializePurposeKeyring, openPurposeKeyring } = require('../src/purpose-keyring.cjs');
const { initializeSafetyJournal, openSafetyJournal } = require('../src/safety-journal.cjs');
const { createSourceVault, openSourceVault, openSourceVaultRestoreStage } = require('../src/source-vault.cjs');
const repo = path.resolve(__dirname, '../..');
let compiled; let javaPath; let jarPath;
const installationId = 'synthetic-native-owner';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function syntheticWrapper() {
  // Public fixture key, no OS credential store. Real authenticated encryption exercises restart.
  const key = Buffer.alloc(32, 49);
  return { isAvailable: async () => true,
    wrap: async bytes => {
      const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    unwrap: async bytes => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    } };
}
const wrapper = syntheticWrapper();
const fingerprint = bytes => { const result = crypto.createHash('sha256').update(bytes).digest('hex'); bytes.fill(0); return result; };
test.before(async () => {
  compiled = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-resume-lock-compile-'));
  let javaHome = process.env.JAVA_HOME;
  if (!javaHome && process.platform === 'darwin') javaHome = (await execFile('/usr/libexec/java_home', ['-v', '21'])).stdout.trim();
  javaPath = javaHome ? path.join(javaHome, 'bin/java') : (await execFile('which', ['java'])).stdout.trim();
  const javac = javaHome ? path.join(javaHome, 'bin/javac') : 'javac';
  const jar = javaHome ? path.join(javaHome, 'bin/jar') : 'jar';
  await execFile(javac, ['--release', '21', '-Xlint:all', '-d', compiled,
    path.join(repo, 'backend/src/main/java/dev/codeintelligence/desktop/NativeLeaseWorker.java')]);
  jarPath = path.join(compiled, 'native-lease.jar');
  await execFile(jar, ['--create', '--file', jarPath, '--main-class', 'dev.codeintelligence.desktop.NativeLeaseWorker', '-C', compiled, 'dev']);
  await fs.chmod(jarPath, 0o600);
});
test.after(async () => { if (compiled) await fs.rm(compiled, { recursive: true, force: true }); });

async function fixture(t, { directories = true } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-resume-lock-test-'));
  const safetyRoot = path.join(root, 'safety'); const restoreRoots = [path.join(root, 'data')];
  await fs.mkdir(safetyRoot, { mode: 0o700 });
  if (directories) for (const kind of ['purpose-keyring', 'ai-journal']) await fs.mkdir(path.join(safetyRoot, kind), { mode: 0o700 });
  const handles = []; const processes = []; const providers = [];
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.close?.().catch(() => {});
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close').catch(() => {}); }
    for (const provider of providers) await provider.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const options = { javaPath, jarPath, safetyRoot, installationId, assertMainOwnership: () => true,
    onLost: () => {}, timeoutMs: 3000, spawnImpl(...args) { const child = cp.spawn(...args); processes.push(child); return child; } };
  return { root, safetyRoot, restoreRoots, options, handles, processes,
    async provider(extra = {}) { const result = await createNativeOwnerLocks({ ...options, ...extra }); providers.push(result); return result; },
    async lease(provider, kind = 'purpose-keyring') {
      const result = await acquireNativeOwnerLock(provider, { safetyRoot, installationId, kind });
      handles.push({ close: result.release }); return result;
    },
    keyringOptions: { safetyRoot, restoreRoots, installationId, wrapper },
    journalOptions: { safetyRoot, restoreRoots, installationId, runningBuild: '100',
      verifyCommittedReservation: async row => ({ ...row, committed: true }),
      verifySettlement: async row => ({ ...row, verified: true }), verifyActivation: async () => true },
  };
}
const rejects = (promise, code) => assert.rejects(promise, error => {
  if (code) assert.equal(error.code, code);
  assert.equal(error.cause, undefined); return true;
});
async function kill(child) { const ended = once(child, 'close'); child.kill('SIGKILL'); await ended; }

test('native markers are permanent private same-inode locks, independently held by each role', async t => {
  const f = await fixture(t); const provider = await f.provider(); const first = await f.lease(provider);
  const journal = await f.lease(provider, 'ai-journal');
  const file = path.join(f.safetyRoot, 'purpose-keyring/owner.lock');
  const before = await fs.stat(file); const marker = await fs.readFile(file);
  assert.equal(before.mode & 0o7777, 0o600); assert.match(marker.toString(), /^CI-NATIVE-OWNER-2\n/);
  assert.equal(marker.includes(String(process.pid)), false);
  await Promise.all([first.check(), first.check(), journal.check()]);
  await rejects(provider.close(), 'NATIVE_OWNER_BUSY');
  await first.release(); assert.equal((await fs.stat(file)).ino, before.ino);
  const reopened = await f.lease(provider); await reopened.check();
  assert.deepEqual(await fs.readFile(file), marker); assert.equal((await fs.stat(file)).ino, before.ino);
  await reopened.release(); await journal.release(); await provider.close();
  await rejects(f.lease(provider), 'NATIVE_OWNER_CLOSED');
});

test('same-process and other-process live writers cannot acquire the OS lock', async t => {
  const f = await fixture(t); const one = await f.provider(); const two = await f.provider();
  const lease = await f.lease(one);
  await rejects(f.lease(one), 'NATIVE_OWNER_BUSY');
  await rejects(f.lease(two));
  await lease.check(); await lease.release();
  const next = await f.lease(two); await next.check();
});

for (const marker of ['{"major":1,"pid":2147483647}', '', 'CI-NATIVE-OWNER-3\n', 'unrecognized']) {
  test(`legacy, torn, or unknown lock is never deleted/adopted (${marker || 'empty'})`, async t => {
    const f = await fixture(t); const file = path.join(f.safetyRoot, 'purpose-keyring/owner.lock');
    await fs.writeFile(file, marker, { mode: 0o600 }); const before = await fs.stat(file);
    await rejects(f.lease(await f.provider()));
    assert.equal(await fs.readFile(file, 'utf8'), marker); assert.equal((await fs.stat(file)).ino, before.ino);
  });
}

for (const mutation of ['symlink', 'hardlink', 'public-file', 'public-directory', 'fifo']) {
  test(`unsafe ${mutation} lock boundary fails without replacing the supplied entry`, async t => {
    const f = await fixture(t); const file = path.join(f.safetyRoot, 'purpose-keyring/owner.lock');
    const other = path.join(f.root, 'innocuous'); await fs.writeFile(other, 'unchanged', { mode: 0o600 });
    if (mutation === 'symlink') await fs.symlink(other, file);
    if (mutation === 'hardlink') await fs.link(other, file);
    if (mutation === 'public-file') await fs.writeFile(file, 'unchanged', { mode: 0o644 });
    if (mutation === 'public-directory') await fs.chmod(path.dirname(file), 0o755);
    if (mutation === 'fifo') await execFile('/usr/bin/mkfifo', ['-m', '600', file]);
    await rejects(f.lease(await f.provider({ timeoutMs: 1000 })));
    assert.equal(await fs.readFile(other, 'utf8'), 'unchanged');
    if (mutation !== 'public-directory') assert.ok(await fs.lstat(file));
  });
}

test('installation binding and provider branding prevent cross-installation or forged lock use', async t => {
  const f = await fixture(t); const lease = await f.lease(await f.provider()); await lease.release();
  await rejects(acquireNativeOwnerLock(Object.freeze({ close() {} }), { safetyRoot: f.safetyRoot, installationId, kind: 'purpose-keyring' }), 'NATIVE_OWNER_INVALID');
  const other = await f.provider({ installationId: 'another-installation' });
  await rejects(acquireNativeOwnerLock(other, { safetyRoot: f.safetyRoot, installationId: 'another-installation', kind: 'purpose-keyring' }));
});

test('singleton ownership is checked before enrollment and on each operation; loss is sticky once', async t => {
  const f = await fixture(t); let owned = false; let lost = 0;
  await rejects(f.provider({ assertMainOwnership: () => owned }), 'NATIVE_OWNER_MAIN_OWNERSHIP');
  assert.deepEqual(await fs.readdir(path.join(f.safetyRoot, 'purpose-keyring')), []);
  owned = true; const provider = await f.provider({ assertMainOwnership: () => owned, onLost: () => { lost++; } });
  const lease = await f.lease(provider); owned = false;
  await rejects(lease.check()); assert.equal(lease.isHeld(), false); assert.equal(lost, 1);
  owned = true; await rejects(lease.check()); await rejects(lease.release());
  assert.equal(lost, 1); await rejects(f.lease(provider), 'NATIVE_OWNER_CLOSED');
});

for (const change of ['rename-marker', 'edit-marker', 'replace-directory']) {
  test(`lease detects ${change} and keeps replacement entries untouched`, async t => {
    const f = await fixture(t); let lost = 0; const lease = await f.lease(await f.provider({ onLost: () => { lost++; } }));
    const dir = path.join(f.safetyRoot, 'purpose-keyring'); const file = path.join(dir, 'owner.lock');
    const original = await fs.readFile(file);
    if (change === 'rename-marker') { await fs.rename(file, `${file}.old`); await fs.writeFile(file, original, { mode: 0o600 }); }
    if (change === 'edit-marker') await fs.writeFile(file, Buffer.from(original).fill(65));
    if (change === 'replace-directory') { await fs.rename(dir, `${dir}.old`); await fs.mkdir(dir, { mode: 0o700 }); await fs.writeFile(file, original, { mode: 0o600 }); }
    const changed = await fs.readFile(file); const inode = (await fs.stat(file)).ino;
    await rejects(lease.check()); await rejects(lease.release()); assert.equal(lost, 1);
    assert.deepEqual(await fs.readFile(file), changed); assert.equal((await fs.stat(file)).ino, inode);
  });
}

test('helper death closes key access and journal writes without deleting B or resetting keys', async t => {
  const f = await fixture(t, { directories: false }); let lost = 0;
  const ownerLocks = await f.provider({ onLost: () => { lost++; } });
  const keys = await initializePurposeKeyring({ ...f.keyringOptions, ownerLocks }); f.handles.push(keys);
  const journal = await initializeSafetyJournal({ ...f.journalOptions, ownerLocks, keyProvider: keys }); f.handles.push(journal);
  const keyPath = path.join(f.safetyRoot, 'purpose-keyring/purpose-keyring.wrapped');
  const logPath = path.join(f.safetyRoot, 'ai-journal/events.log');
  const beforeKeys = await fs.readFile(keyPath); const beforeLog = await fs.readFile(logPath);
  await kill(f.processes[1]); assert.equal(lost, 1); assert.equal(journal.snapshot().aiOff, true);
  await rejects(journal.latch('USER_OFF')); await rejects(keys.currentKeyId('backup'));
  assert.deepEqual(await fs.readFile(keyPath), beforeKeys); assert.deepEqual(await fs.readFile(logPath), beforeLog);
  assert.equal(lost, 1);
});

test('kill at keyring before-rename rejects rotation and retains original wrapped keys', async t => {
  const f = await fixture(t, { directories: false }); let armed = false;
  const ownerLocks = await f.provider();
  const keys = await initializePurposeKeyring({ ...f.keyringOptions, ownerLocks, fault: async stage => {
    if (armed && stage === 'keyring:before-rename') await kill(f.processes[0]);
  } }); f.handles.push(keys);
  const file = path.join(f.safetyRoot, 'purpose-keyring/purpose-keyring.wrapped'); const before = await fs.readFile(file);
  armed = true; await rejects(keys.rotate('backup'), 'PURPOSE_KEYRING_LOCKED');
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['owner.lock', 'purpose-keyring.wrapped']);
});

test('kill before a journal write prevents append and poison fallback from mutating the durable log', async t => {
  const f = await fixture(t, { directories: false }); const ownerLocks = await f.provider(); let armed = false;
  const keys = await initializePurposeKeyring({ ...f.keyringOptions, ownerLocks }); f.handles.push(keys);
  const journal = await initializeSafetyJournal({ ...f.journalOptions, ownerLocks, keyProvider: keys, fault: async stage => {
    if (armed && stage === 'log.beforeWrite') await kill(f.processes[1]);
  } }); f.handles.push(journal);
  const file = path.join(f.safetyRoot, 'ai-journal/events.log'); const before = await fs.readFile(file);
  armed = true; await rejects(journal.latch('USER_OFF'), 'WRITER_LOCK_CHANGED');
  assert.deepEqual(await fs.readFile(file), before); assert.equal(journal.snapshot().recoveryOnly, true);
});

test('clean legacy closure can enroll native markers; old legacy writers then fail closed', async t => {
  const f = await fixture(t, { directories: false });
  const old = await initializePurposeKeyring(f.keyringOptions); const id = await old.currentKeyId('backup');
  const before = fingerprint(await old.getBackupKey(id)); await old.close();
  const ownerLocks = await f.provider(); const keys = await openPurposeKeyring({ ...f.keyringOptions, ownerLocks }); f.handles.push(keys);
  assert.equal(fingerprint(await keys.getBackupKey(id)), before); await keys.close();
  await rejects(openPurposeKeyring(f.keyringOptions), 'PURPOSE_KEYRING_LOCKED');
});

test('real Node owner SIGKILL releases all three OS leases; reopen preserves keys, liabilities and source ciphertext', async t => {
  const f = await fixture(t, { directories: false });
  const code = `
    const cp=require('node:child_process'), crypto=require('node:crypto');
    const {createNativeOwnerLocks}=require(${JSON.stringify(path.join(repo, 'desktop/src/native-owner-locks.cjs'))});
    const {initializePurposeKeyring}=require(${JSON.stringify(path.join(repo, 'desktop/src/purpose-keyring.cjs'))});
    const {initializeSafetyJournal}=require(${JSON.stringify(path.join(repo, 'desktop/src/safety-journal.cjs'))});
    const {createSourceVault}=require(${JSON.stringify(path.join(repo, 'desktop/src/source-vault.cjs'))});
    (async()=>{
      const opts=JSON.parse(process.argv[1]);
      const ownerLocks=await createNativeOwnerLocks({...opts,assertMainOwnership:()=>true,onLost:()=>process.exit(4)});
      const keys=await initializePurposeKeyring({...opts,restoreRoots:[opts.dataRoot],ownerLocks,
        wrapper:(${syntheticWrapper.toString()})()});
      const journal=await initializeSafetyJournal({...opts,restoreRoots:[opts.dataRoot],runningBuild:'100',ownerLocks,keyProvider:keys,
        verifyCommittedReservation:async r=>({...r,committed:true}),verifySettlement:async r=>({...r,verified:true}),verifyActivation:async()=>true});
      await journal.activate({projectionDigest:journal.snapshot().projectionDigest,userApproved:true});
      const requestId=crypto.randomUUID();
      await journal.reserveAndPermit({requestId,payloadSha256:'a'.repeat(64),budgetDay:new Date().toISOString().slice(0,10),priceVersion:'synthetic',reservedMicroUsd:'123'});
      const vault=await createSourceVault({...opts,sourceRoot:opts.sourceRoot,ownerLocks,wrapper:(${syntheticWrapper.toString()})()});
      const source=await vault.put({projectId:'1',bytes:Buffer.from('synthetic original source')});
      const id=await keys.currentKeyId('backup'), bytes=await keys.getBackupKey(id);
      const hash=crypto.createHash('sha256').update(bytes).digest('hex');bytes.fill(0);
      process.stdout.write(JSON.stringify({id,hash,requestId,source,snapshot:journal.snapshot()})+'\\n');
      setInterval(()=>{},1000);
    })().catch(()=>process.exit(5));`;
  const child = cp.spawn(process.execPath, ['-e', code, JSON.stringify({ javaPath, jarPath,
    safetyRoot: f.safetyRoot, dataRoot: f.restoreRoots[0], sourceRoot: path.join(f.root, 'sources'), installationId })], { stdio: ['ignore', 'pipe', 'pipe'] });
  f.processes.push(child);
  const before = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('synthetic owner timeout')), 15000);
    child.on('exit', () => { clearTimeout(timer); reject(new Error('synthetic owner exited before ready')); });
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim())); } });
  });
  const marker = path.join(f.safetyRoot, 'purpose-keyring/owner.lock'); const markerInode = (await fs.stat(marker)).ino;
  const logPath = path.join(f.safetyRoot, 'ai-journal/events.log'); const oldLog = await fs.readFile(logPath);
  const sourceKeysPath = path.join(f.safetyRoot, 'source-vault/source-keyring.wrapped');
  const oldSourceKeys = await fs.readFile(sourceKeysPath);
  await kill(child);
  const ownerLocks = await f.provider();
  // Only bounded retry of real OS lock acquisition, never PID/age-based deletion or enrollment.
  let keys;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { keys = await openPurposeKeyring({ ...f.keyringOptions, ownerLocks }); break; }
    catch (error) { if (attempt === 9) throw error; await pause(30); }
  }
  f.handles.push(keys);
  assert.equal(fingerprint(await keys.getBackupKey(before.id)), before.hash);
  assert.equal((await fs.stat(marker)).ino, markerInode);
  const journal = await openSafetyJournal({ ...f.journalOptions, ownerLocks, keyProvider: keys }); f.handles.push(journal);
  const reopened = journal.snapshot(); assert.equal(reopened.aiOff, true);
  assert.equal(reopened.totalLiabilityMicroUsd, '123'); assert.equal(reopened.requests[0].requestId, before.requestId);
  assert.equal(reopened.sequence, before.snapshot.sequence + 1);
  assert.deepEqual((await fs.readFile(logPath)).subarray(0, oldLog.length), oldLog);
  const vault = await openSourceVault({ safetyRoot: f.safetyRoot, sourceRoot: path.join(f.root, 'sources'), installationId, wrapper, ownerLocks });
  f.handles.push(vault);
  const original = await vault.read(before.source); assert.equal(original.toString(), 'synthetic original source'); original.fill(0);
  assert.deepEqual(await fs.readFile(sourceKeysPath), oldSourceKeys);
});

test('source backup export and restore stage share the fixed B lease and retain every key', async t => {
  const f = await fixture(t, { directories: false }); const ownerLocks = await f.provider();
  const sourceRoot = path.join(f.root, 'sources'); const opts = { safetyRoot: f.safetyRoot, sourceRoot, installationId, wrapper, ownerLocks };
  const vault = await createSourceVault(opts); f.handles.push(vault);
  const ref = await vault.put({ projectId: '1', bytes: Buffer.from('synthetic source v1') });
  await vault.rotate(); const keys = vault.info().keyIds;
  const packet = await vault.exportCiphertext(ref); const stage = path.join(f.root, 'stage'); await fs.mkdir(stage, { mode: 0o700 });
  await rejects(openSourceVaultRestoreStage({ ...opts, sourceRoot: stage }), 'SOURCE_VAULT_LOCKED');
  const marker = path.join(f.safetyRoot, 'source-vault/owner.lock'); const inode = (await fs.stat(marker)).ino;
  const keyFile = path.join(f.safetyRoot, 'source-vault/source-keyring.wrapped'); const before = await fs.readFile(keyFile);
  await vault.close();
  const restore = await openSourceVaultRestoreStage({ ...opts, sourceRoot: stage }); f.handles.push(restore);
  await restore.importCiphertext(packet); assert.deepEqual(restore.info().keyIds, keys);
  await rejects(restore.rotate(), 'SOURCE_VAULT_MODE'); await restore.close();
  const readback = await openSourceVault({ ...opts, sourceRoot: stage }); f.handles.push(readback);
  const bytes = await readback.read(ref); assert.equal(bytes.toString(), 'synthetic source v1'); bytes.fill(0);
  assert.equal((await fs.stat(marker)).ino, inode); assert.deepEqual(await fs.readFile(keyFile), before);
  packet.envelope.fill(0);
});

test('source lease loss before rename rejects publication and future reads without changing retained keys', async t => {
  const f = await fixture(t, { directories: false }); const ownerLocks = await f.provider(); let armed = false;
  const opts = { safetyRoot: f.safetyRoot, sourceRoot: path.join(f.root, 'sources'), installationId, wrapper, ownerLocks,
    fault: async stage => { if (armed && stage === 'blob:before-rename') await kill(f.processes[0]); } };
  const vault = await createSourceVault(opts); f.handles.push(vault);
  const ref = await vault.put({ projectId: '1', bytes: Buffer.from('preserved') });
  const keyFile = path.join(f.safetyRoot, 'source-vault/source-keyring.wrapped'); const before = await fs.readFile(keyFile);
  armed = true; await rejects(vault.put({ projectId: '1', bytes: Buffer.from('unpublished') }), 'SOURCE_VAULT_LOCKED');
  await rejects(vault.read(ref), 'SOURCE_VAULT_CLOSED'); assert.deepEqual(await fs.readFile(keyFile), before);
  const hash = crypto.createHash('sha256').update('unpublished').digest('hex');
  assert.deepEqual(await fs.readdir(path.join(opts.sourceRoot, '1', hash)), []);
});

test('legacy stale source lock rejects native takeover without changing keys or source bytes', async t => {
  const f = await fixture(t, { directories: false });
  const opts = { safetyRoot: f.safetyRoot, sourceRoot: path.join(f.root, 'sources'), installationId, wrapper };
  const vault = await createSourceVault(opts); const ref = await vault.put({ projectId: '1', bytes: Buffer.from('preserved') }); await vault.close();
  const marker = path.join(f.safetyRoot, 'source-vault/owner.lock');
  await fs.writeFile(marker, '{"format":1,"pid":2147483647}', { mode: 0o600 });
  const before = await fs.readFile(marker); const inode = (await fs.stat(marker)).ino;
  await rejects(openSourceVault({ ...opts, ownerLocks: await f.provider() }), 'SOURCE_VAULT_LOCKED');
  assert.deepEqual(await fs.readFile(marker), before); assert.equal((await fs.stat(marker)).ino, inode);
  assert.ok((await fs.readFile(path.join(opts.sourceRoot, '1', ref.sha256, 'blob.bin'))).length > 0);
});

test('worker rejects malformed invocation before any directory is created', async () => {
  for (const args of [['--ci-desktop-lease=anything'], ['--ci-desktop-lease', 'extra']]) {
    await assert.rejects(execFile(javaPath, ['-jar', jarPath, ...args]), error => error.code === 2 && error.stdout === '' && error.stderr === '');
  }
});

for (const mode of ['silent-close', 'stderr', 'garbage', 'duplicate-ready', 'timeout', 'check-wrong-sequence']) {
  test(`bounded helper protocol rejects ${mode} without deleting the enrolled marker`, async t => {
    const f = await fixture(t); const original = await f.lease(await f.provider()); await original.release();
    const file = path.join(f.safetyRoot, 'purpose-keyring/owner.lock'); const before = await fs.readFile(file);
    let lost = 0;
    const code = `const mode=${JSON.stringify(mode)};
      let pending=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{
        pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);
          if(mode==='silent-close')process.exit(0);
          if(mode==='stderr'){process.stderr.write('synthetic private failure');return;}
          if(mode==='garbage'){process.stdout.write('INVALID\\n');return;}
          if(mode==='timeout')return;
          if(line.startsWith('ACQUIRE')){const ready='READY\\t'+line.split('\\t')[4]+'\\n';process.stdout.write(mode==='duplicate-ready'?ready+ready:ready);}
          else process.stdout.write('HELD\\t999\\n');
        }});`;
    const provider = await f.provider({ timeoutMs: 300, onLost: () => { lost++; }, spawnImpl() {
      const child = cp.spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] }); f.processes.push(child); return child;
    } });
    await rejects(f.lease(provider)); assert.deepEqual(await fs.readFile(file), before);
    assert.equal(lost, mode === 'check-wrong-sequence' ? 1 : 0);
    await provider.close();
  });
}

test('closing waits for the helper exit after RELEASED and rejects a missing exit', async t => {
  const f = await fixture(t); const original = await f.lease(await f.provider()); await original.release();
  const code = `let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{
    pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){const parts=pending.slice(0,end).split('\\t');pending=pending.slice(end+1);
      process.stdout.write((parts[0]==='ACQUIRE'?'READY\\t'+parts[4]:parts[0]==='CHECK'?'HELD\\t'+parts[1]:'RELEASED\\t'+parts[1])+'\\n');
    }});setInterval(()=>{},1000);`;
  let lost = 0;
  const provider = await f.provider({ timeoutMs: 300, onLost: () => { lost++; }, spawnImpl() {
    const child = cp.spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] }); f.processes.push(child); return child;
  } });
  const lease = await f.lease(provider); const closing = lease.release();
  await rejects(provider.close(), 'NATIVE_OWNER_BUSY'); await rejects(closing, 'NATIVE_OWNER_TIMEOUT');
  assert.equal(lost, 1); assert.equal(f.processes.at(-1).signalCode, 'SIGKILL'); await provider.close();
});

test('factory creates no state and acquisition only accepts its pinned root and fixed roles', async t => {
  const f = await fixture(t); const provider = await f.provider();
  assert.deepEqual(await fs.readdir(path.join(f.safetyRoot, 'purpose-keyring')), []);
  for (const patch of [{ safetyRoot: path.join(f.root, 'other') }, { kind: '../ai-journal' }, { kind: 'arbitrary' }, { installationId: 'other' }]) {
    await rejects(acquireNativeOwnerLock(provider, { safetyRoot: f.safetyRoot, installationId, kind: 'purpose-keyring', ...patch }), 'NATIVE_OWNER_INVALID');
  }
  const other = path.join(f.root, 'missing');
  const empty = await f.provider({ safetyRoot: other });
  await rejects(acquireNativeOwnerLock(empty, { safetyRoot: other, installationId, kind: 'purpose-keyring' }));
  await assert.rejects(fs.lstat(other), { code: 'ENOENT' });
});

test('runtime launcher strips Java injection environment and rejects modified pinned JARs', async t => {
  const f = await fixture(t); const copied = path.join(f.root, 'helper.jar'); await fs.copyFile(jarPath, copied);
  const old = process.env.JAVA_TOOL_OPTIONS; process.env.JAVA_TOOL_OPTIONS = '-Dsynthetic.untrusted=true';
  try {
    let captured;
    const provider = await f.provider({ jarPath: copied, spawnImpl(command, args, options) {
      captured = { command, args, options }; const child = cp.spawn(command, args, options); f.processes.push(child); return child;
    } });
    const lease = await f.lease(provider);
    assert.equal(Object.hasOwn(captured.options.env, 'JAVA_TOOL_OPTIONS'), false);
    assert.deepEqual(captured.args, ['-jar', copied, '--ci-desktop-lease']); assert.equal(captured.options.shell, false);
    await lease.release(); await fs.appendFile(copied, 'modified');
    await rejects(f.lease(provider), 'NATIVE_OWNER_BINARY_CHANGED');
  } finally { if (old === undefined) delete process.env.JAVA_TOOL_OPTIONS; else process.env.JAVA_TOOL_OPTIONS = old; }
});
