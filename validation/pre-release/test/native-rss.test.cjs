'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { prepareNativeRss, openNativeRss } = require('../native-rss.cjs');
const { prepareOwnedPhaseSampler } = require('../workload-sampler.cjs');
const { discoveryRows } = require('../process-memory.cjs');

const gone = pid => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
test('native RSS boundaries and owned helper lifecycle', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-rss-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareNativeRss(root);
  await t.test('RSS accounts for committed pages in KiB and preserves the real PPID', async t => {
    const child = spawn(process.execPath, ['-e', 
      "process.on('message',()=>{global.bytes=Buffer.alloc(64*1024*1024,1);process.send('allocated');});process.send('ready');"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const closed = once(child, 'close');
    let reader;
    t.after(async () => { try { await reader?.close(); } finally { child.kill('SIGTERM'); await closed; } });
    await once(child, 'message');
    reader = await openNativeRss(prepared);
    const before = await reader.read(child.pid);
    const changed = once(child, 'message'); child.send('allocate'); await changed;
    const after = await reader.read(child.pid);
    assert.deepEqual(after.map(row => [row.pid, row.ppid]), [[child.pid, process.pid]]);
    const delta = after[0].rssKiB - before[0].rssKiB;
    assert(delta >= 32 * 1024 && delta <= 96 * 1024, 'committed 64 MiB must not be reported as bytes or omitted');
    await reader.close(); gone(reader.pid);
    await assert.rejects(reader.read(child.pid), /MEMORY_NATIVE_STATE/);
  });
  await t.test('a privileged setuid child in the owner tree is still observed with its RSS', async () => {
    // /bin/ps is setuid root: its task is not readable by the helper (EPERM). It stays alive while its
    // wide output waits on the full pipe, so the frame must report it as U and read its RSS through ps.
    const child = spawn('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,rss=,command='], { stdio: ['ignore', 'pipe', 'ignore'] });
    const closed = once(child, 'close');
    await once(child, 'spawn');
    await new Promise(resolve => setTimeout(resolve, 100));
    const reader = await openNativeRss(prepared);
    try {
      assert.equal(child.exitCode, null, 'ps must still be blocked on its pipe for this test');
      const frame = await (async () => { const { stdout } = await require('node:util').promisify(require('node:child_process').execFile)('/bin/ps', ['-o', 'pid=,ppid=,rss=', '-p', String(child.pid)]); return stdout; })();
      assert.match(frame, new RegExp('^\\s*' + child.pid + '\\s+' + process.pid + '\\s+\\d+'));
      const rows = await reader.read(process.pid);
      const row = rows.find(value => value.pid === child.pid);
      assert(row && row.ppid === process.pid && Number.isSafeInteger(row.rssKiB) && row.rssKiB > 0, 'privileged child row with RSS');
    } finally {
      child.stdout.resume(); child.kill('SIGTERM'); await closed;
      await reader.close();
    }
  });
  await t.test('abandoning admission before a sampler starts leaves no helper behind', async () => {
    const worker = await prepareOwnedPhaseSampler(prepared);
    await worker.close(); gone(worker.helperPid);
  });
  await t.test('malformed, duplicate and excessive target sets fail before producing an RSS frame', () => {
    for (const input of ['0\n', ' +12\n', '12,12\n', '12', Array.from({ length: 1025 }, (_, i) => i + 2).join(',') + '\n']) {
      const result = spawnSync(prepared.binary, [], { input, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, 'READY 2\n');
    }
  });
  await t.test('discovery lists every live PID without spawning and keeps an exec path after the binary is unlinked', async () => {
    // A small owned binary keeps running after its file is removed: proc_pidpath fails (ENOENT) and the
    // helper falls back to the exec path recorded with the process arguments, the source /bin/ps also uses.
    const copy = path.join(root, 'sleeper');
    fs.writeFileSync(copy + '.c', '#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts("R"); fflush(stdout); pause(); return 0; }\n');
    assert.equal(spawnSync('/usr/bin/xcrun', ['clang', '-O2', '-o', copy, copy + '.c'], { timeout: 30000 }).status, 0);
    const child = spawn(copy, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    const closed = once(child, 'close');
    assert.equal(String((await once(child.stdout, 'data'))[0]), 'R\n'); // running from mapped pages before the file goes
    fs.unlinkSync(copy);
    const reader = await openNativeRss(prepared);
    try {
      const started = performance.now();
      const frame = await reader.discover();
      const elapsedMs = performance.now() - started;
      const rows = discoveryRows(frame);
      const byPid = new Map(rows.map(row => [row.pid, row]));
      assert.equal(byPid.get(process.pid)?.executable, fs.realpathSync(process.execPath));
      assert.deepEqual(byPid.get(child.pid), { pid: child.pid, ppid: process.pid, executable: copy, pathKnown: true });
      assert.deepEqual(byPid.get(reader.pid), { pid: reader.pid, ppid: process.pid, executable: prepared.binary, pathKnown: true });
      assert(rows.length >= 3 && rows.every(row => row.pathKnown || !row.executable.startsWith('/')));
      assert(elapsedMs < 250, `discovery took ${elapsedMs} ms`);
      const sampled = await reader.read(process.pid);
      assert(sampled.some(row => row.pid === child.pid && row.ppid === process.pid && row.rssKiB > 0));
    } finally {
      child.kill('SIGTERM'); await closed;
      await reader.close();
    }
  });
  await t.test('a changed retained binary cannot be started', async () => {
    fs.appendFileSync(prepared.binary, 'tampered');
    await assert.rejects(openNativeRss(prepared), /MEMORY_NATIVE_BINARY_CHANGED/);
  });
});
