'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { installOwnerCapture } = require('../job-race-product.cjs');
const { argumentsFor } = require('../job-race-backend.cjs');

const electron = userData => ({ app: { getPath: () => userData, getName: () => 'Code Intelligence Acceptance' } });
function owner() {
  const value = new EventEmitter();
  let resolve; const termination = new Promise(r => { resolve = r; });
  let stopped = false; value.signals = [];
  Object.defineProperties(value, {
    termination: { value: termination },
    exitCode: { get: () => (stopped ? 137 : null) },
    actualProcess: { get: () => ({ pid: 1234, startedAt: '2026-10-07T00:00:00Z' }) },
  });
  value.stopped = () => stopped;
  value.kill = signal => { value.signals.push(signal); stopped = true; resolve({ exitCode: 137, stopped: true }); return true; };
  return value;
}

test('owner capture records only managed owners, restores Map#set and signals through owner.kill', async () => {
  const original = Map.prototype.set;
  const capture = installOwnerCapture(electron('/profile'), { userData: '/profile' });
  try {
    const registry = new Map();
    registry.set('backend', { kill() {} });
    registry.set('redis', owner());
    assert.deepEqual(capture.captured(), []);
    const analyzer = owner(), backend = owner();
    registry.set('ts-analyzer', analyzer);
    assert.notEqual(Map.prototype.set, original);
    registry.set('backend', backend);
    assert.equal(Map.prototype.set, original, 'restored after both owners are captured');
    assert.equal(registry.get('backend'), backend, 'registry writes still happen');
    assert.deepEqual(capture.captured(), ['backend', 'ts-analyzer']);
    assert.deepEqual(await capture.kill('ts-analyzer'), { startedAt: '2026-10-07T00:00:00Z', exitCode: 137, stopped: true });
    assert.deepEqual(analyzer.signals, ['SIGKILL']);
    assert.deepEqual(backend.signals, []);
    await assert.rejects(capture.kill('ts-analyzer'), /OWNER_ALREADY_STOPPED/);
    await assert.rejects(capture.kill('redis'), /OWNER_NOT_CAPTURED/);
  } finally { capture.restore(); Map.prototype.set = original; }
});

test('owner capture refuses a different profile', () => {
  assert.throws(() => installOwnerCapture(electron('/other'), { userData: '/profile' }), /OWNER_CAPTURE_PROFILE_MISMATCH/);
});

test('backend runner accepts only the job race classes and a local Docker socket', () => {
  const socket = 'unix://' + path.join(os.homedir(), '.docker/run/docker.sock');
  assert.deepEqual(argumentsFor(['--socket', socket, '--with-analyzer', '--tests', 'dev.codeintelligence.job.JobPipelineRaceIntegrationTest']),
    { endpoint: socket, tests: ['dev.codeintelligence.job.JobPipelineRaceIntegrationTest'], analyzer: true });
  assert.throws(() => argumentsFor(['--socket', socket, '--tests', 'dev.codeintelligence.AuthIntegrationTest']), /JOB_RACE_TEST_REFUSED/);
  assert.throws(() => argumentsFor(['--socket', 'tcp://127.0.0.1:2375', '--tests', 'dev.codeintelligence.job.JobPipelineRaceIntegrationTest']), /LOCAL_DOCKER_REQUIRED/);
});
