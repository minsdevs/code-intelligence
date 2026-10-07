'use strict';

// ADR-01 backend -> main control path. The backend never reaches an adapter directly: it sends one
// framed request per connection over an install-private Unix-domain socket (0700 directory, 0600
// socket) with the capability main issued to that backend process, and main runs the analysis
// through the adapter session (XPC supervisor). Frames are the adapter wire: 4-byte big-endian
// length and one JSON object, the request bounded like the adapter request (03 §6).
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
  MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES, createFrameDecoder, encodeFrame
} = require('./adapter-isolation.cjs');

// sockaddr_un.sun_path is 104 bytes on macOS including the terminating NUL.
const MAX_SOCKET_PATH_BYTES = 103;
const SOCKET_NAME = 'control.sock';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 4;

class AdapterControlError extends Error {
  constructor(code) { super(code); this.name = 'AdapterControlError'; this.code = code; }
}

const sameCapability = (actual, expected) => typeof actual === 'string' && /^[0-9a-f]{64}$/.test(actual)
  && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** The first candidate directory whose socket path fits sun_path. */
function controlDirectory(parents) {
  for (const parent of parents) {
    if (typeof parent !== 'string' || !path.isAbsolute(parent)) continue;
    // mkdtemp adds six characters to the prefix.
    if (Buffer.byteLength(path.join(parent, 'ci-adapter-XXXXXX', SOCKET_NAME)) <= MAX_SOCKET_PATH_BYTES) return parent;
  }
  throw new AdapterControlError('ADAPTER_CONTROL_PATH_TOO_LONG');
}

function failure(error) {
  if (error?.code === 'ADAPTER_ISOLATION_UNAVAILABLE') return { ok: false, code: 'ADAPTER_ISOLATION_UNAVAILABLE', reason: String(error.reason) };
  if (error?.code === 'ADAPTER_REQUEST_REJECTED') {
    return { ok: false, error: { status: Number.isInteger(error.status) ? error.status : 500, response: error.response ?? null } };
  }
  if (error?.code === 'ANALYSIS_LIMIT') return { ok: false, code: 'ANALYSIS_LIMIT' };
  return { ok: false, code: 'ANALYZER_FAILURE' };
}

/**
 * Listens on a fresh private socket. `handler.health()` and `handler.analyze(body, { signal })`
 * serve requests that carry the current capability; `rotate()` issues a new one and revokes the old.
 */
async function openAdapterControl({ parents, handler, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
  const directory = fs.mkdtempSync(path.join(controlDirectory(parents), 'ci-adapter-'));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, SOCKET_NAME);
  let capability = crypto.randomBytes(32).toString('hex');
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: false }, socket => {
    if (sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    sockets.add(socket);
    const abort = new AbortController();
    const decoder = createFrameDecoder(MAX_REQUEST_FRAME_BYTES);
    let received = false;
    const idle = setTimeout(() => { if (!received) socket.destroy(); }, requestTimeoutMs);
    const respond = value => {
      let bytes;
      try { bytes = encodeFrame(value, MAX_RESPONSE_FRAME_BYTES); } catch { bytes = encodeFrame({ ok: false, code: 'ANALYSIS_LIMIT' }, 1024); }
      socket.end(bytes);
    };
    socket.on('close', () => { clearTimeout(idle); sockets.delete(socket); abort.abort(); });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      let frames;
      // One request per connection; anything malformed or extra ends it without a response.
      try { frames = decoder.push(chunk); } catch { socket.destroy(); return; }
      if (!frames.length) return;
      if (received || frames.length > 1) { socket.destroy(); return; }
      received = true; clearTimeout(idle);
      const [request] = frames;
      if (!sameCapability(request.capability, capability)) { respond({ ok: false, code: 'CAPABILITY_REJECTED' }); return; }
      let work;
      if (request.op === 'health' && exactKeys(request, ['capability', 'op'])) work = Promise.resolve().then(() => handler.health()).then(() => ({ ok: true, result: {} }));
      else if (request.op === 'analyze' && exactKeys(request, ['capability', 'op', 'body'])) {
        work = Promise.resolve().then(() => handler.analyze(request.body, { signal: abort.signal })).then(result => ({ ok: true, result }));
      } else { respond({ ok: false, code: 'INVALID_REQUEST' }); return; }
      work.then(respond, error => respond(failure(error))).catch(() => socket.destroy());
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  fs.chmodSync(socketPath, 0o600);
  const stat = fs.lstatSync(socketPath), parent = fs.lstatSync(directory);
  if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()
      || !parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid()) {
    server.close(); fs.rmSync(directory, { recursive: true, force: true });
    throw new AdapterControlError('ADAPTER_CONTROL_PERMISSIONS');
  }
  let closed = false;
  const closeSync = () => {
    if (closed) return; closed = true;
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return {
    socketPath,
    capability: () => capability,
    rotate() { capability = crypto.randomBytes(32).toString('hex'); return capability; },
    closeSync,
    async close() { closeSync(); },
  };
}

module.exports = { AdapterControlError, MAX_SOCKET_PATH_BYTES, controlDirectory, openAdapterControl };
