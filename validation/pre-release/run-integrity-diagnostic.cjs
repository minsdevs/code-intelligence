'use strict';

// Read-only runtime inventory reproduction inside one newly isolated Electron app.
// The temporary wrappers observe only errors from the retained runtime's reads;
// original errors still propagate and no validator checks or bytes are changed.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), os = require('node:os'), { createRequire } = require('node:module');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { launchEnvironment, bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { closeOwnedApplication, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { captureOwnedApplication, installOwnedDialogs } = require('../backup-compatibility/interruption-hooks.cjs');
const { INTEGRITY_CODES } = require('../../desktop/src/startup-diagnostics.cjs');
const { ensureOutputParent } = require('./owned-output.cjs');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const publicCodes = new Set([...INTEGRITY_CODES, 'OWNED_OUTPUT_REFUSED', 'ERR_ASSERTION',
  'DIAGNOSTIC_DIALOG_TIMEOUT', 'INVENTORY_DIAGNOSTIC_TIMEOUT', 'DIAGNOSTIC_STARTUP_TIMEOUT', 'DIAGNOSTIC_STATUS_TIMEOUT']);
function diagnosticFailure(error) {
  let code, message;
  try { code = error?.code; message = error?.message; } catch { return 'DIAGNOSTIC_FAILED'; }
  if (publicCodes.has(code)) return code;
  return publicCodes.has(message) ? message : 'DIAGNOSTIC_FAILED';
}

function finalizeIntegrity(report, verify) {
  try { verify(); report.artifactIdentityUnchanged = true; }
  catch {
    report.status = 'FAIL'; report.artifactIdentityUnchanged = false;
    report.failure ??= { code: 'DIAGNOSTIC_FINAL_INTEGRITY_FAILED' };
    report.finalizationFailure = 'DIAGNOSTIC_FINAL_INTEGRITY_FAILED';
  }
}

async function main(argv = process.argv.slice(2)) {
  assert.deepEqual([argv.length, argv[0]], [2, '--app']); assert.equal(process.platform, 'darwin'); process.umask(0o077);
  const root = fs.realpathSync(path.resolve(__dirname, '../..')), appPath = fs.realpathSync(argv[1]);
  assert.equal(path.dirname(path.dirname(appPath)), root); assert.equal(path.basename(appPath), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(appPath)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtime = path.join(appPath, 'Contents/Resources/runtime'), file = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file)); await validateRuntimeManifest(runtime, manifest);
  const parent = fs.mkdtempSync('/private/tmp/ciid-');
  const plan = prepareIsolatedRun({ parentDirectory: parent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(n => path.join(os.homedir(), 'Library/Application Support', n)) });
  const base = ensureOutputParent(root, 'validation/local/pre-release-final');
  const evidence = fs.mkdtempSync(path.join(base, 'integrity-'));
  const report = { format: 1, status: 'RUNNING', scope: 'Electron runtime read-only inventory repetition', appPath,
    profile: plan.paths.userData, mockKeychain: true, userProfile: false, claim: plan.claimFile,
    manifestSha256: hash(file), appAsarSha256: hash(path.join(appPath, 'Contents/Resources/app.asar')), driverSha256: hash(__filename) };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  const { _electron } = createRequire(path.join(root, 'frontend/package.json'))('playwright');
  let app, owner, stop; save(); console.log(JSON.stringify({ status: 'RUNNING', evidence }));
  try {
    app = await _electron.launch({ executablePath: path.join(appPath, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], env: launchEnvironment(process.env), timeout: 90000 });
    owner = captureOwnedApplication(app); stop = observeStartup(owner.process(), report, save);
    await bounded(() => app.evaluate(installOwnedDialogs, { profile: plan.paths.userData, parent, nonce: crypto.randomBytes(16).toString('hex'), recover: false }), 10000, 'DIAGNOSTIC_DIALOG_TIMEOUT');
    // A single main-process task captures the original filesystem errors before the
    // product validator sanitizes them. Only finite OS/Node codes leave the process.
    report.inventory = await bounded(() => app.evaluate(async ({ app }, { runtime, profile }) => {
      const fs = process.getBuiltinModule('fs'), p = process.getBuiltinModule('path');
      const assert = process.getBuiltinModule('assert/strict');
      assert.equal(app.getName(), 'Code Intelligence Acceptance'); assert.equal(app.getPath('userData'), profile);
      assert.equal(fs.realpathSync(runtime), runtime);
      const req = process.getBuiltinModule('module').createRequire(p.join(app.getAppPath(), 'package.json'));
      const { validateRuntimeManifest } = req('./src/runtime-manifest.cjs');
      const known = new Set([...Object.keys(process.getBuiltinModule('os').constants.errno),
        'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END',
        'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE', 'ERR_INVALID_STATE',
        'ERR_FS_FILE_TOO_LARGE', 'ERR_INTERNAL_ASSERTION', 'ABORT_ERR', 'ERR_OPERATION_FAILED']);
      const io = fs.promises, originals = {}, failures = [], traces = [];
      const record = (operation, error) => {
        let code, kind;
        try { code = error?.code; kind = error?.name; } catch { code = undefined; kind = undefined; }
        if (traces.length < 16) traces.push({ operation, code: known.has(code) ? code : 'UNCLASSIFIED',
          kind: ['Error', 'TypeError', 'RangeError', 'AbortError'].includes(kind) ? kind : 'OTHER' });
      };
      const target = file => typeof file === 'string' && (file === runtime || file.startsWith(runtime + p.sep));
      for (const name of ['readFile', 'readdir', 'lstat', 'open']) {
        originals[name] = io[name];
        io[name] = async function(file, ...args) {
          try {
            const value = await Reflect.apply(originals[name], io, [file, ...args]);
            if (name === 'open' && target(file)) {
              const read = value.createReadStream.bind(value), directRead = value.read.bind(value),
                close = value.close.bind(value), stat = value.stat.bind(value);
              value.createReadStream = (...args) => {
                try { const stream = read(...args); stream.once('error', error => record('STREAM', error)); return stream; }
                catch (error) { record('STREAM_CREATE', error); throw error; }
              };
              value.stat = async (...args) => { try { return await stat(...args); } catch (error) { record('HANDLE_STAT', error); throw error; } };
              value.read = async (...args) => { try { return await directRead(...args); } catch (error) { record('READ', error); throw error; } };
              value.close = async () => { try { await close(); } catch (error) { record('CLOSE', error); throw error; } };
            }
            return value;
          } catch (error) { if (target(file)) record(name.toUpperCase(), error); throw error; }
        };
      }
      let completed = 0;
      try {
        for (let index = 0; index < 20; index++) {
          try { await validateRuntimeManifest(runtime, JSON.parse(await io.readFile(p.join(runtime, 'runtime-manifest.json'), 'utf8'))); completed++; }
          catch (error) { failures.push({ index, code: req('./src/startup-diagnostics.cjs').startupFailureCode(error) }); break; }
        }
      } finally { for (const [name, original] of Object.entries(originals)) io[name] = original; }
      return { completed, failures, traces, electronVersion: process.versions.electron, nodeVersion: process.versions.node };
    }, { runtime, profile: plan.paths.userData }), 90000, 'INVENTORY_DIAGNOSTIC_TIMEOUT');
    save();
    const page = await bounded(() => app.firstWindow({ timeout: 90000 }), 95000, 'DIAGNOSTIC_STARTUP_TIMEOUT');
    const runtimeStatus = await bounded(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()), 10000, 'DIAGNOSTIC_STATUS_TIMEOUT');
    report.runtime = { ready: runtimeStatus.ready === true, recoveryOnly: runtimeStatus.recoveryOnly === true,
      aiOff: runtimeStatus.aiOff === true, errorPresent: runtimeStatus.error !== null,
      services: Array.isArray(runtimeStatus.services) ? runtimeStatus.services.filter(name => ['backend', 'postgres', 'redis', 'ts-analyzer'].includes(name)) : [] };
    assert.equal(report.runtime.ready, true); assert.equal(report.inventory.completed, 20); assert.equal(report.inventory.failures.length, 0);
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.failure = { code: diagnosticFailure(error) }; save(); }
  finally {
    if (owner) {
      const child = owner.process();
      try { await closeOwnedApplication(owner); } catch { report.status = 'FAIL'; report.cleanupFailed = true; }
      report.exit = { code: child.exitCode, signal: child.signalCode }; stop?.();
    }
    // Identity failure cannot erase the already observed primary/cleanup result.
    finalizeIntegrity(report, () => {
      assert.equal(hash(file), report.manifestSha256);
      assert.equal(hash(path.join(appPath, 'Contents/Resources/app.asar')), report.appAsarSha256);
    });
    save();
  }
  console.log(JSON.stringify({ status: report.status, evidence, inventory: report.inventory }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(diagnosticFailure(error)); process.exitCode = 1; });
module.exports = { main, finalizeIntegrity, diagnosticFailure };
