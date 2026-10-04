'use strict';

const path = require('node:path');
const os = require('node:os');
const { name, build } = require('../package.json');
const { IsolatedRunError, parseIsolatedRunArguments, prepareIsolatedRun } = require('../src/isolated-run.cjs');

// Creates one reusable validation claim. It never imports Electron, builds, reads
// credentials, opens listeners, or launches a child process.
function prepare(argv) {
  const options = parseIsolatedRunArguments(argv);
  if (!options || options.claimFile) throw new IsolatedRunError();
  const appData = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const plan = prepareIsolatedRun({ ...options, forbiddenRoots: [
    path.resolve(__dirname, '..', 'stage'), path.resolve(__dirname, '..', 'dist'),
    path.join(appData, name), path.join(appData, build.productName),
  ] });
  return { status: 'PREPARED', launchAllowed: true, purpose: plan.purpose,
    appIdentity: plan.appIdentity, claimFile: plan.claimFile,
    root: plan.root, runtimeRoot: plan.runtimeRoot, paths: plan.paths };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node desktop/scripts/prepare-isolated-run.cjs --isolated-run-parent <private-canonical-directory> --isolated-runtime-root <separate-runtime-directory> [--isolated-run-purpose validation|automation]\n'
      + 'Creates a reusable private claim for the fixed validation identity. Launch Electron with --isolated-run-claim <claimFile>.\n'
      + 'The runtime directory must already exist outside the parent and desktop stage/dist; the claim never authorizes production profile paths.');
  } else {
    try { console.log(JSON.stringify(prepare(argv), null, 2)); }
    catch (error) {
      const code = error instanceof IsolatedRunError ? error.code : 'ISOLATED_RUN_INVALID';
      console.error(JSON.stringify({ status: 'REFUSED', launchAllowed: false, code }));
      process.exitCode = 1;
    }
  }
}
module.exports = { prepare };

