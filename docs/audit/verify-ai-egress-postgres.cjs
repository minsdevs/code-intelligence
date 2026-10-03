'use strict';

// Local acceptance fixture: a NEW disposable PG, never an existing connection or user database.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

async function verify() {
  // Explicit, fresh artifact names keep earlier acceptance evidence immutable.
  const prefix = process.argv[2] || '/tmp/ci-ai-egress-postgres-real-2026-10-03';
  assert.match(prefix, /^\/tmp\/ci-[a-z0-9-]+$/);
  assert(!fs.existsSync(`${prefix}.log`) && !fs.existsSync(`${prefix}.xml`), 'Use a fresh artifact prefix');
  const psql = fs.realpathSync('/opt/homebrew/bin/psql');
  const database = `ci_ai_cost_test_${crypto.randomBytes(8).toString('hex')}`;
  const password = 'public-synthetic-cost-fixture';
  let container;
  try {
    container = execFileSync('docker', ['run', '--pull=never', '--rm', '-d', '--memory=512m', '--cpus=2',
      '--pids-limit=128', '--tmpfs', '/var/lib/postgresql/data', '-p', '127.0.0.1::5432',
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${database}`, 'pgvector/pgvector:pg16'],
    { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert.match(container, /^[0-9a-f]{64}$/);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const check = spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
        { timeout: 5000, stdio: 'ignore' });
      if (check.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'Disposable PG did not start');
    const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 5000 }).trim();
    assert.match(port, /^127\.0\.0\.1:[0-9]+$/);
    const environment = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) environment[key] = process.env[key];
    Object.assign(environment, { CI_AI_COST_PG_TEST_PSQL: psql, CI_AI_COST_PG_TEST_PORT: port.split(':')[1],
      CI_AI_COST_PG_TEST_DATABASE: database, CI_AI_COST_PG_TEST_USER: 'postgres', CI_AI_COST_PG_TEST_PASSWORD: password });
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec',
      `--test-reporter-destination=${prefix}.log`, '--test-reporter=junit',
      `--test-reporter-destination=${prefix}.xml`,
      path.resolve(__dirname, '../../desktop/test/ai-egress-postgres.test.cjs')],
    { env: environment, cwd: path.resolve(__dirname, '../..'), timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) throw new Error('Disposable PG test failed; see the synthetic test artifacts.');
    console.log(JSON.stringify({ status: 'PASS', scope: 'real psql + disposable PG + V25, synthetic authority; no installed app or provider' }));
  } finally {
    if (container && /^[0-9a-f]{64}$/.test(container)) execFileSync('docker', ['rm', '-f', container], { timeout: 30000, stdio: 'ignore' });
  }
}
verify().catch(() => { console.error('AI cost PG verification failed. Read the local test artifacts.'); process.exitCode = 1; });
