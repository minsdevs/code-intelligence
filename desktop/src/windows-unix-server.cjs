'use strict';

// Binary pipe to the integrity-verified native AF_UNIX listener. No TCP/named-pipe
// endpoint is exposed to clients. Domain framing/authentication remains in the caller.
const { EventEmitter } = require('node:events');
const { localPath } = require('./windows-native-boundary.cjs');
const unavailable = () => new Error('Windows private IPC unavailable.');
function word(value) { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; }
function packet(type, id, body = Buffer.alloc(0)) {
  return Buffer.concat([word(body.length + 5), Buffer.from([type]), word(id), body]);
}
function createWindowsUnixServer({ windowsBoundary, maxRequest, maxResponse, maxConnections, frameTimeoutMs, absoluteDeadline = false }, connection) {
  if (!windowsBoundary || typeof windowsBoundary.launch !== 'function' || typeof connection !== 'function'
      || !Number.isInteger(maxRequest) || maxRequest < 2 || maxRequest > 3 * 1024 * 1024
      || !Number.isInteger(maxResponse) || maxResponse < 2 || maxResponse > 4 * 1024 * 1024
      || !Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 16
      || typeof absoluteDeadline !== 'boolean'
      || !Number.isInteger(frameTimeoutMs) || frameTimeoutMs < 1 || frameTimeoutMs > 30000) throw unavailable();
  const server = new EventEmitter();
  const sockets = new Map();
  let child; let bytes = Buffer.alloc(0); let stopping = false; let stopped = false; let failed = false;
  let timer; let stopTimer; let ready = false; let acknowledgedStop = false;
  server.listening = false;
  const send = (type, id, body, callback) => {
    if (failed || stopped || !child?.stdin.writable) { callback?.(unavailable()); return; }
    const encoded = packet(type, id, body);
    child.stdin.write(encoded, error => { encoded.fill(0); callback?.(error); if (error) lose(); });
  };
  function lose() {
    if (failed || stopped) return;
    failed = true; server.listening = false; clearTimeout(timer);
    bytes.fill(0); bytes = Buffer.alloc(0);
    for (const socket of sockets.values()) socket.finish();
    child?.kill(); server.emit('error', unavailable());
  }
  function event(type, id, body) {
    if (type === 1 && id === 0 && body.length === 0 && !ready && !stopping) {
      ready = true; clearTimeout(timer); server.listening = true; server.emit('listening'); return;
    }
    if (type === 4 && id === 0 && body.length === 0 && stopping && !acknowledgedStop) {
      acknowledgedStop = true; return;
    }
    if (!ready || acknowledgedStop) throw unavailable();
    if (type === 3 && body.length === 0 && id > 0) { sockets.get(id)?.finish(); return; }
    if (type !== 2 || id === 0 || sockets.has(id) || body.length < 6 || body.length > maxRequest + 4
        || body.readUInt32BE(0) !== body.length - 4 || sockets.size >= maxConnections) throw unavailable();
    if (stopping) { send(2, id); return; }
    const socket = new EventEmitter();
    socket.destroyed = false;
    let ended = false;
    socket.finish = () => {
      if (socket.destroyed) return;
      socket.destroyed = true; sockets.delete(id); socket.emit('close');
    };
    socket.destroy = () => { if (!socket.destroyed) { send(2, id); socket.finish(); } return socket; };
    socket.end = (output, callback) => {
      if (ended || socket.destroyed || !Buffer.isBuffer(output) || output.length < 6
          || output.length > maxResponse + 4 || output.readUInt32BE(0) !== output.length - 4) {
        socket.destroy(); callback?.(); return socket;
      }
      ended = true; send(1, id, output, error => { callback?.(); if (error) socket.destroy(); }); return socket;
    };
    sockets.set(id, socket); connection(socket);
    if (!socket.destroyed) socket.emit('data', body);
    if (!socket.destroyed) socket.emit('end');
  }
  server.listen = (socketPath, callback) => {
    if (child || stopping) throw unavailable();
    localPath(socketPath);
    if (Buffer.byteLength(socketPath, 'utf8') > 100 || socketPath.includes('\ufffd')
        || Buffer.from(socketPath).toString('utf8') !== socketPath) throw unavailable();
    if (callback) server.once('listening', callback);
    child = windowsBoundary.launch('unix-server');
    child.on('error', lose); child.stdin.on('error', lose);
    child.stderr.on('data', lose);
    child.stdout.on('data', chunk => {
      if (failed || stopped) return;
      // A helper read is bounded; frames may coalesce, so consume before bounding the remainder.
      const next = Buffer.concat([bytes, chunk]); bytes.fill(0); bytes = next;
      try {
        let offset = 0;
        while (bytes.length - offset >= 4) {
          const size = bytes.readUInt32BE(offset);
          if (size < 5 || size > maxRequest + 9) throw unavailable();
          if (bytes.length - offset < size + 4) break;
          event(bytes[offset + 4], bytes.readUInt32BE(offset + 5), bytes.subarray(offset + 9, offset + size + 4));
          offset += size + 4;
          if (failed) return;
        }
        if (offset) { const rest = Buffer.from(bytes.subarray(offset)); bytes.fill(0); bytes = rest; }
        if (bytes.length > maxRequest + 13) throw unavailable();
      } catch { lose(); }
    });
    child.once('close', (code, signal) => {
      if (!failed && (!stopping || !acknowledgedStop || code !== 0 || signal || bytes.length)) lose();
      stopped = true; server.listening = false; clearTimeout(timer); clearTimeout(stopTimer);
      bytes.fill(0); for (const socket of sockets.values()) socket.finish(); server.emit('close');
    });
    timer = setTimeout(lose, 10000); timer.unref();
    const name = Buffer.from(socketPath);
    const bootstrap = Buffer.concat([word(name.length), name, word(maxRequest), word(maxResponse), word(maxConnections), word(frameTimeoutMs), word(absoluteDeadline ? 1 : 0)]);
    child.stdin.write(bootstrap, error => { bootstrap.fill(0); if (error) lose(); });
    return server;
  };
  server.close = callback => {
    if (callback) {
      const done = () => callback(failed ? unavailable() : undefined);
      if (stopped || !child) queueMicrotask(done); else server.once('close', done);
    }
    if (!stopping) {
      stopping = true; server.listening = false;
      for (const socket of sockets.values()) socket.destroy();
      if (child && !failed && !stopped) send(3, 0);
      if (child && !stopped) { stopTimer = setTimeout(lose, 10000); stopTimer.unref(); }
    }
    return server;
  };
  return server;
}
module.exports = { createWindowsUnixServer };
