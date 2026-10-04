'use strict';

// Backup-only adapters retain the native tagged state. They do not invent POSIX metadata.
const CHUNK = 1024 * 1024;
const { types: { isProxy } } = require('node:util');
const fail = () => { throw Object.assign(new Error('Backup native storage changed.'), { code: 'BACKUP_NATIVE_CHANGED' }); };
const sameIdentity = (a, b) => a?.platform === 'win32' && b?.platform === 'win32' && a.identity === b.identity;
const sameState = (a, b) => sameIdentity(a, b) && a.token === b.token;
function identity(value) {
  return { version: 1, platform: 'win32', identity: value.identity };
}
function checkedIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 3 || ['identity', 'platform', 'version'].some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key], 'value'))) fail();
  if (value.version !== 1 || value.platform !== 'win32' || typeof value.identity !== 'string' || value.identity.length > 66
      || value.identity.match(/^WI1:(?:0|[1-9]\d{0,19}):(?:0|[1-9]\d{0,19}):(?:0|[1-9]\d{0,19})$/)?.[0] !== value.identity
      || value.identity.slice(4).split(':').some(part => BigInt(part) > 18446744073709551615n)) fail();
  return { ...value };
}
async function readHandle(storage, file, maximum, expected) {
  const reader = await storage.openRead(file, { expected, maxBytes: maximum });
  let position = 0;
  return Object.freeze({
    state: reader.state,
    async stat() {
      const current = await storage.stat(file);
      if (!sameState(current, reader.state)) fail();
      return current;
    },
    async read(buffer, offset = 0, length = buffer.length - offset, at = position) {
      const bytes = await reader.read(Math.min(length, CHUNK), at);
      try { bytes.copy(buffer, offset); position = at + bytes.length; return { bytesRead: bytes.length }; }
      finally { bytes.fill(0); }
    },
    async *createReadStream({ start = 0, end = Number(reader.state.size) - 1 } = {}) {
      for (let offset = start; offset <= end;) {
        const bytes = await reader.read(Math.min(CHUNK, end - offset + 1), offset);
        if (!bytes.length) fail();
        offset += bytes.length;
        try { yield bytes; } finally { bytes.fill(0); }
      }
    },
    close: () => reader.close(),
  });
}
async function entries(storage, file = '', maximum = 600000) {
  const result = [];
  for await (const entry of storage.entries(file)) { if (result.length >= maximum) fail(); result.push(entry); }
  return result;
}
module.exports = Object.freeze({ readHandle, sameIdentity, sameState, identity, checkedIdentity, entries });
