'use strict';

// Static entry-point guard for G-COST: every provider-capable network path in shipped desktop code
// (desktop/src is the only packaged source tree) and in the renderer source must stay behind the
// single main-owned egress gateway. Adding a new network-capable module, provider host, transport
// composition or second send site fails here until it is reviewed and added to this inventory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '../..');
const desktopSource = path.join(repo, 'desktop/src');
const frontendSource = path.join(repo, 'frontend/src');
const read = file => fs.readFileSync(file, 'utf8');
const desktopFiles = fs.readdirSync(desktopSource).filter(name => name.endsWith('.cjs') || name.endsWith('.js') || name.endsWith('.mjs')).sort();

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}
const productFrontendFiles = walk(frontendSource).filter(file => !/(\.test\.|\.spec\.|[/\\]test[/\\])/.test(file));

const PROVIDER_HOSTS = ['api.openai.com', 'generativelanguage.googleapis.com', 'api.anthropic.com', 'api.mistral.ai',
  'api.cohere.ai', 'api.cohere.com', 'openai.azure.com', 'api.groq.com', 'api.together.xyz', 'openrouter.ai',
  'api.deepseek.com', 'bedrock-runtime', 'aiplatform.googleapis.com', 'api.x.ai'];
const NETWORK_MODULE = /require\(\s*['"](?:node:)?(https?|http2|net|tls|dgram|dns|undici)['"]\s*\)/g;

// Reviewed inventory: module -> network builtins it may load, and why.
const NETWORK_INVENTORY = Object.freeze({
  'adapter-control.cjs': { modules: ['net'], reason: 'private backend<->main analyzer control Unix-domain socket, capability-authenticated (ADR-01)' },
  'ai-https-transport.cjs': { modules: ['dns', 'https', 'net'], reason: 'sole provider transport: fixed api.openai.com HTTPS, DNS pinned to public answers' },
  'ai-egress-bridge.cjs': { modules: ['net'], reason: 'private backend<->main Unix-domain socket, capability-authenticated' },
  'main.cjs': { modules: ['net'], reason: 'loopback port reservation for bundled services' },
  'service-transport.cjs': { modules: ['https', 'tls'], reason: 'loopback TLS to bundled backend/analyzer with pinned per-run CA' },
  'source-broker.cjs': { modules: ['net'], reason: 'private source-vault Unix-domain socket' },
});

test('only reviewed desktop modules load network-capable builtins', () => {
  const observed = {};
  for (const name of desktopFiles) {
    const modules = [...new Set([...read(path.join(desktopSource, name)).matchAll(NETWORK_MODULE)].map(match => match[1]))].sort();
    if (modules.length) observed[name] = modules;
  }
  assert.deepEqual(observed, Object.fromEntries(Object.entries(NETWORK_INVENTORY).map(([name, value]) => [name, value.modules])));
});

test('desktop code has no fetch, WebSocket, Electron net or command-line HTTP client', () => {
  for (const name of desktopFiles) {
    const text = read(path.join(desktopSource, name));
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${name} must not call fetch`);
    assert.doesNotMatch(text, /new\s+WebSocket\b|EventSource\s*\(/, `${name} must not open a WebSocket/EventSource`);
    assert.doesNotMatch(text, /\bnet\.request\s*\(|session\.fetch|ClientRequest/, `${name} must not use Electron net`);
    assert.doesNotMatch(text, /['"`](?:\/usr\/bin\/)?(?:curl|wget)['"`]/, `${name} must not spawn curl/wget`);
    const electron = /const\s*\{([^}]*)\}\s*=\s*require\(['"]electron['"]\)/.exec(text);
    if (electron) assert.equal(electron[1].split(',').map(s => s.trim()).includes('net'), false, `${name} must not import Electron net`);
  }
});

test('provider hosts appear only in the fixed endpoint table and the sole transport', () => {
  const owners = {};
  for (const name of desktopFiles) {
    const text = read(path.join(desktopSource, name));
    const hosts = PROVIDER_HOSTS.filter(host => text.includes(host));
    if (hosts.length) owners[name] = hosts;
  }
  assert.deepEqual(owners, {
    'ai-egress.cjs': ['api.openai.com', 'generativelanguage.googleapis.com'],
    'ai-https-transport.cjs': ['api.openai.com'],
  });
  for (const file of productFrontendFiles) {
    const text = read(file);
    for (const host of PROVIDER_HOSTS) assert.equal(text.includes(host), false, `${path.relative(repo, file)} names ${host}`);
  }
});

test('the HTTPS transport is composed only by the private desktop gateway', () => {
  const users = desktopFiles.filter(name => read(path.join(desktopSource, name)).includes('createHttpsTransport'));
  assert.deepEqual(users, ['ai-desktop-gateway.cjs', 'ai-https-transport.cjs']);
  const gatewayUsers = desktopFiles.filter(name => read(path.join(desktopSource, name)).includes('openDesktopAiGateway'));
  assert.deepEqual(gatewayUsers, ['ai-desktop-gateway.cjs', 'main.cjs']);
  const coreUsers = desktopFiles.filter(name => /require\(['"]\.\/ai-egress\.cjs['"]\)/.test(read(path.join(desktopSource, name))));
  assert.deepEqual(coreUsers, ['ai-desktop-gateway.cjs']);
});

test('the egress core has exactly one transport call site, after the journal permit and final barrier', () => {
  const text = read(path.join(desktopSource, 'ai-egress.cjs'));
  const sends = [...text.matchAll(/options\.transport\s*\(/g)];
  assert.equal(sends.length, 1);
  const send = sends[0].index;
  const order = ['await committed(entry, \'RESERVED\')', 'await journal.reserveAndPermit(', 'await publish(\'DISPATCHED\'',
    'await committed(entry, \'DISPATCHED\')', 'await journal.consumePermit(permit)', 'ready(); currentContract(entry); if (epoch !== generation) fail(\'OFF\')'];
  let cursor = text.lastIndexOf('async function perform(', send);
  assert.ok(cursor > 0);
  for (const step of order) {
    const at = text.indexOf(step, cursor);
    assert.ok(at > cursor && at < send, `missing or misordered before the send: ${step}`);
    cursor = at;
  }
  // No await between the final barrier and the sole transport invocation.
  assert.doesNotMatch(text.slice(cursor, send).replace(/\/\/.*$/gm, ''), /\bawait\b|\.then\(/);
});

test('renderer bridges expose no AI or provider channel', () => {
  const preload = read(path.join(desktopSource, 'preload.cjs'));
  const exposed = /exposeInMainWorld\('codeIntelligenceDesktop', Object\.freeze\(\{([\s\S]*?)\}\)\)/.exec(preload);
  assert.ok(exposed);
  const keys = [...exposed[1].matchAll(/^\s*([A-Za-z]+)\s*:/gm)].map(match => match[1]).sort();
  assert.deepEqual(keys, ['apiBaseUrl', 'apiToken', 'appVersion', 'authorizeDroppedFolder', 'backup', 'openExternal',
    'pickFolder', 'platform', 'restartRuntime', 'restore', 'runtimeStatus']);
  const main = read(path.join(desktopSource, 'main.cjs'));
  const channels = [...main.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(channels, ['data:backup', 'data:restore', 'external:open', 'folder:authorize', 'folder:pick',
    'runtime:config', 'runtime:restart', 'runtime:status']);
  // External opening is limited to GitHub documentation origins, never a provider origin.
  assert.match(main, /new Set\(\['https:\/\/github\.com', 'https:\/\/docs\.github\.com'\]\)/);
});

test('renderer network calls are same-origin backend API calls only', () => {
  for (const file of productFrontendFiles) {
    const text = read(file);
    for (const match of text.matchAll(/\bfetch\s*\(\s*([^,)]*)/g)) {
      const target = match[1].trim();
      assert.ok(target.startsWith('resolveApiUrl(') || target.startsWith('`/api/'),
        `${path.relative(repo, file)} fetches ${target}`);
    }
    assert.doesNotMatch(text, /new\s+WebSocket\b|navigator\.sendBeacon|new\s+XMLHttpRequest/, path.relative(repo, file));
  }
});
