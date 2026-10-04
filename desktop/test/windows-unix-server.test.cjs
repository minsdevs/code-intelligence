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
  return stderr.match(/^(WINDOWS_JAVA_PROBE_(?:OPEN|CONNECT(?:_(?:ACCESS_DENIED|REFUSED|INVALID_ARGUMENT|PATH_NOT_FOUND|ADDRESS_UNAVAILABLE|TIMED_OUT|OTHER))?|WRITE|FIN|PREFIX|LENGTH|BODY|EOF|OUTPUT)_FAILED)\r?$/m)?.[1]
    ?? 'WINDOWS_JAVA_PROBE_PROCESS_FAILED';
}
test('Java probe diagnostics accept only fixed phase and connect subreason enums', () => {
  for (const reason of ['ACCESS_DENIED', 'REFUSED', 'INVALID_ARGUMENT', 'PATH_NOT_FOUND', 'ADDRESS_UNAVAILABLE', 'TIMED_OUT', 'OTHER']) {
    const code = 'WINDOWS_JAVA_PROBE_CONNECT_' + reason + '_FAILED';
    assert.equal(probeFailure(code + '\r\n'), code);
  }
  for (const value of ['secret path', 'WINDOWS_JAVA_PROBE_CONNECT_PRIVATE_PATH_FAILED', 'WINDOWS_JAVA_PROBE_CONNECT_REFUSED_FAILED secret']) {
    assert.equal(probeFailure(value), 'WINDOWS_JAVA_PROBE_PROCESS_FAILED');
  }
});

function probe(socketPath, request, mode = 'normal') {
  assert.ok(process.env.JAVA_HOME, 'Native AF_UNIX acceptance requires Java 21 JAVA_HOME');
  const child = spawn(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'),
    [path.join(__dirname, 'fixtures', 'PrivateUnixProbe.java'), socketPath, mode],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 });
  const chunks = []; let stderr = ''; let written;
  const didWrite = new Promise(resolve => { written = resolve; });
  child.stdout.on('data', b => chunks.push(b)); child.stderr.on('data', b => { stderr += b; if (stderr.includes('WRITTEN')) written(); });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      try {
        if (signal !== null || code !== 0) {
          const failure = probeFailure(stderr);
          throw Object.assign(new Error(failure), { code: failure });
        }
        const bytes = Buffer.concat(chunks); resolve(bytes.length ? JSON.parse(bytes) : null);
      }
      catch (error) { reject(error); }
    });
  });
  child.stdin.end(frame(request)); return { result, didWrite };
}
test('real Windows AF_UNIX interoperates with Java21 FIN/EOF, Unicode, full-size source frames and AI channel auth',
  { skip: !native, timeout: 90000 }, async t => {
    const boundary = createWindowsBoundary(runtime);
    assert.ok(process.env.RUNNER_TEMP, 'Native AF_UNIX acceptance requires a short private RUNNER_TEMP');
    const directory = path.join(process.env.RUNNER_TEMP, 'u-' + crypto.randomBytes(4).toString('hex') + '-한');
    boundary.createDirectory(directory);
    let source; let ai;
    t.after(async () => { await ai?.close(); await source?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const bytes = Buffer.alloc(2 * 1024 * 1024, 65); const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    let puts = 0;
    const token = 'a'.repeat(64);
    source = await createSourceBroker({ socketPath: path.join(directory, 's'), authToken: token, windowsBoundary: boundary,
      vault: { async put(value) { puts++; assert.deepEqual(value.bytes, bytes); return { projectId: '1', sha256: hash, byteSize: bytes.length, keyId: 'b'.repeat(32) }; }, async read() { return Buffer.from(bytes); } } });
    assert.throws(() => fs.renameSync(path.join(directory, 's'), path.join(directory, 'moved')));
    assert.throws(() => fs.unlinkSync(path.join(directory, 's')));
    const request = { version: 1, requestId: crypto.randomUUID(), auth: token, operation: 'PUT', projectId: '1', sha256: hash, byteSize: bytes.length, bytes: bytes.toString('base64') };
    const held = probe(path.join(directory, 's'), request, 'hold');
    await Promise.race([held.didWrite, held.result.then(() => assert.fail('Peer finished before FIN barrier'))]);
    assert.equal(puts, 0); assert.equal((await held.result).ok, true); assert.equal(puts, 1);
    const rejected = await probe(path.join(directory, 's'), request, 'extra').result.catch(() => null);
    assert.equal(rejected, null); assert.equal(puts, 1);
    const { bytes: ignored, ...read } = request;
    const response = await probe(path.join(directory, 's'), { ...read, operation: 'READ' }).result;
    assert.deepEqual(Buffer.from(response.result.bytes, 'base64'), bytes);
    let calls = 0;
    ai = await openAiEgressBridge({ directory, capability: token, epoch: 'c'.repeat(64), windowsBoundary: boundary,
      handler: async () => { calls++; return { ready: true }; } });
    const aiRequest = { version: 1, auth: token, epoch: 'c'.repeat(64), callId: crypto.randomUUID(), operation: 'STATUS', payload: {} };
    assert.equal((await probe(ai.socketPath, aiRequest).result).ok, true);
    // Invalid capability must close the connection before a response/domain dispatch.
    await assert.rejects(probe(ai.socketPath, { ...aiRequest, auth: 'd'.repeat(64) }).result); assert.equal(calls, 1);
    await ai.close(); await source.close();
    assert.equal(fs.existsSync(ai.socketPath), false); assert.equal(fs.existsSync(path.join(directory, 's')), false);
  });

// A reference listener isolates the Windows filesystem-sharing contract from the
// production bridge. All handles/processes below own only this disposable path.
async function controlledProcess(t, command, args, marker, fallback) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 });
  let stderr = ''; let started = false; let readyResolve; let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const failure = () => {
    const code = stderr.match(/^(WINDOWS_UNIX_PIN_(?:OPEN|DACL|PROCESS)_FAILED)\r?$/m)?.[1]
      ?? (stderr.includes('WINDOWS_JAVA_PROBE_') ? probeFailure(stderr) : fallback);
    return Object.assign(new Error(code), { code });
  };
  child.stdout.resume(); child.stdin.on('error', () => {});
  child.stderr.on('data', bytes => {
    stderr = (stderr + bytes).slice(-8192);
    if (!started && stderr.split(/\r?\n/).includes(marker)) { started = true; readyResolve(); }
  });
  child.once('error', () => readyReject(failure()));
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    if (!started) readyReject(failure());
    resolve({ code, signal });
  }));
  let closing;
  const close = () => closing ??= (async () => {
    child.stdin.end();
    const result = await closed;
    if (result.code !== 0 || result.signal !== null) throw failure();
  })();
  t.after(() => close().catch(() => {}));
  await ready;
  return { close };
}
function pinScript(socketPath, access) {
  // Keep the production DACL/flags/share mask, varying only desired access.
  const additionalAccess = { metadata: 0, 'read-data': 1, delete: 0x10000 }[access];
  return String.raw`
$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class UnixLeafPin {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint length);
  [DllImport("advapi32.dll")]
  static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr acl, out bool defaulted);
  [DllImport("advapi32.dll")]
  static extern uint SetSecurityInfo(IntPtr handle, uint type, uint information, IntPtr owner, IntPtr group, IntPtr acl, IntPtr sacl);
  public static void Run(string path, uint additionalAccess) {
    IntPtr handle = CreateFileW(path, 0x60080u | additionalAccess, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new InvalidOperationException("OPEN");
    try {
      string sid = WindowsIdentity.GetCurrent().User.Value;
      string sddl = "O:" + sid + "D:P(A;;FA;;;" + sid + ")(A;;FA;;;SY)";
      IntPtr descriptor; uint length;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, out length)) throw new InvalidOperationException("DACL");
      try {
        bool present, defaulted; IntPtr acl;
        if (!GetSecurityDescriptorDacl(descriptor, out present, out acl, out defaulted) || !present || acl == IntPtr.Zero
            || SetSecurityInfo(handle, 1, 0x80000004u, IntPtr.Zero, IntPtr.Zero, acl, IntPtr.Zero) != 0) throw new InvalidOperationException("DACL");
      } finally { LocalFree(descriptor); }
      Console.Error.WriteLine("PINNED"); Console.Error.Flush();
      Console.In.ReadLine();
    } finally { CloseHandle(handle); }
  }
}
'@
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(socketPath).toString('base64')}'))
[UnixLeafPin]::Run($p,${additionalAccess})
} catch {
  $e=$_.Exception; while ($e.InnerException) { $e=$e.InnerException }
  $phase=if ($e.Message -eq 'OPEN') {'OPEN'} elseif ($e.Message -eq 'DACL') {'DACL'} else {'PROCESS'}
  [Console]::Error.WriteLine('WINDOWS_UNIX_PIN_'+$phase+'_FAILED'); exit 1
}
`;
}
// Temporary causal matrix: remove after the hosted Windows result establishes
// the required leaf access. Metadata-only opens do not establish namespace pins.
for (const unicode of [false, true]) for (const access of ['metadata', 'read-data', 'delete']) {
  test('real Windows Java reference socket isolates ' + access + ' sharing ' + (unicode ? 'Unicode' : 'ASCII'),
    { skip: !native, timeout: 90000 }, async t => {
      assert.ok(process.env.JAVA_HOME); assert.ok(process.env.RUNNER_TEMP);
      const boundary = createWindowsBoundary(runtime);
      const directory = path.join(process.env.RUNNER_TEMP, 'p-' + crypto.randomBytes(4).toString('hex') + (unicode ? '-한' : ''));
      boundary.createDirectory(directory);
      const processes = [];
      t.after(async () => {
        try { for (const process of processes.reverse()) await process.close().catch(() => {}); }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
      });
      const socketPath = path.join(directory, 's');
      const listener = await controlledProcess(t, path.join(process.env.JAVA_HOME, 'bin', 'java.exe'),
        [path.join(__dirname, 'fixtures', 'PrivateUnixProbe.java'), socketPath, 'listen'], 'LISTENING', 'WINDOWS_JAVA_PROBE_PROCESS_FAILED');
      processes.push(listener);
      await probe(socketPath, {}, 'connect').result;
      const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const pin = await controlledProcess(t, shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(pinScript(socketPath, access), 'utf16le').toString('base64')], 'PINNED', 'WINDOWS_UNIX_PIN_PROCESS_FAILED');
      processes.push(pin);
      if (access !== 'metadata') {
        assert.throws(() => fs.renameSync(socketPath, path.join(directory, 'moved')));
        assert.throws(() => fs.unlinkSync(socketPath));
      }
      if (access === 'delete') {
        // This is a causal experiment, not evidence until executed on Windows.
        await assert.rejects(probe(socketPath, {}, 'connect').result,
          error => /^WINDOWS_JAVA_PROBE_CONNECT_[A-Z_]+_FAILED$/.test(error.code));
      } else await probe(socketPath, {}, 'connect').result;
      await pin.close();
      // Release restores connectivity without changing path or private DACL.
      await probe(socketPath, {}, 'connect').result;
      await listener.close();
    });
}

