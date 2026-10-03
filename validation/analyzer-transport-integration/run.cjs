'use strict';

// Explicitly invoked integration fixture. Generates ephemeral TLS material only inside a new
// private claimed run. No downloads, DB, Redis, desktop launch, Keychain, PID lookup or signals.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn } = require('node:child_process');
const repository = path.resolve(__dirname, '../..');
const { copyPrivateTree, dependencyInventory } = require('../../desktop/scripts/build-isolated.cjs');
const SHA = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const stamp = stat => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(':');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const LIMIT = 128 * 1024 * 1024;
let root, env, plan;
const originalFiles = new Map(), active = new Set(), checks = [];

function directory(file, privateMode = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file
      || /[\x00-\x1f\x7f]/.test(file) || fs.realpathSync(file) !== file) fail('INPUT_PATH_INVALID');
  let cursor = path.parse(file).root;
  for (const part of file.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INPUT_PATH_INVALID');
  }
  const stat = fs.lstatSync(file);
  if (privateMode && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700)) fail('PRIVATE_PARENT_REQUIRED');
  return file;
}
function read(file, maximum = LIMIT) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) fail('INPUT_FILE_INVALID');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const used = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!used) break;
      count += used;
    }
    const same = after => stamp(after) === stamp(before) && after.nlink === before.nlink
      && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs;
    if (count !== before.size || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) fail('INPUT_CHANGED');
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
function copy(source, target) {
  directory(path.dirname(source));
  const bytes = read(source);
  originalFiles.set(source, SHA(bytes));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  return target;
}
function files(directoryName) {
  return fs.readdirSync(directoryName, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const file = path.join(directoryName, entry.name);
      if (entry.isSymbolicLink()) fail('SOURCE_LINK_REFUSED');
      if (entry.isDirectory()) return files(file);
      if (!entry.isFile()) fail('SOURCE_TYPE_REFUSED');
      return [file];
    });
}
function execute(label, command, args, input = '', timeout = 120000) {
  plan.assertIdentity();
  return new Promise((resolve, reject) => {
    const log = fs.openSync(path.join(root, 'logs', `${label}.log`), 'wx', 0o600);
    const child = spawn(command, args, { cwd: root, env, stdio: ['pipe', log, log], shell: false });
    let finished = false;
    active.add(child);
    const timer = setTimeout(() => {
      // Deliberately no kill signal: a timeout is a failed run with cleanup unproven.
      child.unref();
      reject(Object.assign(new Error('CHILD_TIMEOUT_RETAINED'), { code: 'CHILD_TIMEOUT_RETAINED' }));
    }, timeout);
    child.once('error', () => {
      if (finished) return;
      finished = true; clearTimeout(timer); fs.closeSync(log); active.delete(child); reject(new Error('CHILD_START_FAILED'));
    });
    child.once('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); fs.closeSync(log); active.delete(child);
      if (code !== 0) reject(new Error(`FAILED_${label.toUpperCase()}`)); else resolve();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function receive(child, type, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('SERVER_IPC_TIMEOUT')), timeout);
    const onMessage = message => { if (message?.type === type) finish(null, message); };
    const onExit = () => finish(new Error('SERVER_EXITED'));
    function finish(error, result) {
      clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit);
      error ? reject(error) : resolve(result);
    }
    child.on('message', onMessage); child.once('exit', onExit);
  });
}
async function server(label, configuration, expected = 'ready') {
  const log = fs.openSync(path.join(root, 'logs', `${label}.log`), 'wx', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'work/analyzer/server.cjs')], {
    cwd: root, env, stdio: ['ignore', log, log, 'ipc'], shell: false,
  });
  active.add(child);
  child.once('close', () => { active.delete(child); fs.closeSync(log); });
  child.on('error', () => {});
  const ready = receive(child, expected);
  child.send({ type: 'start', environment: configuration });
  const result = await ready;
  return { child, result };
}
async function stats(child) {
  const pending = receive(child, 'stats'); child.send({ type: 'stats' }); return pending;
}
async function closeServer(child) {
  if (child.exitCode !== null) return;
  const stopped = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SERVER_CLOSE_UNPROVEN')), 10000);
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('SERVER_CLOSE_FAILED')); });
  });
  if (child.connected) child.send({ type: 'close' });
  await stopped;
}
async function raw(port, cert, authorization) {
  return new Promise((resolve, reject) => {
    // An array preserves duplicate Authorization fields, but does not get Node's
    // automatic Host header. Supply it so HTTP/1.1 parsing reaches the auth middleware.
    const headers = ['Host', `127.0.0.1:${port}`, 'Content-Type', 'application/json', 'Content-Length', '1', 'Connection', 'close'];
    for (const value of authorization) headers.push('Authorization', value);
    const request = https.request({ hostname: '127.0.0.1', port, path: '/analyze', method: 'POST',
      ca: cert, rejectUnauthorized: true, agent: false, headers }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.setTimeout(5000, () => request.destroy(new Error('REQUEST_TIMEOUT')));
    request.once('error', reject); request.end('{');
  });
}
function options(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = { '--build-parent': 'parent', '--java-home': 'java', '--gradle-modules-cache': 'cache' }[argv[i]];
    if (!name || parsed[name] || !argv[i + 1]) fail('ARGUMENTS_INVALID');
    parsed[name] = directory(argv[i + 1], name === 'parent');
  }
  if (Object.keys(parsed).length !== 3 || path.basename(parsed.cache) !== 'modules-2') fail('ARGUMENTS_INVALID');
  if (inside(repository, parsed.parent) || inside(parsed.parent, repository)) fail('PARENT_OVERLAPS_SOURCE');
  const appData = path.join(os.homedir(), 'Library/Application Support');
  if (inside(appData, parsed.parent) || inside(parsed.parent, appData)) fail('PARENT_OVERLAPS_APP_DATA');
  for (let cursor = parsed.parent; ; cursor = path.dirname(cursor)) {
    for (const claim of ['.isolated-build.json', '.isolated-run.json', '.analyzer-transport-fixture.json']) {
      if (fs.existsSync(path.join(cursor, claim))) fail('PRIOR_RUN_REUSE_REFUSED');
    }
    if (cursor === path.dirname(cursor)) break;
  }
  if (!/^JAVA_VERSION="21(?:\.|\")/m.test(read(path.join(parsed.java, 'release'), 65536).toString())) fail('JDK_21_REQUIRED');
  return parsed;
}
async function main() {
  if (process.platform !== 'darwin' || !process.getuid) fail('MACOS_FIXTURE_ONLY');
  const selected = options(process.argv.slice(2));
  const parentIdentity = stamp(fs.lstatSync(selected.parent));
  root = fs.mkdtempSync(path.join(selected.parent, 'analyzer-transport-'));
  fs.chmodSync(root, 0o700);
  const rootIdentity = stamp(fs.lstatSync(root));
  const claim = Buffer.from(JSON.stringify({ format: 1, purpose: 'synthetic-analyzer-transport', launchAllowed: false }));
  const claimFile = path.join(root, '.analyzer-transport-fixture.json');
  fs.writeFileSync(claimFile, claim, { flag: 'wx', mode: 0o600 });
  for (const name of ['work', 'home', 'tmp', 'logs', 'jars', 'classes', 'tls']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  plan = { workRoot: path.join(root, 'work'), assertIdentity() {
    directory(root, true); directory(selected.parent, true);
    if (stamp(fs.lstatSync(root)) !== rootIdentity || stamp(fs.lstatSync(selected.parent)) !== parentIdentity
        || !read(claimFile, 4096).equals(claim)) fail('RUN_CHANGED');
  } };
  env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
  const analyzer = path.join(root, 'work/analyzer');
  fs.mkdirSync(analyzer, { mode: 0o700 });
  const dependencySource = path.join(repository, 'analyzers/ts-analyzer/node_modules');
  const dependency = copyPrivateTree(plan, dependencySource, path.join(analyzer, 'node_modules'));
  for (const file of files(path.join(repository, 'analyzers/ts-analyzer/src')).filter(file => !file.endsWith('.test.ts'))) {
    copy(file, path.join(analyzer, 'src', path.relative(path.join(repository, 'analyzers/ts-analyzer/src'), file)));
  }
  copy(path.join(repository, 'analyzers/ts-analyzer/tsconfig.json'), path.join(analyzer, 'tsconfig.json'));
  copy(path.join(__dirname, 'server.cjs'), path.join(analyzer, 'server.cjs'));
  await execute('compile-nest', process.execPath, [path.join(analyzer, 'node_modules/typescript/bin/tsc'),
    '-p', path.join(analyzer, 'tsconfig.json'), '--sourceMap', 'false', '--incremental', 'false']);
  const javaFiles = ['TsAnalyzerClient', 'TsAnalyzerProperties', 'TsAnalyzerTls', 'TsAnalyzeDtos',
    'TsRequestBudget', 'TsSyntaxInputException', 'TsAnalyzerException'].map(name =>
    copy(path.join(repository, `backend/src/main/java/dev/codeintelligence/analysis/ts/${name}.java`), path.join(root, 'work/java', `${name}.java`)));
  javaFiles.push(copy(path.join(repository, 'backend/src/main/java/dev/codeintelligence/job/JobInputFailure.java'), path.join(root, 'work/java/JobInputFailure.java')));
  javaFiles.push(copy(path.join(__dirname, 'AnalyzerTransportProbe.java'), path.join(root, 'work/java/AnalyzerTransportProbe.java')));
  const fixture = copy(path.join(repository, 'backend/src/test/resources/fixtures/ts-nullable-metadata.json'), path.join(root, 'work/fixture.json'));
  // Exact offline dependencies for this repository's Spring Boot 4.1.0 / Spring 7.0.8 baseline.
  const modules = [
    ...['spring-core', 'spring-beans', 'spring-context', 'spring-web', 'spring-expression', 'spring-aop'].map(name => ['org.springframework', name, '7.0.8']),
    ['org.springframework.boot', 'spring-boot', '4.1.0'], ['tools.jackson.core', 'jackson-core', '3.1.4'],
    ['tools.jackson.core', 'jackson-databind', '3.1.4'], ['com.fasterxml.jackson.core', 'jackson-annotations', '2.22'],
    ['io.micrometer', 'micrometer-observation', '1.17.0'], ['io.micrometer', 'micrometer-commons', '1.17.0'],
    ['org.jspecify', 'jspecify', '1.0.0'], ['commons-logging', 'commons-logging', '1.3.6'],
  ];
  const jars = modules.map(([group, name, version]) => {
    const input = directory(path.join(selected.cache, 'files-2.1', group, name, version));
    const found = files(input).filter(file => path.basename(file) === `${name}-${version}.jar`);
    if (found.length !== 1) fail('OFFLINE_DEPENDENCY_AMBIGUOUS');
    return copy(found[0], path.join(root, 'jars', `${name}-${version}.jar`));
  });
  const classpath = [path.join(root, 'classes'), ...jars].join(path.delimiter);
  await execute('compile-java', path.join(selected.java, 'bin/javac'), ['-J-XX:+DisableAttachMechanism',
    '--release', '21', '-encoding', 'UTF-8', '-parameters', '-proc:none', '-cp', classpath, '-d', path.join(root, 'classes'), ...javaFiles]);
  const tls = {};
  for (const [name, ip] of [['valid', '127.0.0.1'], ['wrong-san', '127.0.0.2']]) {
    const config = path.join(root, 'tls', `${name}.cnf`), key = path.join(root, 'tls', `${name}.key`), cert = path.join(root, 'tls', `${name}.crt`);
    fs.writeFileSync(config, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=fixture\n[ext]\nsubjectAltName=IP:${ip}\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { flag: 'wx', mode: 0o600 });
    await execute(`certificate-${name}`, '/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-config', config, '-keyout', key, '-out', cert]);
    fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600);
    tls[name] = { key, cert, pin: new crypto.X509Certificate(read(cert)).fingerprint256.replaceAll(':', '').toLowerCase() };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const configuration = material => ({ TS_ANALYZER_HOST: '127.0.0.1', TS_ANALYZER_PORT: '0',
    TS_ANALYZER_TLS_CERT_FILE: material.cert, TS_ANALYZER_TLS_KEY_FILE: material.key, TS_ANALYZER_AUTH_TOKEN: token });
  const probe = (label, port, pin, mode) => execute(label, path.join(selected.java, 'bin/java'), [
    '-XX:+DisableAttachMechanism', `-Duser.home=${env.HOME}`, `-Djava.io.tmpdir=${env.TMPDIR}`,
    '-cp', classpath, 'dev.codeintelligence.analysis.ts.AnalyzerTransportProbe'],
  JSON.stringify({ url: `https://127.0.0.1:${port}`, pin, token, mode, fixture }), 20000);
  const live = await server('nest-valid', configuration(tls.valid));
  try {
    const port = live.result.port;
    await probe('java-success', port, tls.valid.pin, 'success'); checks.push('java-health-analyze-null-metadata');
    const before = await stats(live.child);
    if (before.requests !== 2 || before.bodyBytes < 1) fail('SUCCESS_NOT_OBSERVED');
    await probe('java-wrong-pin', port, tls['wrong-san'].pin, 'reject-tls');
    const after = await stats(live.child);
    if (after.requests !== before.requests || after.bodyBytes !== before.bodyBytes) fail('PAYLOAD_BEFORE_PIN');
    checks.push('wrong-pin-no-http-payload');
    for (const [label, headers] of [['missing-token', []], ['wrong-token', [`Bearer ${'0'.repeat(64)}`]],
      ['duplicate-token', [`Bearer ${token}`, `Bearer ${token}`]]]) {
      const beforeRequest = await stats(live.child);
      const status = await raw(port, read(tls.valid.cert), headers);
      const afterRequest = await stats(live.child);
      const safeLabel = label.replaceAll('-', '_').toUpperCase();
      if (status !== 401) fail(`AUTH_BEFORE_PARSER_${safeLabel}_HTTP_${Number.isInteger(status) ? status : 'UNKNOWN'}`);
      if (afterRequest.requests !== beforeRequest.requests + 1) fail(`AUTH_REQUEST_NOT_OBSERVED_${safeLabel}`);
      checks.push(`${label}-malformed-json-401`);
    }
    const authorizedStatus = await raw(port, read(tls.valid.cert), [`Bearer ${token}`]);
    if (authorizedStatus !== 400) fail(`AUTHORIZED_JSON_HTTP_${Number.isInteger(authorizedStatus) ? authorizedStatus : 'UNKNOWN'}`);
    checks.push('valid-token-malformed-json-400');
  } finally { await closeServer(live.child); }
  const wrongHost = await server('nest-wrong-san', configuration(tls['wrong-san']));
  try {
    await probe('java-wrong-san', wrongHost.result.port, tls['wrong-san'].pin, 'reject-tls');
    const observed = await stats(wrongHost.child);
    if (observed.requests !== 0 || observed.bodyBytes !== 0) fail('PAYLOAD_BEFORE_HOSTNAME');
    checks.push('correct-pin-wrong-san-no-http-payload');
  } finally { await closeServer(wrongHost.child); }
  const partial = await server('nest-partial', { TS_ANALYZER_PORT: '0', TS_ANALYZER_AUTH_TOKEN: token }, 'refused');
  await closeServer(partial.child); checks.push('partial-tls-refused');
  plan.assertIdentity();
  for (const [file, expected] of originalFiles) if (SHA(read(file)) !== expected) fail('ORIGINAL_INPUT_CHANGED');
  if (dependencyInventory(dependencySource).sha256 !== dependency.sha256) fail('ORIGINAL_DEPENDENCIES_CHANGED');
  if (active.size) fail('CHILD_CLEANUP_UNPROVEN');
  const report = { format: 1, status: 'ANALYZER_TRANSPORT_INTEGRATION_PASSED', checks,
    fixtureRoot: root, launchAllowed: false, desktopAcceptance: false, originalInputsUnchanged: true,
    inputs: Object.fromEntries([...originalFiles].filter(([file]) => inside(repository, file))
      .map(([file, hash]) => [path.relative(repository, file), hash])),
    jars: jars.map(file => ({ name: path.basename(file), sha256: SHA(read(file)) })),
    dependenciesSha256: dependency.sha256, osCredentialStoreIsolationVerified: false,
    electronStarted: false, productNativeServicesStarted: false, generatedTestCredentials: true };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, checks, fixtureRoot: root, launchAllowed: false }));
}

if (require.main === module) {
  process.umask(0o077);
  main().catch(async error => {
    for (const child of [...active]) if (child.connected) {
      try { await closeServer(child); } catch { child.disconnect(); child.unref(); }
    }
    const report = { status: 'ANALYZER_TRANSPORT_INTEGRATION_FAILED', code: /^[A-Z0-9_]+$/.test(error.code || error.message)
      ? error.code || error.message : 'FIXTURE_FAILED', fixtureRoot: root || null, checks, launchAllowed: false, cleanupVerified: active.size === 0 };
    if (root) try { fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 }); } catch {}
    console.error(JSON.stringify(report)); process.exitCode = 1;
  });
}
