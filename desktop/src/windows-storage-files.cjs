'use strict';

const { WINDOWS_STORAGE_CHUNK } = require('./windows-storage.cjs');
const fail = () => { throw Object.assign(new Error('Windows protected file operation refused.'), { code: 'WINDOWS_STORAGE_REFUSED' }); };
async function readStorageFile(storage, file, maximum, { expected } = {}) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) fail();
  const reader = await storage.openRead(file, { expected, maxBytes: maximum });
  let bytes;
  try {
    const size = Number(reader.state.size); if (!Number.isSafeInteger(size) || size > maximum) fail();
    bytes = Buffer.alloc(size); let offset = 0;
    while (offset < size) {
      const chunk = await reader.read(Math.min(WINDOWS_STORAGE_CHUNK, size - offset));
      try { if (!chunk.length || offset + chunk.length > size) fail(); chunk.copy(bytes, offset); offset += chunk.length; }
      finally { chunk.fill(0); }
    }
    const end = await reader.read(1); try { if (end.length) fail(); } finally { end.fill(0); }
    return { bytes, state: reader.state };
  } catch (error) { bytes?.fill(0); throw error; }
  finally { await reader.close(); }
}
async function writeStorageFile(storage, file, bytes, { mode = 'create', expected, maxBytes = bytes?.length } = {}) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) fail();
  const writer = await storage.openWrite(file, { mode, expected, maxBytes });
  try { await writer.write(bytes); return await writer.commit(); }
  finally { await writer.close(); }
}
module.exports = Object.freeze({ readStorageFile, writeStorageFile });
