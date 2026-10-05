'use strict';

// Developer provisioning only. Neither a successful preflight nor verified source bytes
// prove binary compatibility, runtime acceptance, signing, or existing-profile upgrades.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const supply = require('./macos-runtime-supply.json');
const GiB = 1024n ** 3n;
// Conservative working-space policy, not a measured final app size or a reservation.
const MINIMUM_FREE_BYTES = 8n * GiB;
const IDS = ['openssl', 'postgres', 'redis', 'pgvector'];

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { code, details });
}

function validateSupply(value) {
  if (value?.format !== 1 || value.minimumSystemVersion !== '13.0' || value.architecture !== 'arm64'
      || !Array.isArray(value.sources) || value.sources.length !== IDS.length) fail('MAC_SOURCE_LOCK_INVALID');
  const ids = new Set();
  for (const item of value.sources) {
    if (!item || typeof item !== 'object' || !IDS.includes(item.id) || ids.has(item.id) || !/^[0-9]+(?:\.[0-9]+){1,3}$/.test(item.version)
        || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.maxArchiveBytes)
        || item.maxArchiveBytes < 1 || item.maxArchiveBytes > 256 * 1024 ** 2
        || !/^[A-Za-z][A-Za-z0-9.]*$/.test(item.licenseFile)) fail('MAC_SOURCE_LOCK_INVALID');
    ids.add(item.id);
    const expected = {
      openssl: `https://github.com/openssl/openssl/releases/download/openssl-${item.version}/openssl-${item.version}.tar.gz`,
      postgres: `https://download.postgresql.org/pub/source/v${item.version}/postgresql-${item.version}.tar.bz2`,
      redis: `https://download.redis.io/releases/redis-${item.version}.tar.gz`,
      pgvector: `https://codeload.github.com/pgvector/pgvector/tar.gz/${item.revision}`,
    }[item.id];
    if (item.url !== expected || (item.id === 'postgres' && !item.version.startsWith('16.'))
        || (item.id === 'pgvector' && !/^[a-f0-9]{40}$/.test(item.revision))) fail('MAC_SOURCE_LOCK_INVALID');
  }
  return value;
}

function checkCapacity(directory, { statfs = fs.statfsSync, minimumBytes = MINIMUM_FREE_BYTES } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
      || typeof minimumBytes !== 'bigint' || minimumBytes <= 0n) fail('MAC_BUILD_CAPACITY_INPUT');
  const root = fs.realpathSync(directory);
  if (!fs.lstatSync(root).isDirectory()) fail('MAC_BUILD_CAPACITY_INPUT');
  let stats;
  try { stats = statfs(root, { bigint: true }); }
  catch { fail('MAC_BUILD_CAPACITY_UNAVAILABLE'); }
  if (typeof stats.bavail !== 'bigint' || typeof stats.bsize !== 'bigint'
      || stats.bavail < 0n || stats.bsize <= 0n) fail('MAC_BUILD_CAPACITY_UNAVAILABLE');
  const available = stats.bavail * stats.bsize;
  return Object.freeze({
    status: available >= minimumBytes ? 'READY_FOR_PROVISIONING' : 'BLOCKED',
    code: available >= minimumBytes ? null : 'MAC_BUILD_DISK_SPACE',
    root, availableBytes: available.toString(), requiredFreeBytes: minimumBytes.toString(),
    policy: 'Conservative free-space floor; not a disk reservation or measured build size.',
    sourceBuildPerformed: false, nativeRuntimeVerified: false, launchAllowed: false,
  });
}

function requireCapacity(directory, options) {
  const report = checkCapacity(directory, options);
  if (report.status === 'BLOCKED') fail(report.code, report);
  return report;
}

function verifyArchive(file, item) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > item.maxArchiveBytes)
      fail('MAC_SOURCE_ARCHIVE_INVALID');
    const buffer = Buffer.alloc(64 * 1024), hash = crypto.createHash('sha256');
    let count = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, count);
      if (!read) break;
      count += read;
      if (count > item.maxArchiveBytes) fail('MAC_SOURCE_ARCHIVE_INVALID');
      hash.update(buffer.subarray(0, read));
    }
    if (count !== stat.size || stamp(fs.fstatSync(fd)) !== stamp(stat)
        || stamp(fs.lstatSync(file)) !== stamp(stat)) fail('MAC_SOURCE_ARCHIVE_CHANGED');
    const digest = hash.digest('hex');
    if (digest !== item.sha256) fail('MAC_SOURCE_CHECKSUM_MISMATCH');
    return { bytes: count, sha256: digest };
  } finally { fs.closeSync(fd); }
}

function requireBoundedCurl(run = spawnSync) {
  const result = run('/usr/bin/curl', ['--disable', '--version'], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000, maxBuffer: 16384,
  });
  const match = /^curl ([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\b/.exec(result.stdout ?? '');
  // Earlier curl ignores --max-filesize when Content-Length is absent.
  // https://curl.se/docs/manpage.html#--max-filesize
  if (result.error || result.signal || result.status !== 0 || !match
      || Number(match[1]) < 8 || (Number(match[1]) === 8 && Number(match[2]) < 4))
    fail('MAC_SOURCE_CURL_8_4_REQUIRED');
  return match.slice(1).join('.');
}

function downloadSource(id, directory, { run = spawnSync, capacity = requireCapacity } = {}) {
  validateSupply(supply);
  const item = supply.sources.find(entry => entry.id === id);
  if (!item) fail('MAC_SOURCE_UNKNOWN');
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory) fail('MAC_SOURCE_DESTINATION');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o700) fail('MAC_SOURCE_DESTINATION');
  const held = () => {
    const current = fs.lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stat.dev
        || current.ino !== stat.ino || current.mode !== stat.mode || current.uid !== stat.uid)
      fail('MAC_SOURCE_DESTINATION_CHANGED');
  };
  // Recheck small, immediate write headroom; the full eight-GiB preflight runs before provisioning.
  capacity(directory, { minimumBytes: BigInt(item.maxArchiveBytes) + 256n * 1024n ** 2n });
  const extension = id === 'postgres' ? '.tar.bz2' : '.tar.gz';
  const archive = path.join(directory, `${id}-${item.version}${extension}`);
  const metadata = path.join(directory, `${id}-source.json`);
  if (fs.existsSync(metadata)) fail('MAC_SOURCE_DESTINATION_EXISTS');
  const curlVersion = requireBoundedCurl(run);
  // O_EXCL prevents replay from replacing even an unsuccessful earlier download.
  held();
  const fd = fs.openSync(archive, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let result;
  try {
    result = run('/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error', '--location',
      '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '5', '--connect-timeout', '15',
      '--max-time', '120', '--max-filesize', String(item.maxArchiveBytes), item.url], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
      stdio: ['ignore', fd, 'pipe'], timeout: 125000, maxBuffer: 16384,
    });
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (result.error || result.signal || result.status !== 0) fail('MAC_SOURCE_DOWNLOAD_FAILED', { id });
  held();
  const verified = verifyArchive(archive, item);
  held();
  fs.writeFileSync(metadata, JSON.stringify({
    id, version: item.version, sourceUrl: item.url, sourceSha256: verified.sha256,
    bytes: verified.bytes, checksumSource: item.checksumSource, revision: item.revision ?? null, curlVersion,
    downloadedAt: new Date().toISOString(),
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return archive;
}

function checkSourceWorkDirectory(context, directory) {
  const contexts = require('./native-acceptance-context.cjs');
  if (context.kind === 'github-hosted') {
    // Hosted RUNNER_TEMP may be 0755; only the directly created mktemp child is private.
    // Keep the existing hosted-context authority without changing its shared parent.
    const root = fs.realpathSync(context.tempRoot);
    if (path.dirname(directory) !== root) fail('MAC_SOURCE_DESTINATION');
    contexts.privatePath(directory);
  } else {
    contexts.privateDescendant(context.tempRoot, directory);
  }
}

function main(argv) {
  validateSupply(supply);
  if (argv[0] === '--check' && argv.length === 2) {
    const result = checkCapacity(path.resolve(argv[1]));
    console.log(JSON.stringify({ ...result, sources: supply.sources.map(({ id, version, sha256 }) => ({ id, version, sha256 })) }, null, 2));
    if (result.status === 'BLOCKED') process.exitCode = 1;
    return;
  }
  if (argv[0] === '--fetch' && argv.length === 3) {
    const contexts = require('./native-acceptance-context.cjs');
    const context = contexts.requireExecutionContext();
    checkSourceWorkDirectory(context, argv[2]);
    console.log(downloadSource(argv[1], argv[2]));
    return;
  }
  fail('MAC_SOURCE_ARGUMENTS', { usage: '--check <existing directory> | --fetch <id> <authorized private work directory>' });
}

module.exports = { validateSupply, checkCapacity, requireCapacity, verifyArchive, requireBoundedCurl, downloadSource, checkSourceWorkDirectory, MINIMUM_FREE_BYTES };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(JSON.stringify({ status: 'BLOCKED', code: error.code || 'MAC_SOURCE_FAILED', details: error.details ?? {}, launchAllowed: false }));
    process.exitCode = 1;
  }
}
