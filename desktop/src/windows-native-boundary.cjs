'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runtimeRelativePath, inheritedEnvironment } = require('./runtime-platform.cjs');
const MAX_BYTES = 16 * 1024 * 1024;
const refuse = () => { throw new Error('Windows protected boundary refused the operation.'); };
function localPath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value) || value.length > 4096
      || path.win32.normalize(value) !== value || value.endsWith('\\')) refuse();
  runtimeRelativePath(value.slice(3).replaceAll('\\', '/'), 'local Windows path', 'win32');
  return value;
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BYTES) refuse();
  const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes;
}
function field(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([integer(bytes.length), bytes]);
}
// The caller must obtain runtimeRoot from the integrity-verified packaged inventory,
// never from a renderer, PATH, environment override or user-selected helper path.
function createWindowsBoundary(runtimeRoot) {
  if (process.platform !== 'win32') refuse();
  const executable = path.win32.join(localPath(runtimeRoot), 'native', 'windows', 'codeintel-boundary.exe');
  const initial = fs.lstatSync(executable, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n) refuse();
  const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest();
  const assertBinary = () => {
    const current = fs.lstatSync(executable, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== initial.dev
        || current.ino !== initial.ino || current.size !== initial.size || current.mtimeNs !== initial.mtimeNs
        || current.ctimeNs !== initial.ctimeNs
        || !crypto.timingSafeEqual(digest, crypto.createHash('sha256').update(fs.readFileSync(executable)).digest())) refuse();
  };
  const invoke = (operation, file, suffix = Buffer.alloc(0), maximum = 4096) => {
    assertBinary();
    const input = Buffer.concat([field(localPath(file)), suffix]);
    let result;
    try {
      result = childProcess.spawnSync(executable, [operation], { input, encoding: 'buffer',
        env: inheritedEnvironment(process.env), windowsHide: true, shell: false,
        timeout: 15000, maxBuffer: maximum, stdio: ['pipe', 'pipe', 'pipe'] });
      if (result.error || result.status !== 0 || result.signal || result.stderr.length || result.stdout.length > maximum) refuse();
      return result.stdout;
    } catch { result?.stdout?.fill(0); refuse(); }
    finally { input.fill(0); }
  };
  const read = (operation, file, maximum) => {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_BYTES) refuse();
    return invoke(operation, file, integer(maximum), maximum);
  };
  const write = (operation, file, bytes) => {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) refuse();
    const encoded = field(bytes);
    try { invoke(operation, file, encoded); } finally { encoded.fill(0); }
  };
  return Object.freeze({
    readPrivate: (file, maximum = MAX_BYTES) => read('read-private', file, maximum),
    readPublic: (file, maximum = MAX_BYTES) => read('read-public', file, maximum),
    createDirectory: directory => { invoke('mkdir', directory); },
    writeFresh: (file, bytes) => write('write-fresh', file, bytes),
    replacePrivate: (file, bytes) => write('replace-private', file, bytes),
    inspect(file, { directory = false, private: privateObject = true } = {}) {
      if (directory && !privateObject) refuse();
      const identity = invoke(directory ? 'inspect-private-directory' : privateObject ? 'inspect-private' : 'inspect-public', file).toString('ascii');
      if (!/^\d+:\d+:\d+$/.test(identity)) refuse();
      return identity;
    },
    launch(operation, spawn = childProcess.spawn) {
      if (!['lease', 'managed'].includes(operation)) refuse();
      assertBinary();
      return spawn(executable, [operation], { env: inheritedEnvironment(process.env),
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    },
  });
}
function boundaryFromJava(javaPath) {
  localPath(javaPath);
  if (path.win32.basename(javaPath).toLowerCase() !== 'java.exe'
      || path.win32.basename(path.win32.dirname(javaPath)).toLowerCase() !== 'bin'
      || path.win32.basename(path.win32.dirname(path.win32.dirname(javaPath))).toLowerCase() !== 'jre') refuse();
  return createWindowsBoundary(path.win32.dirname(path.win32.dirname(path.win32.dirname(javaPath))));
}
function managedWire(options) {
  const encoded = [field(localPath(options.command)), field(localPath(options.cwd)), field(localPath(options.logPath)), integer(options.args.length)];
  for (const arg of options.args) encoded.push(field(arg));
  encoded.push(integer(Object.keys(options.env).length));
  const seen = new Set();
  for (const [name, value] of Object.entries(options.env)) {
    if (seen.has(name.toLowerCase())) refuse(); seen.add(name.toLowerCase());
    encoded.push(field(name), field(value));
  }
  encoded.push(field(options.bootstrap ?? Buffer.alloc(0)));
  const bytes = Buffer.concat(encoded);
  for (const item of encoded) item.fill(0);
  if (bytes.length > 256 * 1024) { bytes.fill(0); refuse(); }
  return bytes;
}
module.exports = Object.freeze({ createWindowsBoundary, boundaryFromJava, managedWire, localPath });
