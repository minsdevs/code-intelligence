'use strict';

// Creates its own disposable server and two empty random fixture DBs. Never accepts a connection.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
async function verify() {
  const prefix = process.argv[2];
  assert.match(prefix || '', /^\/tmp\/ci-backup-[a-z0-9-]+$/);
  assert(!fs.existsSync(`${prefix}.log`) && !fs.existsSync(`${prefix}.xml`));
  const psql = fs.realpathSync('/opt/homebrew/bin/psql');
  const source = `ci_backup_stage_${crypto.randomBytes(12).toString('hex')}`;
  const target = `ci_backup_stage_${crypto.randomBytes(12).toString('hex')}`;
  const live = `ci_backup_live_${crypto.randomBytes(12).toString('hex')}`;
  const costSource = `ci_backup_stage_${crypto.randomBytes(12).toString('hex')}`;
  const costTarget = `ci_backup_stage_${crypto.randomBytes(12).toString('hex')}`;
  const password = 'public-synthetic-backup-fixture';
  let container;
  try {
    container = execFileSync('docker', ['run', '--pull=never', '--rm', '-d', '--memory=512m', '--cpus=2',
      '--pids-limit=128', '--tmpfs', '/var/lib/postgresql/data', '-p', '127.0.0.1::5432',
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${source}`, 'pgvector/pgvector:pg16'],
    { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert.match(container, /^[0-9a-f]{64}$/);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const check = spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
        { timeout: 5000, stdio: 'ignore' });
      if (check.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready);
    execFileSync('docker', ['exec', container, 'createdb', '-U', 'postgres', target], { timeout: 10000, stdio: 'ignore' });
    execFileSync('docker', ['exec', container, 'createdb', '-U', 'postgres', live], { timeout: 10000, stdio: 'ignore' });
    for (const database of [costSource, costTarget]) execFileSync('docker', ['exec', container, 'createdb', '-U', 'postgres', database],
      { timeout: 10000, stdio: 'ignore' });
    const address = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 5000 }).trim();
    assert.match(address, /^127\.0\.0\.1:[0-9]+$/);
    const environment = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) environment[key] = process.env[key];
    Object.assign(environment, { CI_BACKUP_PG_TEST_PSQL: psql, CI_BACKUP_PG_TEST_PORT: address.split(':')[1],
      CI_BACKUP_PG_TEST_SOURCE: source, CI_BACKUP_PG_TEST_TARGET: target, CI_BACKUP_PG_TEST_LIVE: live, CI_BACKUP_PG_TEST_USER: 'postgres',
      CI_BACKUP_PG_TEST_PASSWORD: password });
    Object.assign(environment, { CI_BACKUP_COST_PG_TEST_PSQL: psql, CI_BACKUP_COST_PG_TEST_PORT: address.split(':')[1],
      CI_BACKUP_COST_PG_TEST_SOURCE: costSource, CI_BACKUP_COST_PG_TEST_TARGET: costTarget,
      CI_BACKUP_COST_PG_TEST_USER: 'postgres', CI_BACKUP_COST_PG_TEST_PASSWORD: password });
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec',
      `--test-reporter-destination=${prefix}.log`, '--test-reporter=junit', `--test-reporter-destination=${prefix}.xml`,
      path.resolve(__dirname, '../../desktop/test/backup-postgres.test.cjs'),
      path.resolve(__dirname, '../../desktop/test/backup-database.test.cjs'),
      path.resolve(__dirname, '../../desktop/test/backup-cost-postgres.test.cjs')],
    { env: environment, cwd: path.resolve(__dirname, '../..'), timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.status, 0, 'See synthetic test artifacts');
    console.log(JSON.stringify({ status: 'PASS', scope: 'typed exporter/loader, disposable PG, V1–V25, synthetic data only' }));
  } finally {
    if (container && /^[0-9a-f]{64}$/.test(container)) execFileSync('docker', ['rm', '-f', container], { timeout: 30000, stdio: 'ignore' });
  }
}
verify().catch(() => { console.error('Backup PG verification failed. Read the local synthetic test artifacts.'); process.exitCode = 1; });
