const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const LOCK = '.runtime-stage.lock';
const MARKER = '.runtime-stage-recovery.json';

// Supplied by the release owner/CI. Never synthesize antirollback ordering from time or semver.
function requireBuildSequence(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)
      || value.match(/^(0|[1-9][0-9]{0,18})$/)?.[0] !== value
      || BigInt(value) > 9223372036854775807n) {
    throw new Error('CODE_INTELLIGENCE_BUILD_SEQUENCE must be an explicit canonical nonnegative signed64 decimal string.');
  }
  return value;
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function directory(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Runtime stage paths must be real directories.');
}

function directoryChain(file) {
  let cursor = path.parse(file).root;
  for (const part of file.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!exists(cursor)) break;
    directory(cursor);
  }
}

function syncDirectory(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeDurable(file, value, created = () => {}) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    created(fs.fstatSync(fd));
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Flush built bytes before publication. Build output may not contain links or special files. */
function syncTree(root) {
  directory(root);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) syncTree(file);
    else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else throw new Error('Runtime stage contains a link or special file.');
  }
  syncDirectory(root);
}

/** jlink emits relative license links. Convert only validated links inside this fresh legal tree. */
function materializeLegalTree(legal, guard) {
  const parents = new Map();
  const plans = [];
  let entries = 0, totalBytes = 0;
  const invalid = () => { throw new Error('JRE legal materialization requires unchanged internal regular files and directories.'); };
  const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const directoryStamp = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':');
  function checkedDirectory(file) {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7022n) !== 0n) invalid();
    if (parents.has(file) && parents.get(file) !== directoryStamp(stat)) invalid();
    parents.set(file, directoryStamp(stat));
  }
  function regular(file) {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o7133n) !== 0n
        || (stat.mode & 0o400n) === 0n || stat.size > 8n * 1024n * 1024n) invalid();
    return stat;
  }
  function held() {
    guard();
    for (const file of parents.keys()) checkedDirectory(file);
  }
  function scan(directory, depth = 0) {
    if (depth > 32) invalid();
    checkedDirectory(directory);
    for (const name of fs.readdirSync(directory)) {
      if (++entries > 10000) invalid();
      const file = path.join(directory, name), stat = fs.lstatSync(file, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) scan(file, depth + 1);
      else if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        if (path.isAbsolute(link)) invalid();
        const target = path.resolve(directory, link);
        if (!target.startsWith(legal + path.sep)) invalid();
        let parent = legal;
        for (const component of path.relative(legal, path.dirname(target)).split(path.sep).filter(Boolean)) {
          parent = path.join(parent, component); checkedDirectory(parent);
        }
        const targetStat = regular(target);
        totalBytes += Number(targetStat.size);
        if (totalBytes > 64 * 1024 * 1024) invalid();
        plans.push({ file, link, linkStamp: stamp(stat), target, targetStamp: stamp(targetStat), size: Number(targetStat.size), mode: Number(targetStat.mode & 0o777n) });
      } else regular(file);
    }
  }
  guard();
  directoryChain(legal);
  checkedDirectory(path.dirname(legal));
  scan(legal); // Validate every target before changing even one link.
  held();
  for (const plan of plans) {
    held();
    if (stamp(fs.lstatSync(plan.file, { bigint: true })) !== plan.linkStamp || fs.readlinkSync(plan.file) !== plan.link
        || stamp(regular(plan.target)) !== plan.targetStamp) invalid();
    const temporary = path.join(path.dirname(plan.file), `.ci-legal-${randomUUID()}`);
    let input, output, temporaryIdentity, promoted = false;
    const bytes = Buffer.alloc(64 * 1024);
    try {
      input = fs.openSync(plan.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (stamp(fs.fstatSync(input, { bigint: true })) !== plan.targetStamp) invalid();
      output = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temporaryIdentity = fs.fstatSync(output, { bigint: true });
      let offset = 0;
      while (offset < plan.size) {
        const count = fs.readSync(input, bytes, 0, Math.min(bytes.length, plan.size - offset), offset);
        if (!count) invalid();
        let written = 0;
        while (written < count) {
          const amount = fs.writeSync(output, bytes, written, count - written, offset + written);
          if (!amount) invalid(); written += amount;
        }
        offset += count;
      }
      if (fs.readSync(input, bytes, 0, 1, plan.size) !== 0 || stamp(fs.fstatSync(input, { bigint: true })) !== plan.targetStamp) invalid();
      fs.fchmodSync(output, plan.mode); fs.fsyncSync(output);
      const final = fs.fstatSync(output, { bigint: true });
      if (!final.isFile() || final.nlink !== 1n || Number(final.size) !== plan.size || Number(final.mode & 0o777n) !== plan.mode) invalid();
      fs.closeSync(output); output = undefined; fs.closeSync(input); input = undefined;
      held();
      if (stamp(fs.lstatSync(temporary, { bigint: true })) !== stamp(final)
          || stamp(fs.lstatSync(plan.file, { bigint: true })) !== plan.linkStamp || fs.readlinkSync(plan.file) !== plan.link
          || stamp(regular(plan.target)) !== plan.targetStamp) invalid();
      fs.renameSync(temporary, plan.file); promoted = true;
      syncDirectory(path.dirname(plan.file));
    } finally {
      bytes.fill(0);
      if (output !== undefined) fs.closeSync(output);
      if (input !== undefined) fs.closeSync(input);
      if (!promoted && temporaryIdentity && exists(temporary)) {
        const current = fs.lstatSync(temporary, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== temporaryIdentity.dev || current.ino !== temporaryIdentity.ino) invalid();
        fs.unlinkSync(temporary);
      }
    }
  }
  held();
  return { materialized: plans.length, bytes: totalBytes };
}

/** Repair only the four known development-build libpq/ecpg aliases in a fresh destination. */
function materializePgLibraryAliases(destination, source, guard) {
  const invalid = () => { throw new Error('PostgreSQL alias materialization requires unchanged matching regular build libraries.'); };
  if (typeof source !== 'string' || !path.isAbsolute(source) || path.normalize(source) !== source) invalid();
  const sourceRoot = fs.realpathSync(source);
  directoryChain(sourceRoot); directoryChain(destination);
  const directories = [sourceRoot, destination].map(file => ({ file, stat: fs.lstatSync(file, { bigint: true }) }));
  const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  function held() {
    guard();
    for (const { file, stat } of directories) {
      const current = fs.lstatSync(file, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || (current.mode & 0o7022n) !== 0n
          || current.dev !== stat.dev || current.ino !== stat.ino || current.mode !== stat.mode
          || current.uid !== stat.uid || current.gid !== stat.gid) invalid();
    }
  }
  function verified(file) {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o7022n) !== 0n
        || (stat.mode & 0o400n) === 0n || stat.size > 64n * 1024n * 1024n) invalid();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), bytes = Buffer.alloc(64 * 1024), hash = createHash('sha256');
    try {
      if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)) invalid();
      let offset = 0;
      for (;;) {
        const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
        if (!count) break; offset += count;
        if (offset > Number(stat.size)) invalid(); hash.update(bytes.subarray(0, count));
      }
      if (offset !== Number(stat.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)
          || stamp(fs.lstatSync(file, { bigint: true })) !== stamp(stat)) invalid();
      return { stamp: stamp(stat), hash: hash.digest('hex'), mode: stat.mode & 0o777n };
    } finally { bytes.fill(0); fs.closeSync(fd); }
  }
  const plans = [];
  held();
  for (const [name, versioned] of Object.entries({ 'libpq.dylib': 'libpq.5.dylib', 'libpgtypes.dylib': 'libpgtypes.3.dylib',
    'libecpg.dylib': 'libecpg.6.dylib', 'libecpg_compat.dylib': 'libecpg_compat.3.dylib' })) {
    const file = path.join(destination, name), sourceAlias = path.join(sourceRoot, name);
    if (!exists(file) && !exists(sourceAlias)) continue;
    const sourceTarget = path.join(sourceRoot, versioned), target = path.join(destination, versioned);
    if (fs.realpathSync(sourceAlias) !== sourceTarget) invalid();
    const origin = verified(sourceTarget), copied = verified(target);
    if (origin.hash !== copied.hash || origin.mode !== copied.mode) invalid();
    const alias = fs.lstatSync(file, { bigint: true });
    if (!alias.isSymbolicLink()) {
      const materialized = verified(file);
      if (materialized.hash !== copied.hash || materialized.mode !== copied.mode) invalid();
      continue;
    }
    const link = fs.readlinkSync(file);
    if (path.isAbsolute(link) ? path.normalize(link) !== sourceTarget : path.resolve(destination, link) !== target) invalid();
    plans.push({ file, link, alias: stamp(alias), sourceAlias, sourceTarget, origin, target, copied });
  }
  held();
  for (const plan of plans) {
    held();
    if (fs.realpathSync(plan.sourceAlias) !== plan.sourceTarget || verified(plan.sourceTarget).stamp !== plan.origin.stamp
        || verified(plan.target).stamp !== plan.copied.stamp || stamp(fs.lstatSync(plan.file, { bigint: true })) !== plan.alias
        || fs.readlinkSync(plan.file) !== plan.link) invalid();
    fs.unlinkSync(plan.file);
    // EXCL is essential: a replacement destination symlink must never be followed by copyFile.
    fs.copyFileSync(plan.target, plan.file, fs.constants.COPYFILE_EXCL);
    const copied = verified(plan.file);
    if (copied.hash !== plan.copied.hash || copied.mode !== plan.copied.mode
        || verified(plan.target).stamp !== plan.copied.stamp || verified(plan.sourceTarget).stamp !== plan.origin.stamp) invalid();
    held();
    const fd = fs.openSync(plan.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (stamp(fs.fstatSync(fd, { bigint: true })) !== copied.stamp) invalid(); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory(destination);
  }
  held();
  return { materialized: plans.length };
}

/**
 * Developer build staging only. A crash leaves the exclusive lock/recovery marker for inspection;
 * a subsequent invocation refuses to overwrite any of the retained directories.
 * This does not verify signatures, install an app, or provide a production update protocol.
 */
function createRuntimeStage(stageDirectory, { checkpoint = () => {} } = {}) {
  stageDirectory = path.resolve(stageDirectory);
  directoryChain(stageDirectory);
  fs.mkdirSync(stageDirectory, { recursive: true });
  directoryChain(stageDirectory);
  const root = fs.realpathSync(stageDirectory);
  const rootIdentity = fs.statSync(root);
  const lock = path.join(root, LOCK);
  const marker = path.join(root, MARKER);
  if (exists(marker)) throw new Error('An interrupted runtime stage requires recovery; retained directories were not changed.');
  if (exists(lock)) throw new Error('Another or interrupted runtime build owns the stage lock; inspect it before rebuilding.');
  // Exclusive create is the concurrency authority, not the existence checks above.
  writeDurable(lock, { format: 1, pid: process.pid, operation: randomUUID() });
  const lockIdentity = fs.lstatSync(lock);
  let staging;
  let stagingIdentity;
  let closed = false;
  let committed = false;
  let recoveryRequired = false;
  let materializationFailed = false;
  const stage = path.join(root, 'runtime');
  const previous = path.join(root, `runtime.previous-${randomUUID()}`);

  function sameIdentity(file, expected) {
    const current = fs.lstatSync(file);
    return !current.isSymbolicLink() && current.dev === expected.dev && current.ino === expected.ino;
  }

  function requireOwnership() {
    let owned = false;
    try { owned = sameIdentity(root, rootIdentity) && sameIdentity(lock, lockIdentity); } catch { /* fail closed */ }
    if (!owned) {
      recoveryRequired = true;
      const error = new Error('Runtime stage ownership changed; no cleanup or publication was performed.');
      error.recoveryRequired = true;
      throw error;
    }
  }

  function close() {
    if (closed || recoveryRequired) return;
    requireOwnership();
    // Never clean a directory owned by another invocation or a pre-existing runtime.
    if (!committed && staging && exists(staging)) {
      if (!sameIdentity(staging, stagingIdentity)) {
        recoveryRequired = true;
        throw new Error('Runtime build directory ownership changed; no cleanup was performed.');
      }
      fs.rmSync(staging, { recursive: true });
    }
    fs.unlinkSync(lock);
    closed = true;
    syncDirectory(root);
  }

  try {
    syncDirectory(root);
    if (exists(stage)) directory(stage);
    staging = fs.mkdtempSync(path.join(root, 'runtime.incoming-'));
    stagingIdentity = fs.lstatSync(staging);
  } catch (error) {
    close();
    throw error;
  }

  function publish() {
    if (closed || committed || recoveryRequired || materializationFailed) throw new Error('Runtime stage is no longer publishable.');
    let movedPrevious = false;
    let movedIncoming = false;
    let markerIdentity;
    try {
      requireOwnership();
      if (!sameIdentity(staging, stagingIdentity)) {
        recoveryRequired = true;
        const error = new Error('Runtime build directory ownership changed.');
        error.recoveryRequired = true;
        throw error;
      }
      if (exists(stage)) directory(stage);
      if (exists(previous)) throw new Error('Runtime recovery destination already exists.');
      syncTree(staging);
      checkpoint('BEFORE_MARKER');
      writeDurable(marker, {
        format: 1, incoming: path.basename(staging), previous: path.basename(previous),
        hadPrevious: exists(stage),
      }, (identity) => { markerIdentity = identity; });
      recoveryRequired = true;
      syncDirectory(root);
      checkpoint('MARKER_DURABLE');
      if (exists(previous)) throw new Error('Runtime recovery destination already exists.');
      if (exists(stage)) {
        fs.renameSync(stage, previous);
        movedPrevious = true;
        syncDirectory(root);
      }
      checkpoint('PREVIOUS_RETAINED');
      fs.renameSync(staging, stage);
      movedIncoming = true;
      syncDirectory(root);
      checkpoint('INCOMING_PUBLISHED');
      requireOwnership();
      if (!sameIdentity(marker, markerIdentity)) throw new Error('Runtime recovery marker ownership changed.');
      fs.unlinkSync(marker);
      syncDirectory(root);
      committed = true;
      recoveryRequired = false;
    } catch (error) {
      if (error.recoveryRequired) throw error;
      // Once incoming is installed, uncertain persistence/marker cleanup must not pretend rollback.
      // Keep old+new and the exclusive lock; next run fails closed even if marker unlink succeeded.
      if (movedIncoming) {
        recoveryRequired = true;
        const failure = new Error('Runtime publication needs recovery; both available versions and the stage lock were retained.', { cause: error });
        failure.recoveryRequired = true;
        throw failure;
      }
      try {
        if (movedPrevious) {
          fs.renameSync(previous, stage);
          syncDirectory(root);
        }
        if (exists(marker)) {
          if (!markerIdentity || !sameIdentity(marker, markerIdentity)) {
            throw new Error('Runtime recovery marker ownership changed.');
          }
          fs.unlinkSync(marker);
          syncDirectory(root);
        }
        recoveryRequired = false;
      } catch (rollbackError) {
        recoveryRequired = true;
        const failure = new Error('Runtime staging rollback needs recovery; retained directories and marker were not removed.', { cause: rollbackError });
        failure.recoveryRequired = true;
        throw failure;
      }
      throw error;
    }
    // Publication is already durable. Lock-cleanup errors cannot roll back either version.
    close();
    return { stage, previous: movedPrevious ? previous : null };
  }

  function materializeJreLegal() {
    if (arguments.length || closed || committed || recoveryRequired || materializationFailed) throw new Error('Runtime stage is not materializable.');
    try { return materializeLegalTree(path.join(staging, 'jre', 'legal'), () => {
      requireOwnership();
      const current = fs.lstatSync(staging);
      if (!sameIdentity(staging, stagingIdentity) || current.mode !== stagingIdentity.mode
          || current.uid !== stagingIdentity.uid || current.gid !== stagingIdentity.gid) {
        recoveryRequired = true;
        throw new Error('Runtime stage ownership or permissions changed; legal files were not adopted.');
      }
    }); } catch (error) { materializationFailed = true; throw error; }
  }

  function materializePgAliases(source) {
    if (arguments.length !== 1 || closed || committed || recoveryRequired || materializationFailed) throw new Error('Runtime stage is not materializable.');
    try { return materializePgLibraryAliases(path.join(staging, 'postgres', 'lib'), source, () => {
      requireOwnership();
      const current = fs.lstatSync(staging);
      if (!sameIdentity(staging, stagingIdentity) || current.mode !== stagingIdentity.mode
          || current.uid !== stagingIdentity.uid || current.gid !== stagingIdentity.gid) {
        recoveryRequired = true;
        throw new Error('Runtime stage ownership or permissions changed; library files were not adopted.');
      }
    }); } catch (error) { materializationFailed = true; throw error; }
  }

  return { staging, stage, publish, close, materializeJreLegal, materializePgAliases };
}

module.exports = { createRuntimeStage, requireBuildSequence };
