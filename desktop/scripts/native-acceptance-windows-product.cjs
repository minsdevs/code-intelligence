'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const { zipEntries } = require('./windows-runtime-archive.cjs');
const { verifyWindowsRuntime } = require('./windows-pe-policy.cjs');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');
const SUPPLIES = require('./windows-runtime-supply.json');
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function negativeConnection({ port, ca, command, encrypted, expectErrorReply = false }) {
  return new Promise((resolve, reject) => {
    const socket = encrypted ? tls.connect({ host: '127.0.0.1', port, ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' }) : net.connect(port, '127.0.0.1');
    let response = '', settled = false;
    const finish = error => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(5000, () => finish(new Error('CACHE_NEGATIVE_PROBE_TIMEOUT')));
    socket.once(encrypted ? 'secureConnect' : 'connect', () => { if (command) socket.write(command); else finish(new Error('UNTRUSTED_CACHE_CERTIFICATE_ACCEPTED')); });
    socket.on('data', bytes => {
      response += bytes.toString('utf8');
      if (response.length > 4096) finish(new Error('CACHE_NEGATIVE_RESPONSE_LIMIT'));
      else if (response.includes('\r\n')) finish(expectErrorReply && /^-(?:NOAUTH|WRONGPASS|ERR).*\r\n/.test(response) ? null : new Error('CACHE_AUTH_OR_TLS_BYPASS'));
    });
    socket.once('error', () => finish(expectErrorReply ? new Error('CACHE_NEGATIVE_AUTH_NO_REPLY') : null));
    socket.once('close', () => finish(expectErrorReply ? new Error('CACHE_NEGATIVE_AUTH_NO_REPLY') : null));
  });
}
async function cacheCompatibility({ source, runtime, owned, env, run, report }) {
  const { createWindowsBoundary } = require(path.join(source, 'desktop', 'src', 'windows-native-boundary.cjs'));
  const { createServiceTransport } = require(path.join(source, 'desktop', 'src', 'service-transport.cjs'));
  const { spawnManagedProcess } = require(path.join(source, 'desktop', 'src', 'managed-process.cjs'));
  const { inheritedEnvironment } = require(path.join(source, 'desktop', 'src', 'runtime-platform.cjs'));
  const windowsBoundary = createWindowsBoundary(runtime);
  const userData = path.join(owned, 'cache-compatibility'); windowsBoundary.createDirectory(userData);
  const ports = {}; for (const name of ['postgres', 'redis', 'backend', 'analyzer']) ports[name] = await unusedPort();
  const transport = await createServiceTransport({ userData, ports, getApiToken: () => crypto.randomBytes(32).toString('hex'), windowsBoundary });
  let cache;
  try {
    cache = await spawnManagedProcess({ javaPath: path.join(runtime, 'jre', 'bin', 'java.exe'), jarPath: path.join(runtime, 'backend', 'code-intelligence.jar'),
      command: path.join(runtime, 'cache', 'GarnetServer.exe'), args: ['--config-import-path', transport.redisConfig, '--config-import-format', 'Garnet'],
      cwd: userData, env: inheritedEnvironment(env, 'win32'), logPath: path.join(userData, 'cache-private.log') });
    let ready = false; const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { if (cache.stopped()) throw new Error('GARNET_EXITED'); if (await transport.redisReady()) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 200)); }
    assert.ok(ready, 'Real TLS+AUTH Garnet startup required');
    const material = transport.materials.redis;
    await negativeConnection({ port: ports.redis, ca: material.pem, encrypted: true, command: '*1\r\n$4\r\nPING\r\n', expectErrorReply: true });
    await negativeConnection({ port: ports.redis, ca: material.pem, encrypted: true, command: '*2\r\n$4\r\nAUTH\r\n$5\r\nwrong\r\n', expectErrorReply: true });
    await negativeConnection({ port: ports.redis, encrypted: false, command: '*1\r\n$4\r\nPING\r\n' });
    await negativeConnection({ port: ports.redis, encrypted: true });
    const powershell = path.join(env.SystemRoot || env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const sockets = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', `@(Get-NetTCPConnection -State Listen -OwningProcess ${cache.pid} | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress`], owned, env);
    const listeners = JSON.parse(sockets); const list = Array.isArray(listeners) ? listeners : [listeners];
    assert.equal(list.length, 1); assert.equal(list[0].LocalAddress, '127.0.0.1'); assert.equal(list[0].LocalPort, ports.redis);
    const classes = path.join(owned, 'cache-probe-classes'); fs.mkdirSync(classes);
    const libraries = path.join(classes, 'lib'); fs.mkdirSync(libraries);
    for (const entry of zipEntries(fs.readFileSync(path.join(runtime, 'backend', 'code-intelligence.jar')))) {
      let relative;
      if (/^BOOT-INF\/lib\/[^/]+\.jar$/.test(entry.name)) relative = 'lib/' + path.posix.basename(entry.name);
      else if (entry.name.startsWith('BOOT-INF/classes/') && !entry.directory) relative = entry.name.slice(17);
      if (!relative) continue;
      const target = path.join(classes, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, entry.read(), { flag: 'wx' });
    }
    const properties = path.join(userData, 'probe.properties');
    const escape = value => value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
    windowsBoundary.writeFresh(properties, Buffer.from(`port=${ports.redis}\npassword=${transport.redisPassword}\ncertificate=${escape(material.cert)}\n`));
    const cp = classes + path.delimiter + path.join(libraries, '*');
    const javaSource = path.join(source, 'desktop', 'test', 'fixtures', 'WindowsCacheProbe.java');
    run(path.join(env.JAVA_HOME, 'bin', 'javac.exe'), ['-cp', cp, '-d', classes, javaSource], owned, env, { buildDiagnostics: true, sourceRoot: source });
    const tomcat = path.join(owned, 'cache-probe-tomcat'); fs.mkdirSync(tomcat);
    const result = run(path.join(runtime, 'jre', 'bin', 'java.exe'), ['-cp', cp, 'WindowsCacheProbe', properties, tomcat], owned, env);
    assert.match(result, /WINDOWS_GARNET_SPRING_SESSION_LETTUCE_LUA_SSE_PASS/);
    report.checks.push('garnet-exact-loopback-tls-auth', 'garnet-rejects-plaintext-missing-auth-wrong-auth-untrusted-ca',
      'actual-spring-session-save-read-rotate-expire-delete', 'actual-lettuce-lua-evalsha', 'actual-job-pattern-pubsub-to-sse');
    report.cacheCompatibility = { status: 'PASS', implementation: 'Microsoft Garnet 2.2.0 self-contained',
      sessionRepository: 'RedisSessionRepository', indexedSessionEvents: 'not-used-by-application', redisCli: false };
  } finally {
    if (cache) { cache.kill('SIGTERM'); const stopped = await cache.termination; assert.equal(stopped.stopped, true); }
    await transport.close();
  }
}
async function runWindowsProduct({ source, owned, artifacts, report, env, run, phase }) {
  require('./native-acceptance.cjs').requireHosted(env);
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  require('./native-acceptance-windows.cjs').requireStandardUserToken(JSON.parse(fs.readFileSync(path.join(artifacts, 'token.json'), 'utf8')));
  const desktop = path.join(source, 'desktop'), supply = path.join(owned, 'windows-runtime-supply');
  phase('windows-pinned-runtime-provision');
  const powershell = path.join(env.SystemRoot || env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(desktop, 'scripts', 'provision-windows-runtime.ps1'), '-Destination', supply], owned, env, { buildDiagnostics: true, sourceRoot: source });
  const buildEnv = { ...env, CODE_INTELLIGENCE_WINDOWS_SUPPLY: supply, JAVA_HOME: path.join(supply, 'jdk') };
  const npmCli = env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  for (const directory of ['frontend', 'analyzers/ts-analyzer']) run(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], path.join(source, directory), buildEnv);
  phase('windows-current-source-runtime-stage');
  run(process.execPath, ['scripts/stage-runtime.mjs'], desktop, buildEnv, { buildDiagnostics: true, sourceRoot: source });
  const runtime = path.join(desktop, 'stage', 'runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-manifest.json')));
  await validateRuntimeManifest(runtime, manifest);
  const proof = verifyWindowsRuntime({ root: runtime, manifest, provenance: JSON.parse(fs.readFileSync(path.join(runtime, 'windows-provenance.json'))), supplies: SUPPLIES });
  report.runtimeManifestSha256 = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  report.nativeRuntime = { files: proof.files, native: proof.native, resolvedImports: proof.closure.length };
  report.checks.push('windows-pinned-supply-and-pe-provenance-closure', 'current-source-runtime-stage');
  phase('windows-real-cache-compatibility'); await cacheCompatibility({ source, runtime, owned, env: buildEnv, run, report });
  phase('windows-real-product');
  await require('./native-acceptance-electron.cjs').runProduct({ source, owned, artifacts, report, env: buildEnv, phase });
  report.productAcceptance = { status: 'PASS', scope: 'fresh-standard-user-unsigned-development-runtime', signedInstallation: false };
}
module.exports = { runWindowsProduct, negativeConnection };
