'use strict';

// Native states remain native states: no POSIX permission, inode, or timestamp emulation.
const path = require('node:path');
const { readStorageFile } = require('./windows-storage-files.cjs');

async function openSourceVaultStorage({ windowsBoundary, safetyRoot, sourceRoot, fail,
  sameIdentity, sameFileState, projectArgument, maxBlobBytes }) {
  const sessions = new Map();
  let lost = false;
  const assertLive = () => { if (lost) fail('SOURCE_VAULT_CLOSED'); };
  async function close() {
    lost = true;
    const results = await Promise.allSettled([...sessions.values()].map(session => session.close()));
    if (results.some(result => result.status === 'rejected')) fail('SOURCE_VAULT_IO');
  }
  try {
    for (const root of new Set([path.dirname(safetyRoot), path.dirname(sourceRoot)])) {
      sessions.set(root, await windowsBoundary.openStorage(root, { mode: 'private', onLost: () => { lost = true; } }));
    }
  } catch (error) { await close().catch(() => {}); throw error; }
  function storage(file) {
    assertLive();
    // Most specific retained parent wins if the two trusted parents are nested.
    let selected;
    for (const [root, session] of sessions) {
      const relative = path.relative(root, file);
      if (relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
        if (!selected || root.length > selected.root.length) selected = { root, session };
      }
    }
    if (!selected) fail('SOURCE_VAULT_UNSAFE_PATH');
    return selected.session;
  }
  const statOrMissing = (file, { directory = false } = {}) => storage(file).stat(file, { directory, missing: true });
  async function privateDirectory(file, expected) {
    const state = await storage(file).stat(file, { directory: true });
    if (!state || state.kind !== 'directory' || expected && !sameIdentity(state, expected)) fail('SOURCE_VAULT_UNSAFE_PATH');
    return state;
  }
  async function directoryEmpty(file) {
    for await (const entry of storage(file).entries(file)) return false;
    return true;
  }
  async function ensureDirectory(file) {
    return await statOrMissing(file, { directory: true }) || await storage(file).mkdir(file);
  }
  async function readPrivateFile(file, maximum, missingCode) {
    const state = await statOrMissing(file);
    if (!state) fail(missingCode);
    if (BigInt(state.size) > BigInt(maximum)) fail('SOURCE_VAULT_LIMIT');
    const value = await readStorageFile(storage(file), file, maximum, { expected: state });
    return { bytes: value.bytes, stat: value.state };
  }
  async function scanDirectory(directory, depth, prefix, entries, maximum) {
    const before = await privateDirectory(directory);
    for await (const entry of storage(directory).entries(directory)) {
      if (entries.size >= maximum) fail('SOURCE_VAULT_LIMIT');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (depth < 2) {
        if (!entry.directory) fail('SOURCE_VAULT_UNSAFE_PATH');
        if (depth === 0) {
          try { projectArgument(entry.name); } catch { fail('SOURCE_VAULT_UNSAFE_PATH'); }
        } else if (entry.name.match(/^[a-f0-9]{64}$/)?.[0] !== entry.name) fail('SOURCE_VAULT_UNSAFE_PATH');
        entries.set(relative, await privateDirectory(file));
        await scanDirectory(file, depth + 1, relative, entries, maximum);
      } else {
        if (entry.directory || entry.name !== 'blob.bin') fail('SOURCE_VAULT_UNSAFE_PATH');
        const state = await storage(file).stat(file);
        if (BigInt(state.size) > BigInt(maxBlobBytes)) fail('SOURCE_VAULT_LIMIT');
        entries.set(relative, { kind: 'file', bytes: Number(state.size) });
      }
    }
    if (!sameFileState(before, await privateDirectory(directory, before))) fail('SOURCE_VAULT_UNSAFE_PATH');
  }
  async function scanSourceStore(root, maximum) {
    const entries = new Map();
    await scanDirectory(root, 0, '', entries, maximum);
    let bytes = 0;
    for (const entry of entries.values()) if (entry.kind === 'file') bytes += entry.bytes;
    return { entries, bytes };
  }
  async function writeImmutable(directory, filename, bytes, { previous, fault, kind, checkOwnership }) {
    if (previous) fail('SOURCE_VAULT_MODE');
    const file = path.join(directory, filename), session = storage(file);
    await checkOwnership();
    if (await statOrMissing(file)) fail('SOURCE_VAULT_NOT_FRESH');
    const writer = await session.openWrite(file, { mode: 'create', maxBytes: bytes.length });
    let written;
    try {
      await writer.write(bytes);
      await fault?.(`${kind}:native-written`);
      await checkOwnership();
      written = await writer.commit();
      await fault?.(`${kind}:native-committed`);
    } finally { await writer.close(); }
    // Commit includes flush + exact native readback. Keep a bounded checked read for the
    // caller's AEAD authentication before publication; a failed attempt retains evidence.
    const readback = await readStorageFile(session, file, bytes.length, { expected: written });
    try {
      if (!sameFileState(written, readback.state) || !readback.bytes.equals(bytes)) fail('SOURCE_VAULT_INTEGRITY');
      await checkOwnership();
      return written;
    } finally { readback.bytes.fill(0); }
  }
  return Object.freeze({ assertLive, close, storage, privateDirectory, ensureDirectory, directoryEmpty,
    statOrMissing, readPrivateFile, scanDirectory, scanSourceStore, atomicWrite: writeImmutable,
    mkdir: file => storage(file).mkdir(file), entries: file => storage(file).entries(file),
    // Immutable file commit is the persistence barrier. This is only a namespace/identity check,
    // not a claim that Windows FlushFileBuffers on a directory durably commits its namespace.
    syncDirectory: file => privateDirectory(file) });
}
module.exports = { openSourceVaultStorage };
