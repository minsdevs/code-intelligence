'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { setImmediate: tick } = require('node:timers/promises');
const test = require('node:test');
const zlib = require('node:zlib');
const { createBackupSourceWorker, BackupSourceWorkerError, LIMITS } = require('../src/backup-source-worker.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function rawFrame(bytes) { const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length); return Buffer.concat([prefix, bytes]); }
const frame = value => rawFrame(Buffer.from(JSON.stringify(value)));
function frames(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset); offset += 4;
    result.push(JSON.parse(bytes.subarray(offset, offset + length))); offset += length;
  }
  return result;
}
function object(type, bytes) {
  return { version: 1, kind: 'OBJECT', objectType: type,
    gitOid: crypto.createHash('sha1').update(`${type.toLowerCase()} ${bytes.length}\0`).update(bytes).digest('hex'),
    rawSha256: sha(bytes), byteSize: bytes.length, bytesBase64: bytes.toString('base64') };
}
function publicSource() {
  const bytes = Buffer.from('export const v = 1;\r\n');
  const blob = object('BLOB', bytes);
  const tree = object('TREE', Buffer.concat([Buffer.from('100644 src.ts\0'), Buffer.from(blob.gitOid, 'hex')]));
  const commit = object('COMMIT', Buffer.from(`tree ${tree.gitOid}\nauthor Synthetic <synthetic@example.invalid> 1700000000 +0000\ncommitter Synthetic <synthetic@example.invalid> 1700000000 +0000\n\nSynthetic snapshot\n`));
  const selection = { snapshots: [{ snapshotId: '11', commitOid: commit.gitOid,
    files: [{ path: 'src.ts', gitOid: blob.gitOid, byteSize: bytes.length }] }], commits: [commit.gitOid],
  branches: [{ name: 'main', headOid: commit.gitOid }], headOid: commit.gitOid };
  const objects = [blob, tree, commit].sort((a, b) => a.gitOid.localeCompare(b.gitOid));
  const digest = crypto.createHash('sha256').update('CI_BACKUP_OBJECTS_V1\n');
  for (const item of objects) digest.update(`${item.objectType}\0${item.gitOid}\0${item.rawSha256}\0${item.byteSize}\n`);
  const expected = { selectionSha256: sha(Buffer.from(JSON.stringify(selection))), objectCount: objects.length,
    totalObjectBytes: objects.reduce((total, item) => total + item.byteSize, 0), objectsSha256: digest.digest('hex') };
  return { selection, objects, expected, bytes, blob, tree, commit,
    output: [{ version: 1, kind: 'BEGIN', projectId: '7', ...expected }, ...objects,
      { version: 1, kind: 'END', projectId: '7', ...expected }] };
}
async function* records(objects) { for (const item of objects) yield item; }
async function failed(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BackupSourceWorkerError);
    if (code) assert.equal(error.code, `BACKUP_SOURCE_${code}`);
    assert.doesNotMatch(String(error), /private-|sentinel|never-read|Exception|SELECT|source text/);
    assert.equal(error.cause, undefined); assert.equal(error.stdout, undefined); assert.equal(error.stderr, undefined);
    return true;
  });
}

async function fixture(t, changes = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-source-wrapper-'));
  await fs.chmod(root, 0o700);
  const javaPath = path.join(root, 'synthetic-java'), jarPath = path.join(root, 'synthetic.jar');
  await fs.writeFile(javaPath, 'synthetic executable never executed', { mode: 0o700 });
  await fs.writeFile(jarPath, 'synthetic jar never loaded', { mode: 0o600 });
  const source = publicSource(), calls = [], control = {};
  const spawn = (command, args, options) => {
    if (control.spawnThrows) throw new Error('private-spawn-sentinel');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const stdout = child.stdout, stderr = child.stderr;
    const call = { command, args, options, chunks: [], references: [], signals: [], eof: false, child, closed: false }; calls.push(call);
    const close = (code = 0, signal = null) => {
      if (call.closed) return; call.closed = true;
      stdout.end(); stderr.end(); child.emit('exit', code, signal); child.emit('close', code, signal);
    };
    call.close = close;
    child.kill = signal => {
      call.signals.push(signal);
      if (control.killThrows) throw new Error('private-kill-sentinel');
      if (!control.ignoreKill) queueMicrotask(() => close(null, signal));
      return !control.ignoreKill;
    };
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      call.chunks.push(Buffer.from(chunk));
      call.references.push(chunk);
      if (control.stdinError) callback(new Error('private-stdin-sentinel'));
      else if (control.delayInput) control.delayInput(callback);
      else callback();
    } });
    child.stdin.on('finish', () => {
      call.eof = true;
      queueMicrotask(async () => {
        if (control.hang) return;
        if (control.respond) { await control.respond(call, close); return; }
        const request = frames(Buffer.concat(call.chunks))[0];
        const output = control.output || (request.operation.startsWith('EXPORT') ? source.output
          : [{ version: 1, kind: 'RESTORED', projectId: '7', ...source.expected }]);
        child.stdout.write(control.rawOutput || Buffer.concat(output.map(frame)));
        if (control.stderr) child.stderr.write(control.stderr);
        if (control.noEof) return;
        child.stdout.end(); child.stderr.end();
        if (!control.noClose) close(control.exitCode ?? 0, control.exitSignal ?? null);
      });
    });
    if (control.spawnError) queueMicrotask(() => child.emit('error', new Error('private-spawn-sentinel')));
    if (control.missingStream) child[control.missingStream] = null;
    return child;
  };
  const options = { javaPath, jarPath, spawn, timeoutMs: 10000, killGraceMs: 5,
    env: { PATH: '/synthetic/bin', HOME: '/synthetic/home', LANG: 'C',
      JAVA_TOOL_OPTIONS: 'private-java-sentinel', JDK_JAVA_OPTIONS: 'private-jdk-sentinel',
      _JAVA_OPTIONS: 'private-hidden-java-sentinel', CLASSPATH: 'private-classpath-sentinel',
      OPENAI_API_KEY: 'private-provider-sentinel', GITHUB_TOKEN: 'private-github-sentinel',
      PGPASSWORD: 'private-database-sentinel' }, ...changes };
  const worker = await createBackupSourceWorker(options);
  t.after(async () => { for (const call of calls) call.close(null, 'SIGTERM'); await worker.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const received = [];
  return { root, source, calls, control, options, worker, received,
    export: (overrides = {}) => worker.exportProject({ reposRoot: path.join(root, 'repos'), projectId: '7',
      selection: source.selection, writeRecord: async item => { received.push(item); }, ...overrides }),
    restore: (overrides = {}) => worker.restoreProject({ stageRoot: path.join(root, 'stage'), projectId: '7',
      selection: source.selection, expected: source.expected, objects: records(source.objects), ...overrides }),
  };
}

test('fixed main-only launch streams BEGIN/OBJECT/END and returns only after EOF and close', async t => {
  const f = await fixture(t); f.control.noClose = true;
  let settled = false; const pending = f.export().then(value => { settled = true; return value; });
  while (f.received.length !== 5) await tick();
  assert.equal(settled, false); assert.equal(f.calls[0].eof, true);
  const call = f.calls[0]; call.close();
  assert.deepEqual(await pending, f.source.expected);
  assert.deepEqual(f.received, f.source.output); assert.ok(f.received.every(Object.isFrozen));
  assert.deepEqual(call.args, ['-Xmx512m', '-jar', f.options.jarPath, '--ci-backup-source-worker']);
  assert.equal(call.command, f.options.javaPath); assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(JSON.stringify(call.args).includes('/repos'), false);
  assert.deepEqual(call.options.env, { PATH: '/synthetic/bin', HOME: '/synthetic/home', LANG: 'C' });
  assert.equal(JSON.stringify(call.options).includes('private-'), false);
  const request = frames(Buffer.concat(call.chunks)); assert.equal(request.length, 1);
  assert.equal(request[0].reposRoot, path.join(f.root, 'repos'));
});

test('restore sends exact verified objects plus END and waits for a matching receipt', async t => {
  const f = await fixture(t); assert.deepEqual(await f.restore(), f.source.expected);
  const input = frames(Buffer.concat(f.calls[0].chunks));
  assert.equal(input[0].operation, 'IMPORT'); assert.deepEqual(input[0].expected, f.source.expected);
  assert.deepEqual(input.slice(1, -1), f.source.objects); assert.deepEqual(input.at(-1), f.source.output.at(-1));
  assert.equal(f.calls[0].eof, true);
});

test('sink backpressure stops further callbacks and concurrent helpers are rejected', async t => {
  const f = await fixture(t); let release; const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const pending = f.export({ writeRecord: async () => { calls++; if (calls === 1) await blocked; } });
  while (calls !== 1) await tick();
  await tick(); assert.equal(calls, 1); await failed(f.export(), 'BUSY');
  release(); await pending; assert.equal(calls, 5);
});

test('fragmented headers and payloads are reassembled without assuming chunk boundaries', async t => {
  const f = await fixture(t);
  f.control.respond = async (call, close) => {
    const bytes = Buffer.concat(f.source.output.map(frame));
    for (let i = 0; i < bytes.length; i += 3) call.child.stdout.write(bytes.subarray(i, i + 3));
    close();
  };
  assert.deepEqual(await f.export(), f.source.expected);
});

test('a sink failure is static and reaps the helper before returning failure', async t => {
  const f = await fixture(t); f.control.noClose = true;
  await failed(f.export({ writeRecord: async () => { throw new Error('private-source text'); } }), 'SINK');
  assert.equal(f.calls[0].closed, true); assert.deepEqual(f.calls[0].signals, ['SIGTERM']);
});

for (const mutation of ['wrong-digest', 'wrong-owner', 'unknown-field', 'count-limit', 'extra-end', 'no-end', 'unknown-error']) {
  test(`export rejects ${mutation} without exposing subprocess data`, async t => {
    const f = await fixture(t); const output = copy(f.source.output);
    if (mutation === 'wrong-digest') output[0].selectionSha256 = '0'.repeat(64);
    if (mutation === 'wrong-owner') output[0].projectId = '8';
    if (mutation === 'unknown-field') output[0].privatePath = 'private-sentinel';
    if (mutation === 'count-limit') output[0].objectCount = LIMITS.objects + 1;
    if (mutation === 'extra-end') output.push(copy(output.at(-1)));
    if (mutation === 'no-end') output.pop();
    if (mutation === 'unknown-error') output.splice(0, output.length, { version: 1, kind: 'ERROR', code: 'private-source text' });
    f.control.output = output; await failed(f.export());
  });
}

for (const mutation of ['raw-hash', 'git-oid', 'size', 'base64', 'type', 'duplicate', 'wrong-object-digest']) {
  test(`object frame ${mutation} cannot be accepted as verified source`, async t => {
    const f = await fixture(t); const output = copy(f.source.output);
    if (mutation === 'raw-hash') output[1].rawSha256 = '0'.repeat(64);
    if (mutation === 'git-oid') output[1].gitOid = '0'.repeat(40);
    if (mutation === 'size') output[1].byteSize++;
    if (mutation === 'base64') output[1].bytesBase64 = '!'.repeat(output[1].bytesBase64.length);
    if (mutation === 'type') output[1].objectType = 'PACK';
    if (mutation === 'duplicate') output[2] = copy(output[1]);
    if (mutation === 'wrong-object-digest') { output[0].objectsSha256 = '0'.repeat(64); output.at(-1).objectsSha256 = '0'.repeat(64); }
    f.control.output = output; await failed(f.export());
    assert.equal(f.received.some(item => item.kind === 'END'), false);
  });
}

for (const mutation of ['duplicate-json', 'invalid-utf8', 'oversized-prefix', 'truncated-prefix', 'truncated-body']) {
  test(`framing rejects ${mutation}`, async t => {
    const f = await fixture(t);
    if (mutation === 'duplicate-json') f.control.rawOutput = rawFrame(Buffer.from('{"version":1,"version":1,"kind":"ERROR","code":"SOURCE_FAILURE"}'));
    if (mutation === 'invalid-utf8') f.control.rawOutput = rawFrame(Buffer.from([0xc3, 0x28]));
    if (mutation === 'oversized-prefix') { f.control.rawOutput = Buffer.alloc(4); f.control.rawOutput.writeUInt32BE(LIMITS.frameBytes + 1); }
    if (mutation === 'truncated-prefix') f.control.rawOutput = Buffer.from([0, 0]);
    if (mutation === 'truncated-body') f.control.rawOutput = frame(f.source.output[0]).subarray(0, 10);
    await failed(f.export());
  });
}

test('valid output followed by a nonzero exit is still failure', async t => {
  const f = await fixture(t); f.control.exitCode = 9;
  await failed(f.export(), 'PROCESS'); assert.equal(f.received.at(-1).kind, 'END');
});

test('subprocess stderr is bounded and never returned or logged', async t => {
  const f = await fixture(t); f.control.stderr = Buffer.alloc(LIMITS.stderrBytes + 1, 97);
  await failed(f.export(), 'LIMIT');
});

test('static worker policy failures remain actionable without source disclosure', async t => {
  const f = await fixture(t); f.control.output = [{ version: 1, kind: 'ERROR', code: 'SOURCE_SECRET_DETECTED' }];
  await failed(f.export(), 'SOURCE_SECRET_DETECTED'); assert.deepEqual(f.received, []);
});

for (const kind of ['spawnThrows', 'spawnError', 'stdinError']) {
  test(`${kind} is contained and any acquired child is reaped`, async t => {
    const f = await fixture(t); f.control[kind] = true;
    await failed(f.export(), 'PROCESS'); assert.ok(f.calls.every(call => call.closed));
  });
}

for (const stream of ['stdin', 'stdout', 'stderr']) {
  test(`a created child missing ${stream} is reaped even though setup never completed`, async t => {
    const f = await fixture(t); f.control.missingStream = stream;
    await failed(f.export(), 'PROCESS');
    assert.equal(f.calls[0].closed, true); assert.deepEqual(f.calls[0].signals, ['SIGTERM']);
    assert.equal(f.calls[0].chunks.length, 0);
  });
}

test('missing stdout EOF cannot be replaced by an END record', async t => {
  const f = await fixture(t, { timeoutMs: 20 }); f.control.noEof = true;
  await failed(f.export(), 'TIMEOUT'); assert.equal(f.calls[0].closed, true);
});

test('timeout escalates to SIGKILL and an unconfirmed child permanently blocks this handle', async t => {
  const f = await fixture(t, { timeoutMs: 20 }); f.control.hang = true; f.control.ignoreKill = true;
  await failed(f.export(), 'TERMINATION'); assert.deepEqual(f.calls[0].signals, ['SIGTERM', 'SIGKILL']);
  await failed(f.export(), 'CLOSED'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].closed, false);
});

test('a synchronous kill throw is not interpreted as termination', async t => {
  const f = await fixture(t, { timeoutMs: 20 }); f.control.hang = true; f.control.killThrows = true;
  await failed(f.export(), 'TERMINATION'); await failed(f.restore(), 'CLOSED');
});

test('close cancels a live helper and no later job can spawn', async t => {
  const f = await fixture(t); f.control.hang = true;
  const pending = f.export(); const rejected = failed(pending, 'CLOSED');
  while (!f.calls.length) await tick(); await Promise.all([f.worker.close(), f.worker.close()]); await rejected;
  assert.equal(f.calls[0].closed, true); await failed(f.export(), 'CLOSED');
  assert.deepEqual(f.calls[0].signals, ['SIGTERM']);
});

test('an unconfirmed child remains owned and explicit close can retry termination', async t => {
  const f = await fixture(t, { timeoutMs: 20 }); f.control.hang = true; f.control.ignoreKill = true;
  await failed(f.export(), 'TERMINATION');
  f.control.ignoreKill = false; await f.worker.close();
  assert.equal(f.calls[0].closed, true); assert.deepEqual(f.calls[0].signals, ['SIGTERM', 'SIGKILL', 'SIGTERM']);
  await failed(f.export(), 'CLOSED'); assert.equal(f.calls.length, 1);
});

test('binary replacement after construction refuses before process creation', async t => {
  const f = await fixture(t); await fs.writeFile(f.options.jarPath, 'changed bundled jar fixture');
  await failed(f.export(), 'BINARY_CHANGED'); assert.equal(f.calls.length, 0);
});

test('restore corruption is rejected before END/EOF and without successful receipt', async t => {
  const f = await fixture(t); const objects = copy(f.source.objects); objects[0].rawSha256 = '0'.repeat(64);
  await failed(f.restore({ objects: records(objects) }), 'INTEGRITY');
  assert.equal(f.calls[0].eof, false); assert.equal(f.calls[0].closed, true);
});

test('a mismatched restored receipt fails even when Java exits cleanly', async t => {
  const f = await fixture(t); f.control.output = [{ version: 1, kind: 'RESTORED', projectId: '7',
    ...f.source.expected, objectsSha256: '0'.repeat(64) }];
  await failed(f.restore(), 'INTEGRITY');
});

test('missing restore input cannot be silently shortened by a matching count claim', async t => {
  const f = await fixture(t);
  await failed(f.restore({ objects: records(f.source.objects.slice(1)) }), 'INTEGRITY'); assert.equal(f.calls[0].eof, false);
});

test('selection is normalized deterministically and cannot grant arbitrary paths or refs', async t => {
  const f = await fixture(t); const chosen = copy(f.source.selection);
  chosen.snapshots[0].files[0].path = '../outside';
  await failed(f.export({ selection: chosen }), 'INVALID');
  await failed(f.export({ projectId: '007' }), 'INVALID');
  await failed(f.export({ reposRoot: '/synthetic/../outside' }), 'INVALID');
  assert.equal(f.calls.length, 0);
});

test('selection getter/proxy values are not evaluated as private worker commands', async t => {
  const f = await fixture(t); let invoked = false;
  const chosen = { ...f.source.selection }; Object.defineProperty(chosen, 'commits', { enumerable: true, get() { invoked = true; return []; } });
  await failed(f.export({ selection: chosen }), 'INVALID'); assert.equal(invoked, false);
  await failed(f.export({ selection: new Proxy(f.source.selection, {}) }), 'INVALID'); assert.equal(f.calls.length, 0);
});

test('invalid executable/JAR paths are rejected without using a shell or accepting symlinks', async t => {
  const f = await fixture(t); const alias = path.join(f.root, 'jar-alias'); await fs.symlink(f.options.jarPath, alias);
  await failed(createBackupSourceWorker({ ...f.options, jarPath: alias }), 'INVALID');
  await failed(createBackupSourceWorker({ ...f.options, javaPath: 'java' }), 'INVALID');
  assert.equal(f.calls.length, 0);
});

const liveJava = process.env.CI_BACKUP_SOURCE_TEST_JAVA, liveJar = process.env.CI_BACKUP_SOURCE_TEST_JAR;
test('opt-in real bundled JAR exports and reconstructs public synthetic Git objects',
  { skip: !liveJava || !liveJar, timeout: 60000 }, async t => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-source-jar-'));
    await fs.chmod(root, 0o700);
    const source = publicSource(), repos = path.join(root, 'repos'), stage = path.join(root, 'stage');
    await fs.mkdir(path.join(repos, '7', '.git', 'objects'), { recursive: true, mode: 0o700 });
    await fs.mkdir(stage, { mode: 0o700 });
    for (const item of source.objects) {
      const raw = Buffer.from(item.bytesBase64, 'base64'), directory = path.join(repos, '7', '.git', 'objects', item.gitOid.slice(0, 2));
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, item.gitOid.slice(2)), zlib.deflateSync(Buffer.concat([
        Buffer.from(`${item.objectType.toLowerCase()} ${raw.length}\0`), raw])), { mode: 0o600 });
    }
    // The fixture is an object database, not a native Git repository or a source working folder.
    const worker = await createBackupSourceWorker({ javaPath: await fs.realpath(liveJava), jarPath: await fs.realpath(liveJar) });
    t.after(async () => { await worker.close(); await fs.rm(root, { recursive: true, force: true }); });
    const captured = [];
    const expected = await worker.exportProject({ reposRoot: repos, projectId: '7', selection: source.selection,
      writeRecord: async item => { captured.push(item); } });
    assert.deepEqual(expected, source.expected); assert.deepEqual(captured, source.output);
    assert.deepEqual(await worker.restoreProject({ stageRoot: stage, projectId: '7', selection: source.selection, expected,
      objects: records(captured.filter(item => item.kind === 'OBJECT')) }), expected);
    assert.equal(await fs.readFile(path.join(stage, '7', '.git', 'HEAD'), 'utf8'), `${source.commit.gitOid}\n`);
    assert.equal(await fs.readFile(path.join(stage, '7', '.git', 'refs', 'heads', 'main'), 'utf8'), `${source.commit.gitOid}\n`);
    const config = await fs.readFile(path.join(stage, '7', '.git', 'config'), 'utf8'); assert.doesNotMatch(config, /remote|filter|include/);
  });

function retainedManifest(entries, policy = 'local-ingest-v1', limits = 'a'.repeat(64)) {
  const digest = crypto.createHash('sha256');
  const text = value => { const raw = Buffer.from(value), length = Buffer.alloc(4); length.writeUInt32BE(raw.length); digest.update(length).update(raw); };
  const number = value => { const raw = Buffer.alloc(8); raw.writeBigInt64BE(BigInt(value)); digest.update(raw); };
  text('code-intelligence-local-manifest-v1'); text(policy); text(limits);
  for (const entry of entries) { digest.update(Buffer.from([1])); text(entry.path); text('REGULAR_FILE'); number(entry.byteSize); digest.update(Buffer.from(entry.rawSha256, 'hex')); }
  digest.update(Buffer.from([0])); number(entries.length); number(entries.reduce((sum, entry) => sum + entry.byteSize, 0));
  return digest.digest('hex');
}
function retainedPublicSource() {
  const source = publicSource();
  // Deliberately construct raw Git payload independently of the Java CommitBuilder implementation.
  source.commit = object('COMMIT', Buffer.from(`tree ${source.tree.gitOid}\nauthor Code Intelligence <local@code-intelligence.invalid> 1700000000 +0000\ncommitter Code Intelligence <local@code-intelligence.invalid> 1700000000 +0000\n\nCode Intelligence local snapshot`));
  source.selection.snapshots[0].commitOid = source.commit.gitOid;
  source.selection.commits = [source.commit.gitOid]; source.selection.branches[0].headOid = source.commit.gitOid;
  source.selection.headOid = source.commit.gitOid;
  source.objects = [source.blob, source.tree, source.commit].sort((a, b) => a.gitOid.localeCompare(b.gitOid));
  const digest = crypto.createHash('sha256').update('CI_BACKUP_OBJECTS_V1\n');
  for (const item of source.objects) digest.update(`${item.objectType}\0${item.gitOid}\0${item.rawSha256}\0${item.byteSize}\n`);
  source.expected = { selectionSha256: sha(Buffer.from(JSON.stringify(source.selection))), objectCount: source.objects.length,
    totalObjectBytes: source.objects.reduce((total, item) => total + item.byteSize, 0), objectsSha256: digest.digest('hex') };
  source.output = [{ version: 1, kind: 'BEGIN', projectId: '7', ...source.expected }, ...source.objects,
    { version: 1, kind: 'END', projectId: '7', ...source.expected }];
  const entries = [{ path: 'src.ts', gitOid: source.blob.gitOid, rawSha256: source.blob.rawSha256, byteSize: source.blob.byteSize }];
  source.retained = [{ snapshotId: '11', commitOid: source.commit.gitOid, commitEpochSecond: '1700000000',
    policyVersion: 'local-ingest-v1', limitsSha256: 'a'.repeat(64), manifestSha256: retainedManifest(entries),
    fileCount: entries.length, totalBytes: source.bytes.length, entries }];
  return source;
}
async function retainedCase(t, changes = {}) {
  const f = await fixture(t, changes); Object.assign(f.source, retainedPublicSource());
  const reads = [], buffers = [];
  const args = { scratchRoot: path.join(f.root, 'scratch'), retained: f.source.retained,
    readRetainedBlob: async request => { reads.push(request); const bytes = Buffer.from(f.source.bytes); buffers.push(bytes); return bytes; } };
  return { ...f, reads, buffers, args, retainedExport: overrides => f.export({ ...args, ...overrides }) };
}

test('retained stream sends exact verified bytes and typed metadata without source keys, then clears owned buffers', async t => {
  const f = await retainedCase(t); assert.deepEqual(await f.retainedExport(), f.source.expected);
  assert.deepEqual(f.reads, [{ projectId: '7', sha256: f.source.blob.rawSha256, byteSize: f.source.bytes.length }]);
  assert.ok(Object.isFrozen(f.reads[0])); assert.ok(f.buffers.every(bytes => bytes.every(byte => byte === 0)));
  assert.deepEqual(f.received, f.source.output);
  const input = frames(Buffer.concat(f.calls[0].chunks));
  assert.equal(input.length, 4); assert.equal(input[0].operation, 'EXPORT_RETAINED'); assert.equal(input[0].retainedCount, 1);
  assert.equal(input[0].scratchRoot, f.args.scratchRoot); assert.deepEqual(input[0].selection, f.source.selection);
  const { entries, ...metadata } = f.source.retained[0];
  assert.deepEqual(input[1], { version: 1, kind: 'RETAINED_BEGIN', ...metadata });
  assert.deepEqual(input[2], { version: 1, kind: 'RETAINED_ENTRY', ...entries[0], bytesBase64: f.source.bytes.toString('base64') });
  assert.deepEqual(input[3], { version: 1, kind: 'RETAINED_END', snapshotId: '11' });
  assert.doesNotMatch(JSON.stringify(input), /keyId|keyBytes|token|credential/);
  assert.ok(f.calls[0].references.every(bytes => bytes.every(byte => byte === 0)));
  assert.deepEqual(f.calls[0].options.env, { PATH: '/synthetic/bin', HOME: '/synthetic/home', LANG: 'C' });
});

for (const mutation of ['policy', 'limits', 'digest', 'count', 'total', 'snapshot', 'commit', 'timestamp-number', 'timestamp-negative',
  'timestamp-leading', 'timestamp-limit', 'timestamp-extra', 'descriptor-field', 'entry-field', 'empty', 'duplicate', 'path', 'long-segment', 'size', 'missing-capability', 'overlap']) {
  test(`retained metadata ${mutation} fails before spawn or vault read`, async t => {
    const f = await retainedCase(t); const retained = copy(f.source.retained), d = retained[0]; const options = { retained };
    if (mutation === 'policy') d.policyVersion = 'local-ingest-v2';
    if (mutation === 'limits') d.limitsSha256 = 'b'.repeat(64);
    if (mutation === 'digest') d.manifestSha256 = '0'.repeat(64);
    if (mutation === 'count') d.fileCount = 0;
    if (mutation === 'total') d.totalBytes++;
    if (mutation === 'snapshot') d.snapshotId = '12';
    if (mutation === 'commit') d.commitOid = '0'.repeat(40);
    if (mutation === 'timestamp-number') d.commitEpochSecond = 1700000000;
    if (mutation === 'timestamp-negative') d.commitEpochSecond = '-1';
    if (mutation === 'timestamp-leading') d.commitEpochSecond = '01700000000';
    if (mutation === 'timestamp-limit') d.commitEpochSecond = '253402300800';
    if (mutation === 'timestamp-extra') d.commitEpochSecond = '1700000000\n';
    if (mutation === 'descriptor-field') d.keyId = 'not-allowed';
    if (mutation === 'entry-field') d.entries[0].keyBytes = 'not-allowed';
    if (mutation === 'empty') retained.length = 0;
    if (mutation === 'duplicate') retained.push(copy(d));
    if (mutation === 'path') { d.entries[0].path = '../escape'; d.manifestSha256 = retainedManifest(d.entries); }
    if (mutation === 'long-segment') {
      d.entries[0].path = 'x'.repeat(256); d.manifestSha256 = retainedManifest(d.entries);
      const chosen = copy(f.source.selection); chosen.snapshots[0].files[0].path = d.entries[0].path; options.selection = chosen;
    }
    if (mutation === 'size') d.entries[0].byteSize = LIMITS.objectBytes + 1;
    if (mutation === 'missing-capability') options.readRetainedBlob = null;
    if (mutation === 'overlap') options.scratchRoot = path.join(f.root, 'repos', 'scratch');
    await failed(f.retainedExport(options)); assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0);
  });
}

test('retained paths reject file/directory case aliases with matching complete selection and manifest', async t => {
  const f = await retainedCase(t); const retained = copy(f.source.retained), d = retained[0];
  d.entries = [{ ...d.entries[0], path: 'A/x.ts' }, { ...d.entries[0], path: 'a/y.ts' }];
  d.fileCount = 2; d.totalBytes *= 2; d.manifestSha256 = retainedManifest(d.entries);
  const chosen = copy(f.source.selection); chosen.snapshots[0].files = d.entries.map(({ path, gitOid, byteSize }) => ({ path, gitOid, byteSize }));
  await failed(f.retainedExport({ retained, selection: chosen }), 'INVALID'); assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0);
});

test('retained descriptors and entries are copied before asynchronous launch and getter values are never invoked', async t => {
  const f = await retainedCase(t); const descriptors = copy(f.source.retained);
  const pending = f.retainedExport({ retained: descriptors }); descriptors[0].commitEpochSecond = '1'; descriptors[0].entries[0].rawSha256 = '0'.repeat(64);
  await pending; const input = frames(Buffer.concat(f.calls[0].chunks)); assert.equal(input[1].commitEpochSecond, '1700000000');
  assert.equal(input[2].rawSha256, f.source.blob.rawSha256);
  let invoked = false; const poisoned = copy(f.source.retained);
  Object.defineProperty(poisoned[0], 'entries', { enumerable: true, get() { invoked = true; return []; } });
  await failed(f.retainedExport({ retained: poisoned }), 'INVALID'); assert.equal(invoked, false); assert.equal(f.calls.length, 1);
});

for (const mutation of ['corrupt', 'short', 'not-buffer', 'reader-throws', 'stdin-error']) {
  test(`retained ${mutation} fails with no complete stream and reaps the process`, async t => {
    const f = await retainedCase(t); let received;
    const readRetainedBlob = async () => {
      if (mutation === 'reader-throws') throw new Error('private-source text');
      received = mutation === 'not-buffer' ? new Uint8Array(f.source.bytes) : Buffer.from(f.source.bytes);
      if (mutation === 'corrupt') received[0] ^= 1;
      if (mutation === 'short') received = received.subarray(1);
      if (mutation === 'stdin-error') f.control.stdinError = true;
      return received;
    };
    await failed(f.retainedExport({ readRetainedBlob })); assert.equal(f.calls[0].closed, true);
    assert.equal(f.calls[0].eof, false); assert.equal(f.received.length, 0);
    if (Buffer.isBuffer(received)) assert.ok(received.every(byte => byte === 0));
  });
}

test('stdin backpressure defers vault access and cancellation clears a late returned blob', async t => {
  const f = await retainedCase(t); let releaseWrite, releaseBlob, supplied;
  f.control.delayInput = callback => { releaseWrite = callback; };
  const pending = f.retainedExport({ readRetainedBlob: () => new Promise(resolve => { releaseBlob = resolve; }) });
  const failure = failed(pending, 'CLOSED');
  while (!releaseWrite) await tick(); assert.equal(releaseBlob, undefined);
  f.control.delayInput = null; releaseWrite(); while (!releaseBlob) await tick();
  await f.worker.close(); await failure; supplied = Buffer.from(f.source.bytes); releaseBlob(supplied);
  await tick(); await tick(); assert.ok(supplied.every(byte => byte === 0));
  assert.equal(frames(Buffer.concat(f.calls[0].chunks)).some(item => item.kind === 'RETAINED_ENTRY'), false);
});

test('a static missing retained commit remains SOURCE_MISSING and does not become an empty export', async t => {
  const f = await retainedCase(t); const retained = copy(f.source.retained); retained[0].commitEpochSecond = null;
  f.control.output = [{ version: 1, kind: 'ERROR', code: 'SOURCE_MISSING' }];
  await failed(f.retainedExport({ retained }), 'SOURCE_MISSING'); assert.equal(f.received.length, 0);
  assert.equal(frames(Buffer.concat(f.calls[0].chunks))[1].commitEpochSecond, null);
});

test('opt-in real bundled JAR reconstructs retained commit without clone and repeats after restore with null timestamp',
  { skip: !liveJava || !liveJar, timeout: 60000 }, async t => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-resume-source-jar-'));
    await fs.chmod(root, 0o700);
    const source = retainedPublicSource(), repos = path.join(root, 'repos'), scratch = path.join(root, 'scratch'), stage = path.join(root, 'stage');
    for (const directory of [repos, scratch, stage]) await fs.mkdir(directory, { mode: 0o700 });
    const worker = await createBackupSourceWorker({ javaPath: await fs.realpath(liveJava), jarPath: await fs.realpath(liveJar) });
    t.after(async () => { await worker.close(); await fs.rm(root, { recursive: true, force: true }); });
    const exported = [];
    const readRetainedBlob = async request => {
      assert.deepEqual(request, { projectId: '7', sha256: source.blob.rawSha256, byteSize: source.bytes.length }); return Buffer.from(source.bytes);
    };
    const expected = await worker.exportProject({ reposRoot: repos, scratchRoot: scratch, projectId: '7', selection: source.selection,
      retained: source.retained, readRetainedBlob, writeRecord: async record => exported.push(record) });
    assert.deepEqual(expected, source.expected); assert.deepEqual(exported, source.output);
    assert.deepEqual(await fs.readdir(repos), []); assert.deepEqual(await fs.readdir(scratch), []);
    await worker.restoreProject({ stageRoot: stage, projectId: '7', selection: source.selection, expected,
      objects: records(exported.filter(record => record.kind === 'OBJECT')) });
    assert.equal(await fs.readFile(path.join(stage, '7', '.git', 'HEAD'), 'utf8'), `${source.commit.gitOid}\n`);
    const retained = copy(source.retained); retained[0].commitEpochSecond = null; const repeated = [];
    assert.deepEqual(await worker.exportProject({ reposRoot: stage, scratchRoot: scratch, projectId: '7', selection: source.selection,
      retained, readRetainedBlob, writeRecord: async record => repeated.push(record) }), expected);
    assert.deepEqual(repeated, exported); assert.deepEqual(await fs.readdir(scratch), []);
    await failed(worker.exportProject({ reposRoot: repos, scratchRoot: scratch, projectId: '7', selection: source.selection,
      retained, readRetainedBlob, writeRecord: async () => assert.fail('missing commit produced output') }), 'SOURCE_MISSING');
    assert.deepEqual(await fs.readdir(scratch), []);
  });

test('opt-in killed retained helper leaves an unadoptable orphan and a new transaction root reconstructs safely',
  { skip: !liveJava || !liveJar, timeout: 60000 }, async t => {
    const { spawn } = require('node:child_process'); const { setTimeout: delay } = require('node:timers/promises');
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-resume-source-crash-'));
    await fs.chmod(root, 0o700);
    const repos = path.join(root, 'repos'), scratch = path.join(root, 'crashed-transaction'), resumed = path.join(root, 'new-transaction');
    for (const directory of [repos, scratch, resumed]) await fs.mkdir(directory, { mode: 0o700 });
    const javaPath = await fs.realpath(liveJava), jarPath = await fs.realpath(liveJar), source = retainedPublicSource();
    // Fixed argv and an empty inherited environment; all bytes and paths remain private stdin.
    const child = spawn(javaPath, ['-Xmx512m', '-jar', jarPath, '--ci-backup-source-worker'],
      { cwd: path.dirname(jarPath), env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    let stdoutBytes = 0, stderrBytes = 0; child.stdout.on('data', bytes => { stdoutBytes += bytes.length; }); child.stderr.on('data', bytes => { stderrBytes += bytes.length; });
    child.stdin.on('error', () => {});
    let worker;
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; await worker?.close(); await fs.rm(root, { recursive: true, force: true }); });
    const { entries, ...header } = source.retained[0];
    const request = { version: 1, operation: 'EXPORT_RETAINED', reposRoot: repos, scratchRoot: scratch, projectId: '7', selection: source.selection, retainedCount: 1 };
    const input = Buffer.concat([frame(request), frame({ version: 1, kind: 'RETAINED_BEGIN', ...header }),
      frame({ version: 1, kind: 'RETAINED_ENTRY', ...entries[0], bytesBase64: source.bytes.toString('base64') })]);
    await new Promise((resolve, reject) => child.stdin.write(input, failure => failure ? reject(failure) : resolve())); input.fill(0);
    const insertedBlob = path.join(scratch, '7', '.git', 'objects', source.blob.gitOid.slice(0, 2), source.blob.gitOid.slice(2));
    const deadline = Date.now() + 15000;
    while (!(await fs.lstat(insertedBlob).catch(() => null))) {
      assert.ok(Date.now() < deadline, 'retained fixture did not reach its private object write');
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); await delay(10);
    }
    assert.equal((await fs.stat(path.join(scratch, '7'))).mode & 0o777, 0o700);
    child.kill('SIGKILL'); const exit = await closed; assert.equal(exit.signal, 'SIGKILL');
    assert.equal(stdoutBytes, 0); assert.equal(stderrBytes, 0);
    const preserved = await fs.readFile(insertedBlob), originalIdentity = await fs.stat(path.join(scratch, '7'), { bigint: true });
    worker = await createBackupSourceWorker({ javaPath, jarPath });
    const args = { reposRoot: repos, projectId: '7', selection: source.selection, retained: source.retained,
      readRetainedBlob: async () => Buffer.from(source.bytes), writeRecord: async () => {} };
    await failed(worker.exportProject({ ...args, scratchRoot: scratch }));
    assert.deepEqual(await fs.readFile(insertedBlob), preserved);
    assert.equal((await fs.stat(path.join(scratch, '7'), { bigint: true })).ino, originalIdentity.ino);
    const output = [];
    assert.deepEqual(await worker.exportProject({ ...args, scratchRoot: resumed, writeRecord: async record => output.push(record) }), source.expected);
    assert.deepEqual(output, source.output); assert.deepEqual(await fs.readdir(resumed), []); assert.deepEqual(await fs.readdir(repos), []);
    assert.deepEqual(await fs.readFile(insertedBlob), preserved);
  });
