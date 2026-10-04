'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('preload exposes no desktop capabilities when the initial document is denied configuration', () => {
  for (const config of [null, undefined]) {
    const exposed = new Map();
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
      process: { platform: 'darwin' },
      require(name) {
        assert.equal(name, 'electron');
        return {
          contextBridge: { exposeInMainWorld(key, value) { exposed.set(key, value); } },
          ipcRenderer: { sendSync() { return config; } },
          webUtils: {},
        };
      },
    });
    assert.equal(exposed.has('codeIntelligenceDesktop'), false);
  }
});
