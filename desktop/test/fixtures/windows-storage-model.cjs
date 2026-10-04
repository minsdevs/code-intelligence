'use strict';

// Protocol model only: does not establish NTFS/ACL, native flush, or power-loss evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function createStorageModel() {
  const files = new Map(); const directories = new Set(['/private', '/private/product']);
  let sequence = 0; let fault; let lost = false; let held = new Set(); const sessions = [];
  const state = (file, bytes, directory = false, previous) => ({ format: 1, platform: 'win32', kind: directory ? 'directory' : 'file',
    identity: previous?.identity || `synthetic-file-${++sequence}`, token: `synthetic-state-${++sequence}`,
    size: String(bytes.length), path: file });
  const boundary = {
    createDirectory(directory) { directories.add(directory); },
    async openStorage(root, options = {}) {
      assert.ok(directories.has(root), 'model root must exist');
      let closed = false;
      const check = () => { if (closed || lost) throw new Error('synthetic session unavailable'); };
      const absolute = name => name ? `${root}/${name.replaceAll('\\', '/')}` : root;
      const session = {
        async stat(name = '', { directory = false, missing = false } = {}) {
          check(); const file = absolute(name);
          if (directory && directories.has(file)) return state(file, Buffer.alloc(0), true);
          if (files.has(file)) { assert.equal(directory, false); return { ...files.get(file).state }; }
          if (missing) return null; throw Object.assign(new Error('synthetic missing'), { code: 'ENOENT' });
        },
        async mkdir(name) { check(); const file = absolute(name); assert.ok(!directories.has(file)); directories.add(file); return state(file, Buffer.alloc(0), true); },
        async *entries(name = '') {
          check(); const prefix = absolute(name) + '/';
          for (const file of new Set([...directories, ...files.keys()])) if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
            yield { name: file.slice(prefix.length), directory: directories.has(file) };
        },
        async openRead(name, { expected, maxBytes }) {
          check(); const file = absolute(name); const entry = files.get(file);
          if (!entry) throw Object.assign(new Error('synthetic missing'), { code: 'ENOENT' });
          if (expected) assert.equal(entry.state.token, expected.token);
          assert.ok(entry.bytes.length <= maxBytes);
          const captured = entry.state.token; let offset = 0;
          return { state: { ...entry.state }, async read(length, position) {
            check(); assert.ok(length <= 1024 * 1024); assert.equal(files.get(file).state.token, captured);
            const start = position ?? offset; const bytes = Buffer.from(entry.bytes.subarray(start, start + length)); offset = start + bytes.length; return bytes;
          }, async close() {} };
        },
        async openWrite(name, { mode, expected, maxBytes }) {
          check(); const file = absolute(name); const old = files.get(file);
          if (mode === 'create') { assert.ok(!old, 'exclusive create'); files.set(file, { bytes: Buffer.alloc(0), state: state(file, Buffer.alloc(0)) }); }
          else { assert.ok(old); assert.equal(expected?.token, old.state.token, 'conditional token'); }
          const chunks = mode === 'append' ? [Buffer.from(old.bytes)] : [];
          return {
            async write(bytes) { check(); chunks.push(Buffer.from(bytes)); },
            async commit() {
              check(); const bytes = Buffer.concat(chunks); assert.ok(bytes.length <= maxBytes);
              const next = { bytes, state: state(file, bytes, false, old?.state || files.get(file)?.state) };
              files.set(file, next);
              await fault?.({ file, mode, entry: next });
              return { ...next.state };
            }, async close() { for (const bytes of chunks) bytes.fill(0); },
          };
        },
        async close() { closed = true; },
        lose() { options.onLost?.(); },
      };
      sessions.push(session); return session;
    },
  };
  const ownerLocks = {};
  const lockModule = { async acquireNativeOwnerLock(provider, { kind }) {
    assert.equal(provider, ownerLocks); assert.ok(!held.has(kind)); held.add(kind); let active = true;
    return { async check() { assert.ok(active && !lost); }, isHeld() { return active && !lost; },
      async release() { active = false; held.delete(kind); } };
  } };
  const load = (name, overrides = {}) => {
    const filename = path.join(__dirname, '../../src', name);
    const module = { exports: {} };
    const requireModel = id => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id === './native-owner-locks.cjs') return lockModule;
      if (id === 'node:fs/promises') return new Proxy({}, { get() { throw new Error('Windows safety path used POSIX IO'); } });
      return require(id.startsWith('./') ? path.resolve(path.dirname(filename), id) : id);
    };
    // Keep the caller's Object prototype: production intentionally rejects cross-realm payloads.
    const execute = vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'process', 'module'], { filename });
    execute(requireModel, { platform: 'win32', pid: process.pid }, module); return module.exports;
  };
  return { boundary, ownerLocks, files, directories, load,
    setFault(value) { fault = value; },
    lose() { lost = true; for (const session of sessions) session.lose(); },
    replace(file, bytes) { const entry = files.get(file); files.set(file, { bytes: Buffer.from(bytes), state: state(file, bytes, false, entry?.state) }); },
  };
}
module.exports = { createStorageModel };
