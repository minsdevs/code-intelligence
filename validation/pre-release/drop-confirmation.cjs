'use strict';

// SEC-M-02: main grants a dropped folder only after a native confirmation of that exact canonical
// folder whose default answer refuses. A runner cannot click OS UI, so it answers that one dialog in
// the SDK-owned main process and proves the product asked exactly once, for the canonical dropped
// path. The CDP drop, the trusted IPC, realpath and the backend folder policy stay real.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const DROP_CONFIRMATION = Object.freeze({ parented: true, type: 'question', title: 'Analyze this folder?',
  message: 'Allow Code Intelligence to read this dropped folder?', buttons: ['Analyze folder', 'Cancel'],
  defaultId: 1, cancelId: 1, noLink: true });

function bounded(operation, timeoutMs, code) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

// Serialized into the Electron main process, never imported by product code. Only the expected
// first confirmation is accepted; any other message box gets its refusing answer and is recorded.
function installDropConfirmation({ dialog }, expected) {
  const original = dialog.showMessageBox, requests = [];
  const confirm = async (...args) => {
    const options = args.at(-1) ?? {};
    const request = { parented: args.length > 1 };
    for (const key of ['type', 'title', 'message', 'detail', 'buttons', 'defaultId', 'cancelId', 'noLink']) request[key] = options[key] ?? null;
    requests.push(request);
    const accepted = requests.length === 1 && Object.keys(expected).every(key => JSON.stringify(request[key]) === JSON.stringify(expected[key]));
    return { response: accepted ? 0 : Number.isSafeInteger(options.cancelId) ? options.cancelId : 1, checkboxChecked: false };
  };
  dialog.showMessageBox = confirm;
  return { restore() {
    if (dialog.showMessageBox !== confirm) throw new Error('DROP_CONFIRMATION_REPLACED');
    dialog.showMessageBox = original;
    return requests;
  } };
}

function verifyDropConfirmation(requests, expected) {
  assert.ok(Array.isArray(requests), 'DROP_CONFIRMATION_UNREADABLE');
  if (requests.length === 0) throw new Error('DROP_CONFIRMATION_NOT_REQUESTED');
  if (requests.length !== 1) throw new Error('DROP_CONFIRMATION_REPEATED');
  try { assert.deepEqual(requests[0], expected); } catch { throw new Error('DROP_CONFIRMATION_MISMATCH'); }
  return { requests: 1, accepted: true, canonicalPath: expected.detail, title: expected.title,
    defaultAnswerRefuses: expected.defaultId === expected.cancelId && expected.buttons[expected.defaultId] === 'Cancel' };
}

/**
 * Runs `action` (the drop and whatever waits for its grant, e.g. the preview request) while the
 * confirmation is answered, then restores the main-process dialog and verifies the single request.
 * An action failure stays primary; restore always runs.
 */
async function withDropConfirmation(app, folder, action, { timeoutMs = 10000 } = {}) {
  const expected = { ...DROP_CONFIRMATION, buttons: [...DROP_CONFIRMATION.buttons], detail: fs.realpathSync(folder) };
  const handle = await bounded(app.evaluateHandle(installDropConfirmation, expected), timeoutMs, 'DROP_CONFIRMATION_INSTALL_TIMEOUT');
  let failure, result, requests;
  try { result = await action(); } catch (error) { failure = error; }
  try { requests = await bounded(handle.evaluate(value => value.restore()), timeoutMs, 'DROP_CONFIRMATION_RESTORE_TIMEOUT'); }
  catch (error) { failure ||= error; }
  try { await bounded(handle.dispose(), timeoutMs, 'DROP_CONFIRMATION_DISPOSE_TIMEOUT'); } catch (error) { failure ||= error; }
  if (failure) {
    // Keep the action failure primary, but say whether the confirmation was asked and what differed.
    if (failure && typeof failure === 'object') failure.dropConfirmation = describeRequests(requests, expected);
    throw failure;
  }
  return { result, confirmation: verifyDropConfirmation(requests, expected) };
}

// Evidence-safe summary: counts and the names of differing fields, never the requested values.
function describeRequests(requests, expected) {
  if (!Array.isArray(requests)) return { readable: false };
  return { readable: true, requests: requests.length, differing: requests.map(request => Object.keys(expected)
    .filter(key => JSON.stringify(request?.[key]) !== JSON.stringify(expected[key]))) };
}

module.exports = { DROP_CONFIRMATION, describeRequests, installDropConfirmation, verifyDropConfirmation, withDropConfirmation };
