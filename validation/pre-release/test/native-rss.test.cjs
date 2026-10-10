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
  await t.test('abandoning admission before a sampler starts leaves no helper behind', async () => {
    const worker = await prepareOwnedPhaseSampler(prepared);
    await worker.close(); gone(worker.helperPid);
  });
  await t.test('malformed, duplicate and excessive target sets fail before producing an RSS frame', () => {
    for (const input of ['0\n', ' +12\n', '12,12\n', '12', Array.from({ length: 1025 }, (_, i) => i + 2).join(',') + '\n']) {
      const result = spawnSync(prepared.binary, [], { input, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, 'READY 1\n');
    }
  });
  await t.test('a changed retained binary cannot be started', async () => {
    fs.appendFileSync(prepared.binary, 'tampered');
    await assert.rejects(openNativeRss(prepared), /MEMORY_NATIVE_BINARY_CHANGED/);
  });
});
