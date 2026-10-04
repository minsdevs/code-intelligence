'use strict';

// Focused authenticated value protocol over a caller-owned native storage session and lease.
// Namespace replacement/deletion is never a commit. Failure leaves evidence and poisons this port.
const crypto = require('node:crypto');
const { readStorageFile, writeStorageFile } = require('./windows-storage-files.cjs');
const ZERO = '0'.repeat(64);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw Object.assign(new Error('Authenticated Windows state requires recovery.'), { code: 'WINDOWS_STATE_RECOVERY_REQUIRED' }); };
async function openAuthenticatedState(options) {
  const { storage, file, installationId, purpose, mode, seal, unseal, maxPayloadBytes, maxEncodedBytes,
    maxRecords = 1, fresh = false, initialValue } = options;
  if (!storage || typeof file !== 'string' || !file || typeof installationId !== 'string' || !installationId
      || typeof purpose !== 'string' || !purpose || !['append', 'slots'].includes(mode)
      || typeof seal !== 'function' || typeof unseal !== 'function'
      || ![maxPayloadBytes, maxEncodedBytes, maxRecords].every(n => Number.isSafeInteger(n) && n > 0)
      || !Number.isSafeInteger((maxEncodedBytes + 4) * maxRecords)) fail();
  let poisoned = false; let busy = false; let anchor;
  const encode = async (payload, generation, previous) => {
    if (!Buffer.isBuffer(payload) || payload.length > maxPayloadBytes || !Number.isSafeInteger(generation)) fail();
    const header = Buffer.from(JSON.stringify({ format: 'CI-WINDOWS-STATE-1', installationId, purpose, generation, previous }));
    if (header.length > 4096) fail();
    const plain = Buffer.alloc(4 + header.length + payload.length); plain.writeUInt32BE(header.length); header.copy(plain, 4); payload.copy(plain, 4 + header.length);
    let encoded; let checked;
    try {
      encoded = await seal(plain);
      if (!Buffer.isBuffer(encoded) || !encoded.length || encoded.length > maxEncodedBytes || encoded.equals(plain)) fail();
      checked = await unseal(encoded);
      if (!Buffer.isBuffer(checked) || !checked.equals(plain)) fail();
      const frame = Buffer.alloc(4 + encoded.length); frame.writeUInt32BE(encoded.length); encoded.copy(frame, 4);
      return frame;
    } finally { plain.fill(0); encoded?.fill(0); checked?.fill(0); }
  };
  const decode = async frame => {
    if (frame.length < 5 || frame.readUInt32BE(0) !== frame.length - 4 || frame.length - 4 > maxEncodedBytes) fail();
    let plain;
    try {
      plain = await unseal(frame.subarray(4));
      if (!Buffer.isBuffer(plain) || plain.length < 4) fail();
      const length = plain.readUInt32BE(0);
      if (!length || length > 4096 || length > plain.length - 4 || plain.length - 4 - length > maxPayloadBytes) fail();
      const encodedHeader = plain.subarray(4, 4 + length); const header = JSON.parse(encodedHeader.toString('utf8'));
      if (Object.keys(header).join(',') !== 'format,installationId,purpose,generation,previous'
          || header.format !== 'CI-WINDOWS-STATE-1' || header.installationId !== installationId || header.purpose !== purpose
          || !Number.isSafeInteger(header.generation) || header.generation < 0 || !/^[a-f0-9]{64}$/.test(header.previous)
          || !encodedHeader.equals(Buffer.from(JSON.stringify(header)))) fail();
      return { ...header, digest: hash(frame), value: Buffer.from(plain.subarray(4 + length)) };
    } finally { plain?.fill(0); }
  };
  const load = async () => {
    const records = []; const states = [];
    try {
      if (mode === 'append') {
        const loaded = await readStorageFile(storage, file, (maxEncodedBytes + 4) * maxRecords);
        try {
          let offset = 0;
          while (offset < loaded.bytes.length) {
            if (loaded.bytes.length - offset < 4 || records.length >= maxRecords) fail();
            const length = loaded.bytes.readUInt32BE(offset);
            if (!length || length > maxEncodedBytes || length > loaded.bytes.length - offset - 4) fail();
            const record = await decode(loaded.bytes.subarray(offset, offset + 4 + length)); records.push(record);
            const previous = records.at(-2);
            if (record.generation !== records.length - 1 || record.previous !== (previous?.digest || ZERO)) fail();
            offset += 4 + length;
          }
          if (!records.length) fail();
          states.push(loaded.state);
        } finally { loaded.bytes.fill(0); }
      } else {
        for (let slot = 0; slot < 2; slot++) {
          const loaded = await readStorageFile(storage, `${file}.${slot}`, maxEncodedBytes + 4);
          try { const record = await decode(loaded.bytes); records.push(record); states.push(loaded.state); if (record.generation % 2 !== slot) fail(); }
          finally { loaded.bytes.fill(0); }
        }
        const [older, newer] = [...records].sort((a, b) => a.generation - b.generation);
        if (newer.generation !== older.generation + 1 || newer.previous !== older.digest
            || older.generation === 0 && older.previous !== ZERO) fail();
      }
      const latest = records.reduce((a, b) => a.generation > b.generation ? a : b);
      return { generation: latest.generation, digest: latest.digest, value: Buffer.from(latest.value), states };
    } finally { for (const record of records) record.value.fill(0); }
  };
  const checkAnchor = current => {
    if (anchor && (current.digest !== anchor.digest || current.generation !== anchor.generation
        || current.states.some((state, i) => state.token !== anchor.states[i].token))) fail();
  };
  const remember = current => { anchor = { generation: current.generation, digest: current.digest, states: current.states }; };
  const guarded = async action => {
    if (poisoned || busy) fail(); busy = true;
    try { return await action(); } catch (error) { poisoned = true; throw error; } finally { busy = false; }
  };
  await guarded(async () => {
    if (fresh) {
      const first = await encode(initialValue, 0, ZERO);
      try {
        await writeStorageFile(storage, mode === 'append' ? file : `${file}.0`, first);
        if (mode === 'slots') {
          const second = await encode(initialValue, 1, hash(first));
          try { await writeStorageFile(storage, `${file}.1`, second); } finally { second.fill(0); }
        }
      } finally { first.fill(0); }
    }
    const current = await load();
    try { if (fresh && !current.value.equals(initialValue)) fail(); remember(current); } finally { current.value.fill(0); }
  });
  return Object.freeze({
    read: () => guarded(async () => { const current = await load(); try { checkAnchor(current); return Buffer.from(current.value); } finally { current.value.fill(0); } }),
    write: value => guarded(async () => {
      const current = await load();
      try {
        checkAnchor(current);
        if (mode === 'append' && current.generation + 1 >= maxRecords) fail();
        const generation = current.generation + 1; const frame = await encode(value, generation, current.digest);
        try {
          const slot = generation % 2;
          await writeStorageFile(storage, mode === 'append' ? file : `${file}.${slot}`, frame, {
            mode: mode === 'append' ? 'append' : 'slot', expected: current.states[mode === 'append' ? 0 : slot],
            maxBytes: mode === 'append' ? (maxEncodedBytes + 4) * maxRecords : maxEncodedBytes + 4,
          });
          const committed = await load();
          try {
            if (committed.generation !== generation || committed.digest !== hash(frame) || !committed.value.equals(value)) fail();
            remember(committed);
          } finally { committed.value.fill(0); }
        } finally { frame.fill(0); }
      } finally { current.value.fill(0); }
    }),
  });
}
module.exports = Object.freeze({ openAuthenticatedState });
