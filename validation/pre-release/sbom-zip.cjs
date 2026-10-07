'use strict';

// Lenient, read-only ZIP directory reader for SBOM attribution of nested
// archives and the upstream Electron archive. Unlike the strict inventory
// preflight it records (but never follows) symlink entries, duplicate names and
// extra fields. Members are inflated only into memory with a bound and a CRC
// check; nothing is written to disk or executed.
const zlib = require('node:zlib');
const { crc32 } = require('./inventory-candidate.cjs');

const LIMITS = Object.freeze({ entries: 65534, member: 64 * 1024 * 1024, name: 4096 });
class ZipError extends Error { constructor(code) { super(code); this.code = code; } }
const need = (ok, code) => { if (!ok) throw new ZipError(code); };

function listZip(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length >= 22, 'ZIP_SIZE');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  need(end >= 0, 'ZIP_DIRECTORY');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  need(count !== 0xffff && size !== 0xffffffff && offset !== 0xffffffff && offset + size <= end && count <= LIMITS.entries, 'ZIP_DIRECTORY');
  const entries = []; let cursor = offset;
  for (let i = 0; i < count; i++) {
    need(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'ZIP_DIRECTORY');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const madeBy = bytes.readUInt16LE(cursor + 4) >>> 8, external = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
    need(nameLength > 0 && nameLength <= LIMITS.name && cursor + 46 + nameLength + extra + comment <= end, 'ZIP_DIRECTORY');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const mode = madeBy === 3 ? (external >>> 16) & 0xf000 : 0;
    const type = name.endsWith('/') || mode === 0x4000 ? 'dir' : mode === 0xa000 ? 'symlink' : 'file';
    entries.push({ name, type, flags, method, crc, compressed, size: uncompressed, local });
    cursor += 46 + nameLength + extra + comment;
  }
  return entries;
}

function readMember(bytes, entry, maximum = LIMITS.member) {
  need(entry && entry.type !== 'dir' && !(entry.flags & 1) && entry.size <= maximum && (entry.method === 0 || entry.method === 8), 'ZIP_MEMBER');
  const at = entry.local;
  need(at + 30 <= bytes.length && bytes.readUInt32LE(at) === 0x04034b50, 'ZIP_LOCAL_HEADER');
  const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
  need(start + entry.compressed <= bytes.length, 'ZIP_LOCAL_HEADER');
  const packed = bytes.subarray(start, start + entry.compressed);
  let data;
  try { data = entry.method === 0 ? packed : zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) }); }
  catch { throw new ZipError('ZIP_INFLATE'); }
  need(data.length === entry.size && crc32(data) === entry.crc, 'ZIP_CONTENT');
  return data;
}

module.exports = Object.freeze({ ZipError, listZip, readMember, LIMITS });
