'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { evaluateQualityMetrics } = require('../quality-metrics.cjs');
const supported = ['darwin', 'linux'].includes(process.platform);

for (const exit of [0, 7]) test(`real time output and bounded owned Node exit ${exit} retain the measurement result`, { skip: !supported }, () => {
  const platform = process.platform === 'darwin' ? 'Darwin' : 'Linux';
  const started = performance.now();
  const child = spawnSync('/usr/bin/time', [platform === 'Darwin' ? '-l' : '-v', process.execPath,
    '-e', `const input = Buffer.alloc(1024 * 1024, 19); if (input[0] !== 19) process.exit(99); process.exit(${exit});`], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, exit);
  const measured = evaluateQualityMetrics({ platform, timeOutput: child.stderr,
    commandExitCode: String(child.status), elapsedSeconds: String(Math.ceil((performance.now() - started) / 1000)),
    maxSeconds: '15', maxRssKiB: '2097152' });
  assert.equal(measured.exitCode, exit); assert(measured.rssKiB > 0);
  assert.deepEqual(measured.failures, exit ? ['BACKEND_COMMAND_FAILED'] : []);
  // This verifies time/CLI plumbing, not application process-tree performance.
  assert.equal(measured.scope, 'TIMED_GRADLE_REGRESSION');
});
