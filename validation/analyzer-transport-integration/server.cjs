'use strict';

// Fixture server launched by run.cjs with an IPC channel and a private environment.
require('reflect-metadata');
const path = require('node:path');
const { bootstrap } = require(path.join(process.cwd(), 'work/analyzer/dist/bootstrap.js'));
let app, closing = false;
const observed = { requests: 0, bodyBytes: 0 };
async function close() {
  if (closing) return;
  closing = true;
  try {
    if (app) await app.close();
    process.send?.({ type: 'closed', ...observed });
    if (process.connected) process.disconnect();
  } catch { process.exitCode = 1; }
}
process.on('disconnect', () => { void close(); });
process.on('message', async message => {
  if (message?.type === 'close') return void close();
  if (message?.type === 'stats') return void process.send?.({ type: 'stats', ...observed });
  if (message?.type !== 'start' || app || closing) return;
  try {
    app = await bootstrap(message.environment);
    app.getHttpServer().prependListener('request', request => {
      observed.requests++;
      request.on('data', chunk => { observed.bodyBytes += chunk.length; });
    });
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error();
    process.send?.({ type: 'ready', port: address.port });
  } catch {
    process.send?.({ type: 'refused' });
    await close();
  }
});
