'use strict';

// Serialized into the SDK-owned Electron main process, never imported by product code.
// Only the runner's fresh automation claim is accepted; no keys or DB connections are read.
function installOwnedInterruption({ app }, { profile, parent, mode, pauseForCrash = false }) {
  const builtin = name => process.getBuiltinModule(name);
  const assert = builtin('assert/strict'), fs = builtin('fs'), path = builtin('path');
  assert.equal(app.getName(), 'Code Intelligence Acceptance');
  assert.equal(app.getPath('userData'), profile);
  assert.equal(fs.realpathSync(parent), parent);
  assert.equal(fs.realpathSync(profile), profile);
  assert(profile.startsWith(parent + '/desktop-run-'));
  assert.equal(fs.lstatSync(profile).uid, process.getuid());
  assert.equal(fs.lstatSync(profile).mode & 0o777, 0o700);
  assert(['AFTER_SOURCE_RENAME', 'BEFORE_COMPLETED_CLEANUP'].includes(mode));
  assert.equal(typeof pauseForCrash, 'boolean');
  const io = fs.promises, originalRename = io.rename, originalUnlink = io.unlink;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const sourcePattern = new RegExp('^recovery/(' + uuid + ')/previous-repos$');
  const cleanupPattern = new RegExp('^recovery/(' + uuid + ')/checkpoint/payload\\.bin$');
  let hit = null, restored = false, rejectHold;
  function relative(value) {
    return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
      && value.startsWith(profile + path.sep) ? path.relative(profile, value) : null;
  }
  function trip(transactionId, operationCompleted) {
    const root = path.join(profile, 'recovery', transactionId);
    assert.equal(fs.realpathSync(root), root);
    for (const name of ['checkpoint.cibackup', 'input/archive.cibackup']) {
      const file = path.join(root, name), stat = fs.lstatSync(file);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
      assert.equal(fs.realpathSync(file), file);
      assert.equal(stat.uid, process.getuid());
    }
    hit = { mode, transactionId, operationCompleted, count: 1 };
    if (pauseForCrash) {
      hit.pauseForCrash = true;
      // Only this test invocation can pause here. No rollback runs before the
      // parent kills its captured Electron ChildProcess. restore() rejects the
      // hold when a failed test must unwind without leaving the app blocked.
      return new Promise((_, reject) => { rejectHold = reject; });
    }
    const error = new Error('OWNED_RESTORE_INTERRUPTION'); error.code = 'EIO'; throw error;
  }
  async function rename(from, to, ...rest) {
    const match = relative(to)?.match(sourcePattern);
    if (!restored && !hit && mode === 'AFTER_SOURCE_RENAME'
        && from === path.join(profile, 'data', 'repos') && match) {
      await Reflect.apply(originalRename, io, [from, to, ...rest]);
      return trip(match[1], true);
    }
    return Reflect.apply(originalRename, io, [from, to, ...rest]);
  }
  async function unlink(file, ...rest) {
    const match = relative(file)?.match(cleanupPattern);
    if (!restored && !hit && mode === 'BEFORE_COMPLETED_CLEANUP' && match) return trip(match[1], false);
    return Reflect.apply(originalUnlink, io, [file, ...rest]);
  }
  io.rename = rename; io.unlink = unlink;
  return {
    inspect() { return hit ? { ...hit } : null; },
    restore() {
      assert.equal(io.rename, rename); assert.equal(io.unlink, unlink);
      restored = true; io.rename = originalRename; io.unlink = originalUnlink;
      if (rejectHold) {
        const reject = rejectHold; rejectHold = undefined;
        const error = new Error('OWNED_RESTORE_INTERRUPTION'); error.code = 'EIO'; reject(error);
      }
      return hit ? { ...hit } : null;
    },
  };
}

// Native dialog decisions are controlled, not OS UI acceptance. Fixed codes only are
// emitted, so errors stay observable even after Electron destroys its JS handles.
function installOwnedDialogs({ app, dialog }, { profile, parent, nonce, recover }) {
  const assert = process.getBuiltinModule('assert/strict'), fs = process.getBuiltinModule('fs');
  assert.equal(app.getName(), 'Code Intelligence Acceptance');
  assert.equal(app.getPath('userData'), profile);
  assert.equal(fs.realpathSync(profile), profile);
  assert(profile.startsWith(parent + '/desktop-run-'));
  assert(/^[0-9a-f]{32}$/.test(nonce)); assert.equal(typeof recover, 'boolean');
  let prompts = 0;
  const emit = code => process.stderr.write('OWNED_RECOVERY_EVENT ' + nonce + ' ' + code + '\n');
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1);
    if (!recover || prompts++ || options?.title !== 'Verify interrupted recovery'
        || options.type !== 'warning' || JSON.stringify(options.buttons) !== '["Verify and recover","Quit"]'
        || options.defaultId !== 0 || options.cancelId !== 1) {
      emit('UNEXPECTED_CONFIRMATION'); return { response: 1, checkboxChecked: false };
    }
    emit('RECOVERY_ACCEPTED'); return { response: 0, checkboxChecked: false };
  };
  dialog.showErrorBox = (title, detail) => {
    emit(title === 'Code Intelligence shutdown requires recovery' ? 'SHUTDOWN_RECOVERY_REQUIRED'
      : title === 'Code Intelligence could not start' ? 'STARTUP_FAILED' : 'UNEXPECTED_NATIVE_ERROR');
    // Exact static product diagnostics only; never echo arbitrary paths, error
    // content, connection strings or child output into evidence.
    if (title === 'Code Intelligence could not start') {
      if (detail === 'Bundled runtime manifest or inventory is invalid.') emit('MANIFEST_INVALID');
      else if (detail === 'Bundled runtime manifest does not match this platform.') emit('MANIFEST_PLATFORM');
      else if (typeof detail === 'string' && /^EMFILE:/.test(detail)) emit('IO_FILE_LIMIT');
      else if (typeof detail === 'string' && /^ENFILE:/.test(detail)) emit('IO_SYSTEM_FILE_LIMIT');
      else emit('STARTUP_OTHER');
    }
  };
}

function captureOwnedApplication(app) {
  // The SDK may discard its internal process after early startup exit. Retain
  // the actual ChildProcess while launch still owns it; never reconstruct by PID.
  const child = app.process();
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0
      || typeof child.once !== 'function' || typeof child.kill !== 'function') throw new Error('OWNED_PROCESS_MISSING');
  return {
    process: () => child,
    close: () => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : app.close(),
  };
}

module.exports = { installOwnedInterruption, installOwnedDialogs, captureOwnedApplication };
