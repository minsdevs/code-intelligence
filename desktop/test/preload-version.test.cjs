'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

for (const appVersion of ['2.4.6', '7.8.9-rc.2']) {
  test(`preload exposes runtime app version ${appVersion} on the frozen bridge`, () => {
    let bridge;
    const requests = [];
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
      process: { platform: 'darwin' },
      require(name) {
        assert.equal(name, 'electron');
        return {
          contextBridge: { exposeInMainWorld(key, value) {
            assert.equal(key, 'codeIntelligenceDesktop'); bridge = value;
          } },
          ipcRenderer: { sendSync(channel) {
            requests.push(channel);
            return { appVersion, apiBaseUrl: 'http://127.0.0.1:41000', apiToken: 'synthetic' };
          } },
          webUtils: {},
        };
      },
    });
    assert.deepEqual(requests, ['runtime:config']);
    assert.equal(bridge.appVersion, appVersion);
    assert.equal(Object.isFrozen(bridge), true);
  });
}
