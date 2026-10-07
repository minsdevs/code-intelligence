'use strict';

// Main process only (macOS). G-UPDATE startup wiring around the existing runtime start:
// - before the backend may migrate: the pre-migration checkpoint, or the recovery-only choice
//   when an earlier upgrade did not complete (restore / try again / quit);
// - after the backend is healthy: commit the checkpoint and raise the area-B started-build floor;
// - the user-initiated update check through the application menu and native dialogs only.
// With the shipped empty key set the updater stays disabled and no menu or request is added.
const crypto = require('node:crypto');
// The physical app.asar is hashed below; Electron's asar patch would present it as a directory.
const fs = process.versions?.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const { REVIEWED_SCHEMA } = require('./backup-export-policy.cjs');
const { openUpdateCheckpoints } = require('./update-checkpoint.cjs');
const { createUpdateService, loadUpdateKeys, electronRequest, createProcessRunner } = require('./update-service.cjs');

const TARGET_FLYWAY = Math.max(...REVIEWED_SCHEMA.migrations.map(migration => migration.version));
const KEYS_FILE = path.join(__dirname, '..', 'build', 'update-keys.json');

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
// The installed bundle as recorded for a later restore: <App>.app/Contents/MacOS/<executable>.
// An unpackaged run (no app.asar) has no bundle to record.
async function currentBundle({ app, runningBuild, runtimeRoot, execPath, resourcesPath }) {
  if (!app.isPackaged || typeof resourcesPath !== 'string' || !fs.existsSync(path.join(resourcesPath, 'app.asar'))) return null;
  return { path: path.resolve(execPath, '..', '..', '..'), build: runningBuild,
    runtimeManifestSha256: await hashFile(path.join(runtimeRoot, 'runtime-manifest.json')),
    asarSha256: await hashFile(path.join(resourcesPath, 'app.asar')) };
}

async function openUpdateStartup({ electron, safety, userData, runningBuild, runtimeRoot, execPath, resourcesPath, stopRuntime, quit }) {
  const { app, dialog, shell, net, Menu } = electron;
  const checkpoints = await openUpdateCheckpoints({ userData, runningBuild, targetFlyway: TARGET_FLYWAY,
    bundle: await currentBundle({ app, runningBuild, runtimeRoot, execPath, resourcesPath }) });
  const config = await loadUpdateKeys(KEYS_FILE);
  let service;

  async function offerRecovery(open) {
    const retry = open.state !== 'RESTORING' && open.targetBuild === runningBuild;
    const previous = open.previousBundle ? `build ${open.previousBundle.build} (${open.previousBundle.path})` : 'the previously installed version';
    const buttons = ['Restore previous data', ...(retry ? ['Try the upgrade again'] : []), 'Quit'];
    const choice = await dialog.showMessageBox({ type: 'warning', title: 'Data upgrade did not complete',
      message: 'The database upgrade for this version did not complete. Normal startup is blocked.',
      detail: 'A checkpoint was taken before the upgrade. Restoring returns the database to that checkpoint and keeps your newest '
        + `source files and safety records. Afterwards, reinstall ${previous}.`,
      buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
    if (choice.response === 0) {
      const restored = await checkpoints.restore(open.id);
      await dialog.showMessageBox({ type: 'info', title: 'Previous data restored',
        message: 'The database was restored to the pre-upgrade checkpoint.',
        detail: restored.previousBundle
          ? `Reinstall build ${restored.previousBundle.build}. Its runtime manifest SHA-256 is ${restored.previousBundle.runtimeManifestSha256}.`
          : 'Reinstall the version that was installed before this upgrade.',
        buttons: ['Quit'], noLink: true });
      return false;
    }
    if (!retry || choice.response !== 1) return false;
    await checkpoints.retry(open.id);
    return true;
  }
  // Returns false when startup must not continue (recovery-only).
  async function beforeRuntime() {
    const open = await checkpoints.pending();
    if (open && !await offerRecovery(open)) return false;
    await checkpoints.beforeMigration({ journal: safety.updateState().journal });
    return true;
  }
  async function afterHealthy() {
    await checkpoints.markStarted();
    await safety.recordStartedBuild();
    if (config.enabled && !service) installUpdater();
  }
  async function onStartupFailure() { await checkpoints.markFailed(); }

  async function ask(options) { return (await dialog.showMessageBox({ noLink: true, defaultId: 0, cancelId: 1, ...options })).response === 0; }
  async function checkForUpdates() {
    try {
      const found = await service.check();
      const kind = found.kind === 'recovery' ? 'A signed recovery version' : 'Version';
      if (!await ask({ type: 'info', title: 'Update available', message: `${kind} ${found.version} is available.`,
        detail: 'It is downloaded and its signature, hash, Team ID, bundle ID and notarization are verified before anything is shown.',
        buttons: ['Download and verify', 'Cancel'] })) return;
      await service.download();
      await service.verifyDownloaded();
      await service.handOff();
    } catch (error) {
      await dialog.showMessageBox({ type: 'info', title: 'No verified update', message: 'No verified update can be offered right now.',
        detail: `Nothing was installed. Reason: ${typeof error?.code === 'string' ? error.code : 'UPDATE_FAILED'}`, buttons: ['OK'], noLink: true });
    }
  }
  function installUpdater() {
    service = createUpdateService({ config, userData,
      running: Object.freeze({ product: config.product, bundleId: config.bundleId, teamId: config.teamId, platform: process.platform,
        arch: process.arch, osVersion: process.getSystemVersion(), buildSequence: runningBuild, schemaFlyway: TARGET_FLYWAY, safetyJournalMajor: 1 }),
      request: electronRequest(net), runner: createProcessRunner(), readState: () => safety.updateState(),
      readCheckpoint: () => checkpoints.retained(),
      recordAccepted: verified => safety.recordAcceptedManifest(verified),
      sanctionRollback: verified => safety.sanctionRecoveryRollback(verified),
      restoreCheckpoint: async id => { await stopRuntime(); await checkpoints.restore(id); },
      reveal: async file => shell.showItemInFolder(file),
      confirm: status => ask({ type: 'question', title: 'Ready to install',
        message: `${status.kind === 'recovery' ? 'Recovery version' : 'Version'} ${status.version} is verified and ready to install.`,
        detail: (status.kind === 'recovery' ? 'Your data is first restored to the bound pre-upgrade checkpoint. ' : '')
          + 'The verified installer is shown in Finder and Code Intelligence quits. Replace the app in Applications with it.',
        buttons: ['Show installer and quit', 'Cancel'] }),
      quit });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' },
        { label: 'Check for Updates…', click: () => { checkForUpdates(); } }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  }
  return Object.freeze({ beforeRuntime, afterHealthy, onStartupFailure, updateStatus: () => service?.status() ?? null });
}

module.exports = Object.freeze({ openUpdateStartup, currentBundle, TARGET_FLYWAY });
