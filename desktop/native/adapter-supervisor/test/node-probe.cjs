'use strict';
// ADR-01 Node denial probe (test stage only): runs in the worker Electron copy, reads the probe
// parameters line from stdin, tries a loopback listen and the user's home, and starts the native
// probe as its own child to show that grandchildren inherit the sandbox.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [sentinel, writeTarget, port] = fs.readFileSync(0, 'utf8').trim().split(' ');
const probe = path.join(__dirname, 'probe');
let home;
try { home = fs.readdirSync('/Users/' + require('node:os').userInfo().username).length + ' entries'; } catch (error) { home = 'DENIED(' + error.code + ')'; }
const server = require('node:net').createServer();
const finish = listen => {
  const child = spawnSync(probe, [sentinel, writeTarget, port, 'node-grandchild'], { encoding: 'utf8' });
  console.log(JSON.stringify({ worker: 'node ' + process.versions.node + ' (electron ' + process.versions.electron + ')', tcpListen: listen, userHome: home }));
  console.log(child.error ? 'GRANDCHILD_SPAWN_FAILED ' + child.error.code : child.stdout.trim());
};
server.on('error', error => finish('DENIED(' + error.code + ')'));
server.listen(0, '127.0.0.1', () => { server.close(); finish('ALLOWED'); });
