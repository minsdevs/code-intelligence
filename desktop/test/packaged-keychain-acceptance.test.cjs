'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { launchArguments, launchEnvironment, bounded, waitFor, closePackagedApplication,
  allProcessesExitedZero, attachMainProcess, importThroughFolderPicker } = require('../scripts/packaged-keychain-acceptance.cjs');

test('direct packaged launch cannot inherit provider secrets, Electron loader or mock-keychain hooks', () => {
  const original = { HOME: '/owned/home', USER: 'fixture', LANG: 'en_US.UTF-8', PATH: '/unreviewed',
    NODE_OPTIONS: '--require injected.cjs', NODE_PATH: '/injected', ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_EXTRA_LAUNCH_ARGS: '--use-mock-keychain', DYLD_INSERT_LIBRARIES: '/injected',
    GH_TOKEN: 'synthetic', OPENAI_API_KEY: 'synthetic', PGVECTOR_ROOT: '/old-extension' };
  const env = launchEnvironment(original);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'USER']);
  assert.equal(env.HOME, original.HOME); assert.equal(env.LC_ALL, 'C');
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(original.NODE_OPTIONS, '--require injected.cjs');
});

test('direct packaged arguments bind the generated claim and a loopback-only debugging port', () => {
  assert.deepEqual(launchArguments('/private/tmp/owned/.isolated-run.json', 41234), [
    '--isolated-run-claim=/private/tmp/owned/.isolated-run.json',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=41234',
  ]);
  for (const port of [0, 1024, 65536, 41234.5, '41234'])
    assert.throws(() => launchArguments('/private/tmp/owned/.isolated-run.json', port));
  for (const file of ['relative', '/private/tmp/claim\n--use-mock-keychain', '/private/tmp/claim\0'])
    assert.throws(() => launchArguments(file, 41234));
});

test('only the inspector-enabled launch adds a loopback-only main-process inspector port', () => {
  assert.deepEqual(launchArguments('/private/tmp/owned/.isolated-run.json', 41234, 41235), [
    '--isolated-run-claim=/private/tmp/owned/.isolated-run.json',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=41234', '--inspect=127.0.0.1:41235',
  ]);
  for (const inspect of [0, 1024, 65536, 41234, 41235.5, '41235'])
    assert.throws(() => launchArguments('/private/tmp/owned/.isolated-run.json', 41234, inspect));
});

// SEC-M-02 drop confirmation stays covered by run-product-candidate and the security probe. This
// runner imports through the product's own folder picker and never answers a drop confirmation.
const folder = '/private/tmp/cikr-fixture/keychain-fixture';
function syntheticMain() {
  const shown = [];
  const originalOpen = async (...args) => { shown.push(args); return { canceled: true, filePaths: [] }; };
  const originalMessage = async (...args) => { shown.push(args); return { response: 0 }; };
  const dialog = { showOpenDialog: originalOpen, showMessageBox: originalMessage };
  const main = {
    closed: 0, close() { main.closed++; },
    async evaluateHandle(fn, arg) {
      const value = new Function(`return (${fn.toString()})`)()({ dialog }, JSON.parse(JSON.stringify(arg)));
      return { evaluate: async inner => JSON.parse(JSON.stringify(inner(value))), dispose: async () => {} };
    },
  };
  const productPick = () => dialog.showOpenDialog({ synthetic: 'mainWindow' }, { title: 'Choose a source folder to analyze', properties: ['openDirectory'] });
  const productConfirm = () => dialog.showMessageBox({ synthetic: 'mainWindow' }, { type: 'question', buttons: ['Analyze folder', 'Cancel'],
    defaultId: 1, cancelId: 1, noLink: true, title: 'Analyze this folder?', message: 'Allow Code Intelligence to read this dropped folder?', detail: folder });
  return { main, dialog, originalOpen, originalMessage, shown, productPick, productConfirm };
}

test('the owned import uses the product folder picker once and needs no message-box answer', async () => {
  const s = syntheticMain(); let picked;
  const result = await importThroughFolderPicker(async () => s.main, folder, async () => { picked = await s.productPick(); });
  assert.deepEqual(picked, { canceled: false, filePaths: [folder] });
  assert.deepEqual(result, { importPath: 'folder-picker', pickerCalls: 1, messageBoxes: 0, dropDispatched: false });
  assert.equal(s.dialog.showOpenDialog, s.originalOpen); assert.equal(s.dialog.showMessageBox, s.originalMessage);
  assert.equal(s.main.closed, 1); assert.equal(s.shown.length, 0, 'no OS dialog was shown');
});

test('an unexpected drop confirmation during the import is refused and fails closed', async () => {
  const s = syntheticMain(); let answer;
  await assert.rejects(importThroughFolderPicker(async () => s.main, folder, async () => {
    await s.productPick(); answer = (await s.productConfirm()).response;
  }), /^Error: UNEXPECTED_DROP_CONFIRMATION$/);
  assert.equal(answer, 1); assert.equal(s.main.closed, 1); assert.equal(s.shown.length, 0);
});

test('without a main-process picker answer the import is never started', async () => {
  for (const attach of [async () => { throw new Error('ECONNREFUSED'); }, async () => null]) {
    let started = false;
    await assert.rejects(importThroughFolderPicker(attach, folder, async () => { started = true; }),
      /^Error: PACKAGED_FOLDER_PICKER_UNAVAILABLE$/);
    assert.equal(started, false);
  }
});

test('the runner dispatches no drop and installs no drop-confirmation answer', () => {
  const source = fs.readFileSync(require.resolve('../scripts/packaged-keychain-acceptance.cjs'), 'utf8');
  assert.doesNotMatch(source, /dispatchDragEvent|withDropConfirmation|drop-confirmation\.cjs|showMessageBox/);
  assert.match(source, /require\('\.\.\/\.\.\/validation\/pre-release\/folder-picker\.cjs'\)/);
});

// Synthetic inspector socket: answers the protocol messages the client sends, nothing else.
class FakeSocket extends EventTarget {
  constructor(url) {
    super(); FakeSocket.last = this; this.url = url; this.sent = []; this.closed = 0;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(text) {
    const message = JSON.parse(text); this.sent.push(message);
    const reply = FakeSocket.reply(message);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, ...reply }) })));
  }
  close() { this.closed++; }
}
const inspectorUrl = 'ws://127.0.0.1:41235/4b6f1c2e-6a1d-4c51-9a63-1f0e8d2b7c90';
const listed = async url => { assert.equal(url, 'http://127.0.0.1:41235/json/list'); return [{ type: 'node', webSocketDebuggerUrl: inspectorUrl }]; };

test('the main-process inspector client attaches to the one loopback target and evaluates by reference', async () => {
  FakeSocket.reply = ({ method, params }) => ({ result: method === 'Runtime.evaluate' ? { result: { objectId: 'electron' } }
    : method === 'Runtime.releaseObject' ? {} : params.returnByValue ? { result: { value: 1 } } : { result: { objectId: 'handle-1' } } });
  const main = await attachMainProcess(41235, { fetchJson: listed, WebSocketClass: FakeSocket });
  const handle = await main.evaluateHandle(function install({ dialog }, arg) { return [dialog, arg]; }, { selected: folder });
  assert.equal(await handle.evaluate(value => value.restore()), 1);
  await handle.dispose(); main.close();
  const socket = FakeSocket.last;
  assert.equal(socket.url, inspectorUrl); assert.equal(socket.closed, 1);
  assert.deepEqual(socket.sent.map(message => message.method),
    ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.callFunctionOn', 'Runtime.releaseObject']);
  assert.equal(socket.sent[0].params.expression, "require('electron')"); assert.equal(socket.sent[0].params.includeCommandLineAPI, true);
  assert.deepEqual(socket.sent[1].params.arguments, [{ objectId: 'electron' }, { value: { selected: folder } }]);
  assert.equal(socket.sent[2].params.objectId, 'handle-1'); assert.equal(socket.sent[2].params.returnByValue, true);
});

test('a main-process exception keeps its code and nothing else of its text', async () => {
  FakeSocket.reply = ({ method }) => ({ result: method === 'Runtime.evaluate' ? { result: { objectId: 'electron' } }
    : { exceptionDetails: { exception: { description: 'Error: FOLDER_PICKER_REPLACED\n    at restore (/owned/path)' } } } });
  const main = await attachMainProcess(41235, { fetchJson: listed, WebSocketClass: FakeSocket });
  await assert.rejects(main.evaluateHandle(() => {}, null), /^Error: FOLDER_PICKER_REPLACED$/);
  FakeSocket.reply = () => ({ result: { exceptionDetails: { exception: { description: 'TypeError: /owned/path is secret' } } } });
  await assert.rejects(main.evaluateHandle(() => {}, null), /^Error: MAIN_PROCESS_EVALUATION_FAILED$/);
  main.close();
});

test('a missing, remote or ambiguous inspector target leaves the picker path unavailable', async () => {
  FakeSocket.reply = () => ({ result: { result: { objectId: 'electron' } } });
  for (const fetchJson of [async () => [], async () => ({ webSocketDebuggerUrl: inspectorUrl }),
    async () => [{ webSocketDebuggerUrl: 'ws://0.0.0.0:41235/4b6f1c2e-6a1d-4c51-9a63-1f0e8d2b7c90' }],
    async () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:41236/4b6f1c2e-6a1d-4c51-9a63-1f0e8d2b7c90' }],
    async () => [{ webSocketDebuggerUrl: inspectorUrl }, { webSocketDebuggerUrl: inspectorUrl }],
    async () => { throw new Error('ECONNREFUSED'); }])
    await assert.rejects(attachMainProcess(41235, { fetchJson, WebSocketClass: FakeSocket, timeoutMs: 50 }),
      /^Error: PACKAGED_FOLDER_PICKER_UNAVAILABLE$/);
});

// In-memory process and CDP doubles only. No executable, profile, key or bundle is opened.
function fakeChild(pid = 43201) {
  const child = new EventEmitter();
  child.pid = pid; child.exitCode = null; child.signalCode = null; child.signals = [];
  child.finish = (code, signal = null) => {
    child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
  };
  child.kill = signal => { child.signals.push(signal); return false; };
  return child;
}
const limits = { requestTimeoutMs: 5, normalExitTimeoutMs: 10, killGraceMs: 5 };
const pending = () => new Promise(() => {});

test('a pending CDP operation and a pending polling action have external deadlines', { timeout: 1000 }, async () => {
  await assert.rejects(bounded(pending, 5, 'CDP_TIMEOUT'), /CDP_TIMEOUT/);
  await assert.rejects(waitFor(pending, 5, 'POLL_TIMEOUT'), /POLL_TIMEOUT/);
});

test('normal window close records only observed exit zero and sends no process signal', { timeout: 1000 }, async () => {
  const child = fakeChild(); let disconnects = 0;
  const result = await closePackagedApplication({ child, closeWindow: async () => child.finish(0),
    quitApplication: () => assert.fail('OS fallback must not run'), disconnect: async () => { disconnects++; } }, limits);
  assert.equal(result.pid, child.pid); assert.equal(result.normalWindowCloseRequested, true);
  assert.equal(result.normalApplicationQuitRequested, false); assert.equal(result.terminationConfirmed, true);
  assert.equal(result.processExitedZero, true); assert.equal(result.disconnected, true);
  assert.deepEqual(result.errors, []); assert.deepEqual(child.signals, []); assert.equal(disconnects, 1);
  assert.equal(child.listenerCount('exit'), 0); assert.equal(Object.hasOwn(result, 'cleanExit'), false);
});

test('before CDP attachment, the owned application quit request still awaits actual exit', { timeout: 1000 }, async () => {
  const child = fakeChild(); let requests = 0;
  const result = await closePackagedApplication({ child,
    quitApplication: async () => { requests++; child.finish(0); } }, limits);
  assert.equal(requests, 1); assert.equal(result.normalWindowCloseRequested, false);
  assert.equal(result.normalApplicationQuitRequested, true); assert.equal(result.processExitedZero, true);
  assert.deepEqual(child.signals, []); assert.deepEqual(result.errors, []);
});

test('a hung window close cannot prevent PID quit fallback or hide the failed request', { timeout: 1000 }, async () => {
  const child = fakeChild();
  const result = await closePackagedApplication({ child, closeWindow: pending,
    quitApplication: async () => child.finish(0) }, limits);
  assert.equal(result.normalWindowCloseRequested, true); assert.equal(result.normalApplicationQuitRequested, true);
  assert.equal(result.terminationConfirmed, true); assert.equal(result.processExitedZero, true);
  assert(result.errors.includes('PACKAGE_WINDOW_CLOSE_TIMEOUT')); assert.deepEqual(child.signals, []);
});

test('ignored SIGTERM escalates to SIGKILL and waits for its exit event', { timeout: 1000 }, async () => {
  const child = fakeChild();
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => child.finish(null, signal));
    return true;
  };
  const result = await closePackagedApplication({ child, quitApplication: async () => {} }, limits);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']); assert.deepEqual(result.signalsRequested, child.signals);
  assert.equal(result.terminationConfirmed, true); assert.equal(result.signalCode, 'SIGKILL');
  assert.equal(result.processExitedZero, false); assert(result.errors.length > 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('a synchronous SIGTERM failure still permits owned SIGKILL and exit confirmation', { timeout: 1000 }, async () => {
  const child = fakeChild();
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGTERM') throw new Error('synthetic signal failure');
    queueMicrotask(() => child.finish(null, signal)); return true;
  };
  const result = await closePackagedApplication({ child, quitApplication: async () => {} }, limits);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']); assert.equal(result.terminationConfirmed, true);
  assert.equal(result.processExitedZero, false); assert(result.errors.length > 0);
});

test('signals without exit evidence leave termination explicitly unconfirmed', { timeout: 1000 }, async () => {
  const child = fakeChild();
  const result = await closePackagedApplication({ child, quitApplication: async () => {} }, limits);
  assert.deepEqual(result.signalsRequested, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.terminationConfirmed, false); assert.equal(result.processExitedZero, false);
  assert.equal(result.exitCode, null); assert.equal(result.signalCode, null); assert(result.errors.length > 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('a failed spawn never signals an undefined PID or reports process exit zero', { timeout: 1000 }, async () => {
  const child = fakeChild(); child.pid = undefined; child.exitCode = -2;
  const result = await closePackagedApplication({ child,
    quitApplication: () => assert.fail('No process was spawned') }, limits);
  assert.equal(result.pid, null); assert.equal(result.processExitedZero, false);
  assert.equal(result.terminationConfirmed, false); assert.deepEqual(child.signals, []);
  assert.deepEqual(result.errors, ['PACKAGE_NOT_SPAWNED']);
});

test('a hung CDP disconnect is bounded after the owned process has already stopped', { timeout: 1000 }, async () => {
  const child = fakeChild();
  const result = await closePackagedApplication({ child, closeWindow: async () => child.finish(0), disconnect: pending }, limits);
  assert.equal(result.terminationConfirmed, true); assert.equal(result.processExitedZero, true);
  assert.equal(result.disconnected, false); assert(result.errors.includes('PACKAGE_CDP_DISCONNECT_TIMEOUT'));
  assert.deepEqual(child.signals, []);
});

test('the second nonzero process exit remains visible to aggregate reporting', { timeout: 1000 }, async () => {
  const first = fakeChild(43201), second = fakeChild(43202);
  first.finish(0); second.finish(1);
  const firstResult = { ...await closePackagedApplication({ child: first }, limits), launch: 1 };
  const secondResult = { ...await closePackagedApplication({ child: second }, limits), launch: 2 };
  const launches = [{ sequence: 1, pid: first.pid }, { sequence: 2, pid: second.pid }];
  assert.equal(secondResult.pid, second.pid); assert.equal(secondResult.exitCode, 1);
  assert.equal(secondResult.terminationConfirmed, true); assert.equal(secondResult.processExitedZero, false);
  assert.equal(allProcessesExitedZero(launches, [firstResult, secondResult]), false);
  assert.equal(allProcessesExitedZero(launches, [firstResult]), false);
  assert.equal(allProcessesExitedZero([], []), false);
  assert.equal(allProcessesExitedZero([launches[0]], [firstResult]), true);
  assert.equal(allProcessesExitedZero([launches[0]], [{ ...firstResult, pid: 99999 }]), false);
});
