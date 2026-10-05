'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { argumentsFor, environment } = require('../../validation/pre-release/run-cost-recovery.cjs');

test('cost runner requires one explicit retained app and one known mode', () => {
  assert.deepEqual(argumentsFor(['--app', '/synthetic/app', '--mode', 'normal']), { app: '/synthetic/app', mode: 'normal' });
  assert.deepEqual(argumentsFor(['--app', '/synthetic/app', '--mode', 'crash']), { app: '/synthetic/app', mode: 'crash' });
  for (const args of [[], ['--app', '/synthetic/app'], ['--app', '/synthetic/app', '--mode', 'kill-all'],
    ['--app', '/synthetic/app', '--mode', 'crash', '--profile', '/real-user']]) assert.throws(() => argumentsFor(args));
});

test('cost runner builds a private allowlisted environment and enables exactly one native suite', () => {
  const manifest = { runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/lib' } };
  for (const mode of ['normal', 'crash']) {
    const env = environment('/synthetic/runtime', manifest, '/synthetic/private-home', mode);
    assert.equal(env.HOME, '/synthetic/private-home'); assert.equal(env.TMPDIR, env.HOME);
    assert.equal(env.CI_BACKUP_RUNTIME_JAR, '/synthetic/runtime/backend/code-intelligence.jar');
    assert.equal(env[mode === 'normal' ? 'CI_BACKUP_RUNTIME_REAL' : 'CI_BACKUP_RUNTIME_CRASH_REAL'], '1');
    assert.equal(env[mode === 'normal' ? 'CI_BACKUP_RUNTIME_CRASH_REAL' : 'CI_BACKUP_RUNTIME_REAL'], undefined);
    for (const key of ['NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'APPDATA', 'PGPASSWORD'])
      assert.equal(Object.hasOwn(env, key), false);
  }
});
