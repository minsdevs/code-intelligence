'use strict';

// Folder import through the product's own picker (folder:pick). A runner cannot click OS UI, so it
// answers the one "Choose a source folder" dialog in the main process with a fixture folder. The UI,
// trusted IPC, realpath, backend folder policy, preview and approval stay real. The picker path asks
// no SEC-M-02 drop confirmation, so any message box in that window gets its refusing answer and fails
// the run instead of waiting on a real dialog.
const path = require('node:path');

const FOLDER_PICKER = Object.freeze({ title: 'Choose a source folder to analyze', properties: Object.freeze(['openDirectory']) });

function bounded(operation, timeoutMs, code) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

// Serialized into the Electron main process, never imported by product code. Only the first request
// with the expected wording is answered; any other picker request is refused.
function installFolderPicker({ dialog }, { selected, expected }) {
  const originalOpen = dialog.showOpenDialog, originalMessage = dialog.showMessageBox;
  const record = { calls: 0, refused: 0, messageBoxes: 0 };
  const choose = async (...args) => {
    const options = args.at(-1) ?? {};
    if (record.calls || options.title !== expected.title
      || JSON.stringify(options.properties) !== JSON.stringify(expected.properties)) {
      record.refused++;
      throw new Error('FOLDER_PICKER_REFUSED');
    }
    record.calls++;
    return { canceled: false, filePaths: [selected] };
  };
  const refuse = async (...args) => {
    const options = args.at(-1) ?? {};
    record.messageBoxes++;
    return { response: Number.isSafeInteger(options.cancelId) ? options.cancelId : 1, checkboxChecked: false };
  };
  dialog.showOpenDialog = choose;
  dialog.showMessageBox = refuse;
  return { restore() {
    if (dialog.showOpenDialog !== choose || dialog.showMessageBox !== refuse) throw new Error('FOLDER_PICKER_REPLACED');
    dialog.showOpenDialog = originalOpen;
    dialog.showMessageBox = originalMessage;
    return record;
  } };
}

/**
 * Runs `action` (pressing "Choose folder" and whatever waits for its grant, e.g. the preview button)
 * while the picker is answered, then restores the main-process dialogs and verifies the single
 * request. `app` is anything with Playwright's ElectronApplication.evaluateHandle shape. An
 * unexpected message box is the primary failure (the action failure becomes its cause); otherwise an
 * action failure stays primary. Restore always runs.
 */
async function withFolderPicker(app, folder, action, { timeoutMs = 10000 } = {}) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('FOLDER_PICKER_FOLDER_INVALID');
  const handle = await bounded(app.evaluateHandle(installFolderPicker, { selected: folder, expected: FOLDER_PICKER }),
    timeoutMs, 'FOLDER_PICKER_INSTALL_TIMEOUT');
  let failure, result, record;
  try { result = await action(); } catch (error) { failure = error; }
  try { record = await bounded(handle.evaluate(value => value.restore()), timeoutMs, 'FOLDER_PICKER_RESTORE_TIMEOUT'); }
  catch (error) { failure ||= error; }
  try { await bounded(handle.dispose(), timeoutMs, 'FOLDER_PICKER_DISPOSE_TIMEOUT'); } catch (error) { failure ||= error; }
  if (record?.messageBoxes) throw new Error('UNEXPECTED_DROP_CONFIRMATION', failure ? { cause: failure } : undefined);
  if (failure) throw failure;
  if (record.refused) throw new Error('FOLDER_PICKER_REFUSED');
  if (record.calls !== 1) throw new Error('FOLDER_PICKER_NOT_REQUESTED');
  return { result, pickerCalls: record.calls, messageBoxes: 0 };
}

module.exports = { FOLDER_PICKER, installFolderPicker, withFolderPicker };
