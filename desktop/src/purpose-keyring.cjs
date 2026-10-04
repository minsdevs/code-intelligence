'use strict';

// Trusted main-process library. Never expose this object or its key copies to IPC, env, or workers.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { acquireNativeOwnerLock } = require('./native-owner-locks.cjs');
const { openAuthenticatedState } = require('./windows-authenticated-state.cjs');

const FORMAT = 'code-intelligence-purpose-keyring';
const MAJOR = 1;
const PURPOSES = Object.freeze(['backup', 'safety']);
const KEY_ID = /^[a-f0-9]{32}$/;
const INSTALLATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FILENAME = 'purpose-keyring.wrapped';
const DEFAULT_LIMITS = Object.freeze({ keysPerPurpose: 64, keyringBytes: 32768,
  wrappedBytes: 65536, pendingOperations: 16 });
const MESSAGES = Object.freeze({
  PURPOSE_KEYRING_ARGUMENT: 'Invalid purpose keyring argument.',
  PURPOSE_KEYRING_UNSUPPORTED: 'Purpose keyring format or platform is unsupported.',
  PURPOSE_KEYRING_UNSAFE_PATH: 'Purpose keyring path identity or permissions are unsafe.',
  PURPOSE_KEYRING_LOCKED: 'Purpose keyring ownership requires recovery or another owner to close.',
  PURPOSE_KEYRING_NOT_FRESH: 'Purpose keyring initialization requires fresh key state.',
  PURPOSE_KEYRING_MISSING: 'Required purpose keys are missing; do not replace them.',
  PURPOSE_KEYRING_INVALID: 'Purpose keyring integrity or binding cannot be validated.',
  PURPOSE_KEYRING_WRAPPING_UNAVAILABLE: 'Secure purpose key wrapping is unavailable.',
  PURPOSE_KEYRING_CAPACITY: 'Purpose keyring capacity was reached.',
  PURPOSE_KEYRING_CLOSED: 'Purpose keyring is closed or requires reopening after a failed operation.',
  PURPOSE_KEYRING_IO: 'Purpose keyring operation failed; no successful publication is acknowledged.',
});

class PurposeKeyringError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'PURPOSE_KEYRING_IO';
    super(MESSAGES[safeCode]);
    this.name = 'PurposeKeyringError';
    this.code = safeCode;
  }
}
function fail(code) { throw new PurposeKeyringError(code); }
function safeError(error) {
  return new PurposeKeyringError(error instanceof PurposeKeyringError ? error.code : 'PURPOSE_KEYRING_IO');
}
function exact(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function purpose(value) {
  if (!PURPOSES.includes(value)) fail('PURPOSE_KEYRING_ARGUMENT');
  return value;
}
function keyId(value) {
  if (typeof value !== 'string' || value.length !== 32 || !KEY_ID.test(value)) fail('PURPOSE_KEYRING_ARGUMENT');
  return value;
}
function rootArgument(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')
      || Buffer.byteLength(value) > 4096 || path.resolve(value) !== value
      || path.parse(value).root === value) fail('PURPOSE_KEYRING_ARGUMENT');
  return value;
}
function overlaps(a, b) { return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`); }
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameState(a, b) {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function checkPrivate(stat, directory) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
      || (!directory && stat.nlink !== 1n)) fail('PURPOSE_KEYRING_UNSAFE_PATH');
}
async function statOrMissing(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// No mutable symlink ancestors are accepted. These are pathname checks, not native openat confinement.
async function pathChain(directory, allowMissing = false) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await statOrMissing(current);
    if (!stat) {
      if (allowMissing) return;
      fail('PURPOSE_KEYRING_MISSING');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PURPOSE_KEYRING_UNSAFE_PATH');
    if (await fs.realpath(current) !== current) fail('PURPOSE_KEYRING_UNSAFE_PATH');
  }
}
async function privateDirectory(directory, expected) {
  await pathChain(directory);
  const stat = await fs.lstat(directory, { bigint: true });
  checkPrivate(stat, true);
  if (expected && !sameIdentity(stat, expected)) fail('PURPOSE_KEYRING_UNSAFE_PATH');
  return stat;
}
async function syncDirectory(directory, expected) {
  const before = await privateDirectory(directory, expected);
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    checkPrivate(opened, true);
    if (!sameIdentity(opened, before)) fail('PURPOSE_KEYRING_UNSAFE_PATH');
    await handle.sync();
    await privateDirectory(directory, before);
  } finally { await handle.close(); }
}
async function ensureDirectory(directory) {
  await privateDirectory(path.dirname(directory));
  let created = false;
  try { await fs.mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await privateDirectory(directory);
  if (created) await syncDirectory(path.dirname(directory));
  return stat;
}
async function readPrivateFile(file, maximum) {
  await privateDirectory(path.dirname(file));
  const before = await statOrMissing(file);
  if (!before) fail('PURPOSE_KEYRING_MISSING');
  checkPrivate(before, false);
  if (before.size < 1n || before.size > BigInt(maximum)) fail('PURPOSE_KEYRING_CAPACITY');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    checkPrivate(opened, false);
    if (!sameState(opened, before)) fail('PURPOSE_KEYRING_UNSAFE_PATH');
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail('PURPOSE_KEYRING_INVALID');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(file, { bigint: true });
    checkPrivate(after, false); checkPrivate(current, false);
    if (!sameState(opened, after) || !sameState(after, current)) fail('PURPOSE_KEYRING_UNSAFE_PATH');
    return { bytes, stat: after };
  } catch (error) { bytes?.fill(0); throw error; }
  finally { await handle.close(); }
}
async function unlinkOwned(file, expected) {
  const current = await statOrMissing(file);
  if (!current) fail('PURPOSE_KEYRING_UNSAFE_PATH');
  checkPrivate(current, false);
  if (!sameIdentity(current, expected)) fail('PURPOSE_KEYRING_UNSAFE_PATH');
  await fs.unlink(file);
}
async function acquireLock(directory, directoryStat) {
  const file = path.join(directory, 'owner.lock');
  let handle;
  try { handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST' || error.code === 'ELOOP') fail('PURPOSE_KEYRING_LOCKED'); throw error; }
  let stat;
  try {
    stat = await handle.stat({ bigint: true }); checkPrivate(stat, false);
    await handle.writeFile(JSON.stringify({ major: MAJOR, pid: process.pid, owner: crypto.randomBytes(16).toString('hex') }));
    await handle.sync();
    await syncDirectory(directory, directoryStat);
    const written = await handle.stat({ bigint: true });
    return {
      async check() {
        await privateDirectory(directory, directoryStat);
        const current = await statOrMissing(file);
        if (!current) fail('PURPOSE_KEYRING_LOCKED');
        checkPrivate(current, false);
        if (!sameState(current, written)) fail('PURPOSE_KEYRING_LOCKED');
      },
      async release() {
        try {
          await this.check();
          await unlinkOwned(file, written);
          await syncDirectory(directory, directoryStat);
        } finally { await handle.close(); }
      },
    };
  } catch (error) {
    await handle.close().catch(() => {});
    if (stat) await unlinkOwned(file, stat).catch(() => {});
    throw error;
  }
}
async function checkContents(directory, initialized) {
  const stream = await fs.opendir(directory);
  let count = 0;
  try {
    for await (const entry of stream) {
      count += 1;
      if (count > 2 || (entry.name !== 'owner.lock' && (entry.name !== FILENAME || !initialized)))
        fail(initialized ? 'PURPOSE_KEYRING_INVALID' : 'PURPOSE_KEYRING_NOT_FRESH');
    }
  } finally { await stream.close().catch(() => {}); }
}
async function atomicWrite(directory, filename, bytes, previous, fault, checkOwnership) {
  const target = path.join(directory, filename);
  const temporary = path.join(directory, `.pending-${crypto.randomBytes(16).toString('hex')}`);
  const directoryStat = await privateDirectory(directory);
  let handle; let temporaryStat; let renamed = false;
  try {
    await checkOwnership();
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryStat = await handle.stat({ bigint: true }); checkPrivate(temporaryStat, false);
    await handle.writeFile(bytes);
    await fault?.('keyring:temp-written');
    await handle.sync();
    await fault?.('keyring:file-synced');
    const written = await handle.stat({ bigint: true }); checkPrivate(written, false);
    if (written.size !== BigInt(bytes.length)) fail('PURPOSE_KEYRING_IO');
    await handle.close(); handle = null;
    await privateDirectory(directory, directoryStat);
    await fault?.('keyring:before-rename');
    await checkOwnership();
    const staged = await fs.lstat(temporary, { bigint: true }); checkPrivate(staged, false);
    if (!sameState(staged, written)) fail('PURPOSE_KEYRING_UNSAFE_PATH');
    const current = await statOrMissing(target);
    if (previous) {
      if (!current) fail('PURPOSE_KEYRING_MISSING');
      checkPrivate(current, false);
      if (!sameState(current, previous)) fail('PURPOSE_KEYRING_INVALID');
    } else if (current) fail('PURPOSE_KEYRING_NOT_FRESH');
    await fs.rename(temporary, target); renamed = true;
    await fault?.('keyring:renamed');
    await syncDirectory(directory, directoryStat);
    await fault?.('keyring:directory-synced');
    await checkOwnership();
    const committed = await readPrivateFile(target, bytes.length);
    try {
      if (!sameIdentity(committed.stat, written) || !committed.bytes.equals(bytes)) fail('PURPOSE_KEYRING_INVALID');
      return committed.stat;
    } finally { committed.bytes.fill(0); }
  } finally {
    if (handle) await handle.close();
    if (!renamed && temporaryStat) await unlinkOwned(temporary, temporaryStat);
  }
}

function clearKeys(keys) { if (keys) for (const map of keys.values()) for (const key of map.values()) key.fill(0); }
function encode(installationId, keys) {
  return Buffer.from(JSON.stringify({ format: FORMAT, major: MAJOR, installationId,
    revision: [...keys.values()].reduce((n, map) => n + map.size, 0),
    purposes: PURPOSES.map(name => ({ purpose: name, revision: keys.get(name).size,
      activeKeyId: [...keys.get(name).keys()].at(-1),
      keys: [...keys.get(name)].map(([id, material]) => ({ keyId: id, material: material.toString('base64') })),
    })),
  }), 'utf8');
}
function parse(bytes, installationId, limits) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limits.keyringBytes) fail('PURPOSE_KEYRING_INVALID');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('PURPOSE_KEYRING_INVALID'); }
  if (value?.major !== MAJOR) fail('PURPOSE_KEYRING_UNSUPPORTED');
  if (!exact(value, ['format', 'major', 'installationId', 'revision', 'purposes']) || value.format !== FORMAT
      || value.installationId !== installationId || !Array.isArray(value.purposes)
      || value.purposes.length !== 2) fail('PURPOSE_KEYRING_INVALID');
  const keys = new Map(); const ids = new Set(); const materials = new Set();
  try {
    for (const [index, group] of value.purposes.entries()) {
      if (!exact(group, ['purpose', 'revision', 'activeKeyId', 'keys']) || group.purpose !== PURPOSES[index]
          || !Array.isArray(group.keys) || !group.keys.length || group.keys.length > limits.keysPerPurpose
          || group.revision !== group.keys.length) fail('PURPOSE_KEYRING_INVALID');
      const map = new Map(); keys.set(group.purpose, map);
      for (const entry of group.keys) {
        if (!exact(entry, ['keyId', 'material']) || typeof entry.keyId !== 'string'
            || entry.keyId.length !== 32 || !KEY_ID.test(entry.keyId) || ids.has(entry.keyId)
            || typeof entry.material !== 'string' || entry.material.length !== 44 || materials.has(entry.material))
          fail('PURPOSE_KEYRING_INVALID');
        const material = Buffer.from(entry.material, 'base64');
        if (material.length !== 32 || material.toString('base64') !== entry.material) {
          material.fill(0); fail('PURPOSE_KEYRING_INVALID');
        }
        ids.add(entry.keyId); materials.add(entry.material); map.set(entry.keyId, material);
        if (group.activeKeyId !== group.keys.at(-1).keyId) fail('PURPOSE_KEYRING_INVALID');
      }
    }
    const canonical = encode(installationId, keys);
    try { if (!canonical.equals(bytes)) fail('PURPOSE_KEYRING_INVALID'); }
    finally { canonical.fill(0); }
    return keys;
  } catch (error) { clearKeys(keys); throw error; }
}
function addKey(keys, selected) {
  // Reject the astronomically unlikely RNG collision instead of reusing a key across purposes.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = crypto.randomBytes(16).toString('hex'); const material = crypto.randomBytes(32);
    if ([...keys.values()].every(map => !map.has(id) && [...map.values()].every(old => !old.equals(material)))) {
      keys.get(selected).set(id, material); return id;
    }
    material.fill(0);
  }
  fail('PURPOSE_KEYRING_IO');
}
async function available(wrapper) {
  try { if (await wrapper.isAvailable() !== true) fail('PURPOSE_KEYRING_WRAPPING_UNAVAILABLE'); }
  catch { fail('PURPOSE_KEYRING_WRAPPING_UNAVAILABLE'); }
}
async function wrap(keys, installationId, wrapper, limits) {
  const plaintext = encode(installationId, keys);
  let wrapped; let verification;
  try {
    if (plaintext.length > limits.keyringBytes) fail('PURPOSE_KEYRING_CAPACITY');
    await available(wrapper);
    const provided = await wrapper.wrap(plaintext);
    if (!Buffer.isBuffer(provided) || !provided.length || provided.length > limits.wrappedBytes
        || provided.equals(plaintext)) fail('PURPOSE_KEYRING_INVALID');
    wrapped = Buffer.from(provided);
    // Refuse to publish an unreadable wrapper result, even when wrapping appeared to succeed.
    verification = await wrapper.unwrap(Buffer.from(wrapped));
    if (!Buffer.isBuffer(verification) || !verification.equals(plaintext)) fail('PURPOSE_KEYRING_INVALID');
    return wrapped;
  } catch (error) {
    wrapped?.fill(0);
    if (error instanceof PurposeKeyringError) throw error;
    fail('PURPOSE_KEYRING_WRAPPING_UNAVAILABLE');
  } finally { plaintext.fill(0); if (Buffer.isBuffer(verification)) verification.fill(0); }
}
async function load(file, installationId, wrapper, limits) {
  const wrapped = await readPrivateFile(file, limits.wrappedBytes);
  let plaintext;
  try {
    plaintext = await wrapper.unwrap(wrapped.bytes);
    return { keys: parse(plaintext, installationId, limits), stat: wrapped.stat };
  } catch (error) {
    if (error instanceof PurposeKeyringError) throw error;
    fail('PURPOSE_KEYRING_INVALID');
  } finally { wrapped.bytes.fill(0); if (Buffer.isBuffer(plaintext)) plaintext.fill(0); }
}

async function prepare(options, fresh) {
  let lock; let keys; let storage; let stateStore; let enrollment;
  const restoreSessions = new Map();
  try {
    const windows = process.platform === 'win32';
    if (!windows && (typeof process.getuid !== 'function' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY))
      fail('PURPOSE_KEYRING_UNSUPPORTED');
    if (!options || typeof options !== 'object') fail('PURPOSE_KEYRING_ARGUMENT');
    const safetyRoot = rootArgument(options.safetyRoot);
    const { installationId, fault, ownerLocks } = options;
    if (windows && (!options.windowsBoundary || ownerLocks === undefined)) fail('PURPOSE_KEYRING_UNSUPPORTED');
    if (typeof installationId !== 'string' || installationId.match(INSTALLATION_ID)?.[0] !== installationId
        || !options.wrapper || !['isAvailable', 'wrap', 'unwrap'].every(name => typeof options.wrapper[name] === 'function')
        || (fault !== undefined && typeof fault !== 'function')) fail('PURPOSE_KEYRING_ARGUMENT');
    const wrapper = Object.freeze(Object.fromEntries(['isAvailable', 'wrap', 'unwrap']
      .map(name => [name, options.wrapper[name].bind(options.wrapper)])));
    if (options.limits !== undefined && (!options.limits || typeof options.limits !== 'object' || Array.isArray(options.limits)))
      fail('PURPOSE_KEYRING_ARGUMENT');
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const [name, value] of Object.entries(limits)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, name) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[name])
        fail('PURPOSE_KEYRING_ARGUMENT');
    }
    if (!Array.isArray(options.restoreRoots) || !options.restoreRoots.length || options.restoreRoots.length > 32)
      fail('PURPOSE_KEYRING_ARGUMENT');
    const restoreRoots = options.restoreRoots.map(rootArgument);
    for (const root of restoreRoots) {
      if (overlaps(safetyRoot, root)) fail('PURPOSE_KEYRING_UNSAFE_PATH');
      if (!windows) await pathChain(root, true);
      else {
        const parent = path.dirname(root);
        if (!restoreSessions.has(parent)) restoreSessions.set(parent, await options.windowsBoundary.openStorage(parent, { mode: 'source' }));
        await restoreSessions.get(parent).stat(path.basename(root), { directory: true, missing: true });
      }
    }
    await available(wrapper);
    if (!windows) await privateDirectory(path.dirname(safetyRoot));
    if (windows && fresh) {
      const parent = await options.windowsBoundary.openStorage(path.dirname(safetyRoot));
      try { if (!await parent.stat(path.basename(safetyRoot), { directory: true, missing: true })) await parent.mkdir(path.basename(safetyRoot)); }
      finally { await parent.close(); }
    }
    const safetyStat = windows ? null : fresh ? await ensureDirectory(safetyRoot) : await privateDirectory(safetyRoot);
    if (windows) storage = await options.windowsBoundary.openStorage(safetyRoot);
    if (windows) enrollment = await openAuthenticatedState({ storage, file: 'purpose-keyring.enrollment',
      installationId, purpose: 'purpose-keyring-enrollment', mode: 'append', fresh,
      initialValue: Buffer.from([1]), seal: wrapper.wrap, unseal: wrapper.unwrap,
      maxPayloadBytes: 1, maxEncodedBytes: 16384, maxRecords: 1 });
    const directory = path.join(safetyRoot, 'purpose-keyring');
    if (fresh) {
      try { if (windows) await storage.mkdir('purpose-keyring'); else await fs.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') fail('PURPOSE_KEYRING_NOT_FRESH'); throw error; }
      // This marker is never removed after failed initialization; missing keys require explicit recovery.
      if (!windows) await syncDirectory(safetyRoot, safetyStat);
    }
    const directoryStat = windows ? await storage.stat('purpose-keyring', { directory: true }) : await privateDirectory(directory);
    if (ownerLocks !== undefined) {
      try {
        const native = await acquireNativeOwnerLock(ownerLocks, { safetyRoot, kind: 'purpose-keyring', installationId });
        lock = Object.freeze(Object.fromEntries(['check', 'release'].map(name => [name, async () => {
          try { await native[name](); } catch { fail('PURPOSE_KEYRING_LOCKED'); }
        }])));
      } catch { fail('PURPOSE_KEYRING_LOCKED'); }
    } else lock = await acquireLock(directory, directoryStat);
    const contents = async initialized => {
      if (!windows) return checkContents(directory, initialized);
      let count = 0;
      for await (const entry of storage.entries('purpose-keyring')) {
        if (++count > 2 || (entry.name !== 'owner.lock' && (entry.name !== FILENAME || !initialized)))
          fail(initialized ? 'PURPOSE_KEYRING_INVALID' : 'PURPOSE_KEYRING_NOT_FRESH');
      }
    };
    await contents(!fresh);
    const file = path.join(directory, FILENAME);
    let fileStat;
    if (windows) {
      let initial;
      if (fresh) {
        keys = new Map(PURPOSES.map(name => [name, new Map()]));
        for (const name of PURPOSES) addKey(keys, name);
        initial = encode(installationId, keys);
      }
      try {
        stateStore = await openAuthenticatedState({ storage, file: 'purpose-keyring/' + FILENAME,
          installationId, purpose: 'purpose-keyring', mode: 'append', fresh, initialValue: initial,
          seal: wrapper.wrap, unseal: wrapper.unwrap, maxPayloadBytes: limits.keyringBytes,
          maxEncodedBytes: limits.wrappedBytes, maxRecords: limits.keysPerPurpose * PURPOSES.length - 1 });
        if (!fresh) { const plain = await stateStore.read(); try { keys = parse(plain, installationId, limits); } finally { plain.fill(0); } }
      } finally { initial?.fill(0); }
    } else if (fresh) {
      keys = new Map(PURPOSES.map(name => [name, new Map()]));
      for (const name of PURPOSES) addKey(keys, name);
      const wrapped = await wrap(keys, installationId, wrapper, limits);
      try { fileStat = await atomicWrite(directory, FILENAME, wrapped, null, fault, () => lock.check()); }
      finally { wrapped.fill(0); }
    } else ({ keys, stat: fileStat } = await load(file, installationId, wrapper, limits));

    let poisoned = false; let closing = false; let closed = false; let pending = 0;
    let queue = Promise.resolve(); let closePromise;
    const ensureUsable = () => { if (poisoned || closing || closed) fail('PURPOSE_KEYRING_CLOSED'); };
    const verify = async () => {
      if (windows) {
        await lock.check(); await contents(true);
        for (const root of restoreRoots) await restoreSessions.get(path.dirname(root)).stat(path.basename(root), { directory: true, missing: true });
        const proof = await enrollment.read();
        try { if (proof.length !== 1 || proof[0] !== 1) fail('PURPOSE_KEYRING_INVALID'); } finally { proof.fill(0); }
        const plain = await stateStore.read();
        try { const verified = parse(plain, installationId, limits); clearKeys(verified); } finally { plain.fill(0); }
        await available(wrapper); await lock.check(); return;
      }
      await privateDirectory(safetyRoot, safetyStat);
      await privateDirectory(directory, directoryStat);
      for (const root of restoreRoots) await pathChain(root, true);
      await lock.check();
      await checkContents(directory, true);
      const current = await statOrMissing(file);
      if (!current) fail('PURPOSE_KEYRING_MISSING');
      checkPrivate(current, false);
      if (!sameState(current, fileStat)) fail('PURPOSE_KEYRING_INVALID');
      await available(wrapper);
      await lock.check();
    };
    // Check roots/file/lock again after first publication/loading, before exposing any keys.
    await verify();
    const enqueue = operation => {
      try {
        ensureUsable();
        if (pending >= limits.pendingOperations) fail('PURPOSE_KEYRING_CAPACITY');
      } catch (error) { return Promise.reject(safeError(error)); }
      pending += 1;
      const result = queue.then(async () => {
        if (poisoned) fail('PURPOSE_KEYRING_CLOSED');
        try { await verify(); } catch (error) { poisoned = true; throw error; }
        return operation();
      }).catch(error => { throw safeError(error); }).finally(() => { pending -= 1; });
      queue = result.catch(() => {});
      return result;
    };
    const readKey = (id, selected) => {
      try { keyId(id); } catch (error) { return Promise.reject(safeError(error)); }
      return enqueue(() => {
        const key = keys.get(selected).get(id);
        if (!key) fail('PURPOSE_KEYRING_MISSING');
        return Buffer.from(key);
      });
    };
    const keyring = {
      currentKeyId(selected) {
        try { purpose(selected); } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(() => [...keys.get(selected).keys()].at(-1));
      },
      getMacKey(id, selected) {
        if (selected !== 'safety') return Promise.reject(new PurposeKeyringError('PURPOSE_KEYRING_ARGUMENT'));
        return readKey(id, 'safety');
      },
      getBackupKey(id) { return readKey(id, 'backup'); },
      rotate(selected) {
        try { purpose(selected); } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          if (keys.get(selected).size >= limits.keysPerPurpose) fail('PURPOSE_KEYRING_CAPACITY');
          const next = new Map([...keys].map(([name, map]) => [name,
            new Map([...map].map(([id, material]) => [id, Buffer.from(material)]))]));
          try {
            const id = addKey(next, selected);
            const wrapped = windows ? encode(installationId, next) : await wrap(next, installationId, wrapper, limits);
            try {
              if (windows) { await lock.check(); await stateStore.write(wrapped); await lock.check(); }
              else fileStat = await atomicWrite(directory, FILENAME, wrapped, fileStat, fault, () => lock.check());
            } finally { wrapped.fill(0); }
            await verify();
            clearKeys(keys); keys = next;
            return id;
          } catch (error) { poisoned = true; clearKeys(next); throw error; }
        });
      },
      info() {
        return enqueue(() => Object.freeze({ format: FORMAT, major: MAJOR, installationId,
          purposes: Object.freeze(Object.fromEntries(PURPOSES.map(name => [name, Object.freeze({
            revision: keys.get(name).size, activeKeyId: [...keys.get(name).keys()].at(-1),
            keyIds: Object.freeze([...keys.get(name).keys()]),
          })]))), limits: Object.freeze({ ...limits }),
        }));
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = queue.then(async () => {
          closed = true; clearKeys(keys);
          try { await storage?.close(); }
          finally {
            try { await Promise.all([...restoreSessions.values()].map(session => session.close())); }
            finally { await lock.release(); }
          }
        }).catch(error => { throw safeError(error); });
        return closePromise;
      },
    };
    return Object.freeze(keyring);
  } catch (error) {
    clearKeys(keys);
    await storage?.close().catch(() => {});
    await Promise.all([...restoreSessions.values()].map(session => session.close().catch(() => {})));
    if (lock) await lock.release().catch(() => {});
    throw safeError(error);
  }
}

module.exports = Object.freeze({
  initializePurposeKeyring: options => prepare(options, true),
  openPurposeKeyring: options => prepare(options, false),
  PurposeKeyringError,
});
