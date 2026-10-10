'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { readOwnerMemory } = require('./process-memory.cjs');
const execute = promisify(execFile);
const ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5000;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const NATIVE_RSS_FAILURE_CODES = Object.freeze(["MEMORY_NATIVE_UNSUPPORTED","MEMORY_NATIVE_PROTOCOL","MEMORY_NATIVE_SOURCE_CHANGED","MEMORY_NATIVE_BINARY_CHANGED","MEMORY_NATIVE_BUILD_FAILED","MEMORY_NATIVE_START_FAILED","MEMORY_NATIVE_EXIT_FAILED","MEMORY_NATIVE_QUERY_FAILED","MEMORY_NATIVE_IDENTITY_CHANGED","MEMORY_NATIVE_WRITE_FAILED","MEMORY_NATIVE_LIMIT","MEMORY_NATIVE_STATE","MEMORY_NATIVE_TIMEOUT","MEMORY_NATIVE_INTERRUPTED"]);

// Compile once outside quiet admission/timed runs; retain the binary and hashes with the evidence.
async function prepareNativeRss(evidence) {
  assert.equal(process.platform, 'darwin', 'MEMORY_NATIVE_UNSUPPORTED');
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(evidence, 'rss-native-')));
  fs.chmodSync(directory, 0o700);
  const source = path.join(__dirname, 'native-rss.c'), sourceSha256 = hash(source);
  const binary = path.join(directory, 'rss-reader');
  try {
    await execute('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, source],
      { timeout: 30000, maxBuffer: MAX_BYTES, env: ENV });
  } catch { throw new Error('MEMORY_NATIVE_BUILD_FAILED'); }
  assert.equal(hash(source), sourceSha256, 'MEMORY_NATIVE_SOURCE_CHANGED');
  return Object.freeze({ binary, binarySha256: hash(binary), sourceSha256, driverSha256: hash(__filename), protocol: 1 });
}

async function openNativeRss(prepared) {
  const { binary, binarySha256, protocol } = prepared;
  assert.equal(protocol, 1, 'MEMORY_NATIVE_PROTOCOL');
  const directory = fs.lstatSync(path.dirname(binary)), file = fs.lstatSync(binary);
  assert(directory.isDirectory() && directory.uid === process.getuid() && (directory.mode & 0o077) === 0,
    'MEMORY_NATIVE_BINARY_CHANGED');
  assert(file.isFile() && file.uid === process.getuid() && file.nlink === 1 && !(file.mode & 0o022)
    && fs.realpathSync(binary) === binary && hash(binary) === binarySha256, 'MEMORY_NATIVE_BINARY_CHANGED');
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], env: ENV });
  let pending, failure, closing, exited = false, ready = false;
  const fail = error => {
    failure ??= error;
    if (pending) { const current = pending; pending = null; clearTimeout(current.timer); current.reject(failure); }
  };
  const closed = new Promise(resolve => {
    child.once('error', () => fail(new Error('MEMORY_NATIVE_START_FAILED')));
    child.once('close', (code, signal) => {
      exited = true;
      if (pending || !closing || code !== 0 || signal) fail(new Error(code === 3 ? 'MEMORY_NATIVE_QUERY_FAILED'
        : code === 4 ? 'MEMORY_NATIVE_IDENTITY_CHANGED' : 'MEMORY_NATIVE_EXIT_FAILED'));
      resolve({ code, signal });
    });
  });
  child.stdin.on('error', () => fail(new Error('MEMORY_NATIVE_WRITE_FAILED')));
  child.stdout.on('data', chunk => {
    if (!pending) { fail(new Error('MEMORY_NATIVE_PROTOCOL')); child.kill('SIGTERM'); return; }
    const current = pending;
    if (current.bytes + chunk.length > MAX_BYTES + 4) { fail(new Error('MEMORY_NATIVE_LIMIT')); child.kill('SIGTERM'); return; }
    current.bytes += chunk.length;
    current.parts.push(chunk);
    const tail = chunk.subarray(Math.max(0, chunk.length - 4)).toString('ascii');
    // A frame can span chunks. Only assemble when a newline could end it.
    if (!tail.includes('\n')) return;
    const text = Buffer.concat(current.parts, current.bytes).toString('utf8');
    const complete = ready ? text.endsWith('END\n') : text.endsWith('\n');
    if (!complete) return;
    if ((!ready && text !== 'READY 1\n') || (ready && text.slice(0, -4).includes('END\n'))) {
      fail(new Error('MEMORY_NATIVE_PROTOCOL')); child.kill('SIGTERM'); return;
    }
    pending = null; clearTimeout(current.timer);
    current.resolve(ready ? text.slice(0, -4) : undefined);
  });
  const response = () => {
    if (failure) return Promise.reject(failure);
    if (pending || exited || closing) return Promise.reject(new Error('MEMORY_NATIVE_STATE'));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, parts: [], bytes: 0, timer: setTimeout(() => {
        fail(new Error('MEMORY_NATIVE_TIMEOUT')); child.kill('SIGTERM');
      }, TIMEOUT_MS) };
    });
  };
  const close = () => {
    if (!closing) {
      closing = (async () => {
        if (pending) { fail(new Error('MEMORY_NATIVE_INTERRUPTED')); child.kill('SIGTERM'); }
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
        let exit;
        try { exit = await closed; } finally { clearTimeout(timer); }
        if (failure) throw failure;
        assert(exit.code === 0 && exit.signal === null, 'MEMORY_NATIVE_EXIT_FAILED');
      })();
    }
    return closing;
  };
  try { await response(); ready = true; }
  catch (error) { await close().catch(() => {}); throw error; }
  const readSelected = async pids => {
    assert(Array.isArray(pids) && pids.length > 0 && pids.length <= 1024
      && pids.every(pid => Number.isSafeInteger(pid) && pid > 1 && pid <= 2147483647)
      && new Set(pids).size === pids.length, 'MEMORY_OWNER_INVALID');
    assert(!pending && !closing && !exited, 'MEMORY_NATIVE_STATE');
    const result = response();
    if (pending) child.stdin.write(pids.join(',') + '\n');
    return result;
  };
  return Object.freeze({ pid: child.pid, read: ownerPid => readOwnerMemory(ownerPid, { readSelected }), close });
}

module.exports = { prepareNativeRss, openNativeRss, NATIVE_RSS_FAILURE_CODES };
