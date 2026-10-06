'use strict';

// Offline contracts for the packaged C16 crash-matrix hooks and driver parsing. The hooks run
// against a real private temporary profile with real fs/FileHandle calls that replay the
// product's restore order; no Electron, service, key, network or user profile is involved.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const tls = require('node:tls');
const vm = require('node:vm');
const test = require('node:test');
const { BOUNDARIES, installOwnedBoundary, installOwnedTransport } = require('../../validation/backup-compatibility/recovery-boundaries.cjs');
const { argumentsFor, journalFacts, monotonicHighWater, faultedJournal, journalFrames, FAULTS } = require('../../validation/backup-compatibility/native-recovery-matrix.cjs');

const TX = '12345678-1234-4123-8123-123456789abc';
const { O_CREAT, O_EXCL, O_RDWR, O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_APPEND, O_WRONLY } = fs.constants;

function frame(type, extra = {}) {
  const body = Buffer.from(JSON.stringify({ major: 1, sequence: 1, previousHash: '0'.repeat(64), atMs: 1, event: { type, ...extra }, keyId: 'k', mac: 'm' }));
  const bytes = Buffer.alloc(4 + body.length); bytes.writeUInt32BE(body.length); body.copy(bytes, 4); return bytes;
}

async function profileFixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync('/private/tmp/cirm-test-'));
  const profile = path.join(parent, 'desktop-run-synthetic');
  fs.mkdirSync(profile, { mode: 0o700 });
  for (const dir of ['safety', 'safety/ai-journal', 'backup-maintenance', 'data', 'data/repos', 'data/sources', 'recovery',
    `recovery/${TX}`, `recovery/${TX}/repos`, `recovery/${TX}/sources`, `recovery/${TX}/checkpoint`, `recovery/${TX}/incoming`]) {
    fs.mkdirSync(path.join(profile, dir), { mode: 0o700 });
  }
  fs.writeFileSync(path.join(profile, 'safety/ai-journal/events.log'), frame('GENESIS'), { mode: 0o600 });
  for (const name of ['checkpoint', 'incoming']) fs.writeFileSync(path.join(profile, `recovery/${TX}/${name}/payload.bin`), 'synthetic', { mode: 0o600 });
  const log = await fs.promises.open(path.join(profile, 'safety/ai-journal/events.log'), O_APPEND | O_WRONLY);
  t.after(async () => { await log.close().catch(() => {}); fs.rmSync(parent, { recursive: true, force: true }); });
  const app = { getName: () => 'Code Intelligence Acceptance', getPath: () => profile };
  return { parent, profile, log, app };
}

// The product's restore order, reduced to the file operations the hooks observe.
function restoreSteps(profile, log) {
  const p = (...parts) => path.join(profile, ...parts);
  const io = fs.promises;
  let sequence = 0;
  const record = async name => {
    const file = p('backup-maintenance', name);
    const handle = await io.open(file, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try { await handle.write(Buffer.from('synthetic encrypted record'), 0, 26, 0); await handle.sync(); } finally { await handle.close(); }
    const directory = await io.open(p('backup-maintenance'), O_RDONLY); await directory.sync(); await directory.close();
    const readback = await io.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); await readback.close();
  };
  const next = () => `record-${String(++sequence).padStart(8, '0')}.enc`;
  const journal = async type => { const bytes = frame(type); await log.write(bytes, 0, bytes.length); await log.sync(); };
  const latch = async () => {
    const temporary = p('safety', '.ai-off-' + 'a'.repeat(32)); fs.writeFileSync(temporary, '{}', { mode: 0o600 });
    await io.rename(temporary, p('safety', 'ai-off.json'));
  };
  return [
    ['latch-file', latch], ['journal:LATCH', () => journal('LATCH')],
    ['record:PREPARED', () => record(next())],
    ['active-create', async () => { const h = await io.open(p('backup-maintenance', 'active.enc'), O_RDWR | O_CREAT | O_EXCL, 0o600); await h.close(); }],
    ['latch-file-merge', latch], ['journal:LATCH-merge', () => journal('LATCH')], ['journal:RESTORE_BEGIN', () => journal('RESTORE_BEGIN')],
    ['journal:RESTORE_OBLIGATION_V2', () => journal('RESTORE_OBLIGATION_V2')], ['journal:RESTORE_RECEIPT', () => journal('RESTORE_RECEIPT')],
    ['record:MERGED', () => record(next())], ['journal:MAINTENANCE_SEALED', () => journal('MAINTENANCE_SEALED')],
    ['record:SEALED', () => record(next())], ['record:STAGED', () => record(next())], ['record:DATABASE_SWAPPED', () => record(next())],
    ['record:SS_PREPARED', () => record(next())],
    ['rename:SAVE_REPOS', () => io.rename(p('data/repos'), p('recovery', TX, 'previous-repos'))], ['record:SS_SAVE_REPOS', () => record(next())],
    ['rename:PUBLISH_REPOS', () => io.rename(p('recovery', TX, 'repos'), p('data/repos'))], ['record:SS_PUBLISH_REPOS', () => record(next())],
    ['rename:SAVE_SOURCES', () => io.rename(p('data/sources'), p('recovery', TX, 'previous-sources'))], ['record:SS_SAVE_SOURCES', () => record(next())],
    ['rename:PUBLISH_SOURCES', () => io.rename(p('recovery', TX, 'sources'), p('data/sources'))], ['record:SS_PUBLISH_SOURCES', () => record(next())],
    ['record:SS_PUBLISHED', () => record(next())], ['record:HEALTH_VERIFIED', () => record(next())],
    ['journal:MAINTENANCE_COMPLETED', () => journal('MAINTENANCE_COMPLETED')],
    ['unlink:checkpoint', () => io.unlink(p('recovery', TX, 'checkpoint/payload.bin'))],
    ['unlink:incoming', () => io.unlink(p('recovery', TX, 'incoming/payload.bin'))],
    ['record:RETENTION_READY', () => record(next())], ['record:COMPLETED', () => record(next())],
    ['receipt', async () => { const h = await io.open(p('backup-maintenance', `receipt-${String(sequence).padStart(8, '0')}.enc`), O_RDWR | O_CREAT | O_EXCL, 0o600); await h.close(); }],
    ['unlink:active', () => io.unlink(p('backup-maintenance', 'active.enc'))],
  ];
}

const EXPECTED_STEP = {
  LATCH_BEFORE: 'latch-file', LATCH_AFTER: 'journal:LATCH', PREPARED_BEFORE: 'record:PREPARED', PREPARED_AFTER: 'record:PREPARED',
  MERGED_BEFORE: 'record:MERGED', MERGED_AFTER: 'record:MERGED', SEAL_BEFORE: 'journal:MAINTENANCE_SEALED',
  SEAL_AFTER: 'journal:MAINTENANCE_SEALED', SEALED_AFTER: 'record:SEALED', STAGED_BEFORE: 'record:STAGED', STAGED_AFTER: 'record:STAGED',
  DATABASE_SWAPPED_BEFORE: 'record:DATABASE_SWAPPED', DATABASE_SWAPPED_AFTER: 'record:DATABASE_SWAPPED', SOURCE_RENAME_AFTER: 'rename:SAVE_REPOS',
  SOURCES_PUBLISHED_BEFORE: 'record:SS_PUBLISHED', SOURCES_PUBLISHED_AFTER: 'record:SS_PUBLISHED', HEALTH_BEFORE: 'record:HEALTH_VERIFIED',
  HEALTH_AFTER: 'record:HEALTH_VERIFIED', COMPLETE_BEFORE: 'journal:MAINTENANCE_COMPLETED', COMPLETE_AFTER: 'journal:MAINTENANCE_COMPLETED',
  CLEANUP_BEFORE: 'unlink:checkpoint', RETENTION_AFTER: 'record:RETENTION_READY', COMPLETED_BEFORE: 'record:COMPLETED',
  COMPLETED_AFTER: 'record:COMPLETED', ACTIVE_CLEAR_BEFORE: 'unlink:active', ACTIVE_CLEAR_AFTER: 'unlink:active',
};

const serialized = install => vm.runInNewContext('(' + install.toString() + ')', { process, Buffer });
const pending = promise => Promise.race([promise.then(() => 'DONE'), new Promise(resolve => setTimeout(resolve, 100, 'PENDING'))]);

test('every boundary pauses at exactly its product operation and earlier operations pass through unchanged', async t => {
  assert.deepEqual(Object.keys(EXPECTED_STEP).sort(), Object.keys(BOUNDARIES).sort());
  for (const point of Object.keys(BOUNDARIES)) {
    await t.test(point, async t => {
      const f = await profileFixture(t), original = { open: fs.promises.open, rename: fs.promises.rename, unlink: fs.promises.unlink };
      const hook = await serialized(installOwnedBoundary)({ app: f.app }, { profile: f.profile, parent: f.parent, point });
      let held, label;
      for (const [name, step] of restoreSteps(f.profile, f.log)) {
        const operation = step(); operation.catch(() => {});
        if (await pending(operation) === 'PENDING') { held = operation; label = name; break; }
      }
      const observed = hook.inspect();
      assert.equal(observed.mismatch, null); assert.equal(label, EXPECTED_STEP[point]);
      assert.equal(observed.hit.point, point); assert.equal(observed.hit.count, 1);
      const before = /_BEFORE$/.test(point);
      assert.equal(observed.hit.operationCompleted, !before);
      if (label === 'unlink:active') assert.equal(fs.existsSync(path.join(f.profile, 'backup-maintenance/active.enc')), before);
      if (label === 'rename:SAVE_REPOS') assert.equal(fs.existsSync(path.join(f.profile, 'recovery', TX, 'previous-repos')), true);
      hook.restore();
      await assert.rejects(held, { code: 'EIO' });
      assert.equal(fs.promises.open, original.open); assert.equal(fs.promises.rename, original.rename); assert.equal(fs.promises.unlink, original.unlink);
    });
  }
});

test('an out-of-order operation sequence is reported as a mismatch and never pauses', async t => {
  const f = await profileFixture(t);
  const hook = await serialized(installOwnedBoundary)({ app: f.app }, { profile: f.profile, parent: f.parent, point: 'STAGED_AFTER' });
  const steps = restoreSteps(f.profile, f.log).filter(([name]) => name !== 'journal:MAINTENANCE_SEALED');
  for (const [, step] of steps.slice(0, 14)) assert.equal(await pending(step()), 'DONE');
  const observed = hook.inspect();
  assert.equal(observed.hit, null); assert.equal(observed.mismatch.reason, 'RECORD_SEALED');
  hook.restore();
});

test('boundary hooks refuse ordinary profiles, other claims and unknown points before patching', async t => {
  const f = await profileFixture(t), original = fs.promises.open;
  const install = serialized(installOwnedBoundary);
  await assert.rejects(install({ app: { ...f.app, getName: () => 'Code Intelligence Validation' } }, { profile: f.profile, parent: f.parent, point: 'LATCH_AFTER' }));
  await assert.rejects(install({ app: { ...f.app, getPath: () => '/real/profile' } }, { profile: f.profile, parent: f.parent, point: 'LATCH_AFTER' }));
  await assert.rejects(install({ app: f.app }, { profile: f.profile, parent: '/elsewhere', point: 'LATCH_AFTER' }));
  await assert.rejects(install({ app: f.app }, { profile: f.profile, parent: f.parent, point: 'POWER_LOSS' }));
  assert.equal(fs.promises.open, original);
});

test('loopback provider stand-in counts attempts, settles, holds or refuses without DNS, and restores tls.connect', async t => {
  const f = await profileFixture(t), original = tls.connect, key = 'sk-synthetic-unit';
  const handle = await serialized(installOwnedTransport)({ app: f.app }, { profile: f.profile, parent: f.parent,
    credentialSha256: crypto.createHash('sha256').update('Bearer ' + key).digest('hex') });
  const call = () => new Promise(resolve => {
    const body = Buffer.from('{}');
    const request = https.request({ protocol: 'https:', hostname: 'api.openai.com', port: 443, path: '/v1/chat/completions', method: 'POST',
      agent: false, rejectUnauthorized: true, servername: 'api.openai.com', lookup: () => { throw new Error('DNS must not run'); },
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': String(body.length) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', error => resolve({ error: error.code || error.message }));
    request.end(body);
    t.after(() => request.destroy());
  });
  assert.equal((await call()).error, 'ECONNREFUSED');
  handle.setMode('settle');
  const settled = await call(); assert.equal(settled.status, 200);
  const parsed = JSON.parse(settled.body); assert.equal(parsed.model, 'gpt-4o-mini-2024-07-18'); assert.equal(parsed.usage.total_tokens, 1100);
  handle.setMode('hold'); const held = call();
  for (let i = 0; i < 50 && handle.inspect().held === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const stats = handle.inspect();
  assert.equal(stats.attempts, 3); assert.equal(stats.refused, 1); assert.equal(stats.settled, 1); assert.equal(stats.held, 1);
  assert.equal(stats.credentialMatches, 2); assert.doesNotMatch(JSON.stringify(stats), /sk-synthetic/);
  assert.throws(() => handle.setMode('real'));
  const final = await handle.restore(); assert.equal(final.attempts, 3);
  assert.equal(tls.connect, original);
  assert.ok((await held).error);
});

test('driver accepts only an explicit app, known unique points or faults and the optional cost suffix', () => {
  assert.deepEqual(argumentsFor(['--app', '/synthetic/app', '--points', 'LATCH_AFTER,STAGED_BEFORE']),
    { app: '/synthetic/app', points: ['LATCH_AFTER', 'STAGED_BEFORE'], faults: [], cost: false });
  assert.equal(argumentsFor(['--app', '/synthetic/app', '--points', 'COMPLETE_AFTER', '--cost']).cost, true);
  assert.deepEqual(argumentsFor(['--app', '/synthetic/app', '--faults', 'torn-tail,missing']),
    { app: '/synthetic/app', points: [], faults: ['torn-tail', 'missing'], cost: false });
  for (const args of [[], ['--app', 'relative', '--points', 'LATCH_AFTER'], ['--app', '/a', '--points', 'POWER_LOSS'],
    ['--app', '/a', '--points', 'LATCH_AFTER,LATCH_AFTER'], ['--app', '/a', '--points', 'LATCH_AFTER', '--profile'],
    ['--app', '/a', '--points', 'LATCH_AFTER', '--cost', '--real-provider'], ['--app', '/a', '--faults', 'truncate-all'],
    ['--app', '/a', '--faults', 'torn-tail', '--cost']]) assert.throws(() => argumentsFor(args));
});

test('crafted journal faults change only the intended bytes and keep every original frame as a prefix', () => {
  const bytes = Buffer.concat([frame('GENESIS'), frame('LATCH', { reason: 'RESTORE' })]);
  const torn = faultedJournal('torn-tail', bytes);
  assert.deepEqual(torn.subarray(0, bytes.length), bytes); assert.equal(journalFacts(torn).torn, true);
  const corrupt = faultedJournal('corrupt-mac', bytes);
  assert.equal(corrupt.length, bytes.length); assert.equal(journalFrames(corrupt).length, 2);
  assert.notEqual(journalFrames(corrupt)[1].value.mac, journalFrames(bytes)[1].value.mac);
  assert.deepEqual(journalFrames(corrupt)[1].value.event, journalFrames(bytes)[1].value.event);
  assert.equal([...corrupt].filter((value, i) => value !== bytes[i]).length, 1);
  const major = faultedJournal('incompatible-major', bytes), frames = journalFrames(major);
  assert.deepEqual(major.subarray(0, bytes.length), bytes); assert.equal(frames.length, 3);
  assert.equal(frames[2].value.major, 2); assert.equal(frames[2].value.sequence, frames[1].value.sequence + 1);
  assert.equal(frames[2].value.previousHash, crypto.createHash('sha256').update(frames[1].bytes).digest('hex'));
  assert.deepEqual(FAULTS, ['torn-tail', 'corrupt-mac', 'incompatible-major', 'latch-major', 'missing']);
  assert.throws(() => faultedJournal('missing', bytes));
});

test('journal facts count request events and flag torn tails and high-water regressions without trusting MACs', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const bytes = Buffer.concat([
    frame('RESERVED', { reservation: { requestId: id } }), frame('DISPATCH_INTENT', { requestId: id }),
    frame('SETTLED', { settlement: { requestId: id, actualMicroUsd: '210' } }),
    frame('MAINTENANCE_SEALED', { metadata: { budgetDay: '2026-10-07', minimumVersion: '5' } }),
    frame('MAINTENANCE_COMPLETED', { metadata: { budgetDay: '2026-10-07', minimumVersion: '5' } })]);
  const facts = journalFacts(bytes);
  assert.equal(facts.reserved[id], 1); assert.equal(facts.dispatched[id], 1); assert.equal(facts.settled[id], '210');
  assert.equal(facts.torn, false); assert.equal(monotonicHighWater(facts.highWater), true);
  assert.equal(journalFacts(Buffer.concat([bytes, Buffer.from([0, 0, 0, 9, 1])])).torn, true);
  assert.equal(monotonicHighWater([{ budgetDay: '2026-10-07', minimumVersion: '5' }, { budgetDay: '2026-10-07', minimumVersion: '4' }]), false);
  assert.equal(monotonicHighWater([{ budgetDay: '2026-10-07', minimumVersion: '5' }, { budgetDay: '2026-10-06', minimumVersion: '5' }]), false);
});
