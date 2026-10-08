'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSourceVault, openSourceVault, MAX_BATCH_FILES } = require('../src/source-vault.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error?.code === expected;
// The intent record is published with the vault's atomic writer (temp file flushed, then renamed).
const BATCH_POINTS = ['batch-intent:file-synced', 'batch:intent-written', 'batch:blob-written', 'batch:blobs-synced',
  'batch:intent-retired'];

// Synthetic OS wrapping: this key exists only in this disposable test process.
function syntheticWrapper() {
  const wrappingKey = crypto.randomBytes(32);
  return {
    isAvailable: () => true,
    wrap(bytes) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    unwrap(wrapped) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, wrapped.subarray(0, 12));
      decipher.setAuthTag(wrapped.subarray(12, 28));
      return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]);
    },
  };
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ci-source-batch-test-')));
  const options = { safetyRoot: path.join(root, 'safety'), sourceRoot: path.join(root, 'sources'),
    installationId: 'synthetic-installation_01', wrapper: syntheticWrapper() };
  const handles = [];
  const f = {
    root, options,
    address: ({ projectId, sha256 }) => path.join(options.sourceRoot, String(projectId), sha256),
    blob: value => path.join(f.address(value), 'blob.bin'),
    intent: path.join(options.sourceRoot, '.batch-intent'),
    // A real crash between the intent temp flush and its rename leaves this residue behind.
    pendingIntent: path.join(options.sourceRoot, `.pending-${'b'.repeat(32)}`),
    async create(extra = {}) { const v = await createSourceVault({ ...options, ...extra }); handles.push(v); return v; },
    async open(extra = {}) { const v = await openSourceVault({ ...options, ...extra }); handles.push(v); return v; },
  };
  t.after(async () => {
    for (const handle of handles) await handle.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return f;
}
const exists = file => fs.lstat(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

// Counts the operations that reach the disk barrier: every FileHandle.sync (F_FULLFSYNC on macOS)
// and every rename. The vault resolves both through node:fs/promises at call time.
async function countDurability(t, root) {
  const counts = { sync: 0, rename: 0 };
  const probe = await fs.open(path.join(root, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = prototype.sync;
  const rename = fs.rename;
  prototype.sync = function counted(...args) { counts.sync += 1; return sync.apply(this, args); };
  fs.rename = (...args) => { counts.rename += 1; return rename(...args); };
  t.after(() => { prototype.sync = sync; fs.rename = rename; });
  return counts;
}

test('retaining committed source authenticates bytes without another durability write', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const a = await vault.put({ projectId: 3, bytes: Buffer.from('unchanged source') });
  const b = await vault.put({ projectId: 3, bytes: Buffer.from('another source') });
  const blobs = [a, b].map(({ sha256, byteSize, keyId }) => ({ sha256, byteSize, keyId }));
  const before = await fs.readFile(f.blob(a));
  const counts = await countDurability(t, f.root);
  assert.deepEqual(await vault.retain({ projectId: 3, blobs }), { count: 2 });
  assert.deepEqual(counts, { sync: 0, rename: 0 });
  assert.deepEqual(await fs.readFile(f.blob(a)), before);
  await assert.rejects(vault.retain({ projectId: 4, blobs }), code('SOURCE_VAULT_MISSING'));
  await assert.rejects(vault.retain({ projectId: 3, blobs: [{ ...blobs[0], keyId: 'e'.repeat(32) }] }),
    code('SOURCE_VAULT_INTEGRITY'));
  const damaged = Buffer.from(before); damaged[damaged.length - 1] ^= 1;
  await fs.writeFile(f.blob(a), damaged);
  await assert.rejects(vault.retain({ projectId: 3, blobs }), code('SOURCE_VAULT_INTEGRITY'));
});

test('retention cannot acknowledge missing, oversized or caller-mutated addresses', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const a = await vault.put({ projectId: 1, bytes: Buffer.from('immutable reference') });
  const ref = { sha256: a.sha256, byteSize: a.byteSize, keyId: a.keyId };
  await assert.rejects(vault.retain({ projectId: 1, blobs: [] }), code('SOURCE_VAULT_ARGUMENT'));
  await assert.rejects(vault.retain({ projectId: 1, blobs: Array(129).fill(ref) }), code('SOURCE_VAULT_ARGUMENT'));
  await assert.rejects(vault.retain({ projectId: 1, blobs: Array(1) }), code('SOURCE_VAULT_IO'));
  const pending = vault.retain({ projectId: 1, blobs: [ref] });
  ref.sha256 = '0'.repeat(64);
  assert.deepEqual(await pending, { count: 1 });
  await assert.rejects(vault.retain({ projectId: 1, blobs: [ref] }), code('SOURCE_VAULT_MISSING'));
});

test('a full retention batch authenticates its last blob and preserves queued durability on rejection', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const a = await vault.put({ projectId: 7, bytes: Buffer.from('earlier durable source') });
  const b = await vault.put({ projectId: 7, bytes: Buffer.from('last durable source') });
  const pending = await vault.stage({ projectId: 7, bytes: Buffer.from('pending independent source') });
  const ref = ({ sha256, byteSize, keyId }) => ({ sha256, byteSize, keyId });
  const original = await fs.readFile(f.blob(b));
  const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1;
  await fs.writeFile(f.blob(b), damaged);
  await assert.rejects(vault.retain({ projectId: 7, blobs: [...Array(127).fill(ref(a)), ref(b)] }),
    code('SOURCE_VAULT_INTEGRITY'));
  await vault.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.read(pending), Buffer.from('pending independent source'));
  assert.deepEqual(await fs.readFile(f.blob(b)), damaged);
  await fs.writeFile(f.blob(b), original);
  assert.deepEqual(await reopened.retain({ projectId: 7, blobs: [...Array(127).fill(ref(a)), ref(b)] }), { count: 128 });
});

test('retention refuses a replaced project ancestor without touching the linked ciphertext', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const stored = await vault.put({ projectId: 8, bytes: Buffer.from('approved retained source') });
  const original = await fs.readFile(f.blob(stored));
  const project = path.join(f.options.sourceRoot, '8');
  const moved = path.join(f.root, 'moved-project');
  await fs.rename(project, moved);
  await fs.symlink(moved, project);
  const { sha256, byteSize, keyId } = stored;
  await assert.rejects(vault.retain({ projectId: 8, blobs: [{ sha256, byteSize, keyId }] }),
    code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.deepEqual(await fs.readFile(path.join(moved, sha256, 'blob.bin')), original);
});

test('retention failure drains an in-flight authenticated read before resolving or closing', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const a = await vault.put({ projectId: 9, bytes: Buffer.from('retained while another read fails') });
  const b = await vault.put({ projectId: 9, bytes: Buffer.from('independent durable source') });
  const ref = ({ sha256, byteSize, keyId }) => ({ sha256, byteSize, keyId });
  let beginRead, releaseRead, reportFault;
  const started = new Promise(resolve => { beginRead = resolve; });
  const released = new Promise(resolve => { releaseRead = resolve; });
  const faultIssued = new Promise(resolve => { reportFault = resolve; });
  const open = fs.open;
  let fault = false;
  fs.open = async function(file, ...args) {
    if (file === f.blob(b) && !fault) {
      await started;
      fault = true; reportFault();
      throw Object.assign(new Error('synthetic read fault'), { code: 'EIO' });
    }
    const handle = await open.call(this, file, ...args);
    if (file === f.blob(a)) {
      const read = handle.read;
      handle.read = async function(...args) { beginRead(); await released; return read.apply(this, args); };
    }
    return handle;
  };
  let settled = false, closed = false, deadline, closing;
  const retention = vault.retain({ projectId: 9, blobs: [ref(a), ref(b)] }).then(
    value => { settled = true; return { value }; },
    error => { settled = true; return { error }; },
  );
  try {
    await Promise.race([faultIssued, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('authentication fault did not start')), 5000);
    })]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'a failed batch still owns its pending authenticated read');
    closing = vault.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'closing cannot release ownership while a read remains in flight');
    releaseRead();
    assert.equal((await retention).error?.code, 'SOURCE_VAULT_IO');
    await closing;
  } finally {
    clearTimeout(deadline);
    releaseRead();
    fs.open = open;
    await retention;
    if (closing) await closing;
  }
  const reopened = await f.open();
  assert.deepEqual(await reopened.read(a), Buffer.from('retained while another read fails'));
  assert.deepEqual(await reopened.read(b), Buffer.from('independent durable source'));
});

test('staged blobs become readable and durable only through a barrier of the same vault session', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const inputs = [Buffer.from('first staged source'), Buffer.from('second staged source'), Buffer.from('first staged source')];
  const receipts = [];
  for (const bytes of inputs) receipts.push(await vault.stage({ projectId: 3, bytes }));
  assert.equal(receipts[0].sha256, digest(inputs[0]));
  assert.equal(receipts[0].projectId, '3');
  assert.match(receipts[0].session, /^[a-f0-9]{32}$/);
  assert.deepEqual(receipts.map(r => r.session), Array(3).fill(receipts[0].session));
  assert.deepEqual(receipts.map(r => r.sequence), [1, 2, 3]);
  assert.deepEqual(receipts.map(r => r.deduplicated), [false, false, true]);
  // Below the batch limit nothing is written before the barrier.
  assert.equal(await exists(path.join(f.options.sourceRoot, '3')), false);
  await assert.rejects(vault.barrier({ session: receipts[0].session, sequence: 4 }), code('SOURCE_VAULT_ARGUMENT'));
  await assert.rejects(vault.barrier({ session: 'f'.repeat(32), sequence: 3 }), code('SOURCE_VAULT_MISSING'));
  const barrier = await vault.barrier({ session: receipts[0].session, sequence: 3 });
  assert.deepEqual({ ...barrier }, { format: 1, session: receipts[0].session, sequence: 3 });
  assert.equal(await exists(f.intent), false);
  assert.equal(vault.info().store.entries, 5); // project + two (address, blob) pairs
  await vault.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.read(receipts[0]), inputs[0]);
  assert.deepEqual(await reopened.read(receipts[1]), inputs[1]);
  assert.equal(reopened.info().store.entries, 5);
  // A later session cannot claim the earlier session's staged blobs as durable.
  await assert.rejects(reopened.barrier({ session: receipts[0].session, sequence: 3 }), code('SOURCE_VAULT_MISSING'));
  // Content that is already committed deduplicates without being written again.
  const again = await reopened.stage({ projectId: 3, bytes: inputs[1] });
  assert.equal(again.deduplicated, true);
  await reopened.barrier(again);
});

test('an unacknowledged staged batch is lost on close and its old session barrier fails', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const staged = await vault.stage({ projectId: 1, bytes: Buffer.from('never acknowledged') });
  await vault.close();
  const reopened = await f.open();
  await assert.rejects(reopened.read(staged), code('SOURCE_VAULT_MISSING'));
  await assert.rejects(reopened.barrier(staged), code('SOURCE_VAULT_MISSING'));
  assert.equal(reopened.info().store.entries, 0);
});

test('durability calls per import are bounded by batches, not by per-blob renames and directory flushes', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const files = 2 * MAX_BATCH_FILES + 3;
  const batches = 3;
  const counts = await countDurability(t, f.root);
  let last;
  for (let i = 0; i < files; i += 1) last = await vault.stage({ projectId: 1, bytes: Buffer.from(`source file ${i}`) });
  await vault.barrier(last);
  // One rename per batch (the intent record), never one per blob.
  assert.equal(counts.rename, batches);
  // Per blob only its new file and address directory inode are flushed (each clean after the
  // batch's first device flush); the shared root/project/intent flushes are per batch.
  assert.ok(counts.sync <= 2 * files + 6 * batches, `sync calls ${counts.sync}`);
  const legacy = { sync: counts.sync, rename: counts.rename };
  for (let i = 0; i < 10; i += 1) await vault.put({ projectId: 1, bytes: Buffer.from(`legacy file ${i}`) });
  assert.equal(counts.rename - legacy.rename, 10); // contrast: the per-blob put renames every blob
  assert.ok(counts.sync - legacy.sync >= 30);
  await vault.close();
  const reopened = await f.open();
  assert.equal(reopened.info().store.entries, 1 + 2 * (files + 10));
  assert.deepEqual(await reopened.read({ projectId: 1, sha256: digest(Buffer.from('source file 7')), byteSize: 13 }),
    Buffer.from('source file 7'));
});

test('reaching the batch limit flushes a complete batch before the barrier is requested', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const receipts = [];
  for (let i = 0; i <= MAX_BATCH_FILES; i += 1) receipts.push(await vault.stage({ projectId: 1, bytes: Buffer.from(`f${i}`) }));
  // The first full batch is on disk and intent-free; the last stage is still only in memory.
  assert.equal(await exists(f.blob(receipts[0])), true);
  assert.equal(await exists(f.blob(receipts.at(-1))), false);
  assert.equal(await exists(f.intent), false);
  await vault.barrier(receipts.at(-1));
  assert.equal(await exists(f.blob(receipts.at(-1))), true);
});

for (const point of BATCH_POINTS) test(`batch crash at ${point} leaves the committed state and a recoverable store`, async t => {
  const f = await fixture(t);
  let armed = false;
  const events = [];
  const vault = await f.create({ fault: event => {
    if (event.startsWith('batch')) events.push(event);
    if (armed && event === point) throw new Error('injected crash');
  } });
  const legacy = await vault.put({ projectId: 1, bytes: Buffer.from('legacy committed source') });
  const committed = await vault.stage({ projectId: 1, bytes: Buffer.from('batch committed source') });
  await vault.barrier(committed);
  const committedEnvelope = await fs.readFile(f.blob(committed));
  const fresh = [Buffer.from('interrupted new one'), Buffer.from('interrupted new two')];
  armed = true; events.length = 0;
  const staged = [];
  for (const bytes of fresh) staged.push(await vault.stage({ projectId: 2, bytes }));
  staged.push(await vault.stage({ projectId: 1, bytes: Buffer.from('batch committed source') }));
  await assert.rejects(vault.barrier(staged.at(-1)), code('SOURCE_VAULT_IO'));
  assert.equal(events.at(-1), point);
  // A failed barrier never acknowledges and the handle requires reopening, like a crash.
  assert.throws(() => vault.info(), code('SOURCE_VAULT_CLOSED'));
  await assert.rejects(vault.barrier(staged.at(-1)), code('SOURCE_VAULT_CLOSED'));
  await vault.close();
  await fs.writeFile(f.pendingIntent, 'torn intent', { mode: 0o600 });

  const reopened = await f.open();
  assert.equal(await exists(f.intent), false);
  assert.equal(await exists(f.pendingIntent), false);
  assert.deepEqual(await reopened.read(legacy), Buffer.from('legacy committed source'));
  assert.deepEqual(await reopened.read(committed), Buffer.from('batch committed source'));
  assert.deepEqual(await fs.readFile(f.blob(committed)), committedEnvelope);
  const survived = point === 'batch:intent-retired';
  for (const [index, bytes] of fresh.entries()) {
    assert.equal(await exists(f.address(staged[index])), survived, `address ${index}`);
    if (survived) assert.deepEqual(await reopened.read(staged[index]), bytes);
    else await assert.rejects(reopened.read(staged[index]), code('SOURCE_VAULT_MISSING'));
  }
  // Accounting after recovery matches a fresh scan of what remains.
  const recovered = reopened.info().store;
  await reopened.close();
  const scanned = await f.open();
  assert.deepEqual(scanned.info().store, recovered);
  // No permanent residue: the same content can be staged and committed again.
  let last;
  for (const bytes of fresh) last = await scanned.stage({ projectId: 2, bytes });
  assert.equal(last.deduplicated, survived);
  await scanned.barrier(last);
  for (const [index, bytes] of fresh.entries()) assert.deepEqual(await scanned.read(staged[index]), bytes);
});

test('other operations flush staged blobs first so a per-blob put never acknowledges non-durable bytes', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const bytes = Buffer.from('staged then put');
  const staged = await vault.stage({ projectId: 1, bytes });
  const put = await vault.put({ projectId: 1, bytes });
  assert.equal(put.deduplicated, true);
  assert.equal(await exists(f.blob(staged)), true);
  assert.equal(await exists(f.intent), false);
  const other = await vault.stage({ projectId: 1, bytes: Buffer.from('staged then read') });
  assert.deepEqual(await vault.read(other), Buffer.from('staged then read'));
  // The barrier still confirms the whole session after an implicit flush.
  assert.equal((await vault.barrier(other)).sequence, 2);
});

test('a damaged batch intent fails closed without deleting any blob', async t => {
  const f = await fixture(t);
  let crash = false;
  const vault = await f.create({ fault: event => { if (crash && event === 'batch:blobs-synced') throw new Error('injected crash'); } });
  const committed = await vault.put({ projectId: 1, bytes: Buffer.from('committed') });
  crash = true;
  const staged = await vault.stage({ projectId: 1, bytes: Buffer.from('interrupted') });
  await assert.rejects(vault.barrier(staged), code('SOURCE_VAULT_IO'));
  await vault.close();
  const record = JSON.parse(await fs.readFile(f.intent, 'utf8'));
  record.addresses.push({ projectId: '1', sha256: committed.sha256 });
  await fs.writeFile(f.intent, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(f.open(), code('SOURCE_VAULT_INTEGRITY'));
  assert.equal(await exists(f.blob(committed)), true);
  assert.equal(await exists(f.blob(staged)), true);
});

test('staging honours the store quota before writing and stays unavailable to restore stages', async t => {
  const f = await fixture(t);
  const vault = await f.create({ maxStoreEntries: 4 });
  const first = await vault.stage({ projectId: 1, bytes: Buffer.from('fits') });
  await assert.rejects(vault.stage({ projectId: 1, bytes: Buffer.from('does not fit') }), code('SOURCE_VAULT_LIMIT'));
  await vault.barrier(first);
  assert.equal(vault.info().store.entries, 3);
  await assert.rejects(vault.stage({ projectId: 1, bytes: 'not bytes' }), code('SOURCE_VAULT_ARGUMENT'));
  await assert.rejects(vault.barrier({ session: first.session, sequence: 0 }), code('SOURCE_VAULT_ARGUMENT'));
});

test('deduplicated staged receipts report the key that protects the stored bytes after rotation', async t => {
  const f = await fixture(t);
  const vault = await f.create();
  const bytes = Buffer.from('rotated source');
  const first = await vault.stage({ projectId: 1, bytes });
  await vault.barrier(first);
  const rotated = await vault.rotate();
  assert.notEqual(rotated.activeKeyId, first.keyId);
  const again = await vault.stage({ projectId: 1, bytes });
  const twice = await vault.stage({ projectId: 1, bytes });
  const fresh = await vault.stage({ projectId: 1, bytes: Buffer.from('new under rotated key') });
  assert.deepEqual([again.keyId, twice.keyId, fresh.keyId], [first.keyId, first.keyId, rotated.activeKeyId]);
  await vault.barrier(fresh);
  assert.deepEqual(await vault.exportCiphertext(again).then(value => value.keyId), first.keyId);
});
