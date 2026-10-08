'use strict';

// Folder import through the product's own picker: the one "Choose a source folder" dialog is answered
// once in the main process, and any message box in that window is refused and fails the run.
// Synthetic Electron double only; no OS dialog, app or profile is opened.
const assert = require('node:assert/strict');
const test = require('node:test');
const { FOLDER_PICKER, withFolderPicker } = require('../folder-picker.cjs');

const folder = '/private/tmp/folder-picker-fixture/project';

// Mirrors Playwright: the installer is serialized and run against the main process' electron module.
function syntheticApp() {
  const shown = [];
  const originalOpen = async (...args) => { shown.push(['open', args]); return { canceled: true, filePaths: [] }; };
  const originalMessage = async (...args) => { shown.push(['message', args]); return { response: 0 }; };
  const dialog = { showOpenDialog: originalOpen, showMessageBox: originalMessage };
  const app = {
    disposed: 0,
    async evaluateHandle(fn, arg) {
      // Rebuilt from its source text: proves the installer is self-contained once serialized.
      const value = new Function(`return (${fn.toString()})`)()({ dialog }, JSON.parse(JSON.stringify(arg)));
      return { evaluate: async inner => JSON.parse(JSON.stringify(inner(value))), dispose: async () => { app.disposed++; } };
    },
  };
  // What desktop/src/main.cjs asks on folder:pick, and the SEC-M-02 confirmation of a dropped folder.
  const productPick = () => dialog.showOpenDialog({ synthetic: 'mainWindow' }, { title: 'Choose a source folder to analyze', properties: ['openDirectory'] });
  const productConfirm = () => dialog.showMessageBox({ synthetic: 'mainWindow' }, { type: 'question', buttons: ['Analyze folder', 'Cancel'],
    defaultId: 1, cancelId: 1, noLink: true, title: 'Analyze this folder?', message: 'Allow Code Intelligence to read this dropped folder?', detail: folder });
  return { app, dialog, originalOpen, originalMessage, shown, productPick, productConfirm };
}

test('the single product folder picker is answered with the fixture folder and the dialogs are restored', async () => {
  const s = syntheticApp();
  const { result, pickerCalls, messageBoxes } = await withFolderPicker(s.app, folder, () => s.productPick());
  assert.deepEqual(result, { canceled: false, filePaths: [folder] });
  assert.equal(pickerCalls, 1); assert.equal(messageBoxes, 0);
  assert.equal(s.dialog.showOpenDialog, s.originalOpen); assert.equal(s.dialog.showMessageBox, s.originalMessage);
  assert.equal(s.app.disposed, 1); assert.equal(s.shown.length, 0, 'no OS dialog was shown');
  assert.deepEqual(FOLDER_PICKER, { title: 'Choose a source folder to analyze', properties: ['openDirectory'] });
});

test('a picker that was never requested fails instead of passing silently', async () => {
  const s = syntheticApp();
  await assert.rejects(withFolderPicker(s.app, folder, async () => 'no dialog'), /^Error: FOLDER_PICKER_NOT_REQUESTED$/);
  assert.equal(s.dialog.showOpenDialog, s.originalOpen);
});

test('a second picker request, or one with other wording or properties, is refused and fails the run', async () => {
  for (const pick of [
    s => s.productPick().then(() => s.productPick()),
    s => s.dialog.showOpenDialog({}, { title: 'Choose an encrypted backup from this installation', properties: ['openFile'] }),
    s => s.dialog.showOpenDialog({}, { title: FOLDER_PICKER.title, properties: ['openDirectory', 'multiSelections'] }),
  ]) {
    const s = syntheticApp(); let refusal;
    await assert.rejects(withFolderPicker(s.app, folder, () => pick(s).catch(error => { refusal = error.message; })), /^Error: FOLDER_PICKER_REFUSED$/);
    assert.equal(refusal, 'FOLDER_PICKER_REFUSED'); assert.equal(s.dialog.showOpenDialog, s.originalOpen);
    assert.equal(s.shown.length, 0);
  }
});

test('an unexpected drop confirmation gets its refusing answer, shows no OS dialog and fails the run', async () => {
  const s = syntheticApp(); let answer;
  const run = withFolderPicker(s.app, folder, async () => {
    await s.productPick();
    answer = (await s.productConfirm()).response;
    throw new Error('IMPORT_PREVIEW_TIMEOUT');
  });
  await assert.rejects(run, error => error.message === 'UNEXPECTED_DROP_CONFIRMATION' && error.cause?.message === 'IMPORT_PREVIEW_TIMEOUT');
  assert.equal(answer, 1, 'the cancel answer, never "Analyze folder"');
  assert.equal(s.dialog.showMessageBox, s.originalMessage); assert.equal(s.shown.length, 0);
});

test('an action failure stays primary and the dialogs are still restored', async () => {
  const s = syntheticApp();
  await assert.rejects(withFolderPicker(s.app, folder, async () => { throw new Error('PREVIEW_NOT_VISIBLE'); }), /^Error: PREVIEW_NOT_VISIBLE$/);
  assert.equal(s.dialog.showOpenDialog, s.originalOpen); assert.equal(s.dialog.showMessageBox, s.originalMessage);
  assert.equal(s.app.disposed, 1);
});

test('a dialog replaced by someone else is reported and a relative folder is never offered', async () => {
  const s = syntheticApp();
  await assert.rejects(withFolderPicker(s.app, folder, async () => { s.dialog.showOpenDialog = async () => ({}); }), /^Error: FOLDER_PICKER_REPLACED$/);
  await assert.rejects(withFolderPicker(syntheticApp().app, 'relative/project', async () => {}), /^Error: FOLDER_PICKER_FOLDER_INVALID$/);
});
