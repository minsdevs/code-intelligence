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
  const sessions = new Map(), observed = new Map(), destinations = new Map();
  if (root) sessions.set('workspace:' + root, await windowsBoundary.openStorage(root, { mode: 'workspace' }));
  const sameAuthority = (a, b) => native.sameIdentity(a, b) && a.volume === b.volume && a.owner === b.owner;
  function wrap(state) {
    if (!state) return null;
    return Object.freeze({ ...state, size: BigInt(state.size),
      isDirectory: () => state.kind === 'directory', isFile: () => state.kind === 'file', isSymbolicLink: () => false });
  }
  async function session(file, { directory = false, source = false } = {}) {
    for (const value of sessions.values()) {
      // The selected parent grants metadata access to itself, never access to its descendants.
      if (value.mode === 'backup-output') {
        if (file === value.root && directory && !source) return value;
        continue;
      }
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
  async function prepareBackupDestination(selected, name) {
    if (typeof root !== 'string' || typeof selected !== 'string' || typeof name !== 'string' || !/^[A-Za-z]:\\/.test(selected)
        || path.win32.normalize(selected) !== selected || selected === path.win32.parse(selected).root
        || !/^CodeIntelligence-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name)) refuse();
    const relative = path.win32.relative(root, selected);
    if (relative === '' || relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative)) refuse();
    const parentKey = 'backup-output:' + selected, output = path.win32.join(selected, name), childKey = 'workspace:' + output;
    if (sessions.has(parentKey) || sessions.has(childKey) || destinations.has(output)) refuse();
    const parent = await windowsBoundary.openStorage(selected, { mode: 'backup-output' });
    let child, created, closed = false;
    const close = async () => {
      if (closed) return;
      closed = true; sessions.delete(childKey); sessions.delete(parentKey); destinations.delete(output);
      for (const file of observed.keys()) {
        const inside = path.win32.relative(output, file);
        if (file === selected || inside === '' || inside !== '..' && !inside.startsWith('..\\') && !path.win32.isAbsolute(inside)) observed.delete(file);
      }
      let error;
      try { await child?.close(); } catch (cause) { error = cause; }
      try { await parent.close(); } catch (cause) { error ||= cause; }
      if (error) throw error;
    };
    try {
      if (!sameAuthority(parent.rootState, await parent.stat('', { directory: true }))) refuse();
      created = await parent.mkdir(name, { inherit: true });
      child = await windowsBoundary.openStorage(output, { mode: 'workspace' });
      if (!sameAuthority(created, child.rootState)
          || !sameAuthority(parent.rootState, await parent.stat('', { directory: true }))) refuse();
      sessions.set(parentKey, parent); sessions.set(childKey, child);
      observed.set(selected, parent.rootState); observed.set(output, created);
      destinations.set(output, { created, async discard(expected) {
        if (closed || !sameAuthority(expected, created)) refuse();
        await child.close(); child = null; sessions.delete(childKey);
        await parent.discardOutput(created); observed.delete(output);
      }, close });
      return Object.freeze({ root: output, close });
    } catch (error) {
      // Never adopt or erase a replaced child. Native discard requires the exact fresh identity
      // and an empty private directory; any uncertain output is preserved for inspection.
      try { await child?.close(); child = null; if (created) await parent.discardOutput(created); } catch {}
      try { await close(); } catch {}
      throw error;
    }
  }
  return Object.freeze({
    lstat, stat, open, prepareBackupDestination,
    async realpath(file) { await lstat(file); return file; },
    async mkdir(file) { const storage = await session(file); const value = await storage.mkdir(file, { inherit: true }); observed.set(file, value); },
    async readdir(file) { const result = []; for await (const entry of entries(file)) result.push(entry.name); return result; },
    opendir: async file => entries(file),
    async unlink(file) { const expected = observed.get(file); if (!expected || expected.kind !== 'file') refuse(); await (await session(file)).remove(file, expected); observed.delete(file); },
    async rmdir(file) {
      const expected = observed.get(file); if (!expected || expected.kind !== 'directory') refuse();
      const destination = destinations.get(file);
      if (destination) return destination.discard(expected);
      await (await session(file)).remove(file, expected.identity, { directory: true }); observed.delete(file);
    },
    async syncNamespace(file) { return stat(file, { directory: true }); },
    async capacity(file) { return (await session(file, { directory: true })).capacity(); },
    async openSource(file) { const storage = await session(file, { source: true }); const value = await storage.stat(file); observed.set(file, value); return { stat: wrap(value), handle: await native.readHandle(storage, file, MAX_BYTES, value) }; },
    async close() {
      let error;
      for (const value of [...destinations.values()]) try { await value.close(); } catch (cause) { error ||= cause; }
      for (const value of sessions.values()) try { await value.close(); } catch (cause) { error ||= cause; }
      sessions.clear(); observed.clear(); if (error) throw error;
    },
  });
}
module.exports = Object.freeze({ createBackupPlatformIO });
