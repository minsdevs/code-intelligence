'use strict';

// ADR-01 adapter supervisor packaging (macOS). Builds the XPC service and the bridge from
// desktop/native/adapter-supervisor, assembles the service bundle with its workers inside it (exec
// outside the service bundle is denied by the sandbox), signs it inner-first and returns the hashes
// main attests at startup. The worker Node runtime is a separate copy of the licensed Electron
// already supplied to the app, with its own fuse wire, so the app binary can keep RunAsNode off.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { isMachOHeader } = require('./native-runtime-policy.cjs');

const NATIVE = path.join(__dirname, '..', 'native', 'adapter-supervisor');
const SERVICE = 'AdapterSupervisor.xpc';
const SERVICE_DIRECTORY = path.posix.join('XPCServices', SERVICE);
const SUPERVISOR = path.posix.join(SERVICE_DIRECTORY, 'Contents', 'MacOS', 'AdapterSupervisor');
const BRIDGE = path.posix.join('MacOS', 'adapter-bridge');
const WORKER_NODE = 'MacOS/adapter-node';
const ANALYZER = 'Resources/ts-analyzer';
const ELECTRON_FRAMEWORKS = Object.freeze(['Electron Framework', 'Mantle', 'ReactiveObjC', 'Squirrel']);
// The worker copy runs only as Node: no NODE_OPTIONS and no inspector, argv and env are fixed by
// the supervisor's signed table.
const WORKER_FUSES = Object.freeze({ runAsNode: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false });
const MINIMUM_SYSTEM_VERSION = '13.0';

function reject(code) { throw Object.assign(new Error(code), { code }); }
function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
    maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, ...options });
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

/** Compiles the service and bridge (and the test-only probe) for arm64, macOS 13 or later. */
function compile(output, { probe = false } = {}) {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const sdk = run('/usr/bin/xcrun', ['--show-sdk-path']).trim();
  const clang = (target, sources, frameworks) => run('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Werror', '-arch', 'arm64',
    `-mmacosx-version-min=${MINIMUM_SYSTEM_VERSION}`, '-isysroot', sdk, '-o', path.join(output, target),
    ...sources.map(source => path.join(NATIVE, source)), ...frameworks.flatMap(name => ['-framework', name])]);
  clang('AdapterSupervisor', ['supervisor.c'], ['CoreFoundation']);
  clang('adapter-bridge', ['bridge.c'], ['CoreFoundation']);
  if (probe) clang('probe', ['test/probe.c'], []);
  return output;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}
function plistValue(value, indent) {
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`;
  if (Array.isArray(value)) return `<array>${value.map(item => plistValue(item, indent)).join('')}</array>`;
  if (value && typeof value === 'object') {
    const inner = Object.entries(value).map(([key, item]) => `${indent}  <key>${escapeXml(key)}</key>${plistValue(item, indent + '  ')}`);
    return `<dict>\n${inner.join('\n')}\n${indent}</dict>`;
  }
  reject('ADAPTER_PLIST_VALUE_UNSUPPORTED');
}
function infoPlist(entries) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">${plistValue(entries, '')}</plist>\n`;
}

/** Writes the service Info.plist. Workers and the peer requirement are filled in at signing time. */
function serviceInfo({ appId, version, workers = {}, peerRequirement = '' }) {
  return infoPlist({
    CFBundleDevelopmentRegion: 'en', CFBundleExecutable: 'AdapterSupervisor', CFBundleIdentifier: `${appId}.adapter-supervisor`,
    CFBundleInfoDictionaryVersion: '6.0', CFBundleName: 'AdapterSupervisor', CFBundlePackageType: 'XPC!',
    CFBundleShortVersionString: version, CFBundleVersion: version, LSMinimumSystemVersion: MINIMUM_SYSTEM_VERSION,
    XPCService: { ServiceType: 'Application' },
    CodeIntelligencePeerRequirement: peerRequirement, CodeIntelligenceWorkers: workers,
  });
}

/** The product table has exactly the TypeScript analyzer; a test stage may add denial probes. */
function workerTable(contents, { testWorkers = false } = {}) {
  const entry = (executable, script, environment) => ({
    executable, sha256: sha256(path.join(contents, executable)),
    ...(script ? { script, scriptSha256: sha256(path.join(contents, script)) } : {}),
    ...(environment ? { environment } : {}),
  });
  const node = { ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', LANG: 'C', LC_ALL: 'C' };
  const table = { 'ts-analyzer': entry(WORKER_NODE, `${ANALYZER}/dist/stdio.js`, node) };
  if (testWorkers) {
    table.probe = entry('Resources/test/probe', null, { LANG: 'C' });
    table['node-probe'] = entry(WORKER_NODE, 'Resources/test/node-probe.cjs', node);
  }
  return table;
}

function cloneTree(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // APFS clone, preserving the framework symlinks that codesign requires.
  run('/bin/cp', ['-cRP', source, destination]);
}

async function flipWorkerFuses(contents) {
  const builder = require('node:module').createRequire(require.resolve('app-builder-lib/package.json'));
  const { flipFuses, FuseVersion, FuseV1Options } = builder('@electron/fuses');
  const options = { runAsNode: FuseV1Options.RunAsNode, enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments };
  const config = { version: FuseVersion.V1 };
  for (const [name, value] of Object.entries(WORKER_FUSES)) config[options[name]] = value;
  await flipFuses(path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Electron Framework'), config);
}

/**
 * Assembles <destination>/AdapterSupervisor.xpc from the compiled binaries, the Electron app the
 * desktop is built with, and the staged ts-analyzer. Nothing is signed yet.
 */
async function assembleService({ destination, binaries, electronApp, analyzer, appId, version, testWorkers = false }) {
  const bundle = path.join(destination, SERVICE), contents = path.join(bundle, 'Contents');
  if (fs.existsSync(bundle)) reject('ADAPTER_SERVICE_EXISTS');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.copyFileSync(path.join(binaries, 'AdapterSupervisor'), path.join(contents, 'MacOS', 'AdapterSupervisor'));
  fs.chmodSync(path.join(contents, 'MacOS', 'AdapterSupervisor'), 0o755);
  const electronContents = path.join(electronApp, 'Contents');
  const stub = fs.readdirSync(path.join(electronContents, 'MacOS'));
  if (stub.length !== 1) reject('ADAPTER_ELECTRON_LAYOUT');
  run('/bin/cp', ['-c', path.join(electronContents, 'MacOS', stub[0]), path.join(contents, WORKER_NODE)]);
  for (const name of ELECTRON_FRAMEWORKS) cloneTree(path.join(electronContents, 'Frameworks', `${name}.framework`), path.join(contents, 'Frameworks', `${name}.framework`));
  cloneTree(analyzer, path.join(contents, ANALYZER));
  if (testWorkers) {
    fs.mkdirSync(path.join(contents, 'Resources', 'test'), { recursive: true });
    fs.copyFileSync(path.join(binaries, 'probe'), path.join(contents, 'Resources', 'test', 'probe'));
    fs.chmodSync(path.join(contents, 'Resources', 'test', 'probe'), 0o755);
    fs.copyFileSync(path.join(NATIVE, 'test', 'node-probe.cjs'), path.join(contents, 'Resources', 'test', 'node-probe.cjs'));
  }
  await flipWorkerFuses(contents);
  fs.writeFileSync(path.join(contents, 'Info.plist'), serviceInfo({ appId, version }));
  return bundle;
}

/** Places the assembled service and the bridge into a packed app (afterPack, before signing). */
function installService({ app, stage }) {
  const contents = path.join(app, 'Contents');
  if (fs.existsSync(path.join(contents, SERVICE_DIRECTORY)) || fs.existsSync(path.join(contents, BRIDGE))) reject('ADAPTER_SERVICE_EXISTS');
  cloneTree(path.join(stage, SERVICE), path.join(contents, SERVICE_DIRECTORY));
  run('/bin/cp', ['-c', path.join(stage, 'bin', 'adapter-bridge'), path.join(contents, BRIDGE)]);
}

function machOFiles(root) {
  const result = [], header = Buffer.alloc(4);
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile()) continue;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { if (fs.readSync(fd, header, 0, 4, 0) === 4 && isMachOHeader(header)) result.push(file); } finally { fs.closeSync(fd); }
    }
  };
  visit(root);
  // Deepest first: nested code is signed before the code that seals it.
  return result.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b));
}

/**
 * Signs the service inner-first and the bridge, seals the worker table and the bridge's code
 * requirement into the service Info.plist, and returns the manifest section main attests.
 * Ad-hoc signatures pin the bridge by CDHash; a Developer ID signature pins it by Team ID.
 */
function signService({ app, identity, keychain, appId, version, testWorkers = false }) {
  if (process.platform !== 'darwin') reject('MAC_SIGNING_REQUIRES_MACOS');
  if (!identity) reject('MAC_SIGNING_IDENTITY_REQUIRED');
  const contents = path.join(app, 'Contents'), bundle = path.join(contents, SERVICE_DIRECTORY);
  const serviceContents = path.join(bundle, 'Contents');
  const sign = (file, { entitlements, runtime = true, identifier } = {}) => {
    const args = ['--force', '--sign', identity, identity === '-' ? '--timestamp=none' : '--timestamp'];
    if (runtime) args.push('--options', 'runtime');
    if (entitlements) args.push('--entitlements', path.join(NATIVE, 'entitlements', entitlements), '--generate-entitlement-der');
    if (identifier) args.push('--identifier', identifier);
    if (keychain) args.push('--keychain', keychain);
    run('/usr/bin/codesign', [...args, file]);
  };
  for (const name of ELECTRON_FRAMEWORKS) {
    const framework = path.join(serviceContents, 'Frameworks', `${name}.framework`);
    const versions = path.join(framework, 'Versions');
    for (const file of machOFiles(versions)) {
      if (path.basename(file) === name && path.dirname(path.dirname(file)) === versions) continue;
      sign(file);
    }
    sign(framework);
  }
  // An ad-hoc signature has no Team ID, so library validation would reject the worker's own
  // Electron framework; a Developer ID signature keeps library validation on.
  sign(path.join(serviceContents, WORKER_NODE), { entitlements: identity === '-' ? 'worker-adhoc.plist' : 'worker.plist',
    identifier: `${appId}.adapter-node` });
  if (testWorkers) sign(path.join(serviceContents, 'Resources', 'test', 'probe'), { entitlements: 'worker-native.plist', identifier: `${appId}.adapter-probe` });
  const bridge = path.join(contents, BRIDGE), bridgeIdentifier = `${appId}.adapter-bridge`;
  sign(bridge, { entitlements: 'bridge.plist', identifier: bridgeIdentifier });
  // codesign -d prints the signature details on stderr.
  const verbose = spawnText('/usr/bin/codesign', ['-d', '--verbose=4', bridge]);
  const team = verbose.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
  const cdhash = verbose.match(/^CDHash=([0-9a-f]{40})$/m)?.[1];
  let peerRequirement;
  if (identity === '-') {
    if (!cdhash) reject('ADAPTER_BRIDGE_CDHASH_MISSING');
    peerRequirement = `identifier "${bridgeIdentifier}" and cdhash H"${cdhash}"`;
  } else {
    if (!team) reject('ADAPTER_BRIDGE_TEAM_MISSING');
    peerRequirement = `anchor apple generic and identifier "${bridgeIdentifier}" and certificate leaf[subject.OU] = "${team}"`;
  }
  fs.writeFileSync(path.join(serviceContents, 'Info.plist'),
    serviceInfo({ appId, version, peerRequirement, workers: workerTable(serviceContents, { testWorkers }) }));
  sign(bundle, { entitlements: 'supervisor.plist' });
  run('/usr/bin/codesign', ['--verify', '--strict', '--deep', bundle]);
  run('/usr/bin/codesign', ['--verify', '--strict', bridge]);
  return { format: 1, supervisorSha256: sha256(path.join(contents, SUPERVISOR)), bridgeSha256: sha256(bridge) };
}

function spawnText(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, timeout: 60000 });
  if (result.status !== 0) reject('ADAPTER_CODESIGN_DETAILS_FAILED');
  return `${result.stdout}\n${result.stderr}`;
}

module.exports = {
  ANALYZER, BRIDGE, ELECTRON_FRAMEWORKS, SERVICE, SERVICE_DIRECTORY, SUPERVISOR, WORKER_FUSES, WORKER_NODE,
  assembleService, compile, installService, serviceInfo, signService, workerTable,
};
