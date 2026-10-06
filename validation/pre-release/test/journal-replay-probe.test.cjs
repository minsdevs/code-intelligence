'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const { argumentsFor, countFrames, measurements, syntheticWrapper } = require('../run-journal-replay-probe.cjs');

const app = path.join(path.parse(__dirname).root, 'synthetic-repo', '.native-product-AbC123', 'Code Intelligence Validation.app');
const cli = value => ['--app', value, '--journal-replay-probe'];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function frame(size) {
  const bytes = Buffer.alloc(size + 4, 0x61);
  bytes.writeUInt32BE(size, 0);
  return bytes;
}

test('journal probe CLI requires the exact opt-in and candidate application name', () => {
  const input = Object.freeze(cli(app));
  assert.deepEqual(argumentsFor(input), { app });
  for (const argv of [undefined, null, {}, '--journal-replay-probe', [], ['--app', app],
    ['--application', app, '--journal-replay-probe'], ['--app', app, '--startup-probe-3'],
    ['--journal-replay-probe', app, '--app'], [...input, '--ignore-errors'],
    cli(path.join(path.dirname(app), 'Code Intelligence.app')),
    cli(path.join(path.dirname(path.dirname(app)), 'native-product-AbC123', path.basename(app))),
    cli(path.join(path.dirname(path.dirname(app)), '.native-product-', path.basename(app))),
    cli(path.join(path.dirname(path.dirname(app)), '.native-product-AbC_123', path.basename(app)))]) {
    assert.throws(() => argumentsFor(argv), /JOURNAL_PROBE_ARGUMENT/);
  }
});

test('journal probe CLI rejects relative, non-normalized and control-character paths', () => {
  const parent = path.dirname(path.dirname(app));
  const candidate = path.basename(path.dirname(app));
  const relative = `${candidate}${path.sep}${path.basename(app)}`;
  const aliases = [
    `${parent}${path.sep}.${path.sep}${candidate}${path.sep}${path.basename(app)}`,
    `${parent}${path.sep}unused${path.sep}..${path.sep}${candidate}${path.sep}${path.basename(app)}`,
    `${parent}${path.sep}${path.sep}${candidate}${path.sep}${path.basename(app)}`,
  ];
  for (const value of [relative, '', null, 3, ...aliases,
    ...['\0', '\n', '\r', '\t', '\x1f', '\x7f'].map(control =>
      `${parent}${control}${path.sep}${candidate}${path.sep}${path.basename(app)}`)]) {
    assert.throws(() => argumentsFor(cli(value)), /JOURNAL_PROBE_ARGUMENT/);
  }
});

test('frame counting accepts binary payloads at the frame bound without modifying input', () => {
  // This helper counts framing only; record JSON, MAC and replay validation belong to the journal.
  const bytes = Buffer.concat([frame(1), frame(7), frame(16384)]);
  const before = Buffer.from(bytes);
  assert.equal(countFrames(Buffer.alloc(0)), 0);
  assert.equal(countFrames(bytes), 3);
  assert.deepEqual(bytes, before);
});

test('frame counting rejects non-buffers, incomplete headers, torn payloads and invalid lengths', () => {
  const torn = frame(7).subarray(0, 10);
  const excessiveLength = Buffer.alloc(4);
  excessiveLength.writeUInt32BE(0xffffffff);
  for (const value of [null, 'frame', new Uint8Array([0, 0, 0, 1, 1]),
    Buffer.alloc(1), Buffer.alloc(2), Buffer.alloc(3), frame(0), torn, frame(16385), excessiveLength,
    Buffer.concat([frame(1), Buffer.from([0, 0, 0])])]) {
    assert.throws(() => countFrames(value), /JOURNAL_PROBE_LOG/);
  }
});

test('frame count capacity accepts 1024 complete records and rejects the next complete record', () => {
  const bytes = Buffer.concat(Array.from({ length: 1024 }, () => frame(1)));
  assert.equal(countFrames(bytes), 1024);
  assert.throws(() => countFrames(Buffer.concat([bytes, frame(1)])), /JOURNAL_PROBE_LOG/);
});

test('log byte capacity accepts exactly four MiB and rejects valid framing above that limit', () => {
  const fullFrame = frame(16384);
  const bytes = Buffer.concat([...Array(255).fill(fullFrame), frame(15360)]);
  assert.equal(bytes.length, 4 * 1024 * 1024);
  assert.equal(countFrames(bytes), 256);
  assert.throws(() => countFrames(Buffer.concat([bytes, frame(1)])), /JOURNAL_PROBE_LOG/);
});

test('inactive measurements still delegate values and failures without counting or reading the clock', async () => {
  let clockReads = 0, operations = 0;
  const metrics = measurements(() => { clockReads++; return 0; });
  const before = metrics.snapshot();
  const value = Buffer.from('synthetic-return-value');
  assert.strictEqual(await metrics.invoke('getMacKey', () => { operations++; return value; }), value);
  const failure = new Error('synthetic-operation-failure');
  await assert.rejects(metrics.invoke('currentKeyId', () => { operations++; throw failure; }), error => error === failure);
  metrics.command('purpose-keyring', 'CHECK');
  assert.equal(operations, 2);
  assert.equal(clockReads, 0);
  assert.deepEqual(metrics.snapshot(), before);
});

test('measurement eligibility follows call entry across start and stop boundaries', async () => {
  let now = 10;
  const metrics = measurements(() => now), first = deferred(), second = deferred();
  const value = Object.freeze({ synthetic: true });
  metrics.start();
  const recorded = metrics.invoke('getMacKey', () => first.promise);
  assert.equal(metrics.snapshot().calls.getMacKey.calls, 1);
  now = 25; metrics.stop(); first.resolve(value);
  assert.strictEqual(await recorded, value);
  assert.deepEqual(metrics.snapshot().calls.getMacKey, { calls: 1, failed: 0, totalMs: 15 });

  const afterRecorded = metrics.snapshot();
  const unrecorded = metrics.invoke('currentKeyId', () => second.promise);
  now = 40; metrics.start(); second.resolve(value);
  assert.strictEqual(await unrecorded, value);
  assert.deepEqual(metrics.snapshot(), afterRecorded);
  metrics.stop();
});

test('active measurement preserves synchronous and asynchronous error identity and counts elapsed failure time', async () => {
  let now = 3;
  const metrics = measurements(() => now), failure = new Error('synthetic-private-error');
  metrics.start();
  await assert.rejects(metrics.invoke('getMacKey', () => { now = 8; throw failure; }), error => error === failure);
  await assert.rejects(metrics.invoke('getMacKey', async () => {
    await Promise.resolve(); now = 15; throw failure;
  }), error => error === failure);
  metrics.stop();
  assert.deepEqual(metrics.snapshot().calls.getMacKey, { calls: 2, failed: 2, totalMs: 12 });
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /synthetic-private-error/);
});

test('nested key and wrapper durations stay inclusive while protocol counts require an active window', async () => {
  let now = 0;
  const metrics = measurements(() => now), value = Buffer.from('synthetic-key-copy');
  metrics.command('ai-journal', 'ACQUIRE');
  metrics.start();
  metrics.command('ai-journal', 'ACQUIRE');
  assert.strictEqual(await metrics.invoke('getMacKey', async () => {
    now = 2;
    assert.equal(await metrics.invoke('isAvailable', async () => { now = 5; return true; }), true);
    metrics.command('purpose-keyring', 'CHECK');
    now = 10; return value;
  }), value);
  metrics.command('ai-journal', 'RELEASE');
  metrics.stop(); metrics.command('ai-journal', 'RELEASE');
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.calls.getMacKey, { calls: 1, failed: 0, totalMs: 10 });
  assert.deepEqual(snapshot.calls.isAvailable, { calls: 1, failed: 0, totalMs: 3 });
  assert.deepEqual(snapshot.protocol['ai-journal'], { ACQUIRE: 1, CHECK: 0, RELEASE: 1 });
  assert.deepEqual(snapshot.protocol['purpose-keyring'], { ACQUIRE: 0, CHECK: 1, RELEASE: 0 });
});

test('metric names and protocol enums reject unknown values before delegation or counter changes', async () => {
  const metrics = measurements(() => 0);
  let delegated = 0;
  metrics.start();
  const before = metrics.snapshot();
  for (const name of ['getBackupKey', 'getMacKey\n', '__proto__', 'constructor', null]) {
    await assert.rejects(metrics.invoke(name, () => { delegated++; }), /JOURNAL_PROBE_METRIC/);
  }
  for (const [role, operation] of [['source-vault', 'CHECK'], ['__proto__', 'CHECK'], [null, 'CHECK'],
    ['purpose-keyring', 'CHECK\n'], ['ai-journal', 'START'], ['ai-journal', 'constructor']]) {
    assert.throws(() => metrics.command(role, operation), /JOURNAL_PROBE_METRIC/);
  }
  assert.equal(delegated, 0);
  assert.deepEqual(metrics.snapshot(), before);
  metrics.stop();
});

test('measurement snapshots are detached and contain only fixed counters, never returned or thrown payloads', async () => {
  let serializedPayloads = 0;
  const sensitive = Object.freeze({
    token: 'SYNTHETIC_PRIVATE_SENTINEL', path: '/synthetic/private/key',
    toJSON() { serializedPayloads++; throw new Error('Payload serialization is forbidden'); },
  });
  const metrics = measurements(() => 0);
  metrics.start();
  assert.strictEqual(await metrics.invoke('getMacKey', () => sensitive), sensitive);
  await assert.rejects(metrics.invoke('getMacKey', async () => { throw sensitive; }), error => error === sensitive);
  metrics.command('purpose-keyring', 'CHECK'); metrics.stop();
  const snapshot = metrics.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['calls', 'protocol']);
  assert.deepEqual(Object.keys(snapshot.calls).sort(), ['currentKeyId', 'getMacKey', 'isAvailable']);
  assert.deepEqual(Object.keys(snapshot.protocol).sort(), ['ai-journal', 'purpose-keyring']);
  for (const counter of Object.values(snapshot.calls)) assert.deepEqual(Object.keys(counter).sort(), ['calls', 'failed', 'totalMs']);
  const encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /SYNTHETIC_PRIVATE_SENTINEL|\/synthetic\/private|token|path|toJSON/);
  snapshot.calls.getMacKey.calls = 9000;
  snapshot.protocol['purpose-keyring'].CHECK = 9000;
  snapshot.protocol.private = sensitive;
  assert.equal(JSON.stringify(metrics.snapshot()), encoded);
  assert.equal(serializedPayloads, 0);
});

test('synthetic authenticated wrapper round-trips empty and binary plaintext without mutating input', async () => {
  const metrics = measurements(() => 0), wrapper = syntheticWrapper(metrics);
  metrics.start(); assert.equal(await wrapper.isAvailable(), true); metrics.stop();
  assert.deepEqual(metrics.snapshot().calls.isAvailable, { calls: 1, failed: 0, totalMs: 0 });
  for (const plain of [Buffer.alloc(0), Buffer.from([0, 255, 128, 1, 10, 0]), Buffer.from('synthetic fixture \u0000 text')]) {
    const before = Buffer.from(plain), encoded = await wrapper.wrap(plain), preserved = Buffer.from(encoded);
    assert.equal(encoded.length, plain.length + 28);
    assert.deepEqual(await wrapper.unwrap(encoded), plain);
    assert.deepEqual(plain, before);
    assert.deepEqual(encoded, preserved);
  }
});

test('synthetic wrapper refuses altered nonce, ciphertext, tag and truncated envelopes', async () => {
  const wrapper = syntheticWrapper(measurements(() => 0)), plain = Buffer.from('synthetic authenticated content');
  const encoded = await wrapper.wrap(plain);
  for (const index of [0, 12, encoded.length - 1]) {
    const changed = Buffer.from(encoded); changed[index] ^= 1;
    await assert.rejects(wrapper.unwrap(changed));
  }
  for (const size of [0, 11, 27, encoded.length - 1]) await assert.rejects(wrapper.unwrap(encoded.subarray(0, size)));
  assert.deepEqual(await wrapper.unwrap(encoded), plain);
});

test('synthetic wrapper authenticates the AAD even when fixture key and framing are correct', async () => {
  const wrapper = syntheticWrapper(measurements(() => 0)), plain = Buffer.from('synthetic domain-bound content');
  // Public fixture material matches the runner; no installed or user-owned key is read.
  const key = Buffer.alloc(32, 77), nonce = Buffer.alloc(12, 19);
  const envelope = aad => {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(aad));
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };
  try {
    assert.deepEqual(await wrapper.unwrap(envelope('journal-replay-synthetic-wrapper-v1')), plain);
    await assert.rejects(wrapper.unwrap(envelope('journal-replay-different-domain')));
  } finally { key.fill(0); }
});
