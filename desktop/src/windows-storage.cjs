'use strict';

const path = require('node:path');
const { runtimeRelativePath } = require('./runtime-platform.cjs');
const CHUNK = 1024 * 1024, HEADER = 256 * 1024;
const STATE_KEYS = ['format', 'platform', 'kind', 'volume', 'fileId', 'owner', 'size', 'allocationSize', 'modified', 'changed', 'identity', 'token'];
function failure() { return Object.assign(new Error('Windows protected storage refused the operation.'), { code: 'WINDOWS_STORAGE_REFUSED' }); }
function requireValue(value) { if (!value) throw failure(); }
function uint(value) { requireValue(Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff); const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function field(value) { const bytes = Buffer.from(value, 'utf8'); requireValue(bytes.toString('utf8') === value && bytes.length <= 16384); return [uint(bytes.length), bytes]; }
function amount(value) { requireValue(Number.isSafeInteger(value) && value >= 0); return field(String(value)); }
function state(value) {
  if (value === null) return null;
  requireValue(value && Object.keys(value).length === STATE_KEYS.length && STATE_KEYS.every(key => Object.hasOwn(value, key)));
  requireValue(value.format === 1 && value.platform === 'win32' && ['file', 'directory'].includes(value.kind)
    && /^\d+$/.test(value.volume) && /^\d+:\d+$/.test(value.fileId) && /^S-1-(?:\d+-)*\d+$/.test(value.owner));
  for (const key of ['size', 'allocationSize', 'modified', 'changed']) requireValue(typeof value[key] === 'string' && /^(?:0|[1-9]\d*)$/.test(value[key]));
  requireValue(BigInt(value.size) <= BigInt(Number.MAX_SAFE_INTEGER));
  requireValue(value.identity === `WI1:${value.volume}:${value.fileId}`
    && value.token === `WS1:${value.volume}:${value.fileId}:${value.size}:${value.allocationSize}:${value.modified}:${value.changed}`);
  return Object.freeze(value);
}
function expectation(value, required = false, full = false) {
  const token = typeof value === 'string' ? value : value?.token;
  requireValue(!required || typeof token === 'string');
  if (token === undefined || token === null) return '';
  requireValue(typeof token === 'string' && (full ? /^WS1:(?:\d+:){6}\d+$/ : /^(?:WI1:\d+:\d+:\d+|WS1:(?:\d+:){6}\d+)$/).test(token));
  return token;
}

async function openWindowsStorage(boundary, root, options = {}) {
  requireValue(process.platform === 'win32' && boundary && typeof boundary.launch === 'function');
  requireValue(typeof root === 'string' && /^[A-Za-z]:\\/.test(root) && path.win32.normalize(root) === root && !root.endsWith('\\'));
  requireValue(Object.keys(options).every(key => ['mode', 'onLost', 'timeoutMs'].includes(key)));
  const mode = options.mode ?? 'private', timeoutMs = options.timeoutMs ?? 15000;
  requireValue(['private', 'workspace', 'source'].includes(mode) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);
  requireValue(options.onLost === undefined || typeof options.onLost === 'function');
  function relative(file, allowRoot = false) {
    requireValue(typeof file === 'string');
    let value = path.win32.isAbsolute(file) ? path.win32.relative(root, file) : file;
    value = value.replaceAll('\\', '/');
    if (!value && allowRoot) return '';
    return runtimeRelativePath(value, 'protected storage member', 'win32');
  }
  const child = boundary.launch('storage');
  let pending, accumulated = Buffer.alloc(0), metadata, sequence = 0, failed = false, closing = false, closed = false;
  let chain = Promise.resolve(), resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const handles = new Set();
  function lose() {
    if (failed) return;
    failed = true; accumulated.fill(0); accumulated = Buffer.alloc(0);
    const current = pending; pending = null;
    if (current) { clearTimeout(current.timer); current.reject(failure()); }
    try { if (!closing) options.onLost?.(); } catch { /* Ownership is already lost. */ }
    if (!closed) child.kill();
  }
  child.once('error', lose); child.stdin.on('error', lose);
  child.stderr.on('data', lose);
  child.once('close', (code, signal) => {
    closed = true; resolveExit({ code, signal });
    if (!closing || pending || code !== 0 || signal) lose();
  });
  child.stdout.on('data', chunk => {
    try {
      requireValue(!failed && pending && accumulated.length + chunk.length <= HEADER + CHUNK + 4);
      accumulated = accumulated.length ? Buffer.concat([accumulated, chunk]) : chunk;
      if (!metadata) {
        if (accumulated.length < 4) return;
        const length = accumulated.readUInt32BE(0); requireValue(length > 0 && length <= HEADER);
        if (accumulated.length < length + 4) return;
        const encoded = accumulated.subarray(4, length + 4);
        metadata = JSON.parse(encoded.toString('utf8')); requireValue(metadata && metadata.seq === pending.seq);
        accumulated = Buffer.from(accumulated.subarray(length + 4));
        const count = metadata.bytes ?? 0; requireValue(Number.isSafeInteger(count) && count >= 0 && count <= CHUNK);
      }
      const count = metadata.bytes ?? 0;
      if (accumulated.length < count) return;
      requireValue(accumulated.length === count);
      const reply = metadata; if (count || Object.hasOwn(reply, 'bytes')) reply.data = accumulated;
      else accumulated.fill(0);
      metadata = null; accumulated = Buffer.alloc(0);
      const current = pending; pending = null; clearTimeout(current.timer); current.resolve(reply);
    } catch { lose(); }
  });
  function response(seq) {
    requireValue(!failed && !closed && !pending);
    return new Promise((resolve, reject) => { pending = { seq, resolve, reject, timer: setTimeout(lose, timeoutMs) }; });
  }
  function send(parts) { for (const bytes of parts) { requireValue(!failed && !closed); child.stdin.write(bytes); } }
  const ready = response(0);
  try { send([...field(root), ...field(mode)]); } catch { lose(); }
  let rootState;
  try { rootState = state((await ready).state); requireValue(rootState?.kind === 'directory'); }
  catch { lose(); await exited; throw failure(); }
  function request(operation, parts = []) {
    const execute = async () => {
      requireValue(!failed && !closed && sequence < 0xffffffff);
      const seq = ++sequence, reply = response(seq);
      try { send([...field(operation), uint(seq), ...parts]); } catch { lose(); }
      return reply;
    };
    const result = chain.then(execute); chain = result.catch(() => {}); return result;
  }
  async function open(file, selectedMode, { expected, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
    requireValue(['read', 'directory', 'create', 'append', 'slot'].includes(selectedMode));
    const writing = ['create', 'append', 'slot'].includes(selectedMode);
    requireValue(!writing || mode !== 'source');
    requireValue(selectedMode !== 'create' || expected === undefined || expected === null);
    const proof = expectation(expected, writing && selectedMode !== 'create', writing && selectedMode !== 'create');
    const reply = await request('open', [...field(relative(file, !writing)), ...field(selectedMode), ...field(proof), ...amount(maxBytes)]);
    requireValue(Number.isSafeInteger(reply.handle) && reply.handle > 0);
    let active = true, offset = 0; const initial = state(reply.state), id = reply.handle;
    const handle = Object.freeze({
      state: initial,
      async read(length = CHUNK, position = offset) {
        requireValue(active && selectedMode === 'read' && Number.isSafeInteger(length) && length > 0 && length <= CHUNK);
        const result = await request('read', [uint(id), ...amount(position), uint(length)]);
        requireValue(Buffer.isBuffer(result.data) && result.data.length === result.bytes);
        offset = position + result.bytes; return result.data;
      },
      async write(bytes) {
        requireValue(active && writing && Buffer.isBuffer(bytes));
        for (let start = 0; start < bytes.length; start += CHUNK) {
          const chunk = bytes.subarray(start, Math.min(start + CHUNK, bytes.length));
          await request('write', [uint(id), uint(chunk.length), chunk]);
        }
      },
      async next() {
        requireValue(active && selectedMode === 'directory');
        const result = await request('next', [uint(id)]);
        requireValue(Array.isArray(result.entries) && result.entries.length <= 1024 && typeof result.end === 'boolean');
        for (const item of result.entries) requireValue(item && Object.keys(item).length === 2 && typeof item.name === 'string'
          && item.name.length > 0 && !/[\\/\0]/.test(item.name) && !['.', '..'].includes(item.name) && typeof item.directory === 'boolean');
        return { entries: result.entries, end: result.end };
      },
      async commit() {
        requireValue(active && writing); const result = state((await request('commit', [uint(id)])).state);
        active = false; handles.delete(handle); return result;
      },
      async close() {
        if (!active) return; active = false; handles.delete(handle);
        if (!failed && !closed) await request('release', [uint(id)]);
      },
    });
    handles.add(handle); return handle;
  }
  return Object.freeze({
    root, mode, rootState,
    async lock(file, marker) {
      requireValue(mode !== 'source' && Buffer.isBuffer(marker) && marker.length > 0 && marker.length <= 4096);
      const reply = await request('lock', [...field(relative(file)), uint(marker.length), marker]);
      requireValue(Number.isSafeInteger(reply.handle) && reply.handle > 0);
      let active = true; const id = reply.handle;
      const lock = Object.freeze({ state: state(reply.state),
        async check() { requireValue(active); return state((await request('check-lock', [uint(id)])).state); },
        async close() { if (!active) return; active = false; handles.delete(lock); if (!failed && !closed) await request('release', [uint(id)]); },
      });
      handles.add(lock); return lock;
    },
    async stat(file = '', { directory = false, missing = false } = {}) {
      return state((await request('stat', [...field(relative(file, true)), uint(directory ? 1 : 0), uint(missing ? 1 : 0)])).state);
    },
    async mkdir(file, { inherit = false } = {}) {
      requireValue(mode !== 'source'); return state((await request('mkdir', [...field(relative(file)), uint(inherit ? 1 : 0)])).state);
    },
    openRead: (file, options) => open(file, 'read', options),
    openWrite: (file, { mode: selectedMode = 'create', ...options } = {}) => open(file, selectedMode, options),
    async *entries(file = '') {
      const directory = await open(file, 'directory');
      try { for (;;) { const page = await directory.next(); for (const entry of page.entries) yield entry; if (page.end) break; } }
      finally { await directory.close(); }
    },
    async remove(file, expected, { directory = false } = {}) {
      requireValue(mode !== 'source'); await request('remove', [...field(relative(file)), uint(directory ? 1 : 0), ...field(expectation(expected, true))]);
    },
    async rename(from, to, expected, { directory = false } = {}) {
      requireValue(mode !== 'source'); return state((await request('rename', [...field(relative(from)), uint(directory ? 1 : 0),
        ...field(expectation(expected, true)), ...field(relative(to))])).state);
    },
    async capacity() {
      const result = await request('capacity'); requireValue(/^\d+$/.test(result.available) && /^\d+$/.test(result.total));
      return { available: BigInt(result.available), total: BigInt(result.total) };
    },
    async close() {
      if (closed) { if (failed) throw failure(); return; }
      if (closing) { await exited; if (failed) throw failure(); return; }
      closing = true;
      try {
        for (const handle of [...handles]) await handle.close();
        await request('close'); child.stdin.end();
        const timer = setTimeout(lose, timeoutMs);
        try { const result = await exited; requireValue(!failed && result.code === 0 && !result.signal); }
        finally { clearTimeout(timer); }
      } catch { lose(); await exited; throw failure(); }
    },
  });
}
module.exports = Object.freeze({ openWindowsStorage, WINDOWS_STORAGE_CHUNK: CHUNK });
