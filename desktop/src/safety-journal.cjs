'use strict';

// Main-process library only. No provider, database, renderer, HTTP, or credential access.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { acquireNativeOwnerLock } = require('./native-owner-locks.cjs');

const MAJOR = 1;
const ZERO = '0'.repeat(64);
const MAX_MONEY = 9223372036854775807n;
const MAX_TIME = 253402300799999;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALLATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const REASONS = new Set([
  'INITIAL_OFF', 'RESTART_RECONCILIATION', 'USER_OFF', 'RESTORE', 'UNKNOWN_USAGE',
  'PROVIDER_TIMEOUT', 'PROJECTION_FAILURE', 'CLOCK_REGRESSION', 'ACK_MISMATCH',
  'OVER_RESERVATION', 'CONFLICT', 'IO_FAILURE', 'CORRUPT', 'CAPACITY',
]);
const DEFAULT_LIMITS = Object.freeze({ recordBytes: 16384, logBytes: 32 * 1024 * 1024, records: 100000, requests: 10000 });

class SafetyJournalError extends Error {
  constructor(code, state) {
    // Never propagate adapter/OS errors, paths, keys, payloads, or caller text.
    super(`Safety journal: ${code}`);
    this.name = 'SafetyJournalError';
    this.code = code;
    this.aiOff = true;
    this.recoveryOnly = true;
    if (state) this.state = state;
  }
}

function fail(code) { throw new SafetyJournalError(code); }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT');
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, i) => key !== [...keys].sort()[i])) fail('INVALID_INPUT');
}
function money(value) {
  if (typeof value !== 'string' || value.match(/^(0|[1-9][0-9]{0,18})$/)?.[0] !== value || BigInt(value) > MAX_MONEY) fail('INVALID_INPUT');
  return value;
}
function identifier(value) { if (typeof value !== 'string' || value.match(ID)?.[0] !== value) fail('INVALID_INPUT'); return value; }
function hash(value) { if (typeof value !== 'string' || value.match(HASH)?.[0] !== value) fail('INVALID_INPUT'); return value; }
function uuid(value) { if (typeof value !== 'string' || value.match(UUID)?.[0] !== value) fail('INVALID_INPUT'); return value; }
function installationId(value) {
  if (typeof value !== 'string' || value.match(INSTALLATION_ID)?.[0] !== value) fail('INVALID_INPUT');
  return value;
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) fail('INVALID_INPUT');
  return value;
}
function maxMoney(...values) { return values.reduce((a, b) => BigInt(a) >= BigInt(b) ? a : b, '0'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function reservation(value) {
  object(value, ['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd']);
  uuid(value.requestId); hash(value.payloadSha256); day(value.budgetDay); identifier(value.priceVersion); money(value.reservedMicroUsd);
  return copy(value);
}
function obligation(value) {
  object(value, ['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status', 'actualMicroUsd', 'proofSha256']);
  reservation(Object.fromEntries(['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd'].map((key) => [key, value[key]])));
  if (!['RESERVED', 'DISPATCHED', 'UNKNOWN_HELD', 'SETTLED'].includes(value.status)) fail('INVALID_INPUT');
  if (value.status === 'SETTLED') { money(value.actualMicroUsd); hash(value.proofSha256); }
  else if (value.actualMicroUsd !== null || value.proofSha256 !== null) fail('INVALID_INPUT');
  return copy(value);
}
function settledInput(value) {
  object(value, ['requestId', 'payloadSha256', 'actualMicroUsd', 'proofSha256']);
  uuid(value.requestId); hash(value.payloadSha256); money(value.actualMicroUsd); hash(value.proofSha256);
  return copy(value);
}
const MAINTENANCE_FIELDS = ['transactionId', 'kind', 'payloadSha256', 'pgProjectionDigest',
  'legacyLiabilityUnresolved', 'budgetDay', 'minimumVersion'];
function maintenanceMetadata(value) {
  object(value, MAINTENANCE_FIELDS); uuid(value.transactionId);
  if (!['BACKUP', 'RESTORE'].includes(value.kind) || typeof value.legacyLiabilityUnresolved !== 'boolean') fail('INVALID_INPUT');
  hash(value.payloadSha256); hash(value.pgProjectionDigest); day(value.budgetDay); money(value.minimumVersion);
  return copy(value);
}
function liability(row) { return row.status === 'SETTLED' && !row.conflict ? row.actualMicroUsd : maxMoney(row.reservedMicroUsd, row.liabilityFloorMicroUsd); }
function rowFrom(reserved) {
  return { ...reserved, status: 'RESERVED', actualMicroUsd: null, proofSha256: null,
    dispatchIntent: false, conflict: false, liabilityFloorMicroUsd: reserved.reservedMicroUsd };
}
function rowSchema(row) {
  object(row, ['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status', 'actualMicroUsd',
    'proofSha256', 'dispatchIntent', 'conflict', 'liabilityFloorMicroUsd']);
  obligation(Object.fromEntries(['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status', 'actualMicroUsd', 'proofSha256'].map((key) => [key, row[key]])));
  money(row.liabilityFloorMicroUsd);
  if (typeof row.dispatchIntent !== 'boolean' || typeof row.conflict !== 'boolean') fail('INVALID_INPUT');
  if (row.conflict && !['UNKNOWN_HELD', 'SETTLED'].includes(row.status)) fail('INVALID_INPUT');
}
function restoreHasher(input) {
  // This prefix and restoreDigest's suffix frame the canonical input object. Its
  // obligations arrive one sorted row at a time, so replay needs bounded hash
  // state rather than a second copy of every restored obligation.
  return crypto.createHash('sha256').update(`{"budgetDay":${JSON.stringify(input.budgetDay)},"minimumVersion":${JSON.stringify(input.minimumVersion)},"obligations":[`);
}
function restoreDigest(pending) {
  return pending.inputHasher.copy().update(`],"restoreId":${JSON.stringify(pending.restoreId)}}`).digest('hex');
}
function mergedObligation(existing, restored, preserveSettlement = false) {
  if (!existing) {
    return { ...rowFrom(reservation(Object.fromEntries(['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd'].map((key) => [key, restored[key]])))),
      status: 'UNKNOWN_HELD', dispatchIntent: restored.status !== 'RESERVED', liabilityFloorMicroUsd: maxMoney(restored.reservedMicroUsd, restored.actualMicroUsd || '0') };
  }
  const merged = copy(existing);
  const sameIdentity = ['payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd'].every((key) => existing[key] === restored[key]);
  const sameProvenSettlement = sameIdentity && existing.status === 'SETTLED'
    && (restored.status !== 'SETTLED' || (existing.actualMicroUsd === restored.actualMicroUsd && existing.proofSha256 === restored.proofSha256));
  if (!sameProvenSettlement) {
    if (!preserveSettlement || existing.status !== 'SETTLED') {
      merged.status = 'UNKNOWN_HELD'; merged.actualMicroUsd = null; merged.proofSha256 = null;
    }
    merged.liabilityFloorMicroUsd = maxMoney(liability(existing), restored.reservedMicroUsd, restored.actualMicroUsd || '0');
    merged.conflict = existing.conflict || !sameIdentity || (existing.status === 'SETTLED' && restored.status === 'SETTLED');
  }
  return merged;
}
function within(first, second) { const relative = path.relative(first, second); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
async function plannedRealPath(input) {
  let existing = input;
  const suffix = [];
  for (;;) {
    try { return path.join(await fs.realpath(existing), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(existing) === existing) fail('UNSAFE_PATH');
      suffix.push(path.basename(existing)); existing = path.dirname(existing);
    }
  }
}
function secureStat(stat, directory = false) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1)
      || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('UNSAFE_FILE');
}
async function regularRead(file, maximum) {
  const before = await fs.lstat(file);
  secureStat(before);
  if (before.size > maximum) fail('CAPACITY');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat(); secureStat(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.size > maximum) fail('UNSAFE_FILE');
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('UNSAFE_FILE');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) fail('IO_FAILURE');
    offset += bytesWritten;
  }
}

class Journal {
  constructor(options, root) {
    this.options = options;
    this.ownerLocks = options.ownerLocks;
    this.root = root;
    this.directory = path.join(root, 'ai-journal');
    this.logPath = path.join(this.directory, 'events.log');
    this.lockPath = path.join(this.directory, 'writer.lock');
    this.latchPath = path.join(root, 'ai-off.json');
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) fail('INVALID_INPUT');
    }
    this.state = { sequence: 0, headHash: ZERO, clockHighWaterMs: 0, budgetDay: '1970-01-01', minimumVersion: '0',
      initialized: false, aiOff: true, requests: new Map(), pendingRestore: null, restoreReceipt: null,
      legacyLiabilityUnresolved: false, pendingMaintenance: null, maintenanceReceipt: null, maintenanceIds: new Set() };
    this.bytes = 0;
    this.queue = Promise.resolve();
    this.permits = new Map();
    this.activeRequests = new Set();
    this.poisoned = false;
    this.closed = false;
    this.closing = false;
  }
  async fault(stage) { if (this.options.fault) await this.options.fault(stage); }
  now() {
    const now = (this.options.clock || Date.now)();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) fail('CLOCK_INVALID');
    return now;
  }
  async mac(keyId, value, domain) {
    let key; let provided;
    try {
      // The trusted main adapter transfers ownership of a fresh copy, never its retained key.
      provided = await this.options.keyProvider.getMacKey(keyId, 'safety');
      if (!Buffer.isBuffer(provided) || provided.length !== 32) fail('KEY_UNAVAILABLE');
      key = Buffer.from(provided);
      return crypto.createHmac('sha256', key).update(`CI-SAFETY-${domain}-1\0${this.options.installationId}\0`).update(canonical(value)).digest('hex');
    } catch { fail('KEY_UNAVAILABLE'); }
    finally {
      key?.fill(0);
      if (Buffer.isBuffer(provided)) provided.fill(0);
    }
  }
  async signed(value, domain) {
    const keyId = identifier(await this.options.keyProvider.currentKeyId('safety'));
    const body = { ...value, keyId };
    return { ...body, mac: await this.mac(keyId, body, domain) };
  }
  async authenticate(value, domain) {
    const { mac, ...body } = value;
    hash(mac); identifier(value.keyId);
    const expected = await this.mac(value.keyId, body, domain);
    if (!crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) fail('MAC_INVALID');
  }
  async syncDirectory(directory, prefix) {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      secureStat(await handle.stat(), true);
      await this.fault(`${prefix}.beforeDirectoryFsync`);
      await handle.sync();
      await this.fault(`${prefix}.afterDirectoryFsync`);
    } finally { await handle.close(); }
  }
  async acquireLock() {
    secureStat(await fs.lstat(this.directory), true);
    if (this.ownerLocks !== undefined) {
      try {
        this.nativeLock = await acquireNativeOwnerLock(this.ownerLocks, {
          safetyRoot: this.root, kind: 'ai-journal', installationId: this.options.installationId,
        });
        return;
      } catch { fail('WRITER_LOCKED'); }
    }
    await this.fault('lock.beforeCreate');
    try { this.lock = await fs.open(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('WRITER_LOCKED'); throw error; }
    this.lockIdentity = await this.lock.stat();
    await this.fault('lock.afterCreate');
    await writeAll(this.lock, Buffer.from(canonical({ major: MAJOR, pid: process.pid, owner: crypto.randomUUID() })));
    await this.fault('lock.beforeFsync'); await this.lock.sync(); await this.fault('lock.afterFsync');
    await this.syncDirectory(this.directory, 'lock');
  }
  async releaseLock() {
    if (this.nativeLock) {
      const native = this.nativeLock; this.nativeLock = null;
      try { await native.release(); } catch { fail('WRITER_LOCK_CHANGED'); }
      return;
    }
    if (!this.lock) return;
    const handle = this.lock;
    this.lock = null;
    try {
      const actual = await fs.lstat(this.lockPath);
      secureStat(actual);
      if (actual.dev !== this.lockIdentity.dev || actual.ino !== this.lockIdentity.ino) fail('WRITER_LOCK_CHANGED');
      await fs.unlink(this.lockPath);
      await this.syncDirectory(this.directory, 'unlock');
    } finally { await handle.close(); }
  }
  async checkOwnership() {
    if (this.ownerLocks === undefined) return;
    if (!this.nativeLock) fail('WRITER_LOCKED');
    try { await this.nativeLock.check(); } catch { fail('WRITER_LOCK_CHANGED'); }
  }
  async readLatch() {
    try {
      const bytes = await regularRead(this.latchPath, 4096);
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      object(value, ['major', 'installationId', 'reason', 'keyId', 'mac']);
      if (value.major !== MAJOR) fail('INCOMPATIBLE_MAJOR');
      if (value.installationId !== this.options.installationId || !REASONS.has(value.reason)) fail('LATCH_INVALID');
      await this.authenticate(value, 'LATCH');
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async writeLatch(reason) {
    if (!REASONS.has(reason)) fail('INVALID_INPUT');
    this.state.aiOff = true; this.permits.clear();
    await this.checkOwnership();
    // Never replace a symlink, hardlink, special file, malformed latch, or another installation's latch.
    await this.readLatch();
    const value = await this.signed({ major: MAJOR, installationId: this.options.installationId, reason }, 'LATCH');
    const temporary = path.join(this.root, `.ai-off-${crypto.randomBytes(16).toString('hex')}`);
    let handle;
    let renamed = false;
    try {
      await this.fault('latch.beforeWrite');
      await this.checkOwnership();
      handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await writeAll(handle, Buffer.from(canonical(value)));
      await this.fault('latch.afterWrite');
      await this.fault('latch.beforeFsync'); await handle.sync(); await this.fault('latch.afterFsync');
      await handle.close(); handle = null;
      await this.fault('latch.beforeRename'); await this.checkOwnership();
      await fs.rename(temporary, this.latchPath); renamed = true;
      await this.fault('latch.afterRename');
      await this.syncDirectory(this.root, 'latch');
      await this.checkOwnership();
    } finally {
      await handle?.close();
      if (!renamed) await fs.unlink(temporary).catch(() => {});
    }
  }
  apply(event, atMs) {
    const state = this.state;
    if (!Number.isSafeInteger(atMs) || atMs < state.clockHighWaterMs || atMs < 0 || atMs > MAX_TIME) fail('CLOCK_INVALID');
    const get = (id) => {
      uuid(id); const row = state.requests.get(id); if (!row) fail('UNKNOWN_REQUEST');
      const next = copy(row); state.requests.set(id, next); return next;
    };
    if (!event || typeof event !== 'object') fail('INVALID_INPUT');
    switch (event.type) {
      case 'GENESIS':
        object(event, ['type', 'installationId']);
        if (state.initialized || state.sequence !== 0 || event.installationId !== this.options.installationId) fail('GENESIS_INVALID');
        state.initialized = true; break;
      case 'RESERVED': {
        object(event, ['type', 'reservation']); const r = reservation(event.reservation);
        if (state.requests.has(r.requestId) || state.requests.size >= this.limits.requests) fail('DUPLICATE_REQUEST');
        state.requests.set(r.requestId, rowFrom(r)); state.budgetDay = [state.budgetDay, r.budgetDay].sort().at(-1); break;
      }
      case 'DISPATCH_INTENT': {
        object(event, ['type', 'requestId']); const row = get(event.requestId);
        if (row.status !== 'RESERVED' || row.dispatchIntent || row.conflict) fail('STATE_INVALID');
        row.status = 'DISPATCHED'; row.dispatchIntent = true; break;
      }
      case 'SETTLED': {
        object(event, ['type', 'settlement']); const s = settledInput(event.settlement); const row = get(s.requestId);
        if (row.payloadSha256 !== s.payloadSha256 || row.conflict || row.status === 'SETTLED') fail('STATE_INVALID');
        row.status = 'SETTLED'; row.actualMicroUsd = s.actualMicroUsd; row.proofSha256 = s.proofSha256;
        if (BigInt(s.actualMicroUsd) > BigInt(row.reservedMicroUsd)) state.aiOff = true;
        break;
      }
      case 'SETTLEMENT_CONFLICT': {
        object(event, ['type', 'settlement']); const s = settledInput(event.settlement); const row = get(s.requestId);
        if (row.status !== 'SETTLED' || row.payloadSha256 !== s.payloadSha256
            || (row.actualMicroUsd === s.actualMicroUsd && row.proofSha256 === s.proofSha256)) fail('STATE_INVALID');
        row.liabilityFloorMicroUsd = maxMoney(liability(row), row.reservedMicroUsd, s.actualMicroUsd);
        row.status = 'UNKNOWN_HELD'; row.actualMicroUsd = null; row.proofSha256 = null; row.conflict = true;
        state.aiOff = true; break;
      }
      case 'UNKNOWN_HELD': {
        object(event, ['type', 'requestId', 'reason']); if (!REASONS.has(event.reason)) fail('INVALID_INPUT');
        const row = get(event.requestId); if (row.status !== 'SETTLED') row.status = 'UNKNOWN_HELD'; break;
      }
      case 'LATCH':
        object(event, ['type', 'reason']); if (!REASONS.has(event.reason)) fail('INVALID_INPUT');
        state.aiOff = true;
        for (const [id, row] of state.requests) if (row.status !== 'SETTLED') state.requests.set(id, { ...row, status: 'UNKNOWN_HELD' });
        break;
      case 'ACTIVATED':
        object(event, ['type', 'projectionDigest']); hash(event.projectionDigest);
        if (state.pendingRestore || state.pendingMaintenance || state.legacyLiabilityUnresolved
            || event.projectionDigest !== this.projectionDigest()) fail('STATE_INVALID');
        state.aiOff = false; break;
      case 'MAINTENANCE_SEALED':
      case 'MAINTENANCE_COMPLETED': {
        object(event, ['type', 'metadata']); const metadata = maintenanceMetadata(event.metadata);
        if (!state.aiOff || state.pendingRestore || metadata.budgetDay < state.budgetDay
            || BigInt(metadata.minimumVersion) < BigInt(state.minimumVersion)) fail('MAINTENANCE_INVALID');
        if (event.type === 'MAINTENANCE_SEALED') {
          if (state.pendingMaintenance || state.maintenanceIds.has(metadata.transactionId)) fail('MAINTENANCE_INVALID');
          state.maintenanceIds.add(metadata.transactionId);
          state.pendingMaintenance = metadata; state.maintenanceReceipt = null;
        } else {
          const pending = state.pendingMaintenance;
          if (!pending || ['transactionId', 'kind', 'payloadSha256'].some(key => pending[key] !== metadata[key])) fail('MAINTENANCE_INVALID');
          state.pendingMaintenance = null; state.maintenanceReceipt = metadata;
        }
        state.legacyLiabilityUnresolved ||= metadata.legacyLiabilityUnresolved;
        state.budgetDay = metadata.budgetDay; state.minimumVersion = metadata.minimumVersion;
        state.aiOff = true; break;
      }
      case 'RESTORE_BEGIN': {
        object(event, ['type', 'restoreId', 'inputDigest', 'obligationCount', 'inputBudgetDay', 'inputMinimumVersion', 'budgetDay', 'minimumVersion']);
        uuid(event.restoreId); hash(event.inputDigest); day(event.inputBudgetDay); money(event.inputMinimumVersion);
        day(event.budgetDay); money(event.minimumVersion);
        if (state.pendingRestore || state.restoreReceipt?.restoreId === event.restoreId
            || !Number.isSafeInteger(event.obligationCount) || event.obligationCount < 0 || event.obligationCount > this.limits.requests) fail('RESTORE_INVALID');
        if (event.budgetDay < event.inputBudgetDay || BigInt(event.minimumVersion) < BigInt(event.inputMinimumVersion)) fail('RESTORE_INVALID');
        if (event.budgetDay < state.budgetDay || BigInt(event.minimumVersion) < BigInt(state.minimumVersion)) fail('HIGH_WATER_REGRESSION');
        state.budgetDay = event.budgetDay; state.minimumVersion = event.minimumVersion;
        state.pendingRestore = { restoreId: event.restoreId, inputDigest: event.inputDigest, obligationCount: event.obligationCount,
          inputBudgetDay: event.inputBudgetDay, inputMinimumVersion: event.inputMinimumVersion, appliedCount: 0, lastRequestId: null,
          inputHasher: restoreHasher({ budgetDay: event.inputBudgetDay, minimumVersion: event.inputMinimumVersion }) };
        state.restoreReceipt = null; state.aiOff = true; break;
      }
      case 'RESTORE_OBLIGATION':
      case 'RESTORE_OBLIGATION_V2': {
        object(event, ['type', 'restoreId', 'inputDigest', 'index', 'obligation']); uuid(event.restoreId); hash(event.inputDigest);
        const restored = obligation(event.obligation); const pending = state.pendingRestore;
        if (!pending || event.restoreId !== pending.restoreId || event.inputDigest !== pending.inputDigest
            || event.index !== pending.appliedCount || pending.appliedCount >= pending.obligationCount
            || (pending.lastRequestId !== null && restored.requestId <= pending.lastRequestId)
            || restored.budgetDay > state.budgetDay) fail('RESTORE_INVALID');
        // Old records retain their historical interpretation and projection hashes. New imports
        // preserve a proven immutable settlement while a conflicting floor keeps its full liability.
        const before = state.requests.get(restored.requestId);
        const merged = mergedObligation(before, restored, event.type === 'RESTORE_OBLIGATION_V2'); rowSchema(merged);
        if (before && BigInt(liability(merged)) < BigInt(liability(before))) fail('LIABILITY_REGRESSION');
        if (!before && state.requests.size >= this.limits.requests) fail('CAPACITY');
        const inputHasher = pending.inputHasher.copy().update(pending.appliedCount ? ',' : '').update(canonical(restored));
        state.pendingRestore = { ...pending, inputHasher, appliedCount: pending.appliedCount + 1, lastRequestId: restored.requestId };
        state.requests.set(restored.requestId, merged); break;
      }
      case 'RESTORE_RECEIPT': {
        object(event, ['type', 'restoreId', 'inputDigest', 'obligationCount', 'projectionDigest']);
        uuid(event.restoreId); hash(event.inputDigest); hash(event.projectionDigest); const pending = state.pendingRestore;
        if (!pending || event.restoreId !== pending.restoreId || event.inputDigest !== pending.inputDigest
            || event.obligationCount !== pending.obligationCount || pending.appliedCount !== pending.obligationCount
            || restoreDigest(pending) !== pending.inputDigest || event.projectionDigest !== this.projectionDigest()) fail('RESTORE_INVALID');
        state.restoreReceipt = { restoreId: event.restoreId, inputDigest: event.inputDigest,
          obligationCount: event.obligationCount, projectionDigest: event.projectionDigest };
        state.pendingRestore = null; break;
      }
      default: fail('EVENT_UNKNOWN');
    }
    state.clockHighWaterMs = atMs;
  }
  projectionDigest() {
    return digest(canonical({ requests: [...this.state.requests.values()].sort((a, b) => a.requestId.localeCompare(b.requestId)),
      budgetDay: this.state.budgetDay, minimumVersion: this.state.minimumVersion }));
  }
  snapshot() {
    const requests = [...this.state.requests.values()].sort((a, b) => a.requestId.localeCompare(b.requestId));
    const pending = this.state.pendingRestore;
    const pendingRestore = pending ? { restoreId: pending.restoreId, inputDigest: pending.inputDigest, obligationCount: pending.obligationCount,
      inputBudgetDay: pending.inputBudgetDay, inputMinimumVersion: pending.inputMinimumVersion, appliedCount: pending.appliedCount,
      lastRequestId: pending.lastRequestId, processedInputDigest: pending.inputHasher.copy().digest('hex') } : null;
    return copy({ major: MAJOR, installationId: this.options.installationId, sequence: this.state.sequence, headHash: this.state.headHash,
      aiOff: this.state.aiOff || this.poisoned || this.closed || (this.ownerLocks !== undefined && !this.nativeLock?.isHeld()),
      recoveryOnly: this.poisoned || (this.ownerLocks !== undefined && !this.nativeLock?.isHeld()),
      clockHighWaterMs: this.state.clockHighWaterMs, budgetDay: this.state.budgetDay, minimumVersion: this.state.minimumVersion,
      projectionDigest: this.projectionDigest(), totalLiabilityMicroUsd: requests.reduce((sum, row) => sum + BigInt(liability(row)), 0n).toString(),
      requests, pendingRestore, restoreReceipt: this.state.restoreReceipt,
      legacyLiabilityUnresolved: this.state.legacyLiabilityUnresolved,
      pendingMaintenance: this.state.pendingMaintenance, maintenanceReceipt: this.state.maintenanceReceipt });
  }
  async append(event) {
    await this.checkOwnership();
    if (!this.state.initialized && event.type !== 'GENESIS') fail('GENESIS_INVALID');
    if (this.state.sequence >= this.limits.records) fail('CAPACITY');
    const atMs = Math.max(this.state.clockHighWaterMs, this.now());
    // Validate the complete transition before persisting any bytes. A rejected API input must
    // never create a well-MACed but semantically invalid record in an otherwise healthy log.
    const previous = this.state;
    const next = { ...previous, requests: new Map(previous.requests), maintenanceIds: new Set(previous.maintenanceIds) };
    try { this.state = next; this.apply(event, atMs); }
    finally { this.state = previous; }
    const record = await this.signed({ major: MAJOR, sequence: this.state.sequence + 1, previousHash: this.state.headHash, atMs, event }, 'RECORD');
    const body = Buffer.from(canonical(record));
    if (body.length > this.limits.recordBytes || this.bytes + body.length + 4 > this.limits.logBytes) fail('CAPACITY');
    const frame = Buffer.alloc(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4);
    const descriptor = await this.log.stat(); secureStat(descriptor);
    const actual = await fs.lstat(this.logPath); secureStat(actual);
    if (actual.dev !== descriptor.dev || actual.ino !== descriptor.ino || descriptor.size !== this.bytes) fail('LOG_CHANGED');
    this.pendingState = next;
    await this.fault('log.beforeWrite'); await this.checkOwnership();
    await writeAll(this.log, frame); await this.fault('log.afterWrite');
    await this.fault('log.beforeFsync'); await this.log.sync(); await this.fault('log.afterFsync');
    await this.checkOwnership();
    this.state = next; this.pendingState = null;
    this.state.sequence = record.sequence; this.state.headHash = digest(frame); this.bytes += frame.length;
  }
  async replay() {
    const bytes = await regularRead(this.logPath, this.limits.logBytes);
    let offset = 0;
    while (offset < bytes.length) {
      if (bytes.length - offset < 4) fail('TORN_TAIL');
      const length = bytes.readUInt32BE(offset);
      if (length < 1 || length > this.limits.recordBytes) fail('FRAME_INVALID');
      if (bytes.length - offset - 4 < length) fail('TORN_TAIL');
      const encoded = bytes.subarray(offset + 4, offset + 4 + length);
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)); }
      catch { fail('RECORD_INVALID'); }
      object(value, ['major', 'sequence', 'previousHash', 'atMs', 'event', 'keyId', 'mac']);
      if (value.major !== MAJOR) fail('INCOMPATIBLE_MAJOR');
      if (!encoded.equals(Buffer.from(canonical(value)))) fail('RECORD_INVALID');
      if (value.sequence !== this.state.sequence + 1 || value.sequence > this.limits.records || value.previousHash !== this.state.headHash) fail('CHAIN_INVALID');
      await this.authenticate(value, 'RECORD');
      if (!this.state.initialized && value.event?.type !== 'GENESIS') fail('GENESIS_INVALID');
      this.apply(value.event, value.atMs);
      this.state.sequence = value.sequence;
      this.state.headHash = digest(bytes.subarray(offset, offset + 4 + length));
      offset += 4 + length;
      this.bytes = offset;
    }
    if (!this.state.initialized) fail('JOURNAL_MISSING');
  }
  async poison(code) {
    this.poisoned = true; this.state.aiOff = true; this.permits.clear(); this.activeRequests.clear();
    if (this.pendingState) {
      // An unacknowledged append may already be durable. Never report a cleared legacy hold
      // or permit admission while the maintenance seal's publication is uncertain.
      this.state.legacyLiabilityUnresolved ||= this.pendingState.legacyLiabilityUnresolved;
      this.state.pendingMaintenance ||= this.pendingState.pendingMaintenance;
      this.state.minimumVersion = maxMoney(this.state.minimumVersion, this.pendingState.minimumVersion);
      this.state.budgetDay = [this.state.budgetDay, this.pendingState.budgetDay].sort().at(-1);
      for (const [id, row] of this.pendingState.requests) {
        const previous = this.state.requests.get(id);
        if (!previous || canonical(previous) !== canonical(row)) {
          this.state.requests.set(id, { ...row, status: 'UNKNOWN_HELD', actualMicroUsd: null, proofSha256: null,
            liabilityFloorMicroUsd: maxMoney(row.reservedMicroUsd, row.actualMicroUsd || '0', row.liabilityFloorMicroUsd, previous ? liability(previous) : '0') });
        }
      }
      this.pendingState = null;
    }
    for (const row of this.state.requests.values()) if (row.status !== 'SETTLED') row.status = 'UNKNOWN_HELD';
    await this.writeLatch(code === 'CAPACITY' ? 'CAPACITY' : 'IO_FAILURE').catch(() => {});
  }
  run(action) {
    if (this.closing || this.closed) return Promise.reject(new SafetyJournalError('CLOSED'));
    const pending = this.queue.then(async () => {
      if (this.poisoned) fail('RECOVERY_REQUIRED');
      try { await this.checkOwnership(); const result = await action(); await this.checkOwnership(); return result; }
      catch (error) {
        const code = error instanceof SafetyJournalError ? error.code : 'IO_FAILURE';
        if (!['INVALID_INPUT', 'AI_OFF', 'DUPLICATE_REQUEST', 'UNKNOWN_REQUEST', 'PERMIT_INVALID', 'ACTIVATION_REJECTED', 'CONCURRENCY_LIMIT', 'RESTORE_PENDING', 'RESTORE_CONFLICT', 'MAINTENANCE_REJECTED'].includes(code)) await this.poison(code);
        throw new SafetyJournalError(code, this.snapshot());
      }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  reserveAndPermit(input) {
    return this.run(async () => {
      const r = reservation(input);
      if (this.state.aiOff || this.state.pendingMaintenance || this.state.legacyLiabilityUnresolved || await this.readLatch()) fail('AI_OFF');
      if (this.state.requests.has(r.requestId)) fail('DUPLICATE_REQUEST');
      const now = this.now(); const currentDay = new Date(now).toISOString().slice(0, 10);
      if (now < this.state.clockHighWaterMs || currentDay < this.state.budgetDay || r.budgetDay !== currentDay) fail('CLOCK_REGRESSION');
      if (this.activeRequests.size >= 2) fail('CONCURRENCY_LIMIT');
      // Preflight capacity for both records before asking the PG projection adapter.
      if (this.state.requests.size >= this.limits.requests || this.state.sequence + 2 > this.limits.records
          || this.bytes + 2 * this.limits.recordBytes + 8 > this.limits.logBytes) fail('CAPACITY');
      const ack = await this.options.verifyCommittedReservation(copy(r));
      try { object(ack, ['committed', ...Object.keys(r)]); } catch { fail('ACK_MISMATCH'); }
      const { committed, ...ackReservation } = ack;
      if (committed !== true || canonical(ackReservation) !== canonical(r)) fail('ACK_MISMATCH');
      if (this.now() < now || new Date(this.now()).toISOString().slice(0, 10) !== currentDay) fail('CLOCK_REGRESSION');
      await this.append({ type: 'RESERVED', reservation: r });
      await this.append({ type: 'DISPATCH_INTENT', requestId: r.requestId });
      if (this.now() < this.state.clockHighWaterMs || new Date(this.now()).toISOString().slice(0, 10) !== currentDay) fail('CLOCK_REGRESSION');
      await this.fault('permit.beforeReturn');
      const permit = Object.freeze({ requestId: r.requestId, payloadSha256: r.payloadSha256, permitId: crypto.randomUUID() });
      this.permits.set(permit.permitId, permit); this.activeRequests.add(r.requestId);
      return permit;
    });
  }
  consumePermit(input) {
    return this.run(async () => {
      object(input, ['requestId', 'payloadSha256', 'permitId']); uuid(input.requestId); hash(input.payloadSha256); uuid(input.permitId);
      if (this.state.aiOff || await this.readLatch()) fail('AI_OFF');
      if (this.now() < this.state.clockHighWaterMs) fail('CLOCK_REGRESSION');
      const permit = this.permits.get(input.permitId);
      if (!permit || canonical(permit) !== canonical(input)) fail('PERMIT_INVALID');
      this.permits.delete(input.permitId);
      return Object.freeze({ requestId: input.requestId, payloadSha256: input.payloadSha256, authorized: true });
    });
  }
  settle(input) {
    return this.run(async () => {
      const s = settledInput(input); const row = this.state.requests.get(s.requestId);
      if (!row) fail('UNKNOWN_REQUEST');
      if (row.payloadSha256 !== s.payloadSha256) fail('SETTLEMENT_MISMATCH');
      if (row.status === 'SETTLED' && row.actualMicroUsd === s.actualMicroUsd && row.proofSha256 === s.proofSha256) return this.snapshot();
      if (row.conflict) fail('SETTLEMENT_CONFLICT');
      const proof = await this.options.verifySettlement(copy(s));
      try { object(proof, ['verified', ...Object.keys(s)]); } catch { fail('SETTLEMENT_MISMATCH'); }
      const { verified, ...ackSettlement } = proof;
      if (verified !== true || canonical(ackSettlement) !== canonical(s)) fail('SETTLEMENT_MISMATCH');
      if (row.status === 'SETTLED') {
        await this.writeLatch('CONFLICT');
        await this.append({ type: 'SETTLEMENT_CONFLICT', settlement: s });
        fail('SETTLEMENT_CONFLICT');
      }
      if (BigInt(s.actualMicroUsd) > BigInt(row.reservedMicroUsd)) await this.writeLatch('OVER_RESERVATION');
      await this.append({ type: 'SETTLED', settlement: s });
      this.permits.forEach((permit, id) => { if (permit.requestId === s.requestId) this.permits.delete(id); });
      this.activeRequests.delete(s.requestId);
      // Receipt is returned only after journal fsync, before the caller updates PostgreSQL.
      return this.snapshot();
    });
  }
  holdUnknown(requestId, reason = 'UNKNOWN_USAGE') {
    return this.run(async () => {
      uuid(requestId); if (!REASONS.has(reason)) fail('INVALID_INPUT');
      await this.append({ type: 'UNKNOWN_HELD', requestId, reason });
      this.permits.forEach((permit, id) => { if (permit.requestId === requestId) this.permits.delete(id); });
      this.activeRequests.delete(requestId); return this.snapshot();
    });
  }
  latch(reason = 'USER_OFF') {
    return this.run(async () => {
      if (!REASONS.has(reason)) fail('INVALID_INPUT');
      await this.writeLatch(reason); await this.append({ type: 'LATCH', reason });
      this.activeRequests.clear(); return this.snapshot();
    });
  }
  mergeRestore(input) {
    return this.run(async () => {
      object(input, ['restoreId', 'obligations', 'budgetDay', 'minimumVersion']); uuid(input.restoreId); day(input.budgetDay); money(input.minimumVersion);
      if (!Array.isArray(input.obligations) || input.obligations.length > this.limits.requests) fail('INVALID_INPUT');
      const incoming = input.obligations.map(obligation).sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
      const request = { restoreId: input.restoreId, obligations: incoming, budgetDay: input.budgetDay, minimumVersion: input.minimumVersion };
      const inputDigest = digest(canonical(request)); const ids = new Set();
      for (const row of incoming) { if (ids.has(row.requestId)) fail('INVALID_INPUT'); ids.add(row.requestId); }
      const pending = this.state.pendingRestore;
      if (pending && (pending.restoreId !== request.restoreId || pending.inputDigest !== inputDigest
          || pending.obligationCount !== incoming.length)) fail('RESTORE_PENDING');
      const completed = this.state.restoreReceipt;
      if (completed?.restoreId === request.restoreId && (completed.inputDigest !== inputDigest
          || completed.obligationCount !== incoming.length)) fail('RESTORE_CONFLICT');
      if (pending) {
        const prefix = restoreHasher(request);
        for (let index = 0; index < pending.appliedCount; index++) prefix.update(index ? ',' : '').update(canonical(incoming[index]));
        if (prefix.digest('hex') !== pending.inputHasher.copy().digest('hex')) fail('RESTORE_INVALID');
      }
      if (new Set([...this.state.requests.keys(), ...ids]).size > this.limits.requests) fail('CAPACITY');
      const budgetDay = [this.state.budgetDay, request.budgetDay,
        ...[...this.state.requests.values()].map((row) => row.budgetDay), ...incoming.map((row) => row.budgetDay)].sort().at(-1);
      const minimumVersion = maxMoney(this.state.minimumVersion, request.minimumVersion);
      await this.writeLatch('RESTORE'); await this.append({ type: 'LATCH', reason: 'RESTORE' }); this.activeRequests.clear();
      if (completed?.restoreId === request.restoreId) return this.snapshot();
      // Bind the entire normalized input and high-water before any row. A crash
      // cannot authorize a different/empty restore to replace its unfinished work.
      if (!pending) await this.append({ type: 'RESTORE_BEGIN', restoreId: request.restoreId, inputDigest, obligationCount: incoming.length,
        inputBudgetDay: request.budgetDay, inputMinimumVersion: request.minimumVersion, budgetDay, minimumVersion });
      for (let index = pending?.appliedCount || 0; index < incoming.length; index++) {
        await this.append({ type: 'RESTORE_OBLIGATION_V2', restoreId: request.restoreId, inputDigest, index, obligation: incoming[index] });
      }
      await this.append({ type: 'RESTORE_RECEIPT', restoreId: request.restoreId, inputDigest, obligationCount: incoming.length,
        projectionDigest: this.projectionDigest() });
      return this.snapshot();
    });
  }
  maintenance(input, completing) {
    // Capture caller input before entering the async writer queue.
    let metadata;
    try { metadata = maintenanceMetadata(input); }
    catch { return Promise.reject(new SafetyJournalError('INVALID_INPUT')); }
    return this.run(async () => {
      const callback = this.options[completing ? 'verifyMaintenanceCompletion' : 'verifyMaintenanceSeal'];
      const existing = completing ? this.state.maintenanceReceipt : this.state.pendingMaintenance;
      if (existing?.transactionId === metadata.transactionId && canonical(existing) === canonical(metadata)) {
        // Idempotent retry still requires fresh committed PG evidence; an old receipt is not
        // permission to skip revalidation after a database replacement or ambiguous ACK.
      } else if (completing ? !this.state.pendingMaintenance
        || ['transactionId', 'kind', 'payloadSha256'].some(key => this.state.pendingMaintenance[key] !== metadata[key])
        : this.state.pendingMaintenance || this.state.maintenanceIds.has(metadata.transactionId)) fail('MAINTENANCE_REJECTED');
      if (typeof callback !== 'function' || !this.state.aiOff || this.state.pendingRestore
          || metadata.budgetDay < this.state.budgetDay || BigInt(metadata.minimumVersion) < BigInt(this.state.minimumVersion)
          || BigInt(metadata.minimumVersion) > BigInt(this.options.runningBuild)) fail('MAINTENANCE_REJECTED');
      const ack = await callback(this.snapshot(), copy(metadata));
      try { object(ack, ['verified', ...MAINTENANCE_FIELDS]); } catch { fail('MAINTENANCE_REJECTED'); }
      const { verified, ...acknowledged } = ack;
      if (verified !== true || canonical(acknowledged) !== canonical(metadata)) fail('MAINTENANCE_REJECTED');
      if (!(existing?.transactionId === metadata.transactionId && canonical(existing) === canonical(metadata)))
        await this.append({ type: completing ? 'MAINTENANCE_COMPLETED' : 'MAINTENANCE_SEALED', metadata });
      await this.verifyMaintenanceHead();
      return this.snapshot();
    });
  }
  sealMaintenance(input) { return this.maintenance(input, false); }
  completeMaintenance(input) { return this.maintenance(input, true); }
  async verifyMaintenanceHead() {
    await this.fault('maintenance.beforeReadback');
    const descriptor = await this.log.stat(); secureStat(descriptor);
    const bytes = await regularRead(this.logPath, this.limits.logBytes);
    const actual = await fs.lstat(this.logPath); secureStat(actual);
    if (actual.dev !== descriptor.dev || actual.ino !== descriptor.ino || bytes.length !== this.bytes) fail('LOG_CHANGED');
    // Validate the bounded chain against the trusted in-memory head. This also covers an
    // idempotent ACK after later latch/import records, rather than just rereading the last seal.
    let offset = 0; let previous = ZERO; let sequence = 0;
    while (offset < bytes.length) {
      if (bytes.length - offset < 4) fail('LOG_CHANGED');
      const length = bytes.readUInt32BE(offset);
      if (length < 1 || length > this.limits.recordBytes || length > bytes.length - offset - 4) fail('LOG_CHANGED');
      let value;
      try { value = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString('utf8')); } catch { fail('LOG_CHANGED'); }
      if (value.previousHash !== previous || value.sequence !== ++sequence) fail('LOG_CHANGED');
      previous = digest(bytes.subarray(offset, offset + 4 + length)); offset += 4 + length;
    }
    if (sequence !== this.state.sequence || previous !== this.state.headHash) fail('LOG_CHANGED');
    await this.fault('maintenance.afterReadback');
  }
  activate(acknowledgement) {
    return this.run(async () => {
      object(acknowledgement, ['projectionDigest', 'userApproved']); hash(acknowledgement.projectionDigest);
      if (acknowledgement.userApproved !== true || acknowledgement.projectionDigest !== this.projectionDigest()) fail('ACTIVATION_REJECTED');
      const now = this.now();
      if (now < this.state.clockHighWaterMs || new Date(now).toISOString().slice(0, 10) < this.state.budgetDay) fail('CLOCK_REGRESSION');
      if (BigInt(this.options.runningBuild) < BigInt(this.state.minimumVersion)) fail('BUILD_TOO_OLD');
      if ([...this.state.requests.values()].some((row) => row.conflict || (row.status === 'SETTLED' && BigInt(row.actualMicroUsd) > BigInt(row.reservedMicroUsd)))
          || this.state.pendingRestore || this.state.pendingMaintenance || this.state.legacyLiabilityUnresolved
          || this.options.recoveryMode === true) fail('ACTIVATION_REJECTED');
      if (await this.options.verifyActivation(this.snapshot(), copy(acknowledgement)) !== true) fail('ACTIVATION_REJECTED');
      const latchPresent = await this.readLatch();
      if (!this.state.aiOff && !latchPresent) return this.snapshot();
      await this.append({ type: 'ACTIVATED', projectionDigest: this.projectionDigest() });
      this.state.aiOff = true;
      await this.fault('activate.beforeUnlink'); await this.checkOwnership();
      await fs.unlink(this.latchPath); await this.fault('activate.afterUnlink');
      await this.syncDirectory(this.root, 'activate'); await this.checkOwnership(); this.state.aiOff = false;
      return this.snapshot();
    });
  }
  close() {
    if (this.closing) return this.closePromise;
    this.closing = true;
    this.closePromise = this.queue.then(async () => {
      this.closed = true; this.permits.clear();
      try { try { await this.log?.close(); } finally { await this.releaseLock(); } }
      catch { throw new SafetyJournalError('CLOSE_FAILED'); }
    });
    return this.closePromise;
  }
}

async function prepare(options, initialize) {
  let journal;
  try {
    if (!options || typeof options !== 'object' || !path.isAbsolute(options.safetyRoot || '')
        || !Array.isArray(options.restoreRoots) || !options.restoreRoots.length
        || options.restoreRoots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) fail('INVALID_INPUT');
    installationId(options.installationId); money(options.runningBuild);
    if (options.recoveryMode !== undefined && typeof options.recoveryMode !== 'boolean') fail('INVALID_INPUT');
    for (const name of ['verifyCommittedReservation', 'verifySettlement', 'verifyActivation']) if (typeof options[name] !== 'function') fail('INVALID_INPUT');
    if (!options.keyProvider || typeof options.keyProvider.currentKeyId !== 'function' || typeof options.keyProvider.getMacKey !== 'function') fail('INVALID_INPUT');
    const root = path.resolve(options.safetyRoot); const real = await plannedRealPath(root);
    for (const input of options.restoreRoots) {
      const restore = path.resolve(input); const resolved = await plannedRealPath(restore);
      if (within(root, restore) || within(restore, root) || within(real, resolved) || within(resolved, real)) fail('RESTORE_OVERLAP');
    }
    if (initialize) await fs.mkdir(root, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    secureStat(await fs.lstat(root), true);
    journal = new Journal(options, root);
    if (initialize) {
      try { await fs.lstat(journal.latchPath); fail('ALREADY_INITIALIZED'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await fs.mkdir(journal.directory, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') fail('ALREADY_INITIALIZED'); throw error; }
      await journal.syncDirectory(root, 'initialize');
    }
    await journal.acquireLock();
    if (initialize) {
      await journal.writeLatch('INITIAL_OFF');
      await journal.checkOwnership();
      journal.log = await fs.open(journal.logPath, constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await journal.log.sync(); await journal.syncDirectory(journal.directory, 'initializeLog');
      await journal.append({ type: 'GENESIS', installationId: options.installationId });
    } else {
      await journal.readLatch();
      try { await journal.replay(); }
      catch (error) { if (error.code === 'ENOENT') fail('JOURNAL_MISSING'); throw error; }
      journal.log = await fs.open(journal.logPath, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
      await journal.writeLatch('RESTART_RECONCILIATION');
      await journal.append({ type: 'LATCH', reason: 'RESTART_RECONCILIATION' });
    }
    // Expose capabilities, never mutable internal state, file descriptors, options, or key ports.
    return Object.freeze(Object.fromEntries(['snapshot', 'reserveAndPermit', 'consumePermit', 'settle', 'holdUnknown',
      'latch', 'mergeRestore', 'sealMaintenance', 'completeMaintenance', 'activate', 'close'].map((name) => [name, journal[name].bind(journal)])));
  } catch (error) {
    const code = error instanceof SafetyJournalError ? error.code : 'IO_FAILURE';
    // Another live writer owns its own OFF policy; never mutate or remove that writer's files.
    if (journal?.lock || journal?.nativeLock) { await journal.poison(code); await journal.close().catch(() => {}); }
    else if (journal && !['WRITER_LOCKED', 'ALREADY_INITIALIZED'].includes(code)) {
      journal.poisoned = true;
      await journal.writeLatch('CORRUPT').catch(() => {});
    }
    throw new SafetyJournalError(code, journal?.snapshot());
  }
}

module.exports = {
  initializeSafetyJournal: (options) => prepare(options, true),
  openSafetyJournal: (options) => prepare(options, false),
  SafetyJournalError,
};
