'use strict';

// Main-only lifetime guardian. No renderer operation, arbitrary PID registration or re-adoption.
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { TextDecoder, types: { isProxy } } = require('node:util');

const MAX_FRAME = 256 * 1024;
const MAX_BOOTSTRAP = 16 * 1024;
const MAX_REPLY = 4096;
const SYSTEM_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME'];
const HELPER_ERRORS = new Set(['START_FAILED', 'CONTROL_INVALID', 'BOOTSTRAP_FAILED', 'STOP_UNVERIFIED']);
const ERROR_CODES = new Set(['INVALID', 'HELPER_START', 'START_TIMEOUT', 'PROTOCOL', 'CONTROL_LOST', 'HELPER_DIED', ...HELPER_ERRORS]);

class ManagedProcessError extends Error {
  constructor(code = 'HELPER_DIED', owner) {
    const safe = ERROR_CODES.has(code) ? code : 'HELPER_DIED';
    super(`Managed process: ${safe}`);
    this.name = 'ManagedProcessError';
    this.code = `MANAGED_PROCESS_${safe}`;
    if (owner) Object.defineProperty(this, 'managedProcess', { value: owner });
  }
}
function invalid() { throw new ManagedProcessError('INVALID'); }
function plain(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const item of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (!Object.hasOwn(item, 'value')) invalid();
}
function exact(value, fields) {
  plain(value);
  if (Reflect.ownKeys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalid();
}
function text(value, max) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > max
      || Buffer.from(value).toString('utf8') !== value) invalid();
  return value;
}
function absolute(value) {
  text(value, 4096);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) invalid();
  return value;
}
function frame(value, maximum = MAX_FRAME) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length < 2 || bytes.length > maximum) invalid();
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  const result = Buffer.concat([prefix, bytes]); bytes.fill(0); return result;
}
function specification(options) {
  plain(options);
  const fields = ['javaPath', 'jarPath', 'command', 'args', 'cwd', 'env', 'logPath'];
  if (Object.hasOwn(options, 'bootstrap')) fields.push('bootstrap');
  exact(options, fields);
  for (const key of ['javaPath', 'jarPath', 'command', 'cwd', 'logPath']) absolute(options[key]);
  if (!Array.isArray(options.args) || isProxy(options.args) || options.args.length > 128
      || Reflect.ownKeys(options.args).length !== options.args.length + 1) invalid();
  for (const item of Object.values(Object.getOwnPropertyDescriptors(options.args)))
    if (!Object.hasOwn(item, 'value')) invalid();
  for (let index = 0; index < options.args.length; index++) if (!Object.hasOwn(options.args, index)) invalid();
  const args = options.args.map(value => text(value, 8192));
  plain(options.env);
  if (Reflect.ownKeys(options.env).length > 128 || Reflect.ownKeys(options.env).length !== Object.keys(options.env).length) invalid();
  const env = {};
  for (const [name, value] of Object.entries(options.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) invalid();
    env[name] = text(value, 32 * 1024);
  }
  const bootstrap = options.bootstrap ?? Buffer.alloc(0);
  if (!Buffer.isBuffer(bootstrap) || bootstrap.length > MAX_BOOTSTRAP) invalid();
  const wire = frame({ version: 1, kind: 'START', command: options.command, args, cwd: options.cwd,
    env, logPath: options.logPath, bootstrap: bootstrap.toString('base64') });
  bootstrap.fill(0);
  return { javaPath: options.javaPath, jarPath: options.jarPath, bootstrap, wire };
}

/** The injected launcher is for disposable tests; the production launcher always uses the fixed JAR flag. */
function createManagedProcessSpawner({ spawn = childProcess.spawn, startTimeoutMs = 10000 } = {}) {
  if (typeof spawn !== 'function' || !Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 10 || startTimeoutMs > 10000) invalid();
  return async function spawnManagedProcess(options) {
    let spec;
    try { spec = specification(options); }
    catch (error) {
      // Main transfers ownership of its bootstrap buffer even on a rejected launch.
      const own = options && typeof options === 'object' && !isProxy(options)
        ? Object.getOwnPropertyDescriptor(options, 'bootstrap') : null;
      if (own && Object.hasOwn(own, 'value') && Buffer.isBuffer(own.value)) own.value.fill(0);
      throw error instanceof ManagedProcessError ? error : new ManagedProcessError('INVALID');
    }
    const owner = new EventEmitter();
    // A startup/close race may precede main adding listeners. The fixed error remains observable below.
    owner.on('error', () => {});
    let pid, startedAt = null, helper, helperClosed = false, acknowledged = false;
    let targetExit = null, exitCode = null, killed = false, provedStopped = false, failure = null;
    let corrupt = false, incoming = Buffer.alloc(0), replies = 0, receivedBytes = 0;
    let resolveStart, rejectStart, resolveTermination, rejectTermination;
    const startup = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    const termination = new Promise((resolve, reject) => { resolveTermination = resolve; rejectTermination = reject; });
    termination.catch(() => {});
    Object.defineProperties(owner, {
      pid: { enumerable: true, get: () => pid },
      helperPid: { enumerable: true, get: () => helper?.pid },
      exitCode: { enumerable: true, get: () => exitCode },
      signalCode: { enumerable: true, get: () => null },
      killed: { enumerable: true, get: () => killed },
      failure: { get: () => failure },
      termination: { value: termination },
      actualProcess: { get: () => Object.freeze({ pid, startedAt, helperPid: helper?.pid }) },
    });
    owner.stopped = () => provedStopped;
    const report = code => {
      const error = new ManagedProcessError(code, owner);
      failure ||= error;
      if (!acknowledged) rejectStart(error);
      queueMicrotask(() => owner.emit('error', error));
      return error;
    };
    const closeLease = () => { try { helper?.stdin.end(); } catch { try { helper?.stdin.destroy(); } catch {} } };
    owner.kill = (signal = 'SIGTERM') => {
      if (!['SIGTERM', 'SIGKILL'].includes(signal)) invalid();
      if (provedStopped || helperClosed) return false;
      killed = true;
      const bytes = frame({ version: 1, kind: 'STOP', signal }, 1024);
      try {
        helper.stdin.write(bytes, error => {
          bytes.fill(0);
          if (error && !provedStopped) { report('CONTROL_LOST'); closeLease(); }
        });
        return true;
      } catch {
        bytes.fill(0); report('CONTROL_LOST'); closeLease(); return false;
      }
    };
    const badProtocol = () => {
      if (corrupt) return;
      corrupt = true; report('PROTOCOL'); closeLease();
    };
    const reply = body => {
      const encoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
      const value = JSON.parse(encoded);
      // Helper replies contain only fixed ASCII metadata. Canonical form rejects duplicate keys too.
      if (JSON.stringify(value) !== encoded || value.version !== 1 || ++replies > 8) throw new Error();
      if (value.kind === 'STARTED') {
        exact(value, ['version', 'kind', 'pid', 'startedAt']);
        if (acknowledged || targetExit || typeof value.pid !== 'string' || !/^[1-9][0-9]*$/.test(value.pid)
            || !Number.isSafeInteger(Number(value.pid))
            || (value.startedAt !== null && (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))))) throw new Error();
        pid = Number(value.pid); startedAt = value.startedAt; acknowledged = true;
        clearTimeout(startTimer); resolveStart(owner); queueMicrotask(() => owner.emit('spawn'));
      } else if (value.kind === 'EXIT') {
        exact(value, ['version', 'kind', 'pid', 'exitCode', 'stopped']);
        if (!acknowledged || targetExit || value.pid !== String(pid) || value.stopped !== true
            || !Number.isInteger(value.exitCode) || value.exitCode < -2147483648 || value.exitCode > 2147483647) throw new Error();
        targetExit = value;
      } else if (value.kind === 'ERROR') {
        exact(value, ['version', 'kind', 'code']);
        if (!HELPER_ERRORS.has(value.code)) throw new Error();
        report(value.code);
      } else throw new Error();
    };
    const startTimer = setTimeout(() => { report('START_TIMEOUT'); closeLease(); }, startTimeoutMs);
    try {
      const env = {};
      for (const name of SYSTEM_ENV) if (typeof process.env[name] === 'string') env[name] = process.env[name];
      helper = spawn(spec.javaPath, ['-jar', spec.jarPath, '--ci-managed-process'], {
        env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      helper.on('error', () => { report('HELPER_START'); closeLease(); });
      helper.stdin.on('error', () => { if (!provedStopped && !helperClosed) { report('CONTROL_LOST'); closeLease(); } });
      helper.stdout.on('data', chunk => {
        if (corrupt || !Buffer.isBuffer(chunk)) { badProtocol(); return; }
        receivedBytes += chunk.length;
        if (receivedBytes > 8 * (MAX_REPLY + 4)) { badProtocol(); return; }
        incoming = Buffer.concat([incoming, chunk]);
        try {
          while (incoming.length >= 4) {
            const length = incoming.readUInt32BE(0);
            if (length < 2 || length > MAX_REPLY) throw new Error();
            if (incoming.length < length + 4) break;
            reply(incoming.subarray(4, length + 4));
            incoming = incoming.subarray(length + 4);
          }
          if (incoming.length > MAX_REPLY + 4) throw new Error();
        } catch { badProtocol(); }
      });
      helper.stdout.on('error', badProtocol);
      // ChildProcess close waits for stdout draining; helper exit alone is never target-exit evidence.
      helper.once('close', (code, signal) => {
        helperClosed = true; clearTimeout(startTimer); spec.wire.fill(0); spec.bootstrap.fill(0);
        if (!corrupt && incoming.length === 0 && acknowledged && targetExit && code === 0 && signal == null) {
          provedStopped = true; exitCode = targetExit.exitCode;
          const proof = Object.freeze({ pid, exitCode, signalCode: null, stopped: true });
          resolveTermination(proof); owner.emit('exit', exitCode, null); owner.emit('close', exitCode, null);
        } else {
          const error = report('HELPER_DIED'); rejectStart(error); rejectTermination(error);
          owner.emit('guardianExit', code, signal);
        }
      });
      helper.stdin.write(spec.wire, error => {
        spec.wire.fill(0); spec.bootstrap.fill(0);
        if (error && !helperClosed) { report('CONTROL_LOST'); closeLease(); }
      });
    } catch {
      clearTimeout(startTimer); spec.wire.fill(0); spec.bootstrap.fill(0);
      const error = report('HELPER_START'); rejectTermination(error); closeLease();
    }
    return startup;
  };
}

const spawnManagedProcess = createManagedProcessSpawner();
module.exports = { spawnManagedProcess, createManagedProcessSpawner, ManagedProcessError, MAX_FRAME, MAX_BOOTSTRAP };
