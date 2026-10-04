'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { createWindowsBoundary, managedWire, localPath } = require('../src/windows-native-boundary.cjs');

// This input is test-only. Production code has no helper-path environment override.
const runtime = process.env.CI_WINDOWS_BOUNDARY_TEST_RUNTIME;
const enabled = process.platform === 'win32' && !!runtime;
function fixture(t) {
  const boundary = createWindowsBoundary(runtime);
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-native-boundary-'));
  const root = path.join(container, 'private space 한글');
  boundary.createDirectory(root);
  const children = [];
  const ownChild = child => {
    const closed = new Promise(resolve => child.once('close', resolve));
    children.push({ child, closed }); return child;
  };
  t.after(async () => {
    for (const { child, closed } of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    await fs.promises.rm(container, { recursive: true, force: true });
  });
  return { boundary, root, ownChild };
}
function reply(child) {
  let buffered = '';
  return new Promise((resolve, reject) => {
    const closed = () => { cleanup(); reject(new Error('Lease closed before response')); };
    const data = chunk => { buffered += chunk.toString('ascii'); if (buffered.endsWith('\n')) { cleanup(); resolve(buffered.trimEnd()); } };
    const cleanup = () => { child.stdout.off('data', data); child.off('close', closed); };
    child.stdout.on('data', data); child.once('close', closed);
  });
}
async function acquire(boundary, root, nonce = 'a'.repeat(32)) {
  const child = boundary.launch('lease'); const ready = reply(child);
  child.stdin.write(`ACQUIRE\t${Buffer.from(root).toString('base64url')}\ttest-installation\tpurpose-keyring\t${nonce}\n`);
  assert.equal(await ready, `READY\t${nonce}`); return child;
}
test('Windows path boundary rejects network/device/stream and normalization aliases', () => {
  for (const candidate of ['\\\\server\\share\\x', '\\\\?\\C:\\x', 'C:relative', 'C:\\x:stream', 'C:\\x\\..\\y', 'C:\\CON.txt', 'C:\\name.'])
    assert.throws(() => localPath(candidate));
  assert.equal(localPath('C:\\private space\\한글.pem'), 'C:\\private space\\한글.pem');
});
test('real NTFS protected creation/read/atomic replacement and recovery refusal', { skip: !enabled }, t => {
  const { boundary, root } = fixture(t); const file = path.join(root, 'secret.bin');
  boundary.writeFresh(file, Buffer.from('first'));
  assert.equal(boundary.readPrivate(file, 32).toString(), 'first');
  assert.throws(() => boundary.writeFresh(file, Buffer.from('overwrite')));
  assert.throws(() => boundary.readPrivate(file, 4));
  boundary.replacePrivate(file, Buffer.from('second'));
  assert.equal(boundary.readPrivate(file, 32).toString(), 'second');
  boundary.writeFresh(`${file}.pending`, Buffer.from('interrupted'));
  assert.throws(() => boundary.replacePrivate(file, Buffer.from('third')));
  assert.equal(boundary.readPrivate(file, 32).toString(), 'second');
});
test('real NTFS rejects hardlinks, streams, junction ancestors and broad inherited private ACLs', { skip: !enabled }, t => {
  const { boundary, root } = fixture(t); const file = path.join(root, 'secret.bin');
  boundary.writeFresh(file, Buffer.from('secret'));
  fs.linkSync(file, path.join(root, 'hardlink'));
  assert.throws(() => boundary.readPrivate(file, 32));
  fs.unlinkSync(path.join(root, 'hardlink'));
  assert.throws(() => boundary.readPrivate(`${file}:stream`, 32));
  const junction = path.join(path.dirname(root), 'junction');
  fs.symlinkSync(root, junction, 'junction');
  assert.throws(() => boundary.readPrivate(path.join(junction, 'secret.bin'), 32));
  const inherited = path.join(path.dirname(root), 'inherited-file');
  fs.writeFileSync(inherited, 'unprotected');
  assert.throws(() => boundary.readPrivate(inherited, 32));
});
test('native leases contend, enforce monotonic protocol and release on guardian death', { skip: !enabled, timeout: 20000 }, async t => {
  const { boundary, root, ownChild } = fixture(t);
  boundary.createDirectory(path.join(root, 'purpose-keyring'));
  const first = ownChild(await acquire(boundary, root));
  const second = ownChild(boundary.launch('lease')); const secondClosed = once(second, 'close');
  second.stdin.write(`ACQUIRE\t${Buffer.from(root).toString('base64url')}\ttest-installation\tpurpose-keyring\t${'b'.repeat(32)}\n`);
  assert.notEqual((await secondClosed)[0], 0);
  let response = reply(first); first.stdin.write('CHECK\t1\n'); assert.equal(await response, 'HELD\t1');
  const killed = once(first, 'close'); first.kill(); await killed;
  const replacement = ownChild(await acquire(boundary, root));
  response = reply(replacement); const closed = once(replacement, 'close');
  replacement.stdin.write('RELEASE\t1\n'); assert.equal(await response, 'RELEASED\t1'); assert.equal((await closed)[0], 0);
});
function frames(child) {
  const values = []; let buffered = Buffer.alloc(0);
  child.stdout.on('data', bytes => {
    buffered = Buffer.concat([buffered, bytes]);
    while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
      const length = buffered.readUInt32BE(0); values.push(JSON.parse(buffered.subarray(4, length + 4))); buffered = buffered.subarray(length + 4);
    }
  });
  return values;
}
function launchProbe(boundary, root, script) {
  const child = boundary.launch('managed');
  child.stdin.write(managedWire({ command: process.execPath, cwd: root, logPath: path.join(root, 'process.log'),
    args: ['-e', script], env: { SystemRoot: process.env.SystemRoot }, bootstrap: Buffer.alloc(0) }));
  return child;
}
test('native suspended launch owns descendants before execution and proves stopped', { skip: !enabled, timeout: 30000 }, async t => {
  const { boundary, root } = fixture(t);
  const child = launchProbe(boundary, root, 'process.stdout.write("native-child"); process.exit(17)');
  const messages = frames(child); const closed = await once(child, 'close');
  assert.equal(closed[0], 0); assert.equal(messages[0].kind, 'STARTED');
  assert.deepEqual(messages[1], { version: 1, kind: 'EXIT', pid: messages[0].pid, exitCode: 17, stopped: true });
  assert.equal(fs.readFileSync(path.join(root, 'process.log'), 'utf8'), 'native-child');
});
test('guardian death closes its non-inherited Job and kills a live descendant', { skip: !enabled, timeout: 30000 }, async t => {
  const { boundary, root, ownChild } = fixture(t); const pidFile = path.join(root, 'descendant.pid');
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const child = ownChild(launchProbe(boundary, root, script)); const messages = frames(child);
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(pidFile)); const descendant = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(messages[0]?.kind, 'STARTED'); const parent = Number(messages[0].pid);
  const closed = once(child, 'close'); child.kill(); await closed;
  for (const pid of [parent, descendant]) {
    let alive = true;
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { alive = false; break; } await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(alive, false);
  }
});
test('native TLS material supports a real pinned loopback handshake and rejects mismatched keys', { skip: !enabled, timeout: 30000 }, async t => {
  const { boundary, root } = fixture(t);
  const crypto = require('node:crypto'); const https = require('node:https');
  require('reflect-metadata'); const x509 = require('@peculiar/x509');
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const keys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01' + crypto.randomBytes(15).toString('hex'), name: 'CN=Native boundary test',
    notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 3600000), signingAlgorithm: algorithm, keys,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
      new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: '127.0.0.1' }])],
  }, crypto.webcrypto);
  const der = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const pem = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }); der.fill(0);
  const certFile = path.join(root, 'cert.pem'), keyFile = path.join(root, 'key.pem');
  boundary.writeFresh(certFile, Buffer.from(certificate.toString('pem')));
  boundary.writeFresh(keyFile, Buffer.from(pem));
  const cert = boundary.readPublic(certFile, 65536), key = boundary.readPrivate(keyFile, 65536);
  const server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, (_req, response) => response.end('protected-native-tls'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cert.fill(0); key.fill(0); });
  const body = await new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', port: server.address().port, ca: cert, rejectUnauthorized: true, agent: false }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; }); response.once('end', () => resolve(data));
    }).once('error', reject);
  });
  assert.equal(body, 'protected-native-tls');
  const mismatch = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  assert.throws(() => require('node:tls').createSecureContext({ cert, key: mismatch }));
});
test('native private read rejects an explicit other-user read grant', { skip: !enabled }, t => {
  const { boundary, root } = fixture(t); const file = path.join(root, 'acl.bin'); boundary.writeFresh(file, Buffer.from('private'));
  // Alter the DACL only: Set-Acl can also attempt privileged owner/SACL updates.
  const command = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  const result = spawnSync(command, [file, '/grant', '*S-1-1-0:(R)', '/q'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || result.error || result.signal) {
    const code = result.error || result.signal ? 'WINDOWS_ACL_TAMPER_PROCESS_FAILED' : 'WINDOWS_ACL_TAMPER_WRITE_FAILED';
    throw Object.assign(new Error(code), { code });
  }
  assert.throws(() => boundary.readPrivate(file, 32));
});
test('actual launcher death closes the guardian lifeline and removes descendants', { skip: !enabled, timeout: 30000 }, async t => {
  const { root, ownChild } = fixture(t); const pidFile = path.join(root, 'orphan-probe.pid');
  const probe = 'require("node:fs").writeFileSync(' + JSON.stringify(pidFile) + ',String(process.pid));setInterval(()=>{},1000)';
  const specification = { command: process.execPath, cwd: root, logPath: path.join(root, 'parent-death.log'), args: ['-e', probe], env: { SystemRoot: process.env.SystemRoot } };
  const launcherCode = 'const {createWindowsBoundary,managedWire}=require(' + JSON.stringify(path.resolve(__dirname, '../src/windows-native-boundary.cjs')) + ');const c=createWindowsBoundary(' + JSON.stringify(runtime) + ').launch("managed");c.stdin.write(managedWire(' + JSON.stringify(specification) + '));setInterval(()=>{},1000)';
  const launcher = ownChild(spawn(process.execPath, ['-e', launcherCode], { env: { SystemRoot: process.env.SystemRoot }, stdio: 'ignore', windowsHide: true }));
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(pidFile)); const child = Number(fs.readFileSync(pidFile, 'utf8'));
  const closed = once(launcher, 'close'); launcher.kill(); await closed;
  let alive = true;
  for (let i = 0; i < 100; i++) { try { process.kill(child, 0); } catch { alive = false; break; } await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(alive, false);
});

test('native retained storage streams past 16 MiB and returns the exact bytes', { skip: !enabled, timeout: 60000 }, async t => {
  const { boundary, root } = fixture(t); const storage = await boundary.openStorage(root);
  const crypto = require('node:crypto'), chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251;
  let failed = false;
  try {
    const writer = await storage.openWrite('large.bin', { maxBytes: 32 * 1024 * 1024 });
    const expected = crypto.createHash('sha256');
    for (let i = 0; i < 18; i++) { expected.update(chunk); await writer.write(chunk); }
    const tail = Buffer.from([251]); expected.update(tail); await writer.write(tail);
    const committed = await writer.commit();
    const persisted = await storage.stat('large.bin');
    for (const [field, label] of [['volume', 'VOLUME'], ['fileId', 'FILE_ID'], ['owner', 'OWNER'],
      ['size', 'SIZE'], ['allocationSize', 'ALLOCATION_SIZE'], ['modified', 'MODIFIED'], ['changed', 'CHANGED']]) {
      if (persisted[field] !== committed[field]) {
        const code = 'WINDOWS_STORAGE_COMMIT_' + label + '_CHANGED';
        throw Object.assign(new Error(code), { code });
      }
    }
    assert.equal(persisted.token, committed.token);
    assert.equal(committed.size, String(18 * chunk.length + 1));
    assert.equal(committed.platform, 'win32'); assert.ok(BigInt(committed.allocationSize) > 0n);
    const reader = await storage.openRead('large.bin', { expected: committed, maxBytes: 32 * 1024 * 1024 });
    const actual = crypto.createHash('sha256');
    try { for (;;) { const bytes = await reader.read(); if (!bytes.length) break; actual.update(bytes); bytes.fill(0); } }
    finally { await reader.close(); }
    assert.equal(actual.digest('hex'), expected.digest('hex'));
  } catch (error) { failed = true; throw error; }
  finally { chunk.fill(0); if (failed) await storage.close().catch(() => {}); else await storage.close(); }
});

test('native conditional append refuses a stale state without losing acknowledged records', { skip: !enabled }, async t => {
  const { boundary, root } = fixture(t); const storage = await boundary.openStorage(root);
  const { readStorageFile, writeStorageFile } = require('../src/windows-storage-files.cjs');
  let rejected = false;
  try {
    const first = await writeStorageFile(storage, 'events.log', Buffer.from('one\n'), { maxBytes: 1024 });
    const appended = await writeStorageFile(storage, 'events.log', Buffer.from('two\n'), { mode: 'append', expected: first, maxBytes: 1024 });
    assert.equal((await storage.stat('events.log')).token, appended.token);
    const saved = await readStorageFile(storage, 'events.log', 1024);
    assert.equal(saved.bytes.toString(), 'one\ntwo\n'); saved.bytes.fill(0);
    await assert.rejects(storage.openWrite('events.log', { mode: 'append', expected: first, maxBytes: 1024 }));
    rejected = true;
  } finally { if (rejected) await assert.rejects(storage.close()); else await storage.close(); }
  assert.equal(boundary.readPrivate(path.join(root, 'events.log'), 1024).toString(), 'one\ntwo\n');
});

test('native inactive-slot overwrite truncates old suffix and exact retry preserves bytes', { skip: !enabled }, async t => {
  const { boundary, root } = fixture(t); const storage = await boundary.openStorage(root);
  const { readStorageFile, writeStorageFile } = require('../src/windows-storage-files.cjs');
  try {
    const first = await writeStorageFile(storage, 'value.0', Buffer.from('old generation with a longer authenticated payload'), { maxBytes: 1024 });
    const second = await writeStorageFile(storage, 'value.0', Buffer.from('new generation'), { mode: 'slot', expected: first, maxBytes: 1024 });
    const retry = await storage.openWrite('value.0', { mode: 'append', expected: second, maxBytes: 1024 });
    const flushed = await retry.commit();
    assert.equal(flushed.token, second.token);
    const saved = await readStorageFile(storage, 'value.0', 1024, { expected: flushed });
    assert.equal(saved.bytes.toString(), 'new generation'); saved.bytes.fill(0);
    const empty = await storage.openWrite('value.0', { mode: 'slot', expected: flushed, maxBytes: 1024 });
    const truncated = await empty.commit();
    assert.equal(truncated.size, '0');
    assert.equal((await storage.stat('value.0')).token, truncated.token);
    const emptyRead = await readStorageFile(storage, 'value.0', 1024, { expected: truncated });
    assert.deepEqual(emptyRead.bytes, Buffer.alloc(0));
  } finally { await storage.close(); }
});

test('native private workspace inheritance permits real child files without accepting them as strict private files', { skip: !enabled }, async t => {
  const { boundary, root } = fixture(t), workspace = path.join(root, 'workspace');
  boundary.createDirectory(workspace, { inherit: true });
  fs.mkdirSync(path.join(workspace, 'nested')); const file = path.join(workspace, 'nested', 'Source.java');
  fs.writeFileSync(file, 'class Source {}');
  const storage = await boundary.openStorage(workspace, { mode: 'workspace' });
  try {
    const reader = await storage.openRead('nested/Source.java', { maxBytes: 1024 });
    try { const bytes = await reader.read(); assert.equal(bytes.toString(), 'class Source {}'); bytes.fill(0); }
    finally { await reader.close(); }
    assert.throws(() => boundary.readPrivate(file, 1024));
  } finally { await storage.close(); }
});

test('native retained root blocks rename until the owned session exits', { skip: !enabled }, async t => {
  const { boundary, root } = fixture(t), destination = path.join(path.dirname(root), 'moved');
  boundary.createDirectory(path.join(root, 'nested'));
  const nested = await boundary.openStorage(path.join(root, 'nested'));
  try {
    const storage = await boundary.openStorage(root);
    try { assert.throws(() => fs.renameSync(root, destination)); assert.equal((await storage.stat('', { directory: true })).identity, storage.rootState.identity); }
    finally { await storage.close(); }
    // Closing the root session must not release another session's ancestor pin.
    assert.throws(() => fs.renameSync(root, destination));
    assert.equal((await nested.stat('', { directory: true })).identity, nested.rootState.identity);
  } finally { await nested.close(); }
  fs.renameSync(root, destination); assert.equal(fs.existsSync(root), false);
});

test('native workspace owner locks contend and reopen the same permanent marker', { skip: !enabled }, async t => {
  const { boundary, root } = fixture(t), marker = Buffer.from('CI-WORKSPACE-1\ntest-project\n');
  const owner = await boundary.openStorage(root), contender = await boundary.openStorage(root);
  let refused = false, identity;
  try {
    const lock = await owner.lock('workspace.owner', marker); identity = lock.state.identity;
    assert.equal((await lock.check()).identity, identity);
    await assert.rejects(contender.lock('workspace.owner', marker)); refused = true;
    await lock.close();
  } finally { await owner.close(); if (refused) await assert.rejects(contender.close()); else await contender.close(); }
  const reopened = await boundary.openStorage(root);
  try { const lock = await reopened.lock('workspace.owner', marker); assert.equal(lock.state.identity, identity); await lock.close(); }
  finally { await reopened.close(); marker.fill(0); }
});

test('native IPC-directory cleanup requires released handles, exact identity and emptiness', { skip: !enabled }, async t => {
  const { boundary, root } = fixture(t), held = await boundary.openStorage(root);
  const identity = held.rootState.identity;
  try { assert.throws(() => boundary.removeDirectory(root, identity)); }
  finally { await held.close(); }
  assert.throws(() => boundary.removeDirectory(root, identity + '0'));
  assert.equal('WI1:' + boundary.inspect(root, { directory: true }), identity);
  const file = path.join(root, 'retained.bin'); boundary.writeFresh(file, Buffer.from('owned'));
  assert.throws(() => boundary.removeDirectory(root, identity));
  assert.equal(boundary.readPrivate(file, 16).toString(), 'owned');
  fs.unlinkSync(file); boundary.removeDirectory(root, identity);
  assert.equal(fs.existsSync(root), false);
});
