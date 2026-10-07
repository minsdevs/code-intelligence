'use strict';
// ADR-01 spike Node worker (Electron run-as-node): runs the packaged ts-analyzer extraction engine
// (dist/analyze.service.js, unchanged) on stdin and spawns the probe as a grandchild.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [probe, sentinel, writeTarget, port] = process.argv.slice(2);
require(path.join(__dirname, '../runtime/ts-analyzer/node_modules/reflect-metadata'));
const { AnalyzeService } = require(path.join(__dirname, '../runtime/ts-analyzer/dist/analyze.service.js'));
const source = require('node:fs').readFileSync(0, 'utf8');
let listen, analysis;
new AnalyzeService().analyze({ files: [{ path: 'src/input.ts', content: source }] })
  .then(result => { analysis = { symbols: result.symbols.map(s => s.name ?? s.symbol ?? s.kind), nodes: result.nodes.length, edges: result.edges.length, fileOutcomes: result.fileOutcomes }; },
    error => { analysis = 'ANALYSIS_FAILED ' + error.message; })
  .then(startListen);
function startListen() {
const server = require('node:net').createServer();
server.on('error', error => { listen = 'DENIED(' + error.code + ')'; finish(); });
server.listen(0, '127.0.0.1', () => { listen = 'ALLOWED'; server.close(); finish(); });
}
function finish() {
  const child = spawnSync(probe, [sentinel, writeTarget, port, 'node-grandchild'], { encoding: 'utf8' });
  let home; try { home = require('node:fs').readdirSync(require('node:os').homedir()).length + ' entries'; } catch (error) { home = 'DENIED(' + error.code + ')'; }
  console.log(JSON.stringify({ worker: 'node ' + process.versions.node + ' (electron ' + process.versions.electron + ')', analysis, tcpListen: listen, userHome: home }));
  console.log(child.error ? 'GRANDCHILD_SPAWN_FAILED ' + child.error.code : child.stdout.trim());
}
