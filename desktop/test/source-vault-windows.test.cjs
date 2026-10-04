'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const windowsPath = path.win32;
const CHUNK = 1024 * 1024;
const code = expected => error => error?.code === expected;

// Contract model only: these tests exercise vault logic and native-state consumption, not
// NTFS ACL enforcement, helper crash behavior, or hardware power-loss durability.
async function fixture(t, extra = {}) {
  const nodes = new Map();
  const sessions = [];
  const writes = [];
  const reads = [];
  let sequence = 0;
  let nextIdentity = 0;
  let held = false;
  let writeFailure = null;
  const key = crypto.randomBytes(32);
  const wrapper = {
    isAvailable: () => true,
    wrap(bytes) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    unwrap(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
  };
  function state(node) {
    const size = String(node.bytes?.length || 0), modified = String(node.version);
    return Object.freeze({ format: 1, platform: 'win32', kind: node.kind, volume: '1',
      fileId: '0:' + node.id, owner: 'S-1-5-21-1001', size, allocationSize: size, modified, changed: modified,
      identity: 'WI1:1:0:' + node.id, token: `WS1:1:0:${node.id}:${size}:${size}:${modified}:${modified}` });
  }
  function add(file, kind, bytes) {
    assert.ok(!nodes.has(file));
    const node = { kind, bytes, id: ++nextIdentity, version: ++sequence };
    nodes.set(file, node);
    const parent = nodes.get(windowsPath.dirname(file));
    if (parent) parent.version = ++sequence;
    return state(node);
  }
  function alter(file, bytes) {
    const node = nodes.get(file); assert.ok(node);
    node.bytes = Buffer.from(bytes); node.version = ++sequence;
  }
  const root = 'C:\\private';
  add(root, 'directory');
  const boundary = {
    async openStorage(root, options) {
      assert.equal(options.mode, 'private'); assert.equal(nodes.get(root)?.kind, 'directory');
      let closed = false;
      function target(file = '') {
        assert.equal(closed, false);
        const absolute = windowsPath.isAbsolute(file) ? file : windowsPath.join(root, file);
        const relative = windowsPath.relative(root, absolute);
        assert.ok(relative !== '..' && !relative.startsWith('..\\') && !windowsPath.isAbsolute(relative));
        return absolute;
      }
      function current(file, directory, missing = false) {
        const absolute = target(file);
        if (absolute !== root) assert.equal(nodes.get(windowsPath.dirname(absolute))?.kind, 'directory');
        const node = nodes.get(absolute);
        if (!node && missing) return null;
        assert.ok(node); assert.equal(node.kind, directory ? 'directory' : 'file');
        return state(node);
      }
      const session = {
        root,
        async stat(file = '', { directory = false, missing = false } = {}) { return current(file, directory, missing); },
        async mkdir(file) { return add(target(file), 'directory'); },
        async *entries(file = '') {
          const dir = target(file); current(file, true);
          for (const [absolute, node] of nodes) if (absolute !== dir && windowsPath.dirname(absolute) === dir)
            yield { name: windowsPath.basename(absolute), directory: node.kind === 'directory' };
        },
        async openRead(file, { expected, maxBytes }) {
          const initial = current(file, false), absolute = target(file);
          if (expected) assert.equal(initial.token, expected.token);
          assert.ok(Number(initial.size) <= maxBytes);
          let offset = 0;
          return { state: initial,
            async read(length) {
              assert.ok(length > 0 && length <= CHUNK); reads.push(length);
              assert.equal(current(file, false).token, initial.token);
              const result = Buffer.from(nodes.get(absolute).bytes.subarray(offset, offset + length));
              offset += result.length; return result;
            }, async close() { assert.equal(current(file, false).token, initial.token); } };
        },
        async openWrite(file, { mode, expected, maxBytes }) {
          const absolute = target(file);
          if (mode === 'create') { assert.equal(expected, undefined); add(absolute, 'file', Buffer.alloc(0)); }
          else { assert.equal(mode, 'append'); assert.equal(current(file, false).token, expected.token); }
          writes.push({ file: absolute, mode, maxBytes });
          let closedWriter = false;
          return {
            async write(bytes) {
              assert.equal(closedWriter, false);
              for (let i = 0; i < bytes.length; i += CHUNK) {
                const chunk = bytes.subarray(i, i + CHUNK), node = nodes.get(absolute);
                assert.ok(node.bytes.length + chunk.length <= maxBytes);
                if (writeFailure?.(absolute, chunk)) {
                  alter(absolute, Buffer.concat([node.bytes, chunk.subarray(0, Math.min(7, chunk.length))]));
                  throw new Error('synthetic interrupted write');
                }
                alter(absolute, Buffer.concat([node.bytes, chunk]));
              }
            },
            async commit() { closedWriter = true; return current(file, false); },
            async close() { closedWriter = true; },
          };
        },
        async close() { closed = true; },
        lose() { options.onLost(); },
      };
      sessions.push(session); return session;
    },
  };
  const cache = new Map();
  async function load(name) {
    const filename = path.join(__dirname, '../src', name);
    const source = await fs.readFile(filename, 'utf8');
    const module = { exports: {} };
    vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { Buffer, Uint8Array,
      process: { platform: 'win32', getuid: undefined }, console }, { filename })(specifier => {
      if (specifier === 'node:path') return windowsPath;
      if (specifier === 'node:fs/promises') return new Proxy({}, { get() { throw new Error('POSIX IO in Windows vault'); } });
      if (specifier === './native-owner-locks.cjs') return { async acquireNativeOwnerLock(provider) {
        assert.equal(provider, ownerLocks); if (held) throw new Error('busy'); held = true;
        return { isHeld: () => held, async check() { assert.equal(held, true); }, async release() { held = false; } };
      } };
      if (cache.has(specifier)) return cache.get(specifier);
      return require(specifier.startsWith('.') ? path.join(path.dirname(filename), specifier) : specifier);
    }, module, module.exports);
    cache.set('./' + name, module.exports); return module.exports;
  }
  const ownerLocks = {};
  await load('source-vault-windows.cjs');
  const api = await load('source-vault.cjs');
  const options = { safetyRoot: root + '\\safety', sourceRoot: root + '\\sources',
    installationId: 'windows-test-installation', wrapper, ownerLocks, windowsBoundary: boundary, ...extra };
  const handles = [];
  const f = { ...api, options, nodes, sessions, writes, reads, wrapper, alter, add,
    keyFile: options.safetyRoot + '\\source-vault\\source-keyring.wrapped',
    blob: receipt => windowsPath.join(options.sourceRoot, receipt.projectId, receipt.sha256, 'blob.bin'),
    failWrite(fn) { writeFailure = fn; },
    async create(extra = {}) { const vault = await api.createSourceVault({ ...options, ...extra }); handles.push(vault); return vault; },
    async open(extra = {}) { const vault = await api.openSourceVault({ ...options, ...extra }); handles.push(vault); return vault; },
    async restore(sourceRoot) {
      add(sourceRoot, 'directory');
      const vault = await api.openSourceVaultRestoreStage({ ...options, sourceRoot }); handles.push(vault); return vault;
    },
  };
  t.after(async () => { for (const handle of handles) await handle.close().catch(() => {}); key.fill(0); });
  return f;
}

test('Windows native-state vault retains source bytes and keys across dedup, rotation and reopen', async t => {
  const f = await fixture(t), vault = await f.create();
  const bytes = crypto.randomBytes(f.MAX_FILE_BYTES), receipt = await vault.put({ projectId: 7, bytes });
  assert.deepEqual(await vault.read(receipt), bytes);
  assert.equal((await vault.put({ projectId: 7, bytes })).deduplicated, true);
  const prior = Buffer.from(f.nodes.get(f.keyFile).bytes), first = vault.info().activeKeyId;
  await vault.rotate();
  assert.notEqual(vault.info().activeKeyId, first);
  assert.equal(vault.info().keyIds.includes(first), true);
  assert.equal(f.nodes.get(f.keyFile).bytes.subarray(0, prior.length).equals(prior), true);
  assert.deepEqual(await vault.read(receipt), bytes);
  assert.equal((await vault.put({ projectId: 7, bytes })).keyId, first);
  for (const node of f.nodes.values()) if (node.bytes) assert.equal(node.bytes.includes(bytes), false);
  assert.ok(f.reads.filter(length => length === CHUNK).length >= 2);
  assert.ok(f.writes.some(write => write.mode === 'append' && write.file === f.keyFile));
  await vault.close();
  const reopened = await f.open(); assert.deepEqual(await reopened.read(receipt), bytes);
});

test('Windows restore authenticates before publication and requires empty stage without rotation', async t => {
  const f = await fixture(t), live = await f.create();
  const receipt = await live.put({ projectId: 3, bytes: Buffer.from('archived source') });
  const encrypted = await live.exportCiphertext(receipt);
  await assert.rejects(live.importCiphertext(encrypted), code('SOURCE_VAULT_MODE'));
  await live.rotate(); const keysBefore = Buffer.from(f.nodes.get(f.keyFile).bytes);
  await live.close();
  const stageRoot = 'C:\\private\\stage', stage = await f.restore(stageRoot);
  await assert.rejects(stage.rotate(), code('SOURCE_VAULT_MODE'));
  await assert.rejects(stage.put({ projectId: 3, bytes: Buffer.alloc(0) }), code('SOURCE_VAULT_MODE'));
  const tampered = Buffer.from(encrypted.envelope); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(stage.importCiphertext({ ...encrypted, envelope: tampered,
    cipherSha256: crypto.createHash('sha256').update(tampered).digest('hex') }), code('SOURCE_VAULT_INTEGRITY'));
  assert.equal([...f.nodes.keys()].filter(name => name.startsWith(stageRoot + '\\')).length, 0);
  assert.equal((await stage.importCiphertext(encrypted)).deduplicated, false);
  assert.equal((await stage.importCiphertext(encrypted)).deduplicated, true);
  assert.deepEqual(await stage.read(receipt), Buffer.from('archived source'));
  assert.deepEqual(f.nodes.get(f.keyFile).bytes, keysBefore);
  await stage.close();
  await assert.rejects(f.openSourceVaultRestoreStage({ ...f.options, sourceRoot: stageRoot }), code('SOURCE_VAULT_NOT_FRESH'));
});

test('Windows torn key append poisons live handle and refuses reopen, never falling back', async t => {
  const f = await fixture(t), vault = await f.create();
  const before = Buffer.from(f.nodes.get(f.keyFile).bytes);
  f.failWrite(file => file === f.keyFile);
  await assert.rejects(vault.rotate());
  assert.throws(() => vault.info(), code('SOURCE_VAULT_CLOSED'));
  await vault.close();
  assert.ok(f.nodes.get(f.keyFile).bytes.length > before.length);
  assert.equal(f.nodes.get(f.keyFile).bytes.subarray(0, before.length).equals(before), true);
  await assert.rejects(f.open(), code('SOURCE_VAULT_KEY_INVALID'));
});

test('Windows snapshot chain refuses reordered records and installation transplants', async t => {
  const f = await fixture(t), vault = await f.create(); await vault.rotate(); await vault.close();
  const bytes = Buffer.from(f.nodes.get(f.keyFile).bytes), length = bytes.readUInt32BE(0) + 4;
  f.alter(f.keyFile, Buffer.concat([bytes.subarray(length), bytes.subarray(0, length)]));
  await assert.rejects(f.open(), code('SOURCE_VAULT_KEY_INVALID'));
  f.alter(f.keyFile, bytes);
  await assert.rejects(f.open({ installationId: 'other-installation' }), code('SOURCE_VAULT_KEY_INVALID'));
});

test('Windows live key rollback is detected even at a valid prior record boundary', async t => {
  const f = await fixture(t), vault = await f.create();
  const first = Buffer.from(f.nodes.get(f.keyFile).bytes); await vault.rotate();
  f.alter(f.keyFile, first);
  await assert.rejects(vault.put({ projectId: 1, bytes: Buffer.alloc(0) }), code('SOURCE_VAULT_KEY_INVALID'));
});

test('Windows failed blob attempts retain and charge bytes and metadata, including across reopen', async t => {
  const f = await fixture(t, { maxStoreEntries: 3 }), vault = await f.create();
  f.failWrite(file => file.endsWith('blob.bin'));
  await assert.rejects(vault.put({ projectId: 1, bytes: Buffer.from('first') }), code('SOURCE_VAULT_IO'));
  assert.equal(vault.info().store.entries, 3); assert.equal(vault.info().store.storedBytes, 7);
  f.failWrite(null);
  await assert.rejects(vault.put({ projectId: 1, bytes: Buffer.from('second') }), code('SOURCE_VAULT_LIMIT'));
  await assert.rejects(vault.put({ projectId: 1, bytes: Buffer.from('first') }), code('SOURCE_VAULT_INTEGRITY'));
  await vault.close(); const reopened = await f.open();
  assert.equal(reopened.info().store.entries, 3); assert.equal(reopened.info().store.storedBytes, 7);
});

test('Windows failure after immutable commit remains accounted and can only deduplicate authenticated equality', async t => {
  const f = await fixture(t); let armed = true;
  const vault = await f.create({ fault(stage) { if (armed && stage === 'blob:native-committed') { armed = false; throw new Error('interrupted acknowledgment'); } } });
  const bytes = Buffer.from('committed source');
  await assert.rejects(vault.put({ projectId: 1, bytes }), code('SOURCE_VAULT_IO'));
  assert.ok(vault.info().store.storedBytes > bytes.length);
  assert.equal((await vault.put({ projectId: 1, bytes })).deduplicated, true);
});

test('Windows corrupted ciphertext releases no plaintext through read or dedup', async t => {
  const f = await fixture(t), vault = await f.create(), bytes = Buffer.from('authenticated source');
  const receipt = await vault.put({ projectId: 1, bytes }), file = f.blob(receipt);
  const encrypted = Buffer.from(f.nodes.get(file).bytes); encrypted[encrypted.length - 1] ^= 1; f.alter(file, encrypted);
  await assert.rejects(vault.read(receipt), code('SOURCE_VAULT_INTEGRITY'));
  await assert.rejects(vault.put({ projectId: 1, bytes }), code('SOURCE_VAULT_INTEGRITY'));
});

test('Windows key generations remain bounded at 64 and retain all referenced keys', async t => {
  const f = await fixture(t), vault = await f.create();
  const receipt = await vault.put({ projectId: 1, bytes: Buffer.from('old source') });
  for (let i = 1; i < 64; i++) await vault.rotate();
  assert.equal(vault.info().keyIds.length, 64);
  await assert.rejects(vault.rotate(), code('SOURCE_VAULT_LIMIT'));
  assert.deepEqual(await vault.read(receipt), Buffer.from('old source'));
  await vault.close(); const reopened = await f.open();
  assert.equal(reopened.info().keyIds.length, 64);
  assert.deepEqual(await reopened.read(receipt), Buffer.from('old source'));
});

test('Windows requires verified boundary and native lease, separates roots and refuses lost sessions', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({ windowsBoundary: undefined }), code('SOURCE_VAULT_UNSUPPORTED'));
  await assert.rejects(f.create({ ownerLocks: undefined }), code('SOURCE_VAULT_UNSUPPORTED'));
  await assert.rejects(f.create({ sourceRoot: f.options.safetyRoot.toUpperCase() }), code('SOURCE_VAULT_UNSAFE_PATH'));
  const vault = await f.create();
  await assert.rejects(f.open(), code('SOURCE_VAULT_LOCKED'));
  f.sessions[0].lose();
  assert.throws(() => vault.info(), code('SOURCE_VAULT_CLOSED'));
  await assert.rejects(vault.put({ projectId: 1, bytes: Buffer.alloc(0) }), code('SOURCE_VAULT_CLOSED'));
});

test('Windows missing projects are rejected without probing missing ancestors; subsequent addresses remain writable', async t => {
  const f = await fixture(t), vault = await f.create();
  await assert.rejects(vault.read({ projectId: 9, sha256: '0'.repeat(64), byteSize: 0 }), code('SOURCE_VAULT_MISSING'));
  const first = await vault.put({ projectId: 1, bytes: Buffer.alloc(0) });
  const second = await vault.put({ projectId: 1, bytes: Buffer.from('another address') });
  assert.equal((await vault.read(first)).length, 0);
  assert.deepEqual(await vault.read(second), Buffer.from('another address'));
});

test('Windows post-append interruption preserves all keys for explicit reopen', async t => {
  const f = await fixture(t);
  const vault = await f.create({ fault(stage) { if (stage === 'keyring:native-appended') throw new Error('lost acknowledgment'); } });
  const receipt = await vault.put({ projectId: 1, bytes: Buffer.from('retained reference') });
  await assert.rejects(vault.rotate(), code('SOURCE_VAULT_IO'));
  assert.throws(() => vault.info(), code('SOURCE_VAULT_CLOSED'));
  await vault.close();
  const reopened = await f.open();
  assert.equal(reopened.info().keyIds.length, 2);
  assert.deepEqual(await reopened.read(receipt), Buffer.from('retained reference'));
});

test('Windows missing keys never cause automatic replacement or source deletion', async t => {
  const f = await fixture(t), vault = await f.create();
  const receipt = await vault.put({ projectId: 1, bytes: Buffer.from('keep this ciphertext') });
  await vault.close();
  const ciphertext = Buffer.from(f.nodes.get(f.blob(receipt)).bytes);
  f.nodes.delete(f.keyFile);
  await assert.rejects(f.open(), code('SOURCE_VAULT_KEY_MISSING'));
  await assert.rejects(f.create(), code('SOURCE_VAULT_NOT_FRESH'));
  assert.equal(f.nodes.has(f.keyFile), false);
  assert.deepEqual(f.nodes.get(f.blob(receipt)).bytes, ciphertext);
});

test('Windows authenticated enrollment prevents reinitialization after key directory loss', async t => {
  const f = await fixture(t), vault = await f.create(); await vault.close();
  const enrollmentFile = f.options.safetyRoot + '\\source-vault.enrollment';
  const enrollment = Buffer.from(f.nodes.get(enrollmentFile).bytes);
  const directory = windowsPath.dirname(f.keyFile);
  for (const file of f.nodes.keys()) if (file === directory || file.startsWith(directory + '\\')) f.nodes.delete(file);
  await assert.rejects(f.create(), code('SOURCE_VAULT_NOT_FRESH'));
  await assert.rejects(f.open());
  assert.deepEqual(f.nodes.get(enrollmentFile).bytes, enrollment);
  assert.equal(f.nodes.has(f.keyFile), false);
});

test('Windows torn enrollment refuses create/open before any key generation', async t => {
  const f = await fixture(t);
  f.failWrite(file => file.endsWith('source-vault.enrollment'));
  await assert.rejects(f.create(), code('SOURCE_VAULT_KEY_INVALID'));
  assert.equal(f.nodes.has(f.keyFile), false);
  f.failWrite(null);
  await assert.rejects(f.create(), code('SOURCE_VAULT_NOT_FRESH'));
  await assert.rejects(f.open(), code('SOURCE_VAULT_KEY_INVALID'));
  assert.equal(f.nodes.has(f.keyFile), false);
});

test('Windows missing or changed enrollment refuses live operations and reopen', async t => {
  const f = await fixture(t), vault = await f.create();
  const file = f.options.safetyRoot + '\\source-vault.enrollment';
  const encoded = Buffer.from(f.nodes.get(file).bytes); encoded[encoded.length - 1] ^= 1; f.alter(file, encoded);
  await assert.rejects(vault.put({ projectId: 1, bytes: Buffer.alloc(0) }), code('SOURCE_VAULT_KEY_INVALID'));
  await vault.close();
  await assert.rejects(f.open(), code('SOURCE_VAULT_KEY_INVALID'));
  f.nodes.delete(file);
  await assert.rejects(f.open(), code('SOURCE_VAULT_KEY_MISSING'));
});
