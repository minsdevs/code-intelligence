'use strict';

// Private main <-> backend channel. Renderer API tokens and paths are never accepted here.
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWindowsUnixServer } = require('./windows-unix-server.cjs');

const MAX_FRAME = 2 * 1024 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_CONNECTIONS = 16;
const OPERATIONS = new Set(['STATUS', 'QUOTE', 'APPROVE', 'EXECUTE', 'LATCH', 'ACTIVATE',
  'DISPATCH_PROOF', 'USAGE_PROOF', 'SETTLEMENT_PROOF', 'JOURNAL', 'ENROLLMENT']);
const CAPABILITY = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid() { return new Error('Private AI gateway unavailable.'); }
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function secureDirectory(stat) {
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700
      || (process.getuid && stat.uid !== process.getuid())) throw invalid();
}

async function openAiEgressBridge({ directory, capability, epoch, handler, frameTimeoutMs = 3000, windowsBoundary, onLost = () => {} }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
      || typeof capability !== 'string' || capability.match(CAPABILITY)?.[0] !== capability
      || typeof epoch !== 'string' || epoch.match(CAPABILITY)?.[0] !== epoch
      || typeof handler !== 'function' || !Number.isInteger(frameTimeoutMs)
      || frameTimeoutMs < 1 || frameTimeoutMs > 3000) throw invalid();
  if (process.platform === 'win32' && !windowsBoundary) throw invalid();
  const canonical = windowsBoundary ? directory : await fs.realpath(directory);
  if (canonical !== path.resolve(directory)) throw invalid();
  let before;
  const socketPath = path.join(canonical, 'ai.sock');
  if (Buffer.byteLength(socketPath) > 100) throw invalid();
  if (!windowsBoundary) {
    before = await fs.lstat(canonical); secureDirectory(before);
    try { await fs.lstat(socketPath); throw invalid(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const secret = Buffer.from(capability, 'hex');
  const sessions = new Set();
  const active = new Set();
  let closing = false;
  let closePromise;
  let socketIdentity;

  const connect = (socket) => {
    if (closing || sessions.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    sessions.add(socket);
    let bytes = Buffer.alloc(0);
    let expected = null;
    let ended = false;
    const timeout = setTimeout(() => socket.destroy(), frameTimeoutMs);
    timeout.unref();
    const reject = () => { socket.destroy(); };
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timeout); bytes.fill(0); sessions.delete(socket); });
    socket.on('data', (chunk) => {
      if (ended || bytes.length + chunk.length > MAX_FRAME + 4) { reject(); return; }
      const next = Buffer.concat([bytes, chunk]);
      bytes.fill(0);
      bytes = next;
      if (bytes.length >= 4 && expected === null) {
        expected = bytes.readUInt32BE(0);
        if (expected < 2 || expected > MAX_FRAME) { reject(); return; }
      }
      if (expected !== null && bytes.length > expected + 4) reject();
    });
    // FIN is required before dispatch. A complete prefix cannot hide an extra command/frame.
    socket.on('end', () => {
      ended = true;
      clearTimeout(timeout);
      if (closing || expected === null || bytes.length !== expected + 4 || socket.destroyed) {
        reject(); return;
      }
      let request;
      try {
        const raw = bytes.subarray(4);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        request = JSON.parse(text);
        // Compact JSON in insertion order is the wire form. This also rejects duplicate keys,
        // alternate numeric spellings and invisible trailing data before a handler can run.
        if (JSON.stringify(request) !== text
            || !exact(request, ['version', 'auth', 'epoch', 'callId', 'operation', 'payload'])
            || request.version !== 1 || request.epoch !== epoch
            || typeof request.auth !== 'string' || request.auth.match(CAPABILITY)?.[0] !== request.auth
            || !crypto.timingSafeEqual(secret, Buffer.from(request.auth, 'hex'))
            || typeof request.callId !== 'string' || request.callId.match(UUID)?.[0] !== request.callId
            || !OPERATIONS.has(request.operation)
            || !request.payload || Object.getPrototypeOf(request.payload) !== Object.prototype) throw invalid();
      } catch { bytes.fill(0); reject(); return; }
      bytes.fill(0);
      bytes = Buffer.alloc(0);
      // Never pass the channel capability to domain callbacks or exception/log output.
      const operation = request.operation;
      const payload = request.payload;
      const callId = request.callId;
      request.auth = '';
      const task = Promise.resolve().then(() => {
        if (closing) throw invalid();
        return handler(operation, payload);
      }).then((result) => ({ version: 1, callId, ok: true, result }),
        () => ({ version: 1, callId, ok: false, code: 'AI_GATEWAY_UNAVAILABLE' }))
        .then((reply) => {
          if (socket.destroyed) return;
          let output;
          try { output = Buffer.from(JSON.stringify(reply)); } catch { reject(); return; }
          if (output.length > MAX_RESPONSE) { output.fill(0); reject(); return; }
          const prefix = Buffer.alloc(4); prefix.writeUInt32BE(output.length);
          const frame = Buffer.concat([prefix, output]); output.fill(0);
          socket.end(frame, () => frame.fill(0));
        }).catch(reject).finally(() => active.delete(task));
      active.add(task);
    });
  };
  const server = windowsBoundary
    ? createWindowsUnixServer({ windowsBoundary, maxRequest: MAX_FRAME, maxResponse: MAX_RESPONSE, maxConnections: MAX_CONNECTIONS, frameTimeoutMs }, connect)
    : net.createServer({ allowHalfOpen: true }, connect);
  try {
    await new Promise((resolve, reject) => {
      const failed = (error) => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready); server.listen(socketPath);
    });
    server.on('error', () => { closing = true; for (const socket of sessions) socket.destroy(); onLost(); });
    if (!windowsBoundary) {
      await fs.chmod(socketPath, 0o600);
      socketIdentity = await fs.lstat(socketPath);
      const after = await fs.lstat(canonical);
      secureDirectory(after);
      if (!socketIdentity.isSocket() || before.dev !== after.dev || before.ino !== after.ino) throw invalid();
    }
  } catch {
    closing = true; secret.fill(0);
    for (const socket of sessions) socket.destroy();
    if (windowsBoundary || server.listening) await new Promise(resolve => server.close(resolve));
    throw invalid();
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const stopped = new Promise(resolve => server.close(error => resolve(error)));
      for (const socket of sessions) socket.destroy();
      await Promise.allSettled([...active]);
      const failure = await stopped;
      secret.fill(0);
      if (failure) throw invalid();
      if (windowsBoundary) return; // Native owns identity-checked AF_UNIX leaf cleanup.
      // Node normally removes its socket on close. Do not unlink a replacement path.
      try {
        const current = await fs.lstat(socketPath);
        if (current.dev === socketIdentity.dev && current.ino === socketIdentity.ino && current.isSocket()) {
          await fs.unlink(socketPath);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw invalid(); }
    })();
    return closePromise;
  }
  return Object.freeze({ socketPath, close });
}

module.exports = Object.freeze({ openAiEgressBridge, MAX_FRAME, MAX_RESPONSE });
