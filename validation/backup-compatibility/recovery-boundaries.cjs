'use strict';

// C16 restore crash-matrix hooks. Serialized into the SDK-owned Electron main of a NEW
// automation claim; never imported by product code. They observe only file operations
// and fixed journal event types, hold exactly one operation at a durable edge so the
// supervisor can SIGKILL the captured main, and never read keys, records or payloads.

// Runner expectations. `prompt` is whether the next start must ask to verify an interrupted
// transaction; `outcome` is the data the recovered profile must expose afterwards.
const BOUNDARIES = Object.freeze({
  LATCH_BEFORE: { arrow: 'NORMAL->LATCHED', side: 'before', prompt: false, outcome: 'PREVIOUS' },
  LATCH_AFTER: { arrow: 'NORMAL->LATCHED', side: 'after', prompt: false, outcome: 'PREVIOUS' },
  PREPARED_BEFORE: { arrow: 'LATCHED->SAFETY_SEALED', side: 'before', prompt: false, outcome: 'PREVIOUS' },
  PREPARED_AFTER: { arrow: 'LATCHED->SAFETY_SEALED', side: 'within', prompt: true, outcome: 'PREVIOUS' },
  MERGED_BEFORE: { arrow: 'LATCHED->SAFETY_SEALED', side: 'within', prompt: true, outcome: 'PREVIOUS' },
  MERGED_AFTER: { arrow: 'LATCHED->SAFETY_SEALED', side: 'within', prompt: true, outcome: 'PREVIOUS' },
  SEAL_BEFORE: { arrow: 'LATCHED->SAFETY_SEALED', side: 'within', prompt: true, outcome: 'PREVIOUS' },
  SEAL_AFTER: { arrow: 'LATCHED->SAFETY_SEALED', side: 'within', prompt: true, outcome: 'PREVIOUS' },
  SEALED_AFTER: { arrow: 'LATCHED->SAFETY_SEALED', side: 'after', prompt: true, outcome: 'PREVIOUS' },
  STAGED_BEFORE: { arrow: 'SAFETY_SEALED->DATA_STAGED', side: 'before', prompt: true, outcome: 'PREVIOUS' },
  STAGED_AFTER: { arrow: 'SAFETY_SEALED->DATA_STAGED', side: 'after', prompt: true, outcome: 'PREVIOUS' },
  DATABASE_SWAPPED_BEFORE: { arrow: 'DATA_STAGED->DATA_RESTORED', side: 'within', prompt: true, outcome: 'PREVIOUS' },
  DATABASE_SWAPPED_AFTER: { arrow: 'DATA_STAGED->DATA_RESTORED', side: 'within', prompt: true, outcome: 'PREVIOUS' },
  SOURCE_RENAME_AFTER: { arrow: 'DATA_STAGED->DATA_RESTORED', side: 'within', prompt: true, outcome: 'PREVIOUS' },
  SOURCES_PUBLISHED_BEFORE: { arrow: 'DATA_STAGED->DATA_RESTORED', side: 'within', prompt: true, outcome: 'PREVIOUS' },
  SOURCES_PUBLISHED_AFTER: { arrow: 'DATA_STAGED->DATA_RESTORED', side: 'after', prompt: true, outcome: 'PREVIOUS' },
  HEALTH_BEFORE: { arrow: 'SAFETY_MERGED->HEALTH_VERIFIED', side: 'before', prompt: true, outcome: 'PREVIOUS' },
  HEALTH_AFTER: { arrow: 'SAFETY_MERGED->HEALTH_VERIFIED', side: 'after', prompt: true, outcome: 'PREVIOUS' },
  COMPLETE_BEFORE: { arrow: 'HEALTH_VERIFIED->NORMAL', side: 'before', prompt: true, outcome: 'PREVIOUS' },
  COMPLETE_AFTER: { arrow: 'HEALTH_VERIFIED->NORMAL', side: 'within', prompt: true, outcome: 'RESTORED' },
  CLEANUP_BEFORE: { arrow: 'HEALTH_VERIFIED->NORMAL', side: 'within', prompt: true, outcome: 'RESTORED' },
  RETENTION_AFTER: { arrow: 'HEALTH_VERIFIED->NORMAL', side: 'within', prompt: true, outcome: 'RESTORED' },
  COMPLETED_BEFORE: { arrow: 'HEALTH_VERIFIED->NORMAL', side: 'within', prompt: true, outcome: 'RESTORED' },
  COMPLETED_AFTER: { arrow: 'HEALTH_VERIFIED->NORMAL', side: 'within', prompt: true, outcome: 'RESTORED' },
  ACTIVE_CLEAR_BEFORE: { arrow: 'HEALTH_VERIFIED->NORMAL', side: 'within', prompt: true, outcome: 'RESTORED' },
  ACTIVE_CLEAR_AFTER: { arrow: 'HEALTH_VERIFIED->NORMAL', side: 'after', prompt: false, outcome: 'RESTORED' },
});

async function installOwnedBoundary({ app }, { profile, parent, point }) {
  const builtin = name => process.getBuiltinModule(name);
  const assert = builtin('assert/strict'), fs = builtin('fs'), path = builtin('path');
  assert.equal(app.getName(), 'Code Intelligence Acceptance');
  assert.equal(app.getPath('userData'), profile);
  assert.equal(fs.realpathSync(parent), parent);
  assert.equal(fs.realpathSync(profile), profile);
  assert(profile.startsWith(parent + '/desktop-run-'));
  assert.equal(fs.lstatSync(profile).uid, process.getuid());
  assert.equal(fs.lstatSync(profile).mode & 0o777, 0o700);
  // Trigger table. Records are labelled only by their order within this one restore and
  // checked against independently observed journal types/renames/unlinks at creation time.
  const SPEC = {
    LATCH_BEFORE: ['latch', null, 'before'], LATCH_AFTER: ['journal', 'LATCH', 'after'],
    PREPARED_BEFORE: ['record', 'PREPARED', 'before'], PREPARED_AFTER: ['record', 'PREPARED', 'after'],
    MERGED_BEFORE: ['record', 'MERGED', 'before'], MERGED_AFTER: ['record', 'MERGED', 'after'],
    SEAL_BEFORE: ['journal', 'MAINTENANCE_SEALED', 'before'], SEAL_AFTER: ['journal', 'MAINTENANCE_SEALED', 'after'],
    SEALED_AFTER: ['record', 'SEALED', 'after'],
    STAGED_BEFORE: ['record', 'STAGED', 'before'], STAGED_AFTER: ['record', 'STAGED', 'after'],
    DATABASE_SWAPPED_BEFORE: ['record', 'DATABASE_SWAPPED', 'before'], DATABASE_SWAPPED_AFTER: ['record', 'DATABASE_SWAPPED', 'after'],
    SOURCE_RENAME_AFTER: ['rename', 'SAVE_REPOS', 'after'],
    SOURCES_PUBLISHED_BEFORE: ['record', 'SS_PUBLISHED', 'before'], SOURCES_PUBLISHED_AFTER: ['record', 'SS_PUBLISHED', 'after'],
    HEALTH_BEFORE: ['record', 'HEALTH_VERIFIED', 'before'], HEALTH_AFTER: ['record', 'HEALTH_VERIFIED', 'after'],
    COMPLETE_BEFORE: ['journal', 'MAINTENANCE_COMPLETED', 'before'], COMPLETE_AFTER: ['journal', 'MAINTENANCE_COMPLETED', 'after'],
    CLEANUP_BEFORE: ['unlink', 'checkpoint', 'before'], RETENTION_AFTER: ['record', 'RETENTION_READY', 'after'],
    COMPLETED_BEFORE: ['record', 'COMPLETED', 'before'], COMPLETED_AFTER: ['record', 'COMPLETED', 'after'],
    ACTIVE_CLEAR_BEFORE: ['unlink', 'active', 'before'], ACTIVE_CLEAR_AFTER: ['unlink', 'active', 'after'],
  };
  assert(typeof point === 'string' && Object.hasOwn(SPEC, point));
  const [on, target, when] = SPEC[point];
  const LABELS = ['PREPARED', 'MERGED', 'SEALED', 'STAGED', 'DATABASE_SWAPPED', 'SS_PREPARED', 'SS_SAVE_REPOS',
    'SS_PUBLISH_REPOS', 'SS_SAVE_SOURCES', 'SS_PUBLISH_SOURCES', 'SS_PUBLISHED', 'HEALTH_VERIFIED', 'RETENTION_READY', 'COMPLETED'];
  const RENAMES = ['SAVE_REPOS', 'PUBLISH_REPOS', 'SAVE_SOURCES', 'PUBLISH_SOURCES'];
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const journalFile = path.join(profile, 'safety', 'ai-journal', 'events.log');
  const journalStat = fs.statSync(journalFile);
  const { O_CREAT, O_EXCL } = fs.constants;
  const io = fs.promises, original = { open: io.open, rename: io.rename, unlink: io.unlink };
  const seen = { journal: [], records: [], renames: [], unlinks: [], latches: 0, receipts: 0 };
  let hit = null, mismatch = null, restored = false, rejectHold, journalPending = null, recordPending = null;
  const relative = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
    && value.startsWith(profile + path.sep) ? path.relative(profile, value) : null;
  const journalCache = new WeakMap();
  function isJournal(handle) {
    if (journalCache.has(handle)) return journalCache.get(handle);
    let value = false;
    try { const stat = fs.fstatSync(handle.fd); value = stat.dev === journalStat.dev && stat.ino === journalStat.ino; } catch { value = false; }
    journalCache.set(handle, value); return value;
  }
  function active() { return !restored && !hit && !mismatch; }
  function pause(details) {
    hit = { point, ...details, count: 1 };
    return new Promise((_, reject) => { rejectHold = reject; });
  }
  function invalid(reason) { mismatch ||= { point, reason }; }
  function expectedLabel() {
    const n = seen.records.length + 1, label = LABELS[n - 1];
    if (!label) return null;
    const types = seen.journal.map(item => item.type), names = seen.renames.join(',');
    const last = seen.journal.at(-1), previous = seen.records.at(-1)?.label;
    const ok = {
      PREPARED: types.length === 1 && types[0] === 'LATCH' && !names,
      MERGED: types.includes('RESTORE_RECEIPT') && !types.includes('MAINTENANCE_SEALED') && previous === 'PREPARED',
      SEALED: last?.type === 'MAINTENANCE_SEALED' && last.durable && previous === 'MERGED',
      STAGED: last?.type === 'MAINTENANCE_SEALED' && !names && previous === 'SEALED',
      DATABASE_SWAPPED: !names && previous === 'STAGED',
      SS_PREPARED: !names && previous === 'DATABASE_SWAPPED',
      SS_SAVE_REPOS: names === 'SAVE_REPOS' && previous === 'SS_PREPARED',
      SS_PUBLISH_REPOS: names === 'SAVE_REPOS,PUBLISH_REPOS' && previous === 'SS_SAVE_REPOS',
      SS_SAVE_SOURCES: names === 'SAVE_REPOS,PUBLISH_REPOS,SAVE_SOURCES' && previous === 'SS_PUBLISH_REPOS',
      SS_PUBLISH_SOURCES: names === RENAMES.join(',') && previous === 'SS_SAVE_SOURCES',
      SS_PUBLISHED: names === RENAMES.join(',') && previous === 'SS_PUBLISH_SOURCES',
      HEALTH_VERIFIED: names === RENAMES.join(',') && !types.includes('MAINTENANCE_COMPLETED') && previous === 'SS_PUBLISHED',
      RETENTION_READY: last?.type === 'MAINTENANCE_COMPLETED' && last.durable && seen.unlinks.includes('checkpoint') && previous === 'HEALTH_VERIFIED',
      COMPLETED: previous === 'RETENTION_READY',
    }[label];
    if (!ok) { invalid('RECORD_' + label); return null; }
    return label;
  }
  async function open(file, flags, ...rest) {
    const name = relative(file);
    const record = name && /^backup-maintenance\/record-[0-9]{8}\.enc$/.test(name);
    if (record && active() && typeof flags === 'number' && (flags & (O_CREAT | O_EXCL)) === (O_CREAT | O_EXCL)) {
      const label = expectedLabel();
      if (label) {
        if (on === 'record' && target === label && when === 'before') return pause({ label, ordinal: seen.records.length + 1, operationCompleted: false });
        seen.records.push({ label, durable: false }); recordPending = { name, label };
      }
    } else if (record && active() && recordPending?.name === name && typeof flags === 'number' && !(flags & O_CREAT)) {
      // The first read-only open after creation is the writer's own authenticated readback,
      // which follows file fsync and directory fsync. It changes no durable state.
      const { label } = recordPending; recordPending = null; seen.records.at(-1).durable = true;
      if (on === 'record' && target === label && when === 'after') return pause({ label, ordinal: seen.records.length, operationCompleted: true });
    } else if (name && /^backup-maintenance\/receipt-[0-9]{8}\.enc$/.test(name) && typeof flags === 'number' && (flags & O_CREAT)) seen.receipts++;
    return Reflect.apply(original.open, io, [file, flags, ...rest]);
  }
  function renameAction(from, to) {
    const a = relative(from), b = relative(to);
    if (!a || !b) return null;
    const tx = new RegExp('^recovery/(' + uuid + ')/(previous-repos|previous-sources|repos|sources)$');
    const target = b.match(tx), source = a.match(tx);
    if (a === 'data/repos' && target?.[2] === 'previous-repos') return 'SAVE_REPOS';
    if (a === 'data/sources' && target?.[2] === 'previous-sources') return 'SAVE_SOURCES';
    if (b === 'data/repos' && source?.[2] === 'repos') return 'PUBLISH_REPOS';
    if (b === 'data/sources' && source?.[2] === 'sources') return 'PUBLISH_SOURCES';
    return null;
  }
  async function rename(from, to, ...rest) {
    if (active()) {
      const a = relative(from), b = relative(to);
      if (a && b && /^safety\/\.ai-off-[0-9a-f]{32}$/.test(a) && b === 'safety/ai-off.json') {
        seen.latches++;
        if (on === 'latch' && seen.latches === 1 && !seen.journal.length) return pause({ label: 'AI_OFF_LATCH_FILE', operationCompleted: false });
      }
      const action = renameAction(from, to);
      if (action) {
        await Reflect.apply(original.rename, io, [from, to, ...rest]); seen.renames.push(action);
        if (on === 'rename' && target === action) {
          if (seen.records.length !== 6 || seen.records.at(-1).label !== 'SS_PREPARED') { invalid('RENAME_' + action); return undefined; }
          return pause({ label: action, operationCompleted: true });
        }
        return undefined;
      }
    }
    return Reflect.apply(original.rename, io, [from, to, ...rest]);
  }
  async function unlink(file, ...rest) {
    const name = relative(file);
    let kind = null;
    if (name === 'backup-maintenance/active.enc') kind = 'active';
    else if (name && new RegExp('^recovery/' + uuid + '/checkpoint/payload\\.bin$').test(name)) kind = 'checkpoint';
    else if (name && new RegExp('^recovery/' + uuid + '/incoming/payload\\.bin$').test(name)) kind = 'incoming';
    if (kind && active()) {
      if (kind === 'checkpoint' && seen.journal.at(-1)?.type !== 'MAINTENANCE_COMPLETED') invalid('UNLINK_CHECKPOINT');
      if (kind === 'active' && (!seen.receipts || seen.records.at(-1)?.label !== 'COMPLETED')) invalid('UNLINK_ACTIVE');
      if (!mismatch && on === 'unlink' && target === kind && when === 'before') return pause({ label: kind, operationCompleted: false });
      const result = await Reflect.apply(original.unlink, io, [file, ...rest]); seen.unlinks.push(kind);
      if (!mismatch && on === 'unlink' && target === kind && when === 'after') return pause({ label: kind, operationCompleted: true });
      return result;
    }
    return Reflect.apply(original.unlink, io, [file, ...rest]);
  }
  // FileHandle methods are shared by every open file; only the exact journal inode is observed.
  const probe = await original.open.call(io, journalFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const handleOriginal = { write: prototype.write, sync: prototype.sync };
  function frameType(bytes) {
    try {
      const length = bytes.readUInt32BE(0);
      if (length < 2 || bytes.length < 4 + length) return null;
      const value = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'));
      return typeof value?.event?.type === 'string' && /^[A-Z_0-9]{1,40}$/.test(value.event.type) ? value.event.type : null;
    } catch { return null; }
  }
  async function write(...args) {
    if (active() && isJournal(this) && Buffer.isBuffer(args[0]) && !args[1]) {
      const type = frameType(args[0]);
      if (type) {
        const occurrence = seen.journal.filter(item => item.type === type).length + 1;
        if (on === 'journal' && target === type && when === 'before' && occurrence === 1) return pause({ label: type, operationCompleted: false });
        seen.journal.push({ type, durable: false }); journalPending = seen.journal.at(-1);
      }
    }
    return Reflect.apply(handleOriginal.write, this, args);
  }
  async function sync(...args) {
    if (active() && journalPending && isJournal(this)) {
      const item = journalPending; journalPending = null;
      const result = await Reflect.apply(handleOriginal.sync, this, args); item.durable = true;
      if (on === 'journal' && target === item.type && when === 'after' && seen.journal.filter(row => row.type === item.type).length === 1) {
        return pause({ label: item.type, operationCompleted: true });
      }
      return result;
    }
    return Reflect.apply(handleOriginal.sync, this, args);
  }
  io.open = open; io.rename = rename; io.unlink = unlink; prototype.write = write; prototype.sync = sync;
  const summary = () => ({ point, hit: hit ? { ...hit } : null, mismatch: mismatch ? { ...mismatch } : null,
    journal: seen.journal.map(item => ({ ...item })), records: seen.records.map(item => ({ ...item })),
    renames: [...seen.renames], unlinks: [...seen.unlinks], latches: seen.latches, receipts: seen.receipts });
  return {
    inspect: summary,
    restore() {
      assert.equal(io.open, open); assert.equal(io.rename, rename); assert.equal(io.unlink, unlink);
      assert.equal(prototype.write, write); assert.equal(prototype.sync, sync);
      restored = true; io.open = original.open; io.rename = original.rename; io.unlink = original.unlink;
      prototype.write = handleOriginal.write; prototype.sync = handleOriginal.sync;
      if (rejectHold) {
        const reject = rejectHold; rejectHold = undefined;
        const error = new Error('OWNED_RESTORE_INTERRUPTION'); error.code = 'EIO'; reject(error);
      }
      return summary();
    },
  };
}

// Loopback-only stand-in for the final provider TLS connection. The product's real
// gateway, journal, PG ledger, request validation and response parsing all run; only
// tls.connect for the fixed provider host is replaced. No DNS lookup or network egress.
async function installOwnedTransport({ app }, { profile, parent, credentialSha256 }) {
  const builtin = name => process.getBuiltinModule(name);
  const assert = builtin('assert/strict'), fs = builtin('fs'), net = builtin('net'), http = builtin('http');
  const tls = builtin('tls'), crypto = builtin('crypto');
  assert.equal(app.getName(), 'Code Intelligence Acceptance');
  assert.equal(app.getPath('userData'), profile);
  assert.equal(fs.realpathSync(profile), profile);
  assert(profile.startsWith(parent + '/desktop-run-'));
  assert(/^[0-9a-f]{64}$/.test(credentialSha256));
  const MODEL = 'gpt-4o-mini-2024-07-18';
  const stats = { attempts: 0, settled: 0, held: 0, refused: 0, credentialMatches: 0, requestBodies: [] };
  let mode = 'refuse', restored = false;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    let size = 0; const hash = crypto.createHash('sha256');
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string' && crypto.createHash('sha256').update(authorization).digest('hex') === credentialSha256) stats.credentialMatches++;
    request.on('data', chunk => { size += chunk.length; if (size <= 2 * 1024 * 1024) hash.update(chunk); });
    request.on('end', () => {
      stats.requestBodies.push({ bytes: size, sha256: hash.digest('hex'), path: request.url, method: request.method });
      if (mode === 'hold') { stats.held++; return; }
      if (mode !== 'settle') { stats.refused++; request.socket.destroy(); return; }
      stats.settled++;
      const content = JSON.stringify({ explanation: 'Synthetic recovery-matrix answer.', claims: [], alternatives: [] });
      const body = Buffer.from(JSON.stringify({ id: 'chatcmpl-synthetic-recovery', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: MODEL, service_tier: 'default', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 0 } } }));
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length), 'x-request-id': 'synthetic-recovery-' + stats.settled });
      response.end(body);
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const connect = tls.connect;
  function replacement(...args) {
    const options = args[0];
    if (!restored && options && typeof options === 'object'
        && (options.servername === 'api.openai.com' || options.host === 'api.openai.com' || options.hostname === 'api.openai.com')) {
      stats.attempts++;
      if (mode === 'refuse') {
        const socket = new net.Socket();
        process.nextTick(() => socket.destroy(Object.assign(new Error('OWNED_PROVIDER_REFUSED'), { code: 'ECONNREFUSED' })));
        stats.refused++; return socket;
      }
      return net.connect({ host: '127.0.0.1', port });
    }
    return Reflect.apply(connect, this, args);
  }
  tls.connect = replacement;
  return {
    setMode(value) { assert(['refuse', 'settle', 'hold'].includes(value)); mode = value; return mode; },
    inspect() { return { mode, ...stats, requestBodies: stats.requestBodies.map(item => ({ ...item })) }; },
    async restore() {
      assert.equal(tls.connect, replacement); restored = true; tls.connect = connect;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(() => resolve()));
      return { mode, ...stats, requestBodies: stats.requestBodies.map(item => ({ ...item })) };
    },
  };
}

module.exports = { BOUNDARIES, installOwnedBoundary, installOwnedTransport };
