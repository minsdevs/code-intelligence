'use strict';

// Main-only A-directory transaction. The coordinator owns writer drain, the durable recovery
// record, and the independent database/B protocol. This module never deletes a directory.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { types: { isProxy } } = require('node:util');
const native = require('./backup-windows-io.cjs');

const NAMES = ['repos', 'sources'];
const LIMITS = Object.freeze({ entries: 600000, depth: 64, inspectMs: 120000 });
const OWNERS = new Map(); // Root's installation lock still owns exclusion across processes.
const CODES = new Set(['INVALID', 'UNSAFE', 'CHANGED', 'STATE', 'LIMIT', 'BUSY', 'CLOSED', 'IO', 'TRANSITION']);
class BackupSourceSwapError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'IO';
    super(`Backup source directory transaction: ${safe}`);
    this.name = 'BackupSourceSwapError'; this.code = `BACKUP_SOURCE_SWAP_${safe}`;
  }
}
function fail(code) { throw new BackupSourceSwapError(code); }
function plain(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID');
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) fail('INVALID');
  }
}
function exact(value, keys) {
  plain(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID');
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function identity(stat) { return stat.platform === 'win32' ? native.identity(stat) : { dev: String(stat.dev), ino: String(stat.ino) }; }
function same(a, b) { return a === null ? b === null : b !== null && (a.platform === 'win32' || b.platform === 'win32' ? a.platform === b.platform && a.identity === b.identity : a.dev === b.dev && a.ino === b.ino); }
function key(value) { return value.platform === 'win32' ? value.identity : `${value.dev}:${value.ino}`; }
function volume(value) { return value.platform === 'win32' ? value.identity.split(':')[1] : value.dev; }
function matches(value, pattern) { return typeof value === 'string' && value.match(pattern)?.[0] === value; }
function checkedIdentity(value) {
  plain(value);
  if (value?.platform === 'win32') { try { return native.checkedIdentity(value); } catch { fail('INVALID'); } }
  exact(value, ['dev', 'ino']);
  for (const name of ['dev', 'ino']) if (!matches(value[name], /^(?:0|[1-9][0-9]{0,39})$/)) fail('INVALID');
  return { dev: value.dev, ino: value.ino };
}
function checkedPlan(value, transactionId) {
  exact(value, ['version', 'transactionId', 'roots', 'entries']);
  if (value.version !== 1 || value.transactionId !== transactionId) fail('INVALID');
  exact(value.roots, ['data', 'stage']);
  const roots = { data: checkedIdentity(value.roots.data), stage: checkedIdentity(value.roots.stage) };
  if (!Array.isArray(value.entries) || isProxy(value.entries) || value.entries.length !== 2
      || Reflect.ownKeys(value.entries).length !== 3) fail('INVALID');
  const entries = NAMES.map((name, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value.entries, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID');
    const entry = descriptor.value; exact(entry, ['name', 'previous', 'incoming']);
    if (entry.name !== name) fail('INVALID');
    return { name, previous: entry.previous === null ? null : checkedIdentity(entry.previous), incoming: checkedIdentity(entry.incoming) };
  });
  const ids = [roots.data, roots.stage, ...entries.flatMap(entry => [entry.previous, entry.incoming]).filter(Boolean)];
  if (new Set(ids.map(key)).size !== ids.length || ids.some(id => volume(id) !== volume(roots.data) || id.platform !== roots.data.platform)) fail('INVALID');
  return frozen({ version: 1, transactionId, roots, entries });
}
function absolute(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)
      || path.normalize(value) !== value) fail('INVALID');
  return value;
}
function safeStat(stat, privateMode, directory) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || typeof process.getuid !== 'function' || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o7022n) !== 0n || (privateMode && (stat.mode & 0o077n) !== 0n)
      || (directory && (stat.mode & 0o700n) !== 0o700n) || (!directory && stat.nlink !== 1n)) fail('UNSAFE');
}
async function directory(directoryPath, privateMode, optional = false) {
  let stat;
  try { stat = await fs.lstat(directoryPath, { bigint: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  safeStat(stat, privateMode, true);
  if (await fs.realpath(directoryPath) !== directoryPath) fail('UNSAFE');
  return identity(stat);
}
async function scan(root, privateMode, expected, budget) {
  if (!same(await directory(root, privateMode), expected)) fail('CHANGED');
  async function walk(current, depth) {
    if (depth > LIMITS.depth || performance.now() - budget.started > LIMITS.inspectMs) fail('LIMIT');
    const handle = await fs.opendir(current);
    for await (const entry of handle) {
      if (++budget.entries > LIMITS.entries || performance.now() - budget.started > LIMITS.inspectMs) fail('LIMIT');
      const child = path.join(current, entry.name), stat = await fs.lstat(child, { bigint: true });
      safeStat(stat, privateMode, stat.isDirectory());
      if (stat.isDirectory()) await walk(child, depth + 1);
    }
  }
  await walk(root, 0);
  if (!same(await directory(root, privateMode), expected)) fail('CHANGED');
}

async function createBackupSourceSwap(options) {
  plain(options);
  const allowed = ['dataRoot', 'stageRoot', 'transactionId', 'resumePlan', 'onTransition', 'fault', 'windowsBoundary'];
  if (Object.keys(options).some(name => !allowed.includes(name))) fail('INVALID');
  const dataRoot = absolute(options.dataRoot), stageRoot = absolute(options.stageRoot), transactionId = options.transactionId;
  if (!matches(transactionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      || path.basename(dataRoot) !== 'data' || stageRoot !== path.join(path.dirname(dataRoot), 'recovery', transactionId)
      || typeof options.onTransition !== 'function' || (options.fault !== undefined && typeof options.fault !== 'function')) fail('INVALID');
  let storage;
  if (options.windowsBoundary) storage = await options.windowsBoundary.openStorage(path.dirname(dataRoot), { mode: 'workspace' });
  const inspectDirectory = async (file, privateMode, optional = false) => {
    if (!storage) return directory(file, privateMode, optional);
    const found = await storage.stat(file, { directory: true, missing: optional }); return found ? native.identity(found) : null;
  };
  const scanTree = async (root, privateMode, expected, budget) => {
    if (!storage) return scan(root, privateMode, expected, budget);
    if (!same(await inspectDirectory(root), expected)) fail('CHANGED');
    const seen = new Set();
    async function walk(file, depth) {
      if (depth > LIMITS.depth || performance.now() - budget.started > LIMITS.inspectMs) fail('LIMIT');
      const before = await storage.stat(file, { directory: true });
      if (seen.has(before.identity)) fail('UNSAFE'); seen.add(before.identity);
      for (const entry of await native.entries(storage, file, LIMITS.entries)) {
        if (++budget.entries > LIMITS.entries || performance.now() - budget.started > LIMITS.inspectMs) fail('LIMIT');
        const child = path.join(file, entry.name);
        if (entry.directory) await walk(child, depth + 1); else await storage.stat(child);
      }
      if (!native.sameState(before, await storage.stat(file, { directory: true }))) fail('CHANGED');
    }
    await walk(root, 0); if (!same(await inspectDirectory(root), expected)) fail('CHANGED');
  };
  const owner = Symbol('backup source transaction');
  let roots, plan, ownerKey, closed = false, busy = false;
  const locations = name => ({ live: path.join(dataRoot, name), staged: path.join(stageRoot, name),
    previous: path.join(stageRoot, `previous-${name}`), failed: path.join(stageRoot, `failed-${name}`) });
  async function rootsUnchanged() {
    if (!same(await inspectDirectory(dataRoot, true), roots.data) || !same(await inspectDirectory(stageRoot, true), roots.stage)) fail('CHANGED');
  }
  async function inspectInternal() {
    await rootsUnchanged();
    const slots = {}, budget = { started: performance.now(), entries: 0 };
    for (const entry of plan.entries) {
      const places = locations(entry.name), actual = {};
      for (const [position, file] of Object.entries(places)) {
        const found = await inspectDirectory(file, false, true); actual[position] = found;
        if (found) {
          const isNew = same(found, entry.incoming), isPrevious = entry.previous !== null && same(found, entry.previous);
          if (!isNew && !isPrevious) fail('CHANGED');
          await scanTree(file, isNew || entry.name === 'sources', found, budget);
        }
      }
      const incoming = Object.keys(actual).filter(position => same(actual[position], entry.incoming));
      const previous = entry.previous === null ? [] : Object.keys(actual).filter(position => same(actual[position], entry.previous));
      if (incoming.length !== 1 || previous.length !== (entry.previous === null ? 0 : 1)) fail('STATE');
      const current = incoming[0], old = previous[0] ?? null;
      if (current === 'staged' && (old === 'live' || old === null)) slots[entry.name] = 'READY';
      else if (current === 'staged' && old === 'previous') slots[entry.name] = 'SAVED';
      else if (current === 'live' && (old === 'previous' || old === null)) slots[entry.name] = 'LIVE';
      else if (current === 'failed' && old === 'previous') slots[entry.name] = 'UNPUBLISHED';
      else if (current === 'failed' && (old === 'live' || old === null)) slots[entry.name] = 'ROLLED_BACK';
      else fail('STATE');
    }
    await rootsUnchanged();
    const values = Object.values(slots);
    const phase = values.every(value => value === 'READY') ? 'PREPARED'
      : values.every(value => value === 'LIVE') ? 'PUBLISHED'
      : values.every(value => value === 'ROLLED_BACK') ? 'ROLLED_BACK'
      : values.some(value => ['UNPUBLISHED', 'ROLLED_BACK'].includes(value)) ? 'ROLLING_BACK' : 'PUBLISHING';
    return frozen({ version: 1, transactionId, phase, slots });
  }
  async function point(name, action) { if (options.fault) await options.fault(name, frozen({ action, transactionId })); }
  async function syncParents(action) {
    await rootsUnchanged();
    // Windows directory moves are namespace-only. Authenticated onTransition evidence
    // plus complete identity inventory reconciliation remains mandatory on every resume.
    if (storage) return;
    for (const [name, file] of [['data', dataRoot], ['stage', stageRoot]]) {
      await point(`before-fsync-${name}`, action);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!same(identity(await handle.stat({ bigint: true })), roots[name])) fail('CHANGED');
        await handle.sync();
        if (!same(identity(await handle.stat({ bigint: true })), roots[name])) fail('CHANGED');
      } finally { await handle.close(); }
      await point(`after-fsync-${name}`, action);
    }
    await rootsUnchanged();
  }
  async function checkpoint(action) {
    await syncParents(action);
    const state = await inspectInternal();
    await point('before-transition', action);
    try { await options.onTransition(frozen({ action, plan, state })); } catch { fail('TRANSITION'); }
    await point('after-transition', action);
    const observed = await inspectInternal();
    if (observed.phase !== state.phase || NAMES.some(name => observed.slots[name] !== state.slots[name])) fail('CHANGED');
    return state;
  }
  async function move(entry, from, to, expected, action) {
    await inspectInternal();
    const places = locations(entry.name);
    if (!same(await inspectDirectory(places[from], false, true), expected) || await inspectDirectory(places[to], false, true) !== null) fail('CHANGED');
    await point('before-rename', action);
    await rootsUnchanged();
    if (!same(await inspectDirectory(places[from], false, true), expected) || await inspectDirectory(places[to], false, true) !== null) fail('CHANGED');
    // Node has no rename-NOREPLACE/ancestor capability API. All writers must already be stopped.
    if (storage) await storage.rename(places[from], places[to], expected.identity, { directory: true });
    else await fs.rename(places[from], places[to]);
    await point('after-rename', action);
    if (!same(await inspectDirectory(places[to], false), expected) || await inspectDirectory(places[from], false, true) !== null) fail('CHANGED');
    return checkpoint(action);
  }
  async function run(operation) {
    if (closed) fail('CLOSED'); if (busy) fail('BUSY'); busy = true;
    try { return await operation(); }
    catch (error) { throw error instanceof BackupSourceSwapError ? error : new BackupSourceSwapError('IO'); }
    finally { busy = false; }
  }
  try {
    roots = { data: await inspectDirectory(dataRoot, true), stage: await inspectDirectory(stageRoot, true) };
    if (volume(roots.data) !== volume(roots.stage) || same(roots.data, roots.stage)) fail('INVALID');
    ownerKey = key(roots.data); if (OWNERS.has(ownerKey)) fail('BUSY'); OWNERS.set(ownerKey, owner);
    if (options.resumePlan !== undefined) {
      plan = checkedPlan(options.resumePlan, transactionId);
      if (!same(plan.roots.data, roots.data) || !same(plan.roots.stage, roots.stage)) fail('CHANGED');
    } else {
      const entries = [];
      for (const name of NAMES) {
        const places = locations(name);
        if (await inspectDirectory(places.previous, false, true) !== null || await inspectDirectory(places.failed, false, true) !== null) fail('STATE');
        entries.push({ name, previous: await inspectDirectory(places.live, name === 'sources', true), incoming: await inspectDirectory(places.staged, true) });
      }
      plan = checkedPlan({ version: 1, transactionId, roots, entries }, transactionId);
    }
    await inspectInternal();
  } catch (error) {
    await storage?.close().catch(() => {});
    if (ownerKey && OWNERS.get(ownerKey) === owner) OWNERS.delete(ownerKey);
    throw error instanceof BackupSourceSwapError ? error : new BackupSourceSwapError('IO');
  }
  return Object.freeze({
    plan() { if (closed) fail('CLOSED'); return plan; },
    inspect() { return run(inspectInternal); },
    publish() { return run(async () => {
      let state = await inspectInternal();
      if (Object.values(state.slots).some(value => ['UNPUBLISHED', 'ROLLED_BACK'].includes(value))) fail('STATE');
      state = await checkpoint('PREPARED');
      for (const entry of plan.entries) {
        if (state.slots[entry.name] === 'READY' && entry.previous !== null)
          state = await move(entry, 'live', 'previous', entry.previous, `SAVE_${entry.name.toUpperCase()}`);
        if (['READY', 'SAVED'].includes(state.slots[entry.name]))
          state = await move(entry, 'staged', 'live', entry.incoming, `PUBLISH_${entry.name.toUpperCase()}`);
      }
      if (state.phase !== 'PUBLISHED') fail('STATE'); return checkpoint('PUBLISHED');
    }); },
    rollback() { return run(async () => {
      let state = await checkpoint('ROLLBACK_BEGIN');
      for (const entry of [...plan.entries].reverse()) {
        if (state.slots[entry.name] === 'LIVE')
          state = await move(entry, 'live', 'failed', entry.incoming, `UNPUBLISH_${entry.name.toUpperCase()}`);
        else if (['READY', 'SAVED'].includes(state.slots[entry.name]))
          state = await move(entry, 'staged', 'failed', entry.incoming, `RETAIN_${entry.name.toUpperCase()}`);
        if (state.slots[entry.name] === 'UNPUBLISHED')
          state = await move(entry, 'previous', 'live', entry.previous, `RESTORE_${entry.name.toUpperCase()}`);
      }
      if (state.phase !== 'ROLLED_BACK') fail('STATE'); return checkpoint('ROLLED_BACK');
    }); },
    close() {
      if (busy) fail('BUSY'); closed = true;
      if (OWNERS.get(ownerKey) === owner) OWNERS.delete(ownerKey);
      return storage?.close();
    },
  });
}

module.exports = { createBackupSourceSwap, BackupSourceSwapError, LIMITS };
