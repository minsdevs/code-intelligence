'use strict';

// Synthetic acceptance probe only: apply bundled migration SQL in a disposable, network-isolated
// PostgreSQL container and compare its catalog with the pure policy. No existing DB, row data,
// credentials, userData, SQL dump/restore, schema auto-approval, or product export is used.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createBackupExportPolicy, REVIEWED_SCHEMA } = require('../../desktop/src/backup-export-policy.cjs');

const migrationRoot = path.resolve(__dirname, '../../backend/src/main/resources/db/migration');
const files = fs.readdirSync(migrationRoot).filter(name => name.endsWith('.sql')).sort();
// Repeatable/undo/unclassified SQL must not disappear through a versioned-only filename filter.
assert.deepEqual(files, REVIEWED_SCHEMA.migrations.map(migration => migration.filename).sort());
files.sort((a, b) => Number(a.match(/^V(\d+)/)[1]) - Number(b.match(/^V(\d+)/)[1]));
const migrations = files.map(filename => ({
  version: Number(filename.match(/^V(\d+)/)[1]), filename,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(migrationRoot, filename))).digest('hex'),
}));
// A changed/new migration must fail before starting a DB, not replace the policy baseline.
assert.deepEqual(migrations, REVIEWED_SCHEMA.migrations);

const catalogSql = `
  select coalesce(jsonb_agg(row_json order by table_name), '[]'::jsonb)::text from (
    select c.relname as table_name,
      jsonb_build_object('name', c.relname, 'columns', (
        select jsonb_agg(jsonb_build_object(
          'name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
          'nullable', not a.attnotnull,
          'generation', case when a.attidentity = 'a' then 'identity-always'
            when a.attidentity = 'd' then 'identity-by-default'
            when a.attgenerated <> '' then 'generated'
            when pg_get_expr(d.adbin, d.adrelid) like 'nextval(%' then 'serial'
            else 'none' end
        ) order by a.attnum)
        from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      )) as row_json
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  ) tables`;

function normalizeType(type) {
  if (type === 'timestamp with time zone') return 'timestamptz';
  return type.replace(/^character varying\(/, 'varchar(').replace(/^character\(/, 'char(');
}

async function check() {
  let container;
  let probes = 0;
  try {
    container = execFileSync('docker', ['run', '--pull=never', '--rm', '-d', '--network=none',
      '--memory=512m', '--cpus=2', '--pids-limit=128', '--tmpfs', '/var/lib/postgresql/data',
      '-e', 'POSTGRES_PASSWORD=public-synthetic-fixture', 'pgvector/pgvector:pg16'],
    { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert.match(container, /^[0-9a-f]{64}$/);
    const docker = (args, input) => execFileSync('docker', ['exec', ...(input === undefined ? [] : ['-i']),
      container, ...args], { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'] });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      // The image's temporary init server has no TCP listener; wait for the final server.
      try { docker(['pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 125));
    }
    assert(ready, 'Synthetic PostgreSQL failed to become ready');
    const sql = statement => docker(['psql', '-X', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-tAc', statement]).trim();
    for (const filename of files) {
      docker(['psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
        fs.readFileSync(path.join(migrationRoot, filename)));
    }
    const inventory = () => ({ migrations, tables: JSON.parse(sql(catalogSql)).map(table => ({
      ...table, columns: table.columns.map(column => ({ ...column, type: normalizeType(column.type) })),
    })) });
    const baseline = inventory();
    assert.equal(baseline.tables.length, 52);
    assert.equal(baseline.tables.reduce((n, table) => n + table.columns.length, 0), 439);
    const policy = createBackupExportPolicy(baseline);
    assert.deepEqual(policy.columnsFor('github_credentials'), []);
    assert(!policy.columnsFor('user_ai_settings').includes('encrypted_key'));
    assert(policy.columnsFor('notes').includes('content_md'));
    probes++;
    function rejectsChange(change, undo) {
      sql(change);
      try {
        assert.throws(() => createBackupExportPolicy(inventory()), error => error.code === 'SCHEMA_MISMATCH');
        probes++;
      } finally { sql(undo); }
      createBackupExportPolicy(inventory());
    }
    rejectsChange('alter table notes add column harmless_name text', 'alter table notes drop column harmless_name');
    rejectsChange('alter table user_ai_settings add column refresh_token text',
      'alter table user_ai_settings drop column refresh_token');
    rejectsChange('create table new_credential_store(secret text)', 'drop table new_credential_store');
    rejectsChange('alter table notes alter column title type varchar(255)',
      'alter table notes alter column title type text');
    rejectsChange('alter table notes alter column title drop not null',
      'alter table notes alter column title set not null');
    rejectsChange('alter table analysis_generations alter column fencing_epoch set generated by default',
      'alter table analysis_generations alter column fencing_epoch set generated always');
    rejectsChange('create view unclassified_view as select id from notes', 'drop view unclassified_view');
    console.log(JSON.stringify({ status: 'PASS', probes, migrations: migrations.length,
      tables: 52, columns: 439, scope: 'isolated schema type/nullability/generation contract and mutants only',
      limitations: 'No export/restore, owner binding, rows, freeform-secret check, all constraints/defaults/functions, or live catalog authority verified.' }));
  } finally {
    if (container && /^[0-9a-f]{64}$/.test(container)) {
      execFileSync('docker', ['rm', '-f', container], { timeout: 30_000, stdio: 'ignore' });
    }
  }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
