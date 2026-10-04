'use strict';

// Scoped backup filesystem bridge. Native states stay tagged and namespace mutation
// requires a state observed by the caller; nothing here equates rename/unlink with commit.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const native = require('./backup-windows-io.cjs');
const MAX_BYTES = 10 * 1024 ** 3 + 1024 ** 2;
const refuse = () => { throw new Error('Backup protected IO refused.'); };
async function createBackupPlatformIO(windowsBoundary, root) {
  const sessions = new Map(), observed = new Map();
  if (root) sessions.set('workspace:' + root, await windowsBoundary.openStorage(root, { mode: 'workspace' }));
  function wrap(state) {
    if (!state) return null;
    return Object.freeze({ ...state, size: BigInt(state.size),
      isDirectory: () => state.kind === 'directory', isFile: () => state.kind === 'file', isSymbolicLink: () => false });
  }
  async function session(file, { directory = false, source = false } = {}) {
    for (const value of sessions.values()) {
      const relative = path.relative(value.root, file);
      if (relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
        if (source || value.mode !== 'source') return value;
      }
    }
    const parent = directory ? file : path.dirname(file);
    const value = await windowsBoundary.openStorage(parent, { mode: source ? 'source' : 'workspace' });
    sessions.set((source ? 'source:' : 'workspace:') + parent, value); return value;
  }
  async function stat(file, { missing = false, directory, source = false } = {}) {
    // Node's type hint grants no authority: native stat verifies the selected kind,
    // complete ancestor chain, identity, reparse/link policy and effective ACL.
    if (directory === undefined) {
      try { directory = (await fs.lstat(file)).isDirectory(); }
      catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    }
    const storage = await session(file, { directory, source });
    const value = await storage.stat(file, { directory, missing });
    if (value) observed.set(file, value);
    return wrap(value);
  }
  async function lstat(file) { const value = await stat(file); if (!value) throw Object.assign(new Error('Missing backup file.'), { code: 'ENOENT' }); return value; }
  async function open(file, flags) {
    const creating = Boolean(flags & constants.O_CREAT);
    const storage = await session(file);
    if (!creating) return native.readHandle(storage, file, MAX_BYTES, observed.get(file));
    if (!(flags & constants.O_EXCL)) refuse();
    const writer = await storage.openWrite(file, { mode: 'create', maxBytes: MAX_BYTES });
    let committed = false, closed = false, offset = 0, finalState;
    observed.set(file, writer.state);
    return {
      async stat() { if (!committed && offset !== 0) refuse(); return committed ? lstat(file) : wrap(writer.state); },
      async write(bytes, start = 0, length = bytes.length - start, position = offset) {
        if (closed || committed || position !== offset) refuse();
        await writer.write(bytes.subarray(start, start + length)); offset += length;
        return { bytesWritten: length };
      },
      async sync() { if (closed) refuse(); if (!committed) { finalState = await writer.commit(); observed.set(file, finalState); committed = true; } },
      async close() { if (!closed) { closed = true; await writer.close(); } },
    };
  }
  async function *entries(file) {
    const storage = await session(file, { directory: true });
    for (const entry of await native.entries(storage, file)) yield { ...entry, isDirectory: () => entry.directory, isFile: () => !entry.directory };
  }
  return Object.freeze({
    lstat, stat, open,
    async realpath(file) { await lstat(file); return file; },
    async mkdir(file) { const storage = await session(file); const value = await storage.mkdir(file, { inherit: true }); observed.set(file, value); },
    async readdir(file) { const result = []; for await (const entry of entries(file)) result.push(entry.name); return result; },
    opendir: async file => entries(file),
    async unlink(file) { const expected = observed.get(file); if (!expected || expected.kind !== 'file') refuse(); await (await session(file)).remove(file, expected); observed.delete(file); },
    async rmdir(file) { const expected = observed.get(file); if (!expected || expected.kind !== 'directory') refuse(); await (await session(file)).remove(file, expected.identity, { directory: true }); observed.delete(file); },
    async syncNamespace(file) { return stat(file, { directory: true }); },
    async capacity(file) { return (await session(file, { directory: true })).capacity(); },
    async openSource(file) { const storage = await session(file, { source: true }); const value = await storage.stat(file); observed.set(file, value); return { stat: wrap(value), handle: await native.readHandle(storage, file, MAX_BYTES, value) }; },
    async close() { let error; for (const value of sessions.values()) try { await value.close(); } catch (cause) { error ||= cause; } sessions.clear(); observed.clear(); if (error) throw error; },
  });
}
module.exports = Object.freeze({ createBackupPlatformIO });
