'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const EXCLUDED = new Set(['node_modules', 'dist', 'stage', '.git', '.gradle', '.repowise', 'test-results', 'playwright-report', 'coverage']);
const ROOTS = ['desktop', 'frontend', 'backend', 'analyzers/ts-analyzer'];
function included(relative) {
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => part === 'node_modules' || part.startsWith('.') || /^(?:secrets|credentials|userData|sessionData)$/i.test(part))) return false;
  const normalized = parts.join('/');
  const root = ROOTS.find(root => normalized === root || normalized.startsWith(root + '/'));
  if (!root) return false;
  const output = parts[root.split('/').length];
  // Output names are scoped to package roots, not Java/TypeScript package names.
  if (EXCLUDED.has(output) || (output === 'build' && root !== 'desktop')) return false;
  return !/\.(?:p12|pfx|pem|key|keystore|log|db)$/i.test(relative);
}
function requireHosted(env = process.env, platform = process.platform, arch = process.arch) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Hosted workflow required');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Self-hosted machines are prohibited');
  assert.ok(['workflow_dispatch', 'pull_request'].includes(env.GITHUB_EVENT_NAME), 'Manual dispatch or trusted PR required');
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    assert.ok(path.isAbsolute(env.GITHUB_EVENT_PATH || ''));
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    assert.ok(env.GITHUB_REPOSITORY);
    assert.equal(event.pull_request?.head?.repo?.full_name, env.GITHUB_REPOSITORY, 'Fork source is prohibited');
    assert.equal(event.pull_request?.base?.repo?.full_name, env.GITHUB_REPOSITORY, 'Unexpected PR target');
  }
  assert.equal(env.NATIVE_ACCEPTANCE_CONSENT, 'disposable-hosted-os', 'Explicit disposable OS consent required');
  assert.ok((platform === 'darwin' && arch === 'arm64') || (platform === 'win32' && arch === 'x64'));
  assert.match(env.CODE_INTELLIGENCE_BUILD_SEQUENCE || '', /^[1-9][0-9]{0,18}$/);
  assert.ok(BigInt(env.CODE_INTELLIGENCE_BUILD_SEQUENCE) <= 9223372036854775807n);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40,64}$/);
  for (const key of ['RUNNER_TEMP', 'GITHUB_WORKSPACE']) assert.ok(path.isAbsolute(env[key] || ''));
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'CODE_INTELLIGENCE_ISOLATED_RUN']) assert.ok(!env[key], `Unexpected ${key}`);
}
function copySource(source, destination) {
  assert.ok(!fs.existsSync(destination), 'Source copy must be fresh');
  fs.mkdirSync(destination, { mode: 0o700 });
  const hash = crypto.createHash('sha256'); let count = 0;
  function visit(relative) {
    if (!included(relative)) return;
    const from = path.join(source, relative), to = path.join(destination, relative);
    const stat = fs.lstatSync(from);
    assert.ok(!stat.isSymbolicLink(), 'Source symlinks are not accepted');
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(from).sort()) visit(path.join(relative, name));
    } else {
      assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024, 'Unexpected source file');
      const bytes = fs.readFileSync(from);
      fs.writeFileSync(to, bytes, { flag: 'wx', mode: stat.mode & 0o100 ? 0o700 : 0o600 });
      hash.update(relative.split(path.sep).join('/') + '\0').update(bytes); count++;
    }
  }
  for (const root of ROOTS) visit(root);
  return { files: count, sha256: hash.digest('hex') };
}
function nativeClosureDiagnostics(text) {
  const records = [], seen = new Set();
  const relative = value => typeof value === 'string' && value.length <= 256
    && /^(?:postgres|redis|jre)\/[A-Za-z0-9_+./-]+$/.test(value)
    && path.posix.normalize(value) === value && !value.endsWith('/');
  const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
  for (const match of text.matchAll(/^NATIVE_STAGE_CLOSURE (\{[^\r\n]{1,8192}\})\r?$/gm)) {
    if (records.length === 12) break;
    let item; try { item = JSON.parse(match[1]); } catch { continue; }
    if (!keys(item, ['file', 'reference', 'rpaths']) || !relative(item.file)
        || typeof item.reference !== 'string' || item.reference.length > 256
        || !/^@(loader_path|executable_path|rpath)\/[A-Za-z0-9_+./-]+$/.test(item.reference)
        || !Array.isArray(item.rpaths) || item.rpaths.length > 16) continue;
    const slash = item.reference.indexOf('/'), token = item.reference.slice(0, slash), suffix = item.reference.slice(slash + 1);
    if (suffix.endsWith('/') || suffix.startsWith('/') || path.posix.normalize(suffix) !== suffix) continue;
    if (token === '@rpath' ? suffix.startsWith('../')
      : !relative(path.posix.join(path.posix.dirname(item.file), suffix))) continue;
    if (item.rpaths.some(entry => !keys(entry, ['kind', 'directory']) || !['loader', 'executable'].includes(entry.kind)
      || !(['.', 'postgres', 'redis', 'jre'].includes(entry.directory) || relative(entry.directory)))) continue;
    const encoded = JSON.stringify(item); if (seen.has(encoded)) continue;
    seen.add(encoded); records.push(item);
  }
  return records;
}
// Build-only public compiler IDs/locations are retained; raw text stays private.
function buildDiagnostics(stdout = '', stderr = '', sourceRoot = null) {
  const text = stdout + '\n' + stderr;
  const categories = [];
  for (const [name, expression] of [
    ['typescript', /error TS[0-9]{4,5}:/],
    ['java-compilation', /(?:compileJava FAILED|\.java:[0-9]+: error:)/],
    ['java-symbol-missing', /error: cannot find symbol/],
    ['java-type-mismatch', /error: incompatible types:/],
    ['java-package-missing', /error: package [^\r\n]+ does not exist/],
    ['gradle-dependency-resolution', /Could not resolve all (?:files|dependencies)/],
    ['gradle-toolchain', /(?:Cannot find a Java installation|No matching toolchains found)/],
    ['cmake-configuration', /CMake Error/],
    ['native-link', /(?:Undefined symbols for architecture|(?:^|\n)ld: |LINK : fatal error|fatal error LNK)/],
    ['native-loader', /(?:dyld(?:\[[0-9]+\])?:|Library not loaded:)/],
    ['pgvector-missing', /pgvector is not installed for the selected PostgreSQL runtime/],
    ['native-compile', /(?:fatal error:|error C[0-9]{4}:)/],
    ['native-runtime-policy', /Native runtime publication blocked:/],
    ['missing-file', /\bENOENT\b/],
    ['permission-denied', /\bEACCES\b|Permission denied/],
    ['network-resolution', /\bENOTFOUND\b|Could not resolve host/],
  ]) if (expression.test(text)) categories.push(name);
  const compilerCodes = [...new Set([...text.matchAll(/\b(?:error|fatal error) (TS[0-9]{4,5}|C[0-9]{4}|LNK[0-9]{4}):/g)].map(match => match[1]))].slice(0, 32);
  const policyCodes = ['MINIMUM_OS_EXCEEDED', 'NON_RELOCATABLE_REFERENCE', 'UNSUPPORTED_RPATH',
    'UNRESOLVED_NATIVE_REFERENCE', 'BASENAME_COLLISION', 'ARCHITECTURE_MISMATCH',
    'JAVA_MAJOR_MISMATCH', 'REQUIRED_MODULE_MISSING', 'REQUIRED_EXECUTABLE_MISSING',
    'DEPENDENCY_NOT_DYLIB', 'UNRESOLVED_COPY_DEPENDENCY', 'NATIVE_CHANGED',
    'COPY_BASENAME_COLLISION', 'NATIVE_INSPECTION_FAILED', 'UNSAFE_STAGE_ENTRY', 'INVALID_STAGE_ROOT',
    'MISSING_OR_AMBIGUOUS_DEPLOYMENT_TARGET', 'INVALID_LOAD_COMMANDS', 'UNSUPPORTED_LIBRARY_FORMAT',
    'PRIVATE_NATIVE_PREFIX_REQUIRED', 'UNVERIFIED_NATIVE_DEPENDENCY', 'NATIVE_PREFIX_LINK_ESCAPE',
    'EXTENSION_CONTROL_BINDING', 'REQUIRED_EXTENSION_SQL', 'REQUIRED_EXTENSION_CONTROL',
    'INVALID_PE', 'INVENTORY_LIMIT', 'CASE_COLLISION', 'SYSTEM_DLL_SHADOW', 'DEPENDENCY_NOT_NATIVE',
    'INVALID_WINDOWS_MANIFEST', 'INVENTORY_MISMATCH', 'REQUIRED_NATIVE_MISSING', 'REQUIRED_NATIVE_KIND',
    'PROVENANCE_MISSING', 'UNPINNED_SUPPLY', 'NOTICE_MISSING', 'DEPENDENCY_NOTICE_MISSING', 'CACHE_SELF_CONTAINED_REQUIRED']
    .filter(code => (text.match(/[A-Z][A-Z0-9_]+/g) || []).includes(code));
  const windowsPolicy = [];
  for (const match of text.matchAll(/^NATIVE_WINDOWS_POLICY (\{[^\r\n]{1,1024}\})\r?$/gm)) {
    let item; try { item = JSON.parse(match[1]); } catch { continue; }
    if (!item || !policyCodes.includes(item.code) || typeof item.file !== 'string' || item.file.length > 256
        || !/^(?:jre|cache|postgres|native)\/[A-Za-z0-9_+./-]+$/.test(item.file)
        || path.posix.normalize(item.file) !== item.file || item.file.endsWith('/')
        || Object.keys(item).some(key => !['code', 'file', 'reference'].includes(key))
        || (item.reference !== undefined && (typeof item.reference !== 'string' || !/^[A-Za-z0-9_.-]{1,240}\.dll$/i.test(item.reference)))) continue;
    if (!windowsPolicy.some(value => JSON.stringify(value) === JSON.stringify(item))) windowsPolicy.push(item);
    if (windowsPolicy.length === 12) break;
  }
  const steps = [...stdout.matchAll(/^> (npm run build|\.\/gradlew bootJar|npm ci --omit=dev --ignore-scripts|[^\r\n]*\/bin\/jlink --add-modules[^\r\n]*)$/gm)]
    .map(match => match[1].startsWith('npm run') ? 'typescript-build' : match[1].startsWith('./gradlew')
      ? 'backend-boot-jar' : match[1].startsWith('npm ci') ? 'analyzer-production-dependencies' : 'jre-link');
  const javaSymbols = [...new Set([...text.matchAll(/^[ \t]*symbol:[ \t]+(?:class|variable|method)[ \t]+([A-Za-z_$][A-Za-z0-9_$.]{0,159})/gm)].map(match => match[1]))].slice(0, 32);
  const missingPackages = [...new Set([...text.matchAll(/error: package ([A-Za-z_$][A-Za-z0-9_$.]{0,159}) does not exist/g)].map(match => match[1]))].slice(0, 32);
  const locations = [];
  if (sourceRoot) {
    for (const match of text.matchAll(/^([^\r\n]+\.java):([0-9]{1,7}): error:/gm)) {
      if (!path.isAbsolute(match[1])) continue;
      const relative = path.relative(sourceRoot, match[1]).split(path.sep).join('/');
      if (!/^backend\/src\/(?:main|test)\/java\/[A-Za-z0-9_$/.-]+\.java$/.test(relative) || !included(relative)) continue;
      try {
        const stat = fs.lstatSync(match[1]);
        if (stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(match[1]) === path.resolve(sourceRoot, relative))
          locations.push({ file: relative, line: Number(match[2]) });
      } catch { /* Only source files actually present in this fresh copy are reportable. */ }
      if (locations.length === 32) break;
    }
  }
  // Never publish linker lines, arguments, arbitrary symbols or library paths.
  // Fixed enums distinguish provisioning failures without leaking credentials.
  const nativeLink = {
    reasons: [
      ['undefined-symbols', /Undefined symbols for architecture|ld: (?:symbol\(s\) not found|undefined symbols)/],
      ['library-not-found', /ld: (?:library not found for -l|library [^\r\n]+ not found)/],
      ['duplicate-symbols', /duplicate symbol|ld: [0-9]+ duplicate symbols/],
      ['architecture-mismatch', /ld: [^\r\n]*(?:incompatible architecture|wrong architecture)|ignoring file [^\r\n]*built for/],
      ['deployment-target-mismatch', /was built for newer macOS version|built for macOS [^\r\n]*than being linked/],
      ['unsupported-option', /ld: (?:unknown|unrecognized) (?:option|argument)/],
      ['linker-crash', /ld: Assertion failed|clang: error: linker command failed due to signal/],
    ].filter(([, pattern]) => pattern.test(text)).map(([reason]) => reason),
    architectures: ['arm64', 'x86_64'].filter(arch => text.includes('Undefined symbols for architecture ' + arch + ':')),
    missingLibraries: ['ssl', 'crypto', 'System', 'system', 'atomic', 'pthread', 'c++', 'stdc++']
      .filter(name => text.includes('ld: library not found for -l' + name + '\n') || text.includes("ld: library '" + name + "' not found")),
    failedTargets: ['redis-server', 'redis-cli', 'redis-benchmark', 'hiredis', 'lua', 'xxhash', 'tre', 'module_tests', 'commandfilter.so', 'build']
      .filter(target => text.includes('*** [' + target + '] Error ')),
    rejectedDriverFlags: ['-mmacosx-version-min=13.0', '-Wl,-headerpad_max_install_names']
      .filter(flag => text.split(/\r?\n/).some(line => /^ld: (?:unknown|unrecognized) (?:options?|arguments?):/.test(line) && line.split(/\s+/).includes(flag))),
  };
  return { lastBuildStep: steps.at(-1) || null, categories, compilerCodes, policyCodes, javaSymbols, missingPackages, locations, nativeLink,
    nativeClosure: nativeClosureDiagnostics(text), windowsPolicy };
}
function run(command, args, cwd, env = process.env, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8 * 60 * 1000;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 8 * 60 * 1000);
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  // Compiler output and runtime logs can include paths, source, URLs or credentials.
  // Keep them out of artifacts and GitHub logs; retain only bounded outcome metadata.
  if (result.status !== 0 || result.error) {
    const error = new Error(result.error?.code === 'ETIMEDOUT' ? 'NATIVE_BUILD_TIMEOUT' : 'NATIVE_ACCEPTANCE_COMMAND_FAILED');
    error.exitStatus = Number.isInteger(result.status) ? result.status : null;
    error.commandEvidence = { executable: path.basename(command), signal: result.signal || null,
      timeoutMs, stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || '') };
    if (options.buildDiagnostics) error.commandEvidence.buildDiagnostics = buildDiagnostics(result.stdout || '', result.stderr || '', options.sourceRoot);
    throw error;
  }
  return result.stdout;
}
function npm(args, cwd, env) {
  if (process.platform === 'win32') {
    // Node distributions provide npm-cli.js next to npm.cmd; avoid shell argument quoting.
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return run(process.execPath, [cli, ...args], cwd, env);
  }
  return run('npm', args, cwd, env);
}
// Only newly source-built disposable prefixes may be relocated. Never touch system bottles.
function relocateMacLibraries(prefix) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.ok(path.isAbsolute(prefix) && fs.realpathSync(prefix) === prefix);
  const identity = fs.lstatSync(prefix);
  assert.ok(identity.isDirectory() && identity.uid === process.getuid() && (identity.mode & 0o077) === 0, 'PRIVATE_NATIVE_PREFIX_REQUIRED');
  const policy = require('./native-runtime-policy.cjs');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const inside = file => file.startsWith(prefix + path.sep);
  const system = value => value.startsWith('/usr/lib/') || value.startsWith('/System/Library/');
  const inspect = file => policy.parseLoadCommands(run('/usr/bin/otool', ['-l', file], prefix));
  function nativeFiles(directory) {
    const files = [];
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) files.push(...nativeFiles(file));
      else if (item.isFile()) {
        const fd = fs.openSync(file, 'r'), magic = Buffer.alloc(4);
        try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (magic.toString('hex') === 'cffaedfe') files.push(file);
      } else if (item.isSymbolicLink()) assert.ok(inside(fs.realpathSync(file)), 'NATIVE_PREFIX_LINK_ESCAPE');
    }
    return files;
  }
  const summary = [];
  for (const component of ['postgres', 'redis']) {
    const root = path.join(prefix, component), library = path.join(root, 'lib');
    fs.mkdirSync(library, { recursive: true, mode: 0o700 });
    const queue = nativeFiles(root), visited = new Set(), origins = new Map(), changes = [];
    for (let index = 0; index < queue.length; index++) {
      const file = queue[index]; if (visited.has(file)) continue; visited.add(file);
      const metadata = inspect(file), origin = origins.get(file) || file;
      assert.ok(metadata.version[0] < 13 || (metadata.version[0] === 13 && metadata.version.slice(1).every(part => part === 0)), 'MINIMUM_OS_EXCEEDED');
      assert.equal(run('/usr/bin/lipo', ['-archs', file], prefix).trim(), 'arm64');
      function resolve(reference) {
        if (reference.startsWith('/')) return reference;
        if (reference.startsWith('@loader_path/')) return path.resolve(path.dirname(origin), reference.slice(13));
        if (reference.startsWith('@executable_path/')) return path.resolve(path.dirname(origin), reference.slice(17));
        if (reference.startsWith('@rpath/')) {
          assert.ok(metadata.rpaths.every(rpath => !rpath.startsWith('@rpath')), 'UNSUPPORTED_RPATH');
          const matches = metadata.rpaths.map(rpath => resolve(rpath + '/' + reference.slice(7))).filter(candidate => candidate && fs.existsSync(candidate));
          assert.equal(new Set(matches.map(candidate => fs.realpathSync(candidate))).size, 1, 'UNRESOLVED_NATIVE_REFERENCE');
          return matches[0];
        }
        throw new Error('NON_RELOCATABLE_REFERENCE');
      }
      const args = [];
      for (const reference of metadata.dependencies) {
        if (system(reference) || reference === '/usr/lib/dyld') continue;
        const dependency = fs.realpathSync(resolve(reference));
        assert.ok(inside(dependency), 'UNVERIFIED_NATIVE_DEPENDENCY');
        let bundled = dependency;
        if (!dependency.startsWith(root + path.sep)) {
          bundled = path.join(library, path.basename(dependency));
          if (fs.existsSync(bundled)) assert.equal(hash(bundled), hash(dependency), 'BASENAME_COLLISION');
          else fs.copyFileSync(dependency, bundled, fs.constants.COPYFILE_EXCL);
          origins.set(bundled, dependency);
        }
        queue.push(bundled);
        const replacement = '@loader_path/' + path.relative(path.dirname(file), bundled).split(path.sep).join('/');
        if (replacement !== reference) args.push('-change', reference, replacement);
      }
      // All dependency edges are now direct loader-relative references.
      for (const rpath of metadata.rpaths) args.push('-delete_rpath', rpath);
      changes.push({ file, args });
    }
    for (const { file, args } of changes) {
      if (args.length) run('/usr/bin/install_name_tool', [...args, file], prefix);
      run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file], prefix);
    }
    const digest = crypto.createHash('sha256');
    for (const file of [...visited].sort()) {
      const metadata = inspect(file);
      for (const reference of metadata.dependencies) {
        if (system(reference)) continue;
        assert.ok(reference.startsWith('@loader_path/'), 'NON_RELOCATABLE_REFERENCE');
        const resolved = fs.realpathSync(path.resolve(path.dirname(file), reference.slice(13)));
        assert.ok(resolved.startsWith(root + path.sep), 'UNRESOLVED_NATIVE_REFERENCE');
      }
      assert.equal(metadata.rpaths.length, 0);
      digest.update(path.relative(root, file)).update('\0').update(hash(file));
    }
    summary.push({ component, nativeFiles: visited.size, minimumSystemVersion: '13.0', sha256: digest.digest('hex') });
  }
  return summary;
}
function recordFailure(report, error) {
  report.status = 'FAIL';
  report.failure ||= { category: error.name === 'AssertionError' ? 'assertion' : 'native-step-failed',
    code: /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message || '') ? error.message
      : /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code || '') ? error.code
        : error.name === 'TimeoutError' ? 'NATIVE_UI_TIMEOUT' : 'NATIVE_ACCEPTANCE_STEP_FAILED',
    phase: report.phase,
    exitStatus: Number.isInteger(error.exitStatus) ? error.exitStatus : null, command: error.commandEvidence || null };
  return report.failure;
}
function recordProvisioningFailure({ work, step, exitCode, artifact }) {
  const log = path.join(work, 'build-output');
  let text = '', logBytes = 0;
  if (fs.existsSync(log)) {
    const descriptor = fs.openSync(log, 'r');
    try {
      logBytes = fs.fstatSync(descriptor).size;
      const bytes = Buffer.alloc(Math.min(logBytes, 256 * 1024));
      fs.readSync(descriptor, bytes, 0, bytes.length, logBytes - bytes.length);
      text = bytes.toString('utf8');
    } finally { fs.closeSync(descriptor); }
  }
  const sources = {};
  for (const name of ['openssl', 'postgres', 'pgvector', 'redis']) {
    const file = path.join(work, name + '-source.json');
    if (!fs.existsSync(file)) continue;
    const source = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (/^[0-9]+(?:\.[0-9]+){1,3}$/.test(source.version) && /^[a-f0-9]{64}$/.test(source.sourceSha256)) {
      sources[name] = { version: source.version, sha256: source.sourceSha256 };
    }
  }
  const executionContext = JSON.parse(fs.readFileSync(artifact, 'utf8')).executionContext;
  fs.writeFileSync(artifact, JSON.stringify({ phase: 'native-runtime-provision', status: 'FAIL', step,
    executionContext, exitCode: Number(exitCode), logBytes, diagnosticsTruncated: logBytes > 256 * 1024,
    sources, diagnostics: buildDiagnostics('', text) }, null, 2) + '\n', { mode: 0o600 });
}
async function main(target) {
  const { requireExecutionContext, claimExecution, prepareArtifacts } = require('./native-acceptance-context.cjs');
  const context = requireExecutionContext();
  assert.equal(target, process.platform === 'darwin' ? 'macos' : 'windows');
  claimExecution(context, 'acceptance');
  const artifacts = prepareArtifacts(context);
  const report = { format: 1, revision: context.revision, platform: process.platform, arch: process.arch,
    executionContext: context.evidence,
    buildSequence: context.buildSequence, mode: 'unsigned-development-native',
    nodeVersion: process.versions.node, osRelease: require('node:os').release(),
    signedInstallation: false, notarizedInstallation: false, isolatedRunGateChanged: false,
    scope: target === 'windows' ? 'windows-native-development-app' : 'macos-native-development-app',
    installationAcceptance: { status: 'BLOCKED', code: 'SIGNING_AND_NOTARIZATION_UNAVAILABLE' },
    status: 'RUNNING', phase: 'fresh-source-copy', checks: [] };
  const save = () => fs.writeFileSync(path.join(artifacts, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save();
  try {
    const owned = fs.mkdtempSync(path.join(context.tempRoot, 'native-acceptance-private-'));
    fs.chmodSync(owned, 0o700);
    const source = path.join(owned, 'source');
    report.source = copySource(context.sourceRoot, source);
    const env = { ...process.env, CODE_INTELLIGENCE_BUILD_SEQUENCE: context.buildSequence,
      GRADLE_USER_HOME: path.join(owned, 'gradle'), npm_config_cache: path.join(owned, 'npm-cache'),
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
    // No dependency reuse, global npm installs, database URLs or provider credentials.
    for (const key of Object.keys(env)) if (/^(?:GITHUB_TOKEN|GH_TOKEN|OPENAI_|ANTHROPIC_|DATABASE_URL|SPRING_DATASOURCE_|TOKEN_ENC_KEY|PGPASSWORD|REDIS_PASSWORD|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS)/.test(key)) delete env[key];
    report.phase = 'fresh-dependencies'; save();
    const packages = target === 'macos' ? ['frontend', 'analyzers/ts-analyzer', 'desktop'] : ['desktop'];
    for (const directory of packages) npm(['ci', '--install-links', '--no-audit', '--no-fund'], path.join(source, directory), env);
    report.checks.push('fresh-source-dependencies');
    if (target === 'windows') {
      report.phase = 'standard-user-native-boundaries'; save();
      const { runWindows } = require('./native-acceptance-windows.cjs');
      await runWindows({ source, owned, artifacts, report, run, env });
      report.phase = 'windows-product-readiness-gate'; save();
      // Release packaging stays blocked; unsigned development acceptance runs independently.
      let blocked = false;
      try { await require(path.join(source, 'desktop', 'scripts', 'desktop-build-gate.cjs'))({ electronPlatformName: 'win32' }); }
      catch { blocked = true; }
      assert.ok(blocked, 'Windows product gate changed without product acceptance');
      const readiness = require(path.join(source, 'desktop', 'scripts', 'windows-readiness.cjs')).windowsReadiness();
      assert.equal(readiness.status, 'BLOCKED');
      report.releaseAcceptance = { status: 'BLOCKED', code: 'WINDOWS_RELEASE_NOT_VALIDATED', blockers: readiness.blockers };
      report.checks.push('windows-product-build-gate-remains-enforced');
      await require('./native-acceptance-windows-product.cjs').runWindowsProduct({ source, owned, artifacts, report, env, run,
        phase: name => { report.phase = name; save(); } });
      report.status = 'PASS'; report.phase = 'native-product-complete'; save();
      console.log('Windows native product acceptance passed; signed release gates remain enforced.');
      return;
    }
    report.phase = 'actual-runtime-stage'; save();
    run(process.execPath, ['scripts/stage-runtime.mjs'], path.join(source, 'desktop'), env, { buildDiagnostics: true, sourceRoot: source });
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'desktop', 'stage', 'runtime', 'runtime-manifest.json'), 'utf8'));
    assert.equal(String(manifest.buildSequence), report.buildSequence);
    assert.equal(manifest.platform, 'darwin'); assert.equal(manifest.arch, 'arm64');
    report.runtimeManifestSha256 = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    report.checks.push('current-source-runtime-stage');

    report.phase = 'real-electron-safe-storage-restart'; save();
    const { runProduct } = require('./native-acceptance-electron.cjs');
    await runProduct({ source, owned, artifacts, report, env, phase: name => { report.phase = name; save(); } });
    report.status = 'PASS'; report.phase = 'complete';
  } catch (error) {
    recordFailure(report, error);
    process.exitCode = 1;
  } finally { save(); }
  console.log(`Native acceptance: ${report.status}; phase=${report.phase}. Only credential-free evidence was retained.`);
}
module.exports = { included, requireHosted, copySource, run, buildDiagnostics, relocateMacLibraries, recordFailure, recordProvisioningFailure, main };
if (require.main === module) main(process.argv[2]).catch(() => { console.error('Native acceptance preflight refused.'); process.exitCode = 1; });
