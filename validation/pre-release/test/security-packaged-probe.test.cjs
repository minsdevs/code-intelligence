'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fuseFailures, rendererCspFailures } = require('../security-packaged-probe.cjs');

const POLICY = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; "
  + "style-src 'self' 'unsafe-inline'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const hardened = { documentCsp: POLICY, injectedInlineScriptRan: false, evalAllowed: false, crossOriginFetch: 'blocked',
  listenerReceived: [{ method: 'GET', path: '/', tokenHeaderPresent: false, originHeader: null }] };

test('SEC-M-01 renderer expectations pass only for a delivered policy that blocked every renderer attack', () => {
  assert.deepEqual(rendererCspFailures(hardened), []);
});

test('the LA8ZS9-era renderer outcome (no CSP, inline script, eval and exfiltration worked) fails every expectation', () => {
  const observed = { documentCsp: null, injectedInlineScriptRan: true, evalAllowed: true, crossOriginFetch: 'sent',
    listenerReceived: [{ method: 'GET', path: '/renderer-fetch' }, { method: 'GET', path: '/renderer-image' }] };
  assert.deepEqual(rendererCspFailures(observed), ['DOCUMENT_CSP_MISSING', 'INLINE_SCRIPT_RAN', 'EVAL_ALLOWED',
    'CROSS_ORIGIN_FETCH_SENT', 'RENDERER_REQUEST_REACHED_LISTENER']);
});

test('a delivered but permissive policy is not accepted', () => {
  for (const [policy, failure] of [
    [POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), 'SCRIPT_SRC_NOT_SELF_ONLY'],
    [POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), 'SCRIPT_SRC_NOT_SELF_ONLY'],
    [POLICY.replace("connect-src 'self'", 'connect-src *'), 'CONNECT_SRC_NOT_SELF_ONLY'],
    [POLICY.replace("default-src 'self'; script-src 'self'; ", ''), 'SCRIPT_SRC_NOT_SELF_ONLY'],
    [POLICY.replace("object-src 'none'", "object-src 'self'"), 'OBJECT_SRC_NOT_NONE'],
  ]) assert.deepEqual(rendererCspFailures({ ...hardened, documentCsp: policy }), [failure], policy);
});

test('a missing renderer record fails closed', () => {
  assert.deepEqual(rendererCspFailures(undefined), ['RENDERER_NOT_PROBED']);
});

const LA8ZS9_FUSES = { RunAsNode: 'ENABLE', EnableCookieEncryption: 'DISABLE', EnableNodeOptionsEnvironmentVariable: 'ENABLE',
  EnableNodeCliInspectArguments: 'ENABLE', EnableEmbeddedAsarIntegrityValidation: 'DISABLE', OnlyLoadAppFromAsar: 'DISABLE',
  LoadBrowserProcessSpecificV8Snapshot: 'DISABLE', GrantFileProtocolExtraPrivileges: 'ENABLE' };
const HOOKED_FUSES = { ...LA8ZS9_FUSES, EnableCookieEncryption: 'ENABLE', EnableNodeOptionsEnvironmentVariable: 'DISABLE',
  EnableEmbeddedAsarIntegrityValidation: 'ENABLE', OnlyLoadAppFromAsar: 'ENABLE', GrantFileProtocolExtraPrivileges: 'DISABLE' };

test('SEC-M-04 fuse expectations: the as-built LA8ZS9 wire fails, the afterPack wire of a validation build passes', () => {
  assert.deepEqual(fuseFailures(LA8ZS9_FUSES, {}), ['FUSE_EnableCookieEncryption_DISABLE', 'FUSE_EnableNodeOptionsEnvironmentVariable_ENABLE',
    'FUSE_EnableEmbeddedAsarIntegrityValidation_DISABLE', 'FUSE_OnlyLoadAppFromAsar_DISABLE', 'FUSE_GrantFileProtocolExtraPrivileges_ENABLE']);
  // A validation candidate keeps --inspect for Playwright; RunAsNode stays while the legacy-http flag is set.
  assert.deepEqual(fuseFailures(HOOKED_FUSES, {}), []);
  assert.deepEqual(fuseFailures(HOOKED_FUSES, { adapterIsolation: 'xpc-required' }), ['FUSE_RunAsNode_ENABLE']);
  assert.deepEqual(fuseFailures({ ...HOOKED_FUSES, RunAsNode: 'DISABLE' }, { adapterIsolation: 'xpc-required' }), []);
  assert.deepEqual(fuseFailures(undefined, {}), ['FUSES_NOT_READ']);
});

// The 9lVRha security probe hung for an hour: with RunAsNode off, `<app binary> -e ...` started the app,
// and a synchronous spawn waited on it. Each node-mode probe is now bounded and kills only its own group.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { boundedNodeProbe, effectiveNodeModes, nodeModeFailures } = require('../security-packaged-probe.cjs');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a node-mode probe that does not exit is killed with its own process group at the bound', async () => {
  // The leader and its background child both outlive the bound; the child also holds the stdout pipe.
  const result = await boundedNodeProbe('/bin/sh', ['-c', 'sleep 30 & echo "$!"; wait'], { env: { PATH: '/usr/bin:/bin' }, cwd: os.tmpdir(), timeoutMs: 500 });
  assert.equal(result.timedOut, true); assert.equal(result.signal, 'SIGKILL'); assert.equal(result.error, null);
  assert.ok(result.elapsedMs < 5000, `bounded, took ${result.elapsedMs} ms`);
  const background = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(background) && background > 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(background), false, 'the started group was killed, not only its leader');
});

test('a probe whose pipe is held by a survivor still finishes shortly after the started child exits', async t => {
  const result = await boundedNodeProbe('/bin/sh', ['-c', 'sleep 30 & echo "$!"'], { env: { PATH: '/usr/bin:/bin' }, cwd: os.tmpdir(), timeoutMs: 20000 });
  const background = Number(result.stdout.trim());
  t.after(() => { try { process.kill(background, 'SIGKILL'); } catch { /* already gone */ } });
  assert.equal(result.timedOut, false); assert.equal(result.status, 0);
  assert.ok(result.elapsedMs < 5000, `did not wait for the survivor, took ${result.elapsedMs} ms`);
});

test('a probe that cannot start reports the spawn error instead of throwing or hanging', async () => {
  const result = await boundedNodeProbe('/nonexistent/binary', [], { env: {}, cwd: os.tmpdir(), timeoutMs: 1000 });
  assert.equal(result.error, 'ENOENT'); assert.equal(result.timedOut, false);
});

test('node-mode probes ask for Node mode and name an absent isolated-run claim after --', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'node-mode-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const calls = [];
  const probe = async (executable, args, options) => {
    calls.push({ executable, args, env: options.env });
    return { status: 1, signal: null, timedOut: false, error: null, elapsedMs: 5, stdout: '', stderr: '[desktop] isolated validation refused: ISOLATED_RUN_INVALID\n' };
  };
  const modes = await effectiveNodeModes('/synthetic/app', scratch, probe);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(call.args[0], '-e');
    assert.deepEqual(call.args.slice(-2), ['--', '--isolated-run-claim=' + path.join(scratch, 'absent-claim.json')]);
    assert.equal(fs.existsSync(path.join(scratch, 'absent-claim.json')), false);
  }
  assert.match(calls[1].env.NODE_OPTIONS, /^--require /);
  assert.equal(modes.runAsNodeHonored, false); assert.equal(modes.nodeOptionsRequireHonored, false);
  assert.equal(modes.probes.runAsNode.appModeRefused, true);
});

test('ADR-01 node-mode expectations: RunAsNode off must refuse the script, NODE_OPTIONS is never honored', () => {
  const xpc = { adapterIsolation: 'xpc-required' };
  const outcome = (fields = {}) => ({ status: 1, signal: null, timedOut: false, error: null, elapsedMs: 5, appModeRefused: true, ...fields });
  const refused = { runAsNodeHonored: false, runAsNodeElectron: null, nodeOptionsRequireHonored: false,
    probes: { runAsNode: outcome(), nodeOptions: outcome() } };
  assert.deepEqual(nodeModeFailures(refused, xpc), []);
  assert.deepEqual(nodeModeFailures({ ...refused, runAsNodeHonored: true, runAsNodeElectron: '38.0.0' }, xpc), ['RUN_AS_NODE_HONORED']);
  assert.deepEqual(nodeModeFailures({ ...refused, nodeOptionsRequireHonored: true }, xpc), ['NODE_OPTIONS_REQUIRE_HONORED']);
  // A bound that ran out without the app's own refusal is not evidence that the script was refused.
  assert.deepEqual(nodeModeFailures({ ...refused, probes: { runAsNode: outcome({ timedOut: true, signal: 'SIGKILL', status: -1, appModeRefused: false }),
    nodeOptions: outcome() } }, xpc), ['RUN_AS_NODE_REFUSAL_UNOBSERVED']);
  assert.deepEqual(nodeModeFailures({ ...refused, probes: { runAsNode: outcome({ error: 'ENOENT', appModeRefused: false }), nodeOptions: outcome() } }, xpc),
    ['NODE_MODE_runAsNode_PROBE_ERROR', 'RUN_AS_NODE_REFUSAL_UNOBSERVED']);
  // legacy-http keeps RunAsNode for the analyzer sidecar, so the script must run there.
  const legacy = { ...refused, runAsNodeHonored: true, runAsNodeElectron: '38.0.0',
    probes: { runAsNode: outcome({ status: 0, appModeRefused: false }), nodeOptions: outcome({ status: 0, appModeRefused: false }) } };
  assert.deepEqual(nodeModeFailures(legacy, {}), []);
  assert.deepEqual(nodeModeFailures(refused, {}), ['RUN_AS_NODE_NOT_HONORED']);
  assert.deepEqual(nodeModeFailures(undefined, xpc), ['NODE_MODES_NOT_PROBED']);
});
