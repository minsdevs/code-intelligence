'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createWindowsUnixServer } = require('../src/windows-unix-server.cjs');
const { createWindowsBoundary } = require('../src/windows-native-boundary.cjs');
const { createSourceBroker } = require('../src/source-broker.cjs');
const { openAiEgressBridge } = require('../src/ai-egress-bridge.cjs');
function word(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function frame(value) { const b = Buffer.from(JSON.stringify(value)); return Buffer.concat([word(b.length), b]); }
function event(type, id, body = Buffer.alloc(0)) { return Buffer.concat([word(body.length + 5), Buffer.from([type]), word(id), body]); }
function fixture(connect, overrides = {}) {
  const writes = [];
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _, done) { writes.push(Buffer.from(chunk)); done(); } });
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
  const errors = [];
  const server = createWindowsUnixServer({ windowsBoundary: { launch(mode) { assert.equal(mode, 'unix-server'); return child; } },
    maxRequest: 3 * 1024 * 1024, maxResponse: 4 * 1024 * 1024, maxConnections: 16, frameTimeoutMs: 3000, ...overrides }, connect);
  server.on('error', error => errors.push(error));
  return { server, child, writes, errors };
}
async function stop(f) {
  const closed = new Promise(resolve => f.server.close(resolve));
  f.child.stdout.write(event(4, 0)); f.child.emit('close', 0, null);
  assert.equal(await closed, undefined);
}
test('native adapter preserves fragmented binary frames, out-of-order peers, response FIN command and cleanup ACK', async () => {
  const received = [];
  const f = fixture(socket => {
    let request;
    socket.on('data', bytes => { request = Buffer.from(bytes); });
    socket.on('end', () => { received.push(request); socket.end(frame({ ok: true })); });
  });
  const ready = once(f.server, 'listening'); f.server.listen('C:\\private\\한글.sock');
  const bytes = event(1, 0); f.child.stdout.write(bytes.subarray(0, 3)); f.child.stdout.write(bytes.subarray(3)); await ready;
  const large = frame({ value: 'x'.repeat(2 * 1024 * 1024) });
  const first = event(2, 9, large);
  for (let offset = 0; offset < first.length; offset += 65536) f.child.stdout.write(first.subarray(offset, offset + 65536));
  f.child.stdout.write(Buffer.concat([event(2, 2, frame({ next: true })), event(3, 9), event(3, 2), event(3, 15)]));
  assert.deepEqual(received, [large, frame({ next: true })]);
  assert.equal(f.writes[1][4], 1); assert.equal(f.writes[1].readUInt32BE(5), 9);
  assert.equal(f.errors.length, 0); await stop(f);
});
test('native helper loss destroys live channels and never acknowledges successful close', async () => {
  let socket;
  const f = fixture(value => { socket = value; socket.on('data', () => {}); });
  f.server.listen('C:\\private\\s'); f.child.stdout.write(event(1, 0)); f.child.stdout.write(event(2, 1, frame({ a: 1 })));
  f.child.stderr.write('unsafe native detail');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.destroyed, true); assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].message, 'Windows private IPC unavailable.');
  assert.ok(await new Promise(resolve => f.server.close(resolve)) instanceof Error);
});
test('oversized native output and noncanonical Unicode paths fail closed', async () => {
  const f = fixture(() => assert.fail('must not dispatch'));
  for (const file of ['C:\\p\\' + '한'.repeat(34), 'C:\\p\\\ud800.sock', 'C:\\p\\..\\s']) assert.throws(() => f.server.listen(file));
  f.server.listen('C:\\private\\s'); f.child.stdout.write(word(3 * 1024 * 1024 + 10));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.errors.length, 1);
});
test('native shutdown requires explicit owned-leaf cleanup acknowledgement', async () => {
  const f = fixture(() => {}); f.server.listen('C:\\private\\s'); f.child.stdout.write(event(1, 0));
  const closed = new Promise(resolve => f.server.close(resolve)); f.child.emit('close', 0, null);
  assert.ok(await closed instanceof Error);
});
const runtime = process.env.CI_WINDOWS_BOUNDARY_TEST_RUNTIME;
const native = process.platform === 'win32' && !!runtime;
function probeFailure(stderr) {
  return stderr.match(/^(WINDOWS_JAVA_PROBE_(?:INPUT|STDIN|STDOUT|STDERR|PATH|OPEN|CONNECT(?:_(?:ACCESS_DENIED|REFUSED|INVALID_ARGUMENT|INVALID_PATH|PATH_NOT_FOUND|ADDRESS_UNAVAILABLE|TIMED_OUT|OTHER))?|WRITE|FIN|PREFIX|LENGTH|BODY|EOF|OUTPUT)_FAILED)\r?$/m)?.[1]
    ?? 'WINDOWS_JAVA_PROBE_PROCESS_FAILED';
}
test('Java probe diagnostics accept only fixed phase and connect subreason enums', () => {
  for (const reason of ['ACCESS_DENIED', 'REFUSED', 'INVALID_ARGUMENT', 'INVALID_PATH', 'PATH_NOT_FOUND', 'ADDRESS_UNAVAILABLE', 'TIMED_OUT', 'OTHER']) {
    const code = 'WINDOWS_JAVA_PROBE_CONNECT_' + reason + '_FAILED';
    assert.equal(probeFailure(code + '\r\n'), code);
  }
  for (const value of ['secret path', 'WINDOWS_JAVA_PROBE_CONNECT_PRIVATE_PATH_FAILED', 'WINDOWS_JAVA_PROBE_CONNECT_REFUSED_FAILED secret']) {
    assert.equal(probeFailure(value), 'WINDOWS_JAVA_PROBE_PROCESS_FAILED');
  }
});

function exchangeProbe(child, input, mode, { signal, diagnostic = () => {}, now = () => performance.now(),
  schedule = setTimeout, unschedule = clearTimeout } = {}) {
  const started = now(), chunks = []; let readyAt, line = '', dropping = false, outputSize = 0;
  let written, timer, failure, javaFailure, pipeFailure, finished = false, terminating = false;
  const didWrite = new Promise(resolve => { written = resolve; });
  const terminate = code => {
    if (finished || terminating) return;
    terminating = true;
    failure ??= code;
    // Only this fixture's child is owned; abort also covers the whole 90s test.
    child.kill('SIGKILL');
  };
  const abort = () => terminate('WINDOWS_JAVA_PROBE_ABORTED');
  const result = new Promise((resolve, reject) => {
    const stdout = bytes => {
      outputSize += bytes.length;
      if (outputSize > 4 * 1024 * 1024) terminate('WINDOWS_JAVA_PROBE_OUTPUT_FAILED');
      else chunks.push(bytes);
    };
    const stderr = bytes => {
      for (const character of bytes.toString('utf8')) {
        if (character === '\n') {
          const value = dropping ? '' : line.replace(/\r$/, '');
          if (value === 'WINDOWS_JAVA_PROBE_READY' && readyAt === undefined && !failure) {
            readyAt = now(); unschedule(timer);
            timer = schedule(() => terminate('WINDOWS_JAVA_PROBE_EXCHANGE_TIMEOUT'), 15000);
            child.stdin.end(input);
          } else if (value === 'WRITTEN' && readyAt !== undefined) written();
          else {
            const code = probeFailure(value);
            if (code !== 'WINDOWS_JAVA_PROBE_PROCESS_FAILED') javaFailure ??= code;
          }
          line = ''; dropping = false;
        } else if (!dropping) {
          if (line.length === 256) { line = ''; dropping = true; } else line += character;
        }
      }
    };
    const streams = [['STDIN', child.stdin], ['STDOUT', child.stdout], ['STDERR', child.stderr]];
    const handlers = streams.map(([phase, stream]) => {
      const onError = () => { pipeFailure ??= 'WINDOWS_JAVA_PROBE_' + phase + '_FAILED'; };
      stream.on('error', onError); return [stream, onError];
    });
    child.stdout.on('data', stdout); child.stderr.on('data', stderr);
    child.once('error', () => { failure ??= readyAt === undefined ? 'WINDOWS_JAVA_PROBE_STARTUP_FAILED' : 'WINDOWS_JAVA_PROBE_PROCESS_FAILED'; });
    child.once('close', (exitCode, exitSignal) => {
      if (finished) return; finished = true;
      unschedule(timer); signal?.removeEventListener('abort', abort);
      child.stdout.off('data', stdout); child.stderr.off('data', stderr);
      for (const [stream, onError] of handlers) stream.off('error', onError);
      let value, code = failure ?? javaFailure ?? (readyAt === undefined ? 'WINDOWS_JAVA_PROBE_STARTUP_FAILED'
        : pipeFailure ?? (exitCode !== 0 || exitSignal !== null ? 'WINDOWS_JAVA_PROBE_PROCESS_FAILED' : 'SUCCESS'));
      if (code === 'SUCCESS') {
        try { const bytes = Buffer.concat(chunks); value = bytes.length ? JSON.parse(bytes) : null; }
        catch { code = 'WINDOWS_JAVA_PROBE_OUTPUT_FAILED'; }
      }
      const ended = now(), duration = value => Math.min(300000, Math.max(0, Math.round(value)));
      const numericExit = Number.isInteger(exitCode) && exitCode >= -2147483648 && exitCode <= 4294967295 ? exitCode : 'null';
      const fixedSignal = exitSignal === null ? 'NONE' : ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(exitSignal) ? exitSignal : 'UNKNOWN';
      try { diagnostic(`WINDOWS_JAVA_PROBE_RESULT ${mode} ${readyAt === undefined ? 'STARTUP' : 'EXCHANGE'} ${numericExit} ${fixedSignal} `
        + `${duration((readyAt ?? ended) - started)} ${readyAt === undefined ? 0 : duration(ended - readyAt)} ${duration(ended - started)} ${code}`); }
      catch { /* Diagnostics cannot replace the probe's actual outcome. */ }
      if (code === 'SUCCESS') resolve(value);
      else reject(Object.assign(new Error(code), { code }));
    });
    timer = schedule(() => terminate('WINDOWS_JAVA_PROBE_STARTUP_TIMEOUT'), 30000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  // Test cancellation may interrupt the caller before it awaits the owned child.
  result.catch(() => {});
  return { result, didWrite };
}

function probe(t, socketPath, request, mode = 'normal') {
  assert.ok(process.env.JAVA_HOME, 'Native AF_UNIX acceptance requires Java 21 JAVA_HOME');
  assert.ok(['normal', 'hold', 'extra'].includes(mode));
  if (t.signal.aborted) throw Object.assign(new Error('WINDOWS_JAVA_PROBE_ABORTED'), { code: 'WINDOWS_JAVA_PROBE_ABORTED' });
  const child = spawn(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    [path.join(__dirname, 'fixtures', 'PrivateUnixProbe.java'), mode],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const encodedPath = Buffer.from(socketPath, 'utf8');
  const operation = exchangeProbe(child, Buffer.concat([word(encodedPath.length), encodedPath, frame(request)]), mode,
    { signal: t.signal, diagnostic: value => t.diagnostic(value) });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await operation.result.catch(() => {});
  };
  return { ...operation, close };
}

function probeFixture() {
  const child = new EventEmitter(), writes = [], timers = [], diagnostics = [], kills = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(bytes, _, done) { writes.push(Buffer.from(bytes)); done(); } });
  child.kill = signal => {
    kills.push(signal);
    queueMicrotask(() => { child.stdin.emit('error', new Error('private pipe detail')); child.emit('close', null, signal); });
  };
  const controller = new AbortController(); let clock = 0;
  const operation = exchangeProbe(child, Buffer.from('private fixture input'), 'hold', {
    signal: controller.signal, diagnostic: value => diagnostics.push(value), now: () => clock,
    schedule(callback, duration) { const timer = { callback, duration, cleared: false }; timers.push(timer); return timer; },
    unschedule(timer) { if (timer) timer.cleared = true; },
  });
  return { child, writes, timers, diagnostics, kills, controller, operation, time: value => { clock = value; } };
}

test('Java fixture sends no stdin until exact READY and keeps the original 15s exchange budget', async () => {
  const f = probeFixture();
  assert.equal(f.writes.length, 0); assert.equal(f.timers[0].duration, 30000);
  for (const line of ['private WINDOWS_JAVA_PROBE_READY', 'WINDOWS_JAVA_PROBE_READY private',
    'x'.repeat(1024) + 'WINDOWS_JAVA_PROBE_READY']) f.child.stderr.write(line + '\n');
  assert.equal(f.writes.length, 0);
  f.time(25000); f.child.stderr.write('WINDOWS_JAVA_PROBE_RE'); f.child.stderr.write('ADY\r\n');
  assert.deepEqual(f.writes, [Buffer.from('private fixture input')]);
  assert.equal(f.timers[0].cleared, true); assert.equal(f.timers[1].duration, 15000);
  f.child.stderr.write('WINDOWS_JAVA_PROBE_READY\nWRITTEN\n'); await f.operation.didWrite;
  assert.equal(f.writes.length, 1); assert.equal(f.timers.length, 2);
  f.child.stdout.write('{"ok":true}'); f.time(25200); f.child.emit('close', 0, null);
  assert.deepEqual(await f.operation.result, { ok: true }); assert.equal(f.timers[1].cleared, true);
  assert.deepEqual(f.diagnostics, ['WINDOWS_JAVA_PROBE_RESULT hold EXCHANGE 0 NONE 25000 200 25200 SUCCESS']);
  f.controller.abort(); f.timers[1].callback(); assert.equal(f.kills.length, 0);
  assert.equal(f.child.stdout.listenerCount('data'), 0); assert.equal(f.child.stderr.listenerCount('data'), 0);
});

for (const phase of ['STARTUP', 'EXCHANGE']) test('Java fixture ' + phase + ' deadline stays primary over termination pipe errors', async () => {
  const f = probeFixture();
  if (phase === 'EXCHANGE') { f.time(20000); f.child.stderr.write('WINDOWS_JAVA_PROBE_READY\n'); }
  const timer = f.timers.at(-1); f.time(phase === 'STARTUP' ? 30000 : 35000); timer.callback();
  await assert.rejects(f.operation.result, { code: 'WINDOWS_JAVA_PROBE_' + phase + '_TIMEOUT' });
  assert.deepEqual(f.kills, ['SIGKILL']); assert.equal(timer.cleared, true);
  assert.equal(f.writes.length, phase === 'STARTUP' ? 0 : 1);
  assert.match(f.diagnostics[0], new RegExp('WINDOWS_JAVA_PROBE_' + phase + '_TIMEOUT$'));
  assert.doesNotMatch(f.diagnostics[0], /private|STDIN_FAILED/);
});

test('Java fixture whole-test abort terminates its owned peer and startup exit stays distinct', async () => {
  const aborted = probeFixture(); aborted.child.stderr.write('WINDOWS_JAVA_PROBE_READY\n');
  aborted.controller.abort(); await assert.rejects(aborted.operation.result, { code: 'WINDOWS_JAVA_PROBE_ABORTED' });
  assert.deepEqual(aborted.kills, ['SIGKILL']); assert.ok(aborted.timers.every(timer => timer.cleared));
  const startup = probeFixture(); startup.child.stderr.write('private JVM launch detail\n'); startup.time(120);
  startup.child.emit('close', 1, null);
  await assert.rejects(startup.operation.result, { code: 'WINDOWS_JAVA_PROBE_STARTUP_FAILED' });
  assert.deepEqual(startup.diagnostics, ['WINDOWS_JAVA_PROBE_RESULT hold STARTUP 1 NONE 120 0 120 WINDOWS_JAVA_PROBE_STARTUP_FAILED']);
  assert.equal(startup.writes.length, 0); assert.equal(startup.timers[0].cleared, true);
});

test('real Windows AF_UNIX interoperates with Java21 FIN/EOF, Unicode, full-size source frames and AI channel auth',
  { skip: !native, timeout: 90000 }, async t => {
    const boundary = createWindowsBoundary(runtime);
    assert.ok(process.env.RUNNER_TEMP, 'Native AF_UNIX acceptance requires a short private RUNNER_TEMP');
    const directory = path.join(process.env.RUNNER_TEMP, 'u-' + crypto.randomBytes(4).toString('hex') + '-한');
    boundary.createDirectory(directory);
    let source; let ai; const peers = [];
    const peer = (...args) => { const value = probe(t, ...args); peers.push(value); return value; };
    t.after(async () => {
      await Promise.all(peers.map(value => value.close()));
      await ai?.close(); await source?.close(); fs.rmSync(directory, { recursive: true, force: true });
    });
    const bytes = Buffer.alloc(2 * 1024 * 1024, 65); const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    let puts = 0;
    const token = 'a'.repeat(64);
    source = await createSourceBroker({ socketPath: path.join(directory, 's'), authToken: token, windowsBoundary: boundary,
      vault: { async put(value) { puts++; assert.deepEqual(value.bytes, bytes); return { projectId: '1', sha256: hash, byteSize: bytes.length, keyId: 'b'.repeat(32) }; }, async read() { return Buffer.from(bytes); } } });
    assert.throws(() => fs.renameSync(path.join(directory, 's'), path.join(directory, 'moved')));
    assert.throws(() => fs.unlinkSync(path.join(directory, 's')));
    const request = { version: 1, requestId: crypto.randomUUID(), auth: token, operation: 'PUT', projectId: '1', sha256: hash, byteSize: bytes.length, bytes: bytes.toString('base64') };
    const held = peer(path.join(directory, 's'), request, 'hold');
    await Promise.race([held.didWrite, held.result.then(() => assert.fail('Peer finished before FIN barrier'))]);
    assert.equal(puts, 0); assert.equal((await held.result).ok, true); assert.equal(puts, 1);
    const rejected = await peer(path.join(directory, 's'), request, 'extra').result.catch(() => null);
    assert.equal(rejected, null); assert.equal(puts, 1);
    const { bytes: ignored, ...read } = request;
    const response = await peer(path.join(directory, 's'), { ...read, operation: 'READ' }).result;
    assert.deepEqual(Buffer.from(response.result.bytes, 'base64'), bytes);
    let calls = 0;
    ai = await openAiEgressBridge({ directory, capability: token, epoch: 'c'.repeat(64), windowsBoundary: boundary,
      handler: async () => { calls++; return { ready: true }; } });
    const aiRequest = { version: 1, auth: token, epoch: 'c'.repeat(64), callId: crypto.randomUUID(), operation: 'STATUS', payload: {} };
    assert.equal((await peer(ai.socketPath, aiRequest).result).ok, true);
    // Invalid capability must close the connection before a response/domain dispatch.
    await assert.rejects(peer(ai.socketPath, { ...aiRequest, auth: 'd'.repeat(64) }).result); assert.equal(calls, 1);
    await ai.close(); await source.close();
    assert.equal(fs.existsSync(ai.socketPath), false); assert.equal(fs.existsSync(path.join(directory, 's')), false);
  });
