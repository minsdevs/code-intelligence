'use strict';

// SEC-M-02 runner adaptation: a dropped folder is answered once in the SDK-owned main process and the
// single request must name the canonical dropped path. Synthetic Electron double; temporary folders only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DROP_CONFIRMATION, withDropConfirmation } = require('../drop-confirmation.cjs');

// Mirrors Playwright: the installer is serialized and run against the main process' electron module.
function syntheticApp() {
  const shown = [];
  const original = async (...args) => { shown.push(args); return { response: 1 }; };
  const dialog = { showMessageBox: original };
  const app = {
    disposed: 0,
    async evaluateHandle(fn, arg) {
      // Rebuilt from its source text: proves the installer is self-contained once serialized.
      const value = new Function(`return (${fn.toString()})`)()({ dialog }, JSON.parse(JSON.stringify(arg)));
      return { evaluate: async inner => JSON.parse(JSON.stringify(inner(value))), dispose: async () => { app.disposed++; } };
    },
  };
  // What desktop/src/main.cjs authorizeDroppedPath asks for the canonical folder.
  const productConfirm = canonical => dialog.showMessageBox({ synthetic: 'mainWindow' }, { type: 'question', buttons: ['Analyze folder', 'Cancel'],
    defaultId: 1, cancelId: 1, noLink: true, title: 'Analyze this folder?', message: 'Allow Code Intelligence to read this dropped folder?', detail: canonical });
  return { app, dialog, original, shown, productConfirm };
}

function folders(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drop-confirmation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'project'), link = path.join(root, 'link');
  fs.mkdirSync(real); fs.symlinkSync(real, link);
  return { real, link };
}

test('the single product confirmation for the canonical dropped folder is accepted and recorded', async t => {
  const { real, link } = folders(t);
  const s = syntheticApp();
  const { result, confirmation } = await withDropConfirmation(s.app, link, async () => (await s.productConfirm(real)).response);
  assert.equal(result, 0, 'the product saw the accepting answer');
  assert.deepEqual(confirmation, { requests: 1, accepted: true, canonicalPath: real, title: 'Analyze this folder?', defaultAnswerRefuses: true });
  assert.equal(s.dialog.showMessageBox, s.original, 'the main-process dialog is restored');
  assert.equal(s.app.disposed, 1);
  assert.equal(s.shown.length, 0, 'no OS dialog was shown');
});

test('a confirmation that was never requested fails instead of passing silently', async t => {
  const { real } = folders(t);
  const s = syntheticApp();
  await assert.rejects(withDropConfirmation(s.app, real, async () => 'no dialog'), /^Error: DROP_CONFIRMATION_NOT_REQUESTED$/);
  assert.equal(s.dialog.showMessageBox, s.original);
});

test('a repeated confirmation is refused the second time and fails the run', async t => {
  const { real } = folders(t);
  const s = syntheticApp();
  let answers;
  await assert.rejects(withDropConfirmation(s.app, real, async () => {
    answers = [(await s.productConfirm(real)).response, (await s.productConfirm(real)).response];
  }), /^Error: DROP_CONFIRMATION_REPEATED$/);
  assert.deepEqual(answers, [0, 1]);
});

test('a confirmation for another path, or with changed wording or default, is refused', async t => {
  const { real } = folders(t);
  for (const change of [
    options => ({ ...options, detail: path.dirname(real) }),
    options => ({ ...options, defaultId: 0 }),
    options => ({ ...options, title: 'Analyze?' }),
  ]) {
    const s = syntheticApp();
    let answer;
    await assert.rejects(withDropConfirmation(s.app, real, async () => {
      const expected = { type: 'question', buttons: ['Analyze folder', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        title: DROP_CONFIRMATION.title, message: DROP_CONFIRMATION.message, detail: real };
      answer = (await s.dialog.showMessageBox({ synthetic: 'mainWindow' }, change(expected))).response;
    }), /^Error: DROP_CONFIRMATION_MISMATCH$/);
    assert.equal(answer, 1, 'the refusing default answer was returned');
  }
});

test('an action failure stays primary and the dialog is still restored', async t => {
  const { real } = folders(t);
  const s = syntheticApp();
  await assert.rejects(withDropConfirmation(s.app, real, async () => { throw new Error('PREVIEW_TIMEOUT'); }), /^Error: PREVIEW_TIMEOUT$/);
  assert.equal(s.dialog.showMessageBox, s.original);
  assert.equal(s.app.disposed, 1);
});
