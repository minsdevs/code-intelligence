'use strict';

// Main-only fixed JAR launcher. Source, paths and archive records never become argv or environment.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder, types: { isProxy } } = require('node:util');

const LIMITS = Object.freeze({ frameBytes: 16 * 1024 * 1024, objectBytes: 2 * 1024 * 1024,
  objects: 200000, objectBytesTotal: 10 * 1024 ** 3, stderrBytes: 64 * 1024,
  wireBytes: Math.ceil(10 * 1024 ** 3 * 4 / 3) + 200000 * 1024 + 32 * 1024 * 1024,
  timeoutMs: 180000, killGraceMs: 1000 });
const SYSTEM_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME'];
const RECEIPT = ['selectionSha256', 'objectCount', 'totalObjectBytes', 'objectsSha256'];
const OBJECT = ['version', 'kind', 'objectType', 'gitOid', 'rawSha256', 'byteSize', 'bytesBase64'];
const RETAINED = ['snapshotId', 'commitOid', 'commitEpochSecond', 'policyVersion', 'limitsSha256',
  'manifestSha256', 'fileCount', 'totalBytes', 'entries'];
const CODES = new Set(['INVALID', 'CLOSED', 'BUSY', 'BINARY_CHANGED', 'PROCESS', 'PROTOCOL', 'INTEGRITY',
  'LIMIT', 'TIMEOUT', 'TERMINATION', 'SINK', 'SOURCE_ARGUMENT_INVALID', 'SOURCE_PROTOCOL_INVALID',
  'SOURCE_SELECTION_INVALID', 'SOURCE_UNSAFE_PATH', 'SOURCE_UNSUPPORTED_MODE', 'SOURCE_UNSUPPORTED_ENCODING',
  'SOURCE_SECRET_DETECTED', 'SOURCE_MISSING', 'SOURCE_CHANGED', 'SOURCE_LIMIT', 'SOURCE_INTEGRITY', 'SOURCE_FAILURE']);
class BackupSourceWorkerError extends Error {
  constructor(code = 'PROCESS') {
    const safe = CODES.has(code) ? code : 'PROCESS';
    super(`Backup source worker: ${safe}`); this.name = 'BackupSourceWorkerError'; this.code = `BACKUP_SOURCE_${safe}`;
  }
}
const error = code => new BackupSourceWorkerError(code);
function fail(code) { throw error(code); }
function plain(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (!Object.hasOwn(descriptor, 'value')) fail('INVALID');
}
function exact(value, keys) {
  plain(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID');
}
function full(value, pattern) { return typeof value === 'string' && value.match(pattern)?.[0] === value; }
function number(value, maximum) { if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('LIMIT'); return value; }
function id(value) { if (!full(value, /^[1-9][0-9]{0,18}$/) || BigInt(value) > 9223372036854775807n) fail('INVALID'); return value; }
function hex(value, length) { if (!full(value, new RegExp(`^[0-9a-f]{${length}}$`))) fail('INVALID'); return value; }
function absolute(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')
      || !path.isAbsolute(value) || path.normalize(value) !== value) fail('INVALID');
  return value;
}
function textPath(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 8192
      || value !== Buffer.from(value).toString('utf8') || value.normalize('NFC') !== value
      || /[\\:\x00-\x1f\x7f]/.test(value) || /%2e|%2f|%5c/i.test(value)) fail('INVALID');
  const pieces = value.split('/');
  if (pieces.length > 64 || pieces.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) fail('INVALID');
  return value;
}
function list(value, maximum) {
  if (!Array.isArray(value) || isProxy(value) || value.length > maximum
      || Reflect.ownKeys(value).length !== value.length + 1) fail('LIMIT');
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail('INVALID');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (!Object.hasOwn(descriptor, 'value')) fail('INVALID');
  return value;
}
const pathOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function selection(value) {
  exact(value, ['snapshots', 'commits', 'branches', 'headOid']);
  let files = 0, metadata = 0; const snapshotIds = new Set();
  const snapshots = list(value.snapshots, 10000).map(snapshot => {
    exact(snapshot, ['snapshotId', 'commitOid', 'files']); id(snapshot.snapshotId); hex(snapshot.commitOid, 40);
    if (snapshotIds.has(snapshot.snapshotId)) fail('INVALID'); snapshotIds.add(snapshot.snapshotId);
    const paths = new Set();
    const entries = list(snapshot.files, 50000).map(file => {
      exact(file, ['path', 'gitOid', 'byteSize']); textPath(file.path); hex(file.gitOid, 40); number(file.byteSize, LIMITS.objectBytes);
      metadata += Buffer.byteLength(file.path) + 160;
      if (++files > 50000 || metadata > LIMITS.frameBytes || paths.has(file.path)) fail('LIMIT'); paths.add(file.path);
      return { path: file.path, gitOid: file.gitOid, byteSize: file.byteSize };
    }).sort((a, b) => pathOrder(a.path, b.path));
    for (const name of paths) {
      let parent = name;
      while (parent.includes('/')) { parent = parent.slice(0, parent.lastIndexOf('/')); if (paths.has(parent)) fail('INVALID'); }
    }
    return { snapshotId: snapshot.snapshotId, commitOid: snapshot.commitOid, files: entries };
  }).sort((a, b) => BigInt(a.snapshotId) < BigInt(b.snapshotId) ? -1 : 1);
  const commits = list(value.commits, 50000).map(oid => hex(oid, 40)).sort();
  if (new Set(commits).size !== commits.length) fail('INVALID');
  const names = new Set();
  const branches = list(value.branches, 10000).map(branch => {
    exact(branch, ['name', 'headOid']); textPath(branch.name); hex(branch.headOid, 40);
    if (/[ ~^:?*\[]/.test(branch.name) || branch.name.includes('..') || branch.name.includes('@{')
        || branch.name.endsWith('.') || branch.name.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))
        || names.has(branch.name.toLowerCase())) fail('INVALID'); names.add(branch.name.toLowerCase());
    return { name: branch.name, headOid: branch.headOid };
  }).sort((a, b) => pathOrder(a.name, b.name));
  for (const name of names) {
    let parent = name;
    while (parent.includes('/')) { parent = parent.slice(0, parent.lastIndexOf('/')); if (names.has(parent)) fail('INVALID'); }
  }
  if (value.headOid !== null) {
    hex(value.headOid, 40);
    if (!snapshots.some(s => s.commitOid === value.headOid) && !commits.includes(value.headOid)
        && !branches.some(b => b.headOid === value.headOid)) fail('INVALID');
  }
  return { snapshots, commits, branches, headOid: value.headOid };
}
function manifestString(digest, value) {
  const bytes = Buffer.from(value), prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  digest.update(prefix).update(bytes);
}
function manifestNumber(digest, value) {
  const bytes = Buffer.alloc(8); bytes.writeBigInt64BE(BigInt(value)); digest.update(bytes);
}
function retainedDescriptors(value, chosen) {
  let previousId = 0n, allBytes = 0, allNodes = 0;
  const snapshots = new Map(chosen.snapshots.map(snapshot => [snapshot.snapshotId, snapshot]));
  const descriptors = list(value, chosen.snapshots.length).map(item => {
    exact(item, RETAINED); id(item.snapshotId); hex(item.commitOid, 40);
    const nextId = BigInt(item.snapshotId);
    if (nextId <= previousId) fail('INVALID'); previousId = nextId;
    if (item.commitEpochSecond !== null && (!full(item.commitEpochSecond, /^(0|[1-9][0-9]{0,11})$/)
        || BigInt(item.commitEpochSecond) > 253402300799n)) fail('INVALID');
    if (item.policyVersion !== 'local-ingest-v1') fail('INVALID');
    hex(item.limitsSha256, 64); hex(item.manifestSha256, 64);
    number(item.fileCount, 50000); number(item.totalBytes, 512 * 1024 ** 2);
    const snapshot = snapshots.get(item.snapshotId);
    if (!snapshot || snapshot.commitOid !== item.commitOid || snapshot.files.length !== item.fileCount) fail('INVALID');
    const digest = crypto.createHash('sha256');
    manifestString(digest, 'code-intelligence-local-manifest-v1');
    manifestString(digest, item.policyVersion); manifestString(digest, item.limitsSha256);
    let previous = null, bytes = 0, metadata = 256;
    const files = new Set(), directories = new Set(), aliases = new Map();
    const entries = list(item.entries, 50000).map((entry, index) => {
      exact(entry, ['path', 'gitOid', 'rawSha256', 'byteSize']); textPath(entry.path);
      hex(entry.gitOid, 40); hex(entry.rawSha256, 64); number(entry.byteSize, LIMITS.objectBytes);
      if (entry.path.split('/').some(part => Buffer.byteLength(part) > 255)
          || previous !== null && pathOrder(previous, entry.path) >= 0) fail('INVALID'); previous = entry.path;
      const selected = snapshot.files[index];
      if (!selected || selected.path !== entry.path || selected.gitOid !== entry.gitOid || selected.byteSize !== entry.byteSize) fail('INVALID');
      metadata += Buffer.byteLength(entry.path) + 128; number(metadata, LIMITS.frameBytes);
      if (files.has(entry.path) || directories.has(entry.path)) fail('INVALID'); files.add(entry.path);
      let name = entry.path;
      for (;;) {
        const folded = name.toLowerCase();
        if (aliases.has(folded) && aliases.get(folded) !== name) fail('INVALID'); aliases.set(folded, name);
        if (!name.includes('/')) break;
        name = name.slice(0, name.lastIndexOf('/'));
        if (files.has(name)) fail('INVALID'); directories.add(name);
      }
      number(files.size + directories.size, LIMITS.objects);
      bytes += entry.byteSize; number(bytes, item.totalBytes);
      digest.update(Buffer.from([1])); manifestString(digest, entry.path); manifestString(digest, 'REGULAR_FILE');
      manifestNumber(digest, entry.byteSize); digest.update(Buffer.from(entry.rawSha256, 'hex'));
      return Object.freeze({ path: entry.path, gitOid: entry.gitOid, rawSha256: entry.rawSha256, byteSize: entry.byteSize });
    });
    if (entries.length !== item.fileCount || bytes !== item.totalBytes) fail('INVALID');
    digest.update(Buffer.from([0])); manifestNumber(digest, item.fileCount); manifestNumber(digest, item.totalBytes);
    if (digest.digest('hex') !== item.manifestSha256) fail('INTEGRITY');
    allBytes += bytes; number(allBytes, LIMITS.objectBytesTotal);
    allNodes += files.size + directories.size + 2; number(allNodes, LIMITS.objects);
    return Object.freeze({ ...Object.fromEntries(RETAINED.slice(0, -1).map(key => [key, item[key]])), entries: Object.freeze(entries) });
  });
  if (!descriptors.length) fail('INVALID');
  return Object.freeze(descriptors);
}
function receipt(value) {
  exact(value, RECEIPT); hex(value.selectionSha256, 64); hex(value.objectsSha256, 64);
  number(value.objectCount, LIMITS.objects); number(value.totalObjectBytes, LIMITS.objectBytesTotal);
  return Object.freeze(Object.fromEntries(RECEIPT.map(key => [key, value[key]])));
}
function position(frame, kind, projectId) {
  exact(frame, ['version', 'kind', 'projectId', ...RECEIPT]);
  if (frame.version !== 1 || frame.kind !== kind || frame.projectId !== projectId) fail('PROTOCOL');
  return receipt(Object.fromEntries(RECEIPT.map(key => [key, frame[key]])));
}
function same(a, b) { return RECEIPT.every(key => a[key] === b[key]); }
function objectFrame(value) {
  exact(value, OBJECT);
  if (value.version !== 1 || value.kind !== 'OBJECT' || !['COMMIT', 'TREE', 'BLOB'].includes(value.objectType)) fail('PROTOCOL');
  hex(value.gitOid, 40); hex(value.rawSha256, 64); number(value.byteSize, LIMITS.objectBytes);
  if (typeof value.bytesBase64 !== 'string' || value.bytesBase64.length !== 4 * Math.ceil(value.byteSize / 3)) fail('INTEGRITY');
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  try {
    if (bytes.length !== value.byteSize || bytes.toString('base64') !== value.bytesBase64 || sha(bytes) !== value.rawSha256
        || crypto.createHash('sha1').update(`${value.objectType.toLowerCase()} ${value.byteSize}\0`).update(bytes).digest('hex') !== value.gitOid) fail('INTEGRITY');
    return Object.freeze(Object.fromEntries(OBJECT.map(key => [key, value[key]])));
  } finally { bytes.fill(0); }
}
function inventory() {
  let previous = '', count = 0, bytes = 0;
  const digest = crypto.createHash('sha256').update('CI_BACKUP_OBJECTS_V1\n');
  return {
    add(frame) {
      if (frame.gitOid <= previous || ++count > LIMITS.objects) fail('PROTOCOL'); previous = frame.gitOid;
      bytes += frame.byteSize; number(bytes, LIMITS.objectBytesTotal);
      digest.update(`${frame.objectType}\0${frame.gitOid}\0${frame.rawSha256}\0${frame.byteSize}\n`);
    },
    check(expected) { if (count !== expected.objectCount || bytes !== expected.totalObjectBytes || digest.digest('hex') !== expected.objectsSha256) fail('INTEGRITY'); },
  };
}
function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  try {
    if (!payload.length || payload.length > LIMITS.frameBytes) fail('LIMIT');
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(payload.length);
    return Buffer.concat([prefix, payload]);
  } finally { payload.fill(0); }
}
async function* frames(stream, check) {
  let prefix = Buffer.alloc(4), prefixUsed = 0, payload = null, used = 0, total = 0;
  try {
    for await (const chunk of stream) {
      check();
      if (!Buffer.isBuffer(chunk)) fail('PROTOCOL');
      total += chunk.length; number(total, LIMITS.wireBytes);
      let offset = 0;
      while (offset < chunk.length) {
        check();
        if (!payload) {
          const amount = Math.min(4 - prefixUsed, chunk.length - offset);
          chunk.copy(prefix, prefixUsed, offset, offset + amount); prefixUsed += amount; offset += amount;
          if (prefixUsed !== 4) continue;
          const length = prefix.readUInt32BE();
          if (!length || length > LIMITS.frameBytes) fail('LIMIT');
          payload = Buffer.alloc(length); used = 0;
        }
        const amount = Math.min(payload.length - used, chunk.length - offset);
        chunk.copy(payload, used, offset, offset + amount); used += amount; offset += amount;
        if (used === payload.length) {
          let value;
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
            value = JSON.parse(text);
            // Worker output has ASCII metadata/base64. Exact compact round-trip rejects duplicate keys.
            if (JSON.stringify(value) !== text) fail('PROTOCOL');
          } catch { fail('PROTOCOL'); }
          payload.fill(0); payload = null; prefixUsed = 0;
          yield value;
        }
      }
    }
    if (payload || prefixUsed) fail('PROTOCOL');
  } finally { prefix.fill(0); payload?.fill(0); }
}
async function stamp(file, executable) {
  absolute(file);
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || file !== await fs.realpath(file)
      || (executable && (stat.mode & 0o111n) === 0n)) fail('INVALID');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(':');
}
function write(stream, bytes) {
  return new Promise((resolve, reject) => {
    const failed = () => { cleanup(); reject(error('PROCESS')); };
    const cleanup = () => stream.removeListener('error', failed);
    stream.once('error', failed);
    try { stream.write(bytes, failure => { cleanup(); failure ? reject(error('PROCESS')) : resolve(); }); }
    catch { failed(); }
  }).finally(() => bytes.fill(0));
}
async function end(stream) {
  await new Promise((resolve, reject) => {
    const failed = () => { stream.removeListener('error', failed); reject(error('PROCESS')); };
    stream.once('error', failed);
    try { stream.end(() => { stream.removeListener('error', failed); resolve(); }); } catch { failed(); }
  });
}

async function createBackupSourceWorker(options) {
  plain(options); const javaPath = absolute(options.javaPath), jarPath = absolute(options.jarPath);
  const spawn = options.spawn === undefined ? childProcess.spawn : options.spawn;
  if (typeof spawn !== 'function') fail('INVALID');
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs, killGraceMs = options.killGraceMs ?? LIMITS.killGraceMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs
      || !Number.isInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 5000) fail('INVALID');
  const inherited = options.env === undefined ? process.env : options.env;
  if (options.env !== undefined) plain(inherited);
  const env = Object.freeze(Object.fromEntries(SYSTEM_ENV.filter(key => typeof inherited[key] === 'string').map(key => [key, inherited[key]])));
  let javaStamp, jarStamp;
  try { javaStamp = await stamp(javaPath, true); jarStamp = await stamp(jarPath, false); } catch { fail('INVALID'); }
  let active = null, closing = false, poisoned = false;

  async function terminate(state) {
    if (state.closed) return;
    if (!state.termination) state.termination = (async () => {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try { state.child.kill(signal); } catch { /* A throw is not exit confirmation. */ }
        let timer;
        await Promise.race([state.closePromise, new Promise(resolve => { timer = setTimeout(resolve, killGraceMs); })]);
        clearTimeout(timer);
        if (state.closed) return;
      }
      poisoned = true; fail('TERMINATION');
    })().finally(() => { state.termination = null; });
    return state.termination;
  }

  async function execute(send, receive) {
    if (closing || poisoned) fail('CLOSED'); if (active) fail('BUSY');
    const state = { child: null, closed: false, aborted: false, closePromise: null };
    active = state; let timer, rejectFailure;
    const failure = new Promise((resolve, reject) => { rejectFailure = reject; }); failure.catch(() => {});
    const abort = code => { state.aborted = true; rejectFailure(error(code)); };
    state.abort = abort;
    const check = () => { if (state.aborted || closing) fail('CLOSED'); };
    try {
      if (await stamp(javaPath, true) !== javaStamp || await stamp(jarPath, false) !== jarStamp) fail('BINARY_CHANGED');
      check();
      state.child = spawn(javaPath, ['-Xmx512m', '-jar', jarPath, '--ci-backup-source-worker'],
        { cwd: path.dirname(jarPath), env: { ...env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const child = state.child;
      if (!child || typeof child.once !== 'function' || typeof child.on !== 'function' || typeof child.kill !== 'function') fail('PROCESS');
      // Own termination before validating stdio: a created process must be reaped on setup failure.
      state.closePromise = new Promise(resolve => child.once('close', (code, signal) => { state.closed = true; resolve({ code, signal }); }));
      child.on('error', () => abort('PROCESS'));
      if (!child.stdin || !child.stdout || !child.stderr || typeof child.stdin.on !== 'function'
          || typeof child.stdin.write !== 'function' || typeof child.stdin.end !== 'function'
          || typeof child.stdout[Symbol.asyncIterator] !== 'function' || typeof child.stderr.on !== 'function') fail('PROCESS');
      child.stdin.on('error', () => abort('PROCESS'));
      child.stderr.on('error', () => abort('PROCESS')); let stderrBytes = 0;
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > LIMITS.stderrBytes) abort('LIMIT'); });
      timer = setTimeout(() => abort('TIMEOUT'), timeoutMs);
      const sent = send(child.stdin, check);
      const received = receive(frames(child.stdout, check), check);
      const done = Promise.all([sent, received, state.closePromise]);
      const [, result, closed] = await Promise.race([done, failure]);
      if (closed.code !== 0 || closed.signal != null) fail('PROCESS');
      check(); return result;
    } catch (cause) {
      state.aborted = true;
      if (state.child && state.closePromise) await terminate(state);
      throw cause instanceof BackupSourceWorkerError ? cause : error('PROCESS');
    } finally {
      clearTimeout(timer);
      if (!state.child || state.closed) active = null;
      else poisoned = true;
    }
  }

  return Object.freeze({
    async exportProject(value) {
      plain(value);
      const withRetained = Object.hasOwn(value, 'retained') || Object.hasOwn(value, 'scratchRoot') || Object.hasOwn(value, 'readRetainedBlob');
      exact(value, ['reposRoot', 'projectId', 'selection', 'writeRecord', ...(withRetained ? ['scratchRoot', 'retained', 'readRetainedBlob'] : [])]);
      const reposRoot = absolute(value.reposRoot), projectId = id(value.projectId), chosen = selection(value.selection);
      if (typeof value.writeRecord !== 'function') fail('INVALID');
      const retained = withRetained ? retainedDescriptors(value.retained, chosen) : null;
      const scratchRoot = withRetained ? absolute(value.scratchRoot) : null;
      const readRetainedBlob = value.readRetainedBlob;
      if (withRetained && (typeof readRetainedBlob !== 'function' || scratchRoot === reposRoot
          || scratchRoot.startsWith(reposRoot + path.sep) || reposRoot.startsWith(scratchRoot + path.sep))) fail('INVALID');
      const selectionSha256 = sha(Buffer.from(JSON.stringify(chosen)));
      return execute(async (stdin, check) => {
        check();
        await write(stdin, frame(withRetained
          ? { version: 1, operation: 'EXPORT_RETAINED', reposRoot, scratchRoot, projectId, selection: chosen, retainedCount: retained.length }
          : { version: 1, operation: 'EXPORT', reposRoot, projectId, selection: chosen }));
        for (const descriptor of retained || []) {
          check();
          const { entries, ...header } = descriptor;
          await write(stdin, frame({ version: 1, kind: 'RETAINED_BEGIN', ...header }));
          for (const entry of entries) {
            check(); let bytes;
            try {
              bytes = await readRetainedBlob(Object.freeze({ projectId, sha256: entry.rawSha256, byteSize: entry.byteSize }));
              check();
              if (!Buffer.isBuffer(bytes) || bytes.length !== entry.byteSize || sha(bytes) !== entry.rawSha256
                  || crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.gitOid) fail('INTEGRITY');
              // UTF-8/NUL and the shared SecretMask remain independently enforced by the worker.
              await write(stdin, frame({ version: 1, kind: 'RETAINED_ENTRY', ...entry, bytesBase64: bytes.toString('base64') }));
            } finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
          }
          check(); await write(stdin, frame({ version: 1, kind: 'RETAINED_END', snapshotId: descriptor.snapshotId }));
        }
        check(); await end(stdin);
      }, async (input, check) => {
        let expected = null, ended = false; const objects = inventory();
        for await (const item of input) {
          check();
          if (item?.kind === 'ERROR') { exact(item, ['version', 'kind', 'code']); if (item.version !== 1) fail('PROTOCOL'); fail(item.code); }
          if (ended) fail('PROTOCOL');
          let record;
          if (!expected) {
            expected = position(item, 'BEGIN', projectId);
            if (expected.selectionSha256 !== selectionSha256) fail('INTEGRITY'); record = Object.freeze({ ...item });
          } else if (item?.kind === 'END') {
            if (!same(position(item, 'END', projectId), expected)) fail('INTEGRITY'); objects.check(expected); ended = true; record = Object.freeze({ ...item });
          } else { record = objectFrame(item); objects.add(record); }
          try { await value.writeRecord(record); } catch { fail('SINK'); }
          check();
        }
        if (!expected || !ended) fail('PROTOCOL');
        return expected;
      });
    },
    async restoreProject(value) {
      exact(value, ['stageRoot', 'projectId', 'selection', 'expected', 'objects']);
      const stageRoot = absolute(value.stageRoot), projectId = id(value.projectId), chosen = selection(value.selection), expected = receipt(value.expected);
      if (expected.selectionSha256 !== sha(Buffer.from(JSON.stringify(chosen)))
          || !value.objects || typeof value.objects[Symbol.asyncIterator] !== 'function') fail('INVALID');
      return execute(async (stdin, check) => {
        check(); await write(stdin, frame({ version: 1, operation: 'IMPORT', stageRoot, projectId, selection: chosen, expected }));
        const objects = inventory();
        for await (const item of value.objects) {
          check(); const object = objectFrame(item); objects.add(object); await write(stdin, frame(object));
        }
        objects.check(expected); check();
        await write(stdin, frame({ version: 1, kind: 'END', projectId, ...expected })); await end(stdin);
      }, async (input, check) => {
        let result;
        for await (const item of input) {
          check();
          if (item?.kind === 'ERROR') { exact(item, ['version', 'kind', 'code']); if (item.version !== 1) fail('PROTOCOL'); fail(item.code); }
          if (result) fail('PROTOCOL'); result = position(item, 'RESTORED', projectId);
          if (!same(result, expected)) fail('INTEGRITY');
        }
        if (!result) fail('PROTOCOL'); return result;
      });
    },
    async close() {
      closing = true;
      if (active) { active.abort?.('CLOSED'); if (active.child && active.closePromise) await terminate(active); }
    },
  });
}

module.exports = { createBackupSourceWorker, BackupSourceWorkerError, LIMITS };
