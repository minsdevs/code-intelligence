'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireThat, ContractError } = require('./errors.cjs');
const { parseJson, LIMITS } = require('./json.cjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (parent, child) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function relativePath(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 240, 'UNSAFE_PATH');
  requireThat(!/[\\\0:]/.test(value) && !/%(?:2e|2f|5c)/i.test(value) && !path.isAbsolute(value), 'UNSAFE_PATH');
  requireThat(value.split('/').every(part => part && part !== '.' && part !== '..'), 'UNSAFE_PATH');
  return value;
}

// /tmp and /var are OS-owned aliases on macOS. No other symlink ancestor is accepted.
function checkedAbsolute(value, allowMissingLeaf = false) {
  const absolute = path.resolve(value), parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT' && allowMissingLeaf && index === parts.length - 1) return current;
      throw new ContractError(error.code === 'ENOENT' ? 'INPUT_MISSING' : 'IO_FAILURE');
    }
    if (stat.isSymbolicLink()) {
      const osAlias = process.platform === 'darwin' && ['/tmp', '/var'].includes(current);
      requireThat(osAlias && index !== parts.length - 1, 'SYMLINK_REJECTED');
      current = fs.realpathSync(current);
    }
    if (index !== parts.length - 1) requireThat(stat.isDirectory() || stat.isSymbolicLink(), 'UNSAFE_PATH');
  }
  return current;
}

class SafeIO {
  constructor() { this.inputs = new Map(); this.totalBytes = 0; this.protectedRoots = new Set(); }
  protect(root) { this.protectedRoots.add(checkedAbsolute(root)); }
  protectInputParent(file) {
    let parent = path.dirname(path.resolve(file));
    for (;;) {
      try { this.protect(parent); return; }
      catch (error) {
        const next = path.dirname(parent);
        if (error.code !== 'INPUT_MISSING' || next === parent) throw error;
        parent = next;
      }
    }
  }
  resolve(root, relative) {
    const result = checkedAbsolute(path.join(root, relativePath(relative)));
    requireThat(within(root, result), 'UNSAFE_PATH'); return result;
  }
  read(file, limit = LIMITS.jsonBytes) {
    const absolute = checkedAbsolute(file);
    let descriptor;
    try {
      const before = fs.lstatSync(absolute);
      requireThat(before.isFile() && before.nlink === 1, 'SPECIAL_FILE_REJECTED');
      requireThat(before.size <= limit && this.totalBytes + before.size <= LIMITS.totalBytes, 'INPUT_TOO_LARGE');
      requireThat(Number.isInteger(fs.constants.O_NOFOLLOW), 'NOFOLLOW_UNAVAILABLE');
      descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(descriptor);
      requireThat(opened.isFile() && opened.nlink === 1 && before.ino === opened.ino && before.dev === opened.dev, 'INPUT_CHANGED');
      requireThat(opened.size <= limit && this.totalBytes + opened.size <= LIMITS.totalBytes, 'INPUT_TOO_LARGE');
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0, read;
      do {
        read = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
        length += read;
      } while (read && length < buffer.length);
      const after = fs.fstatSync(descriptor);
      requireThat(length === opened.size && opened.size === after.size && opened.mtimeMs === after.mtimeMs
        && opened.ctimeMs === after.ctimeMs, 'INPUT_CHANGED');
      const bytes = buffer.subarray(0, length), digest = sha256(bytes);
      this.totalBytes += length;
      const previous = this.inputs.get(absolute);
      requireThat(previous == null || previous.sha256 === digest, 'INPUT_CHANGED');
      this.inputs.set(absolute, { sha256: digest, bytes: length });
      return bytes;
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError('IO_FAILURE');
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  json(file) { return parseJson(this.read(file)); }
  assertUnchanged() { for (const [file] of this.inputs) this.read(file); }
  createOutput(requested) {
    const output = checkedAbsolute(requested, true);
    requireThat(!fs.existsSync(output), 'OUTPUT_EXISTS');
    for (const root of this.protectedRoots) requireThat(!within(root, output) && !within(output, root), 'OUTPUT_OVERLAPS_INPUT');
    for (const input of this.inputs.keys()) requireThat(!within(output, input) && !within(input, output), 'OUTPUT_OVERLAPS_INPUT');
    try { fs.mkdirSync(output, { mode: 0o700 }); }
    catch { throw new ContractError('OUTPUT_UNAVAILABLE'); }
    return output;
  }
  inputManifest() {
    // Input paths and input values are intentionally not included in published diagnostics.
    return [...this.inputs.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
  }
}

function writeNew(output, name, text) {
  fs.writeFileSync(path.join(output, name), text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { name, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) };
}
module.exports = { SafeIO, relativePath, checkedAbsolute, sha256, writeNew, within };
