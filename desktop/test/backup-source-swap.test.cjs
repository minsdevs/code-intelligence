'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBackupSourceSwap, BackupSourceSwapError } = require('../src/backup-source-swap.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
async function identity(file) { const stat = await fs.lstat(file, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; }
async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }
async function failed(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BackupSourceSwapError);
    if (code) assert.equal(error.code, `BACKUP_SOURCE_SWAP_${code}`);
    assert.doesNotMatch(String(error), /private-|sentinel|\/tmp|\/var|source text/);
    assert.equal(error.cause, undefined); return true;
  });
}
async function fixture(t, old = ['repos', 'sources']) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-source-swap-'));
  await fs.chmod(root, 0o700);
  const transactionId = crypto.randomUUID(), dataRoot = path.join(root, 'data'), recovery = path.join(root, 'recovery');
  const stageRoot = path.join(recovery, transactionId);
  for (const file of [dataRoot, recovery, stageRoot]) await fs.mkdir(file, { mode: 0o700 });
  const originals = {}, incoming = {}, handles = [], transitions = [];
  for (const name of ['repos', 'sources']) {
    if (old.includes(name)) {
      const file = path.join(dataRoot, name); await fs.mkdir(file, { mode: name === 'repos' ? 0o755 : 0o700 });
      await fs.writeFile(path.join(file, 'original.txt'), `original ${name}\r\n`, { mode: name === 'repos' ? 0o444 : 0o600 });
      originals[name] = await identity(file);
    } else originals[name] = null;
    const file = path.join(stageRoot, name); await fs.mkdir(file, { mode: 0o700 });
    await fs.mkdir(path.join(file, 'nested'), { mode: 0o700 });
    await fs.writeFile(path.join(file, 'nested', 'restored.txt'), `restored ${name}\r\n`, { mode: 0o600 });
    incoming[name] = await identity(file);
  }
  // Other A/B and coordinator files have no source-slot authority and must remain untouched.
  await fs.mkdir(path.join(root, 'safety'), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'safety', 'keep'), 'B sentinel', { mode: 0o600 });
  await fs.writeFile(path.join(dataRoot, 'keep'), 'A sentinel', { mode: 0o600 });
  await fs.writeFile(path.join(stageRoot, 'payload.enc'), 'coordinator sentinel', { mode: 0o600 });
  const options = { dataRoot, stageRoot, transactionId, onTransition: async event => { transitions.push(event); } };
  async function open(extra = {}) { const handle = await createBackupSourceSwap({ ...options, ...extra }); handles.push(handle); return handle; }
  async function untouched() {
    assert.equal(await fs.readFile(path.join(root, 'safety', 'keep'), 'utf8'), 'B sentinel');
    assert.equal(await fs.readFile(path.join(dataRoot, 'keep'), 'utf8'), 'A sentinel');
    assert.equal(await fs.readFile(path.join(stageRoot, 'payload.enc'), 'utf8'), 'coordinator sentinel');
  }
  async function published() {
    for (const name of ['repos', 'sources']) {
      assert.deepEqual(await identity(path.join(dataRoot, name)), incoming[name]);
      assert.equal(await fs.readFile(path.join(dataRoot, name, 'nested', 'restored.txt'), 'utf8'), `restored ${name}\r\n`);
      await absent(path.join(stageRoot, name)); await absent(path.join(stageRoot, `failed-${name}`));
      if (originals[name]) {
        assert.deepEqual(await identity(path.join(stageRoot, `previous-${name}`)), originals[name]);
        assert.equal(await fs.readFile(path.join(stageRoot, `previous-${name}`, 'original.txt'), 'utf8'), `original ${name}\r\n`);
      } else await absent(path.join(stageRoot, `previous-${name}`));
    }
    await untouched();
  }
  async function rolledBack() {
    for (const name of ['repos', 'sources']) {
      if (originals[name]) {
        assert.deepEqual(await identity(path.join(dataRoot, name)), originals[name]);
        assert.equal(await fs.readFile(path.join(dataRoot, name, 'original.txt'), 'utf8'), `original ${name}\r\n`);
      } else await absent(path.join(dataRoot, name));
      assert.deepEqual(await identity(path.join(stageRoot, `failed-${name}`)), incoming[name]);
      assert.equal(await fs.readFile(path.join(stageRoot, `failed-${name}`, 'nested', 'restored.txt'), 'utf8'), `restored ${name}\r\n`);
      await absent(path.join(stageRoot, `previous-${name}`)); await absent(path.join(stageRoot, name));
    }
    await untouched();
  }
  t.after(async () => { for (const handle of handles) { try { handle.close(); } catch {} } await fs.rm(root, { recursive: true, force: true }); });
  return { root, dataRoot, stageRoot, transactionId, originals, incoming, options, transitions, open, published, rolledBack, untouched };
}

test('plan is immutable, path-free and binds existing plus incoming identities before mutation', async t => {
  const f = await fixture(t), handle = await f.open(), plan = handle.plan();
  assert.deepEqual(plan, { version: 1, transactionId: f.transactionId,
    roots: { data: await identity(f.dataRoot), stage: await identity(f.stageRoot) },
    entries: ['repos', 'sources'].map(name => ({ name, previous: f.originals[name], incoming: f.incoming[name] })) });
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.entries[0].incoming));
  assert.doesNotMatch(JSON.stringify(plan), /\/|path|restored\.txt/);
  assert.deepEqual(await handle.inspect(), { version: 1, transactionId: f.transactionId,
    phase: 'PREPARED', slots: { repos: 'READY', sources: 'READY' } });
  assert.equal(f.transitions.length, 0); await f.untouched();
});

test('publish and rollback preserve all bytes and identities without deleting original or B data', async t => {
  const f = await fixture(t), handle = await f.open();
  assert.equal((await handle.publish()).phase, 'PUBLISHED'); await f.published();
  assert.deepEqual(f.transitions.map(item => item.action), ['PREPARED', 'SAVE_REPOS', 'PUBLISH_REPOS', 'SAVE_SOURCES', 'PUBLISH_SOURCES', 'PUBLISHED']);
  assert.equal((await handle.publish()).phase, 'PUBLISHED'); await f.published();
  assert.equal((await handle.rollback()).phase, 'ROLLED_BACK'); await f.rolledBack();
  assert.equal((await handle.rollback()).phase, 'ROLLED_BACK'); await f.rolledBack();
  await failed(handle.publish(), 'STATE');
});

for (const old of [[], ['repos'], ['sources']]) {
  test(`original absence remains absence after rollback: ${old.join(',') || 'both absent'}`, async t => {
    const f = await fixture(t, old), handle = await f.open();
    await handle.publish(); await f.published(); await handle.rollback(); await f.rolledBack();
  });
}

test('rollback before publish keeps original live and retains new directories privately', async t => {
  const f = await fixture(t), handle = await f.open();
  await handle.rollback(); await f.rolledBack();
  assert.equal(f.transitions.some(event => event.action.startsWith('UNPUBLISH')), false);
});

const boundaries = ['before-rename', 'after-rename', 'before-fsync-data', 'after-fsync-data',
  'before-fsync-stage', 'after-fsync-stage', 'before-transition', 'after-transition'];
for (const action of ['SAVE_REPOS', 'PUBLISH_REPOS', 'SAVE_SOURCES', 'PUBLISH_SOURCES']) {
  for (const boundary of boundaries) {
    test(`crash/resume publication at ${action}/${boundary}`, async t => {
      const f = await fixture(t); let triggered = false;
      const handle = await f.open({ fault: async (point, event) => {
        if (!triggered && event.action === action && point === boundary) { triggered = true; throw new Error('private-crash-sentinel'); }
      } });
      const saved = copy(handle.plan()); await failed(handle.publish(), 'IO'); assert.equal(triggered, true); handle.close();
      const resumed = await f.open({ resumePlan: saved });
      await resumed.publish(); await f.published(); await resumed.rollback(); await f.rolledBack();
    });
  }
}

for (const action of ['UNPUBLISH_SOURCES', 'RESTORE_SOURCES', 'UNPUBLISH_REPOS', 'RESTORE_REPOS']) {
  for (const boundary of boundaries) {
    test(`crash/resume rollback at ${action}/${boundary}`, async t => {
      const f = await fixture(t); let triggered = false;
      const handle = await f.open({ fault: async (point, event) => {
        if (!triggered && event.action === action && point === boundary) { triggered = true; throw new Error('private-crash-sentinel'); }
      } });
      const saved = copy(handle.plan()); await handle.publish(); await failed(handle.rollback(), 'IO');
      assert.equal(triggered, true); handle.close();
      const resumed = await f.open({ resumePlan: saved });
      const current = await resumed.inspect();
      if (current.phase !== 'PUBLISHED') await failed(resumed.publish(), 'STATE');
      await resumed.rollback(); await f.rolledBack();
    });
  }
}

test('transition callbacks occur only after both parent sync boundaries and are awaited', async t => {
  const f = await fixture(t), trace = []; let release, reached;
  const gate = new Promise(resolve => { release = resolve; }); const waiting = new Promise(resolve => { reached = resolve; });
  const handle = await f.open({ fault: async (point, event) => { trace.push(`${event.action}:${point}`); }, onTransition: async event => {
    const action = event.action;
    assert.ok(trace.includes(`${action}:after-fsync-data`)); assert.ok(trace.includes(`${action}:after-fsync-stage`));
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.state.slots));
    if (action === 'SAVE_REPOS') { reached(); await gate; }
  } });
  const pending = handle.publish(); await waiting;
  await absent(path.join(f.dataRoot, 'repos'));
  assert.deepEqual(await identity(path.join(f.stageRoot, 'repos')), f.incoming.repos);
  await failed(handle.publish(), 'BUSY'); await failed(handle.inspect(), 'BUSY');
  assert.throws(() => handle.close(), { code: 'BACKUP_SOURCE_SWAP_BUSY' });
  release(); await pending; await f.published();
});

test('failed initial recovery record prevents all renames and exposes only a fixed error', async t => {
  const f = await fixture(t), handle = await f.open({ onTransition: async () => { throw new Error('private-record-sentinel'); } });
  await failed(handle.publish(), 'TRANSITION');
  assert.equal((await handle.inspect()).phase, 'PREPARED');
  for (const name of ['repos', 'sources']) assert.deepEqual(await identity(path.join(f.dataRoot, name)), f.originals[name]);
});

test('failed record after rename can be resumed using the unchanged original plan', async t => {
  const f = await fixture(t), handle = await f.open({ onTransition: async event => {
    if (event.action === 'PUBLISH_REPOS') throw new Error('private-record-sentinel');
  } });
  const plan = copy(handle.plan()); await failed(handle.publish(), 'TRANSITION'); handle.close();
  const resumed = await f.open({ resumePlan: plan }); assert.equal((await resumed.inspect()).slots.repos, 'LIVE');
  await resumed.rollback(); await f.rolledBack();
});

test('a new empty destination observed immediately before rename is preserved instead of replaced', async t => {
  const f = await fixture(t); let unexpected;
  const handle = await f.open({ fault: async (point, event) => {
    if (point === 'before-rename' && event.action === 'SAVE_REPOS') {
      const file = path.join(f.stageRoot, 'previous-repos'); await fs.mkdir(file, { mode: 0o700 }); unexpected = await identity(file);
    }
  } });
  await failed(handle.publish(), 'CHANGED');
  assert.deepEqual(await identity(path.join(f.stageRoot, 'previous-repos')), unexpected);
  assert.deepEqual(await identity(path.join(f.dataRoot, 'repos')), f.originals.repos);
  assert.deepEqual(await identity(path.join(f.stageRoot, 'repos')), f.incoming.repos);
});

test('a replacement during the final awaited checkpoint cannot be reported as successful publication', async t => {
  const f = await fixture(t); let unexpected;
  const handle = await f.open({ onTransition: async event => {
    if (event.action === 'PUBLISHED') {
      const file = path.join(f.dataRoot, 'repos'); await fs.rename(file, path.join(f.stageRoot, 'preserved-new'));
      await fs.mkdir(file, { mode: 0o700 }); unexpected = await identity(file);
    }
  } });
  await failed(handle.publish(), 'CHANGED');
  assert.deepEqual(await identity(path.join(f.dataRoot, 'repos')), unexpected);
  assert.deepEqual(await identity(path.join(f.stageRoot, 'preserved-new')), f.incoming.repos);
  assert.deepEqual(await identity(path.join(f.stageRoot, 'previous-repos')), f.originals.repos);
});

for (const target of ['dataRoot', 'stageRoot', 'staged', 'live', 'previous', 'failed']) {
  test(`changed or unknown ${target} identity is never adopted on recovery`, async t => {
    const f = await fixture(t), handle = await f.open(); const plan = copy(handle.plan()); handle.close();
    const targetPath = target === 'dataRoot' ? f.dataRoot : target === 'stageRoot' ? f.stageRoot
      : target === 'staged' ? path.join(f.stageRoot, 'repos') : target === 'live' ? path.join(f.dataRoot, 'repos')
        : path.join(f.stageRoot, `${target}-repos`);
    if (['dataRoot', 'stageRoot', 'staged', 'live'].includes(target)) await fs.rename(targetPath, `${targetPath}-owned-old`);
    await fs.mkdir(targetPath, { mode: 0o700 }); await fs.writeFile(path.join(targetPath, 'unknown.txt'), 'keep unknown', { mode: 0o600 });
    await failed(f.open({ resumePlan: plan }), 'CHANGED');
    assert.equal(await fs.readFile(path.join(targetPath, 'unknown.txt'), 'utf8'), 'keep unknown');
  });
}

test('missing known directory and a misplaced original both fail closed', async t => {
  const f = await fixture(t), handle = await f.open(); const plan = copy(handle.plan()); handle.close();
  await fs.rename(path.join(f.stageRoot, 'repos'), path.join(f.stageRoot, 'outside-slot'));
  await failed(f.open({ resumePlan: plan }), 'STATE');
  await fs.rename(path.join(f.stageRoot, 'outside-slot'), path.join(f.stageRoot, 'repos'));
  await fs.rename(path.join(f.dataRoot, 'repos'), path.join(f.stageRoot, 'failed-repos'));
  await failed(f.open({ resumePlan: plan }), 'STATE');
});

for (const kind of ['symlink-root', 'symlink-descendant', 'hardlink-file', 'special-inode', 'new-public', 'old-writable', 'sources-public']) {
  test(`unsafe filesystem fixture ${kind} never enters a swap`, async t => {
    const f = await fixture(t), incoming = path.join(f.stageRoot, 'repos'), original = path.join(f.dataRoot, 'repos');
    if (kind === 'symlink-root') { await fs.rename(incoming, `${incoming}-real`); await fs.symlink(`${incoming}-real`, incoming); }
    if (kind === 'symlink-descendant') await fs.symlink(path.join(f.root, 'safety'), path.join(incoming, 'escape'));
    if (kind === 'hardlink-file') await fs.link(path.join(original, 'original.txt'), path.join(incoming, 'alias'));
    if (kind === 'special-inode') {
      // A Unix-domain socket is another special inode; no executable or subprocess is needed.
      // Bind at a short disposable path to respect Darwin's sockaddr_un length, then move the inode.
      const net = require('node:net'); const server = net.createServer();
      const socketRoot = await fs.mkdtemp('/tmp/ci-ss-'); await fs.chmod(socketRoot, 0o700);
      t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(socketRoot, { recursive: true, force: true }); });
      const socketPath = path.join(socketRoot, 's');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      await fs.rename(socketPath, path.join(incoming, 'special'));
    }
    if (kind === 'new-public') await fs.chmod(incoming, 0o755);
    if (kind === 'old-writable') await fs.chmod(original, 0o777);
    if (kind === 'sources-public') await fs.chmod(path.join(f.dataRoot, 'sources'), 0o755);
    await failed(f.open(), 'UNSAFE'); await f.untouched();
  });
}

test('same data root has one in-process owner and failed contenders cannot release it', async t => {
  const f = await fixture(t), handle = await f.open(), plan = handle.plan();
  await failed(f.open(), 'BUSY'); await failed(f.open({ resumePlan: copy(plan) }), 'BUSY');
  await handle.publish(); handle.close();
  const resumed = await f.open({ resumePlan: copy(plan) }); await resumed.rollback(); await f.rolledBack();
});

test('failed initialization releases only its own reservation and close is terminal', async t => {
  const f = await fixture(t); const incoming = path.join(f.stageRoot, 'sources'); await fs.chmod(incoming, 0o755);
  await failed(f.open(), 'UNSAFE'); await fs.chmod(incoming, 0o700);
  const handle = await f.open(); handle.close(); handle.close();
  await failed(handle.publish(), 'CLOSED'); await failed(handle.rollback(), 'CLOSED'); await failed(handle.inspect(), 'CLOSED');
  assert.throws(() => handle.plan(), { code: 'BACKUP_SOURCE_SWAP_CLOSED' });
  const next = await f.open(); await next.rollback(); await f.rolledBack();
});

for (const mutation of ['path', 'wrong-transaction', 'duplicate-inode', 'noncanonical-inode', 'bad-version', 'unknown-field', 'getter']) {
  test(`recovery plan ${mutation} cannot add authority`, async t => {
    const f = await fixture(t), handle = await f.open(), plan = copy(handle.plan()); handle.close(); let read = false;
    if (mutation === 'path') plan.entries[0].path = '/private-sentinel';
    if (mutation === 'wrong-transaction') plan.transactionId = crypto.randomUUID();
    if (mutation === 'duplicate-inode') plan.entries[0].incoming = plan.entries[1].incoming;
    if (mutation === 'noncanonical-inode') plan.roots.data.ino += '\n';
    if (mutation === 'bad-version') plan.version = 2;
    if (mutation === 'unknown-field') plan.verified = true;
    if (mutation === 'getter') Object.defineProperty(plan, 'roots', { enumerable: true, get() { read = true; return {}; } });
    await failed(f.open({ resumePlan: plan }), 'INVALID'); assert.equal(read, false);
    const recovered = await f.open(); assert.equal((await recovered.inspect()).phase, 'PREPARED');
  });
}

test('only the fixed installation stage path and trusted callbacks are accepted', async t => {
  const f = await fixture(t);
  await failed(f.open({ stageRoot: path.join(f.root, 'safety') }), 'INVALID');
  await failed(f.open({ dataRoot: path.join(f.root, 'safety') }), 'INVALID');
  await failed(f.open({ transactionId: `${f.transactionId}\n` }), 'INVALID');
  await failed(f.open({ onTransition: null }), 'INVALID');
  await failed(f.open({ verified: true }), 'INVALID');
  assert.equal(f.transitions.length, 0); await f.untouched();
});
