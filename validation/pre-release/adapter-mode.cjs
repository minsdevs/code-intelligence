'use strict';

// ADR-01: an `xpc-required` candidate carries the adapter supervisor XPC service and runs no
// persistent ts-analyzer child (each analysis is a supervisor session started through main's control
// socket). A `legacy-http` candidate keeps the analyzer sidecar.
const fs = require('node:fs');
const path = require('node:path');

const SERVICE = 'Contents/XPCServices/AdapterSupervisor.xpc';

function adapterMode(app) {
  return fs.existsSync(path.join(app, SERVICE)) ? 'xpc-required' : 'legacy-http';
}

function expectedServices(app) {
  return adapterMode(app) === 'xpc-required' ? ['backend', 'postgres', 'redis'] : ['backend', 'postgres', 'redis', 'ts-analyzer'];
}

/** The packaged analyzer install: inside the supervisor bundle for xpc-required, in the runtime otherwise. */
function analyzerInstall(app) {
  return adapterMode(app) === 'xpc-required'
    ? path.join(app, SERVICE, 'Contents/Resources/ts-analyzer')
    : path.join(app, 'Contents/Resources/runtime/ts-analyzer');
}

module.exports = { adapterMode, analyzerInstall, expectedServices };
