'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { runtimeRelativePath } = require('../src/runtime-platform.cjs');
const CRC = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = CRC[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
// ZIP64 and encrypted/multi-disk archives are deliberately not accepted by this supply format.
function zipEntries(bytes) {
  const invalid = () => { throw new Error('Invalid or unsafe pinned runtime ZIP'); };
  const range = (offset, count) => { if (offset < 0 || count < 0 || offset + count > bytes.length) invalid(); };
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) invalid();
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count !== bytes.readUInt16LE(end + 8) || count === 65535 || start + length !== end) invalid();
  const result = [], seen = new Set(), paths = new Map(); let offset = start, total = 0;
  for (let index = 0; index < count; index++) {
    range(offset, 46); if (bytes.readUInt32LE(offset) !== 0x02014b50) invalid();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const packed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), nameBytes = bytes.readUInt16LE(offset + 28);
    const extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    if (flags & 1 || ![0, 8].includes(method) || size > 512 * 1024 * 1024 || (total += size) > 4 * 1024 * 1024 * 1024
      || (mode & 0xf000) === 0xa000 || bytes.readUInt16LE(offset + 34)) invalid();
    range(offset + 46, nameBytes + extra + comment);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameBytes), directory = name.endsWith('/');
    runtimeRelativePath(directory ? name.slice(0, -1) : name, 'archive member', 'win32');
    if (name.includes('\ufffd') || seen.has(name.toLowerCase())) invalid(); seen.add(name.toLowerCase());
    const parts = name.replace(/\/$/, '').split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const canonical = parts.slice(0, depth).join('/'), key = canonical.toLowerCase();
      const isDirectory = depth < parts.length || directory, prior = paths.get(key);
      if (prior && (prior.canonical !== canonical || prior.directory !== isDirectory)) invalid();
      paths.set(key, { canonical, directory: isDirectory });
    }
    range(local, 30); if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) invalid();
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), data = local + 30 + localName + localExtra;
    range(local + 30, localName); range(data, packed);
    if (data + packed > start || bytes.toString('utf8', local + 30, local + 30 + localName) !== name) invalid();
    result.push({ name, directory, size, read() {
      const raw = bytes.subarray(data, data + packed), decoded = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      if (decoded.length !== size || crc32(decoded) !== crc) invalid(); return decoded;
    } });
    offset += 46 + nameBytes + extra + comment;
  }
  if (offset !== end) invalid(); return result;
}
function extractZip(bytes, destination, select = name => name) {
  if (fs.existsSync(destination)) throw new Error('Runtime extraction destination must be fresh');
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  const entries = zipEntries(bytes), names = new Set();
  for (const entry of entries) {
    const name = select(entry.name, entry.directory); if (!name) continue;
    const safe = runtimeRelativePath(name.replace(/\/$/, ''), 'extracted member', 'win32');
    if (names.has(safe.toLowerCase()) && !entry.directory) throw new Error('Runtime archive collision');
    names.add(safe.toLowerCase());
    const target = path.join(destination, ...safe.split('/'));
    if (entry.directory) { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, entry.read(), { flag: 'wx', mode: 0o600 });
  }
}
module.exports = { zipEntries, extractZip, crc32 };
