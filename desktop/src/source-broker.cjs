'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { createWindowsUnixServer } = require('./windows-unix-server.cjs');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FRAME = 3 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const PROJECT_ID = /^[1-9][0-9]{0,18}$/;
const KEY_ID = /^[0-9a-f]{32}$/;

class SourceBrokerError extends Error {
  constructor(code = 'SOURCE_BROKER_UNAVAILABLE') {
    super(code);
    this.code = code;
  }
}

function reject(code) { throw new SourceBrokerError(code); }
function fullMatch(value, pattern) {
  return typeof value === 'string' && value.match(pattern)?.[0] === value;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    reject('SOURCE_BROKER_INVALID');
  }
}

function validate(request, authToken) {
  const fields = ['version', 'requestId', 'auth', 'operation', 'projectId', 'sha256', 'byteSize'];
  if (request?.operation === 'PUT') fields.push('bytes');
  exactKeys(request, fields);
  if (request.version !== 1) reject('SOURCE_BROKER_UNSUPPORTED');
  if (!fullMatch(request.auth, HEX)
      || !crypto.timingSafeEqual(Buffer.from(request.auth, 'hex'), Buffer.from(authToken, 'hex'))) {
    reject('SOURCE_BROKER_UNAUTHORIZED');
  }
  if (!fullMatch(request.requestId, UUID) || !['PUT', 'READ'].includes(request.operation)
      || !fullMatch(request.projectId, PROJECT_ID)
      || BigInt(request.projectId) > 9223372036854775807n
      || !fullMatch(request.sha256, HEX)
      || !Number.isSafeInteger(request.byteSize) || request.byteSize < 0 || request.byteSize > MAX_BYTES) {
    reject('SOURCE_BROKER_INVALID');
  }
  if (request.operation === 'PUT') {
    if (typeof request.bytes !== 'string' || request.bytes.length !== 4 * Math.ceil(request.byteSize / 3)) {
      reject('SOURCE_BROKER_INVALID');
    }
    const bytes = Buffer.from(request.bytes, 'base64');
    if (bytes.length !== request.byteSize || bytes.toString('base64') !== request.bytes
        || crypto.createHash('sha256').update(bytes).digest('hex') !== request.sha256) {
      reject('SOURCE_BROKER_INVALID');
    }
    return bytes;
  }
  return null;
}

function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_FRAME) reject('SOURCE_BROKER_INVALID');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** Main-only bounded local bridge. It never listens on TCP or exposes key/path operations. */
async function createSourceBroker({ socketPath, authToken, vault, timeoutMs = 10_000, drainTimeoutMs = 10_000, windowsBoundary, onLost = () => {} }) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath
      || Buffer.byteLength(socketPath) > 100 || !fullMatch(authToken, HEX)
      || !vault || typeof vault.put !== 'function' || typeof vault.read !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000
      || !Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 10 || drainTimeoutMs > 30_000) reject();
  const parent = path.dirname(socketPath);
  if (process.platform === 'win32' && !windowsBoundary) reject();
  if (!windowsBoundary) {
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
        || stat.uid !== process.getuid() || await fs.realpath(parent) !== parent) reject();
    try { await fs.lstat(socketPath); reject(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const sockets = new Set();
  const operations = new Set();
  let closing = false;
  let closePromise;
  const connect = (socket) => {
    if (closing || sockets.size >= 8 || operations.size >= 4) { socket.destroy(); return; }
    sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('close', () => { clearTimeout(deadline); sockets.delete(socket); });
    socket.on('error', () => {});
    let chunks = [];
    let size = 0;
    let length;
    let complete = false;
    socket.on('data', (chunk) => {
      if (complete) { socket.destroy(); return; }
      size += chunk.length;
      if (size > MAX_FRAME + 4) { socket.destroy(); return; }
      chunks.push(chunk);
      if (length === undefined && size >= 4) {
        const prefix = Buffer.concat(chunks, size);
        length = prefix.readUInt32BE(0);
        if (length < 2 || length > MAX_FRAME) { socket.destroy(); return; }
      }
      if (length !== undefined && size > length + 4) socket.destroy();
    });
    // Dispatch only after FIN proves there is exactly one complete request.
    socket.on('end', () => {
      complete = true;
      if (closing || socket.destroyed || length === undefined || size !== length + 4) { socket.destroy(); return; }
      // Slots belong to vault operations, not their transport; a disconnected client cannot free one.
      if (operations.size >= 4) { socket.destroy(); return; }
      const body = Buffer.concat(chunks, size).subarray(4);
      chunks = [];
      const operation = (async () => {
        let requestId = null;
        try {
          const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
          if (fullMatch(request?.requestId, UUID)) requestId = request.requestId;
          const bytes = validate(request, authToken);
          let result;
          if (request.operation === 'PUT') {
            const stored = await vault.put({ projectId: request.projectId, bytes });
            if (stored.sha256 !== request.sha256 || stored.byteSize !== request.byteSize
                || stored.projectId !== request.projectId || !fullMatch(stored.keyId, KEY_ID)) reject();
            result = { sha256: stored.sha256, byteSize: stored.byteSize, keyId: stored.keyId };
          } else {
            const bytes = await vault.read({ projectId: request.projectId, sha256: request.sha256, byteSize: request.byteSize });
            if (!Buffer.isBuffer(bytes) || bytes.length !== request.byteSize
                || crypto.createHash('sha256').update(bytes).digest('hex') !== request.sha256) reject();
            result = { sha256: request.sha256, byteSize: bytes.length, bytes: bytes.toString('base64') };
          }
          if (!socket.destroyed) socket.end(frame({ version: 1, requestId, ok: true, result }));
        } catch (error) {
          const code = error instanceof SourceBrokerError ? error.code : 'SOURCE_BROKER_UNAVAILABLE';
          if (!socket.destroyed) socket.end(frame({ version: 1, requestId, ok: false, code }));
        }
      })();
      operations.add(operation);
      operation.finally(() => operations.delete(operation)).catch(() => socket.destroy());
    });
  };
  const server = windowsBoundary
    ? createWindowsUnixServer({ windowsBoundary, maxRequest: MAX_FRAME, maxResponse: MAX_FRAME, maxConnections: 8, frameTimeoutMs: timeoutMs, absoluteDeadline: true }, connect)
    : net.createServer({ allowHalfOpen: true }, connect);
  try {
    await new Promise((resolve, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, resolve);
    });
    if (!windowsBoundary) await fs.chmod(socketPath, 0o600);
  } catch {
    server.close();
    reject();
  }
  server.on('error', () => { closing = true; for (const socket of sockets) socket.destroy(); onLost(); });
  return Object.freeze({
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        for (const socket of sockets) socket.destroy();
        const transportFailure = await new Promise(resolve => server.close(error => resolve(error)));
        let timer;
        try {
          await Promise.race([
            Promise.allSettled([...operations]),
            new Promise((_, rejectDrain) => {
              timer = setTimeout(() => rejectDrain(new SourceBrokerError('SOURCE_BROKER_DRAIN_TIMEOUT')), drainTimeoutMs);
            }),
          ]);
        } finally { clearTimeout(timer); }
        if (transportFailure) reject();
      })();
      // A failed drain must not be treated as permission to close/replace the source vault.
      return closePromise;
    },
  });
}

module.exports = { createSourceBroker, SourceBrokerError, MAX_FRAME };
