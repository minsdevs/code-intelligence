'use strict';

// Main-only typed data adapter. Archive bytes never supply SQL, a database name, or filesystem paths.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const { types: { isProxy } } = require('node:util');
const { createBackupExportPolicy, REVIEWED_SCHEMA, POLICY_LIMITS } = require('./backup-export-policy.cjs');

const LIMITS = Object.freeze({ rowBytes: 16 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, accountingBytes: 64 * 1024 * 1024,
  inputBytes: 2 * 1024 * 1024 * 1024, rows: 1_000_000, stderrBytes: 64 * 1024, queued: 2, timeoutMs: 120_000 });
const TABLES = REVIEWED_SCHEMA.tables;
const POLICY = createBackupExportPolicy(REVIEWED_SCHEMA);
const SEQUENCES = TABLES.flatMap(t => t.columns.filter(c => c.generation !== 'none')
  .map(c => ({ table: t.name, column: c.name, key: `${t.name}.${c.name}`, name: `${t.name}_${c.name}_seq` })));
const FINANCIAL = new Set(['ai_budget_gate', 'ai_request_ledger', 'ai_usage_evidence']);
const FUNCTIONS = ['guard_ai_cost_immutability', 'protect_sealed_source_entry', 'protect_snapshot_source_identity',
  'protect_source_blob', 'protect_source_manifest', 'reject_local_source_input_update'];
const MESSAGES = Object.freeze({ INVALID: 'Invalid backup database configuration or data.', CLOSED: 'The backup database adapter is closed.',
  BUSY: 'The backup database adapter is busy.', MIGRATIONS: 'Bundled backup migrations do not match the reviewed policy.',
  SCHEMA: 'The database schema does not match the reviewed backup schema.', OWNER: 'The installation owner cannot be bound safely.',
  ACTIVE_JOB: 'Active jobs must finish before a backup.', PRECISION: 'A database JSON number cannot be preserved exactly.',
  ROW: 'A backup row does not match the reviewed data policy.', LIMIT: 'The backup exceeds a fixed database adapter limit.',
  PG_FAILED: 'The backup database operation failed.', TIMEOUT: 'The backup database operation exceeded its deadline.',
  TERMINATION: 'The backup database process did not terminate.', STAGING: 'A fresh isolated staging database is required.',
  INTEGRITY: 'Backup row counts or digests do not match.', CALLBACK: 'The backup data consumer failed.' });
class BackupPostgresError extends Error {
  constructor(code) { const safe = Object.hasOwn(MESSAGES, code) ? code : 'INVALID'; super(MESSAGES[safe]);
    this.name = 'BackupPostgresError'; this.code = `BACKUP_PG_${safe}`; }
}
function fail(code = 'INVALID') { throw new BackupPostgresError(code); }
function exact(value, names, code = 'INVALID') {
  if (!value || typeof value !== 'object' || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) fail(code);
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d.enumerable || !Object.hasOwn(d, 'value')) fail(code); }
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && value.length === 64;
const positiveId = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) <= 9223372036854775807n;
const quote = name => `"${name}"`; // Only reviewed literal descriptors enter this function.
const jsonSql = value => `convert_from(decode('${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}','base64'),'UTF8')::jsonb`;
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {}); return { promise, resolve, reject }; }

// Flyway's SQL checksum is CRC32 over UTF-8 lines, excluding line separators and the initial BOM.
function flywayChecksum(text) {
  let crc = -1;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    for (const byte of Buffer.from(line, 'utf8')) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ -1) | 0;
}
async function migrationsAt(root, windowsBoundary) {
  if (windowsBoundary) {
    const storage = await windowsBoundary.openStorage(root, { mode: 'source' });
    try {
      const files = []; for await (const entry of storage.entries()) if (entry.name.endsWith('.sql')) files.push(entry.name);
      if (canonical(files.sort()) !== canonical(REVIEWED_SCHEMA.migrations.map(m => m.filename).sort())) fail('MIGRATIONS');
      const result = [];
      for (const migration of REVIEWED_SCHEMA.migrations) {
        const { bytes } = await require('./windows-storage-files.cjs').readStorageFile(storage, migration.filename, 2 * 1024 * 1024);
        try { if (digest(bytes) !== migration.sha256) fail('MIGRATIONS'); const sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes); result.push({ ...migration, sql, checksum: flywayChecksum(sql) }); }
        finally { bytes.fill(0); }
      }
      return result;
    } finally { await storage.close(); }
  }
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) fail('MIGRATIONS');
  try {
    if ((await fs.realpath(root)) !== root || !(await fs.lstat(root)).isDirectory()) fail('MIGRATIONS');
    const files = (await fs.readdir(root)).filter(name => name.endsWith('.sql')).sort();
    if (canonical(files) !== canonical(REVIEWED_SCHEMA.migrations.map(m => m.filename).sort())) fail('MIGRATIONS');
    const result = [];
    for (const m of REVIEWED_SCHEMA.migrations) {
      const file = path.join(root, m.filename); const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('MIGRATIONS');
      const bytes = await fs.readFile(file);
      if (digest(bytes) !== m.sha256) fail('MIGRATIONS');
      const sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      result.push({ ...m, sql, checksum: flywayChecksum(sql) });
    }
    return result;
  } catch { fail('MIGRATIONS'); }
}

// Compare mathematical decimal values BEFORE JSON.parse can silently round a JSONB numeric.
// Scale-only differences (0.10 -> 0.1) preserve JSON numeric value; arbitrary decimals are not stringified.
function decimalIdentity(token) {
  if (token.length > POLICY_LIMITS.maxNumericChars) fail('PRECISION');
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!match || (match[4] && match[4].length > 6)) fail('PRECISION');
  let digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
  if (!digits) return '0';
  let scale = Number(match[4] || 0) - (match[3] || '').length;
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); scale++; }
  return `${match[1]}${digits}e${scale}`;
}
function exactJson(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > POLICY_LIMITS.maxRowBytes) fail('ROW');
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '"') {
      i++;
      while (i < raw.length) { if (raw[i] === '\\') { i += 2; continue; } if (raw[i++] === '"') break; }
    } else if (raw[i] === '-' || /[0-9]/.test(raw[i])) {
      const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(raw.slice(i))?.[0];
      if (!token) fail('ROW');
      const number = Number(token);
      if (!Number.isFinite(number) || Object.is(number, -0) || (Number.isInteger(number) && !Number.isSafeInteger(number))
          || decimalIdentity(token) !== decimalIdentity(JSON.stringify(number))) fail('PRECISION');
      i += token.length;
    } else i++;
  }
  try { return JSON.parse(raw); } catch { fail('ROW'); }
}
function decodeRow(name, raw) {
  const table = TABLES.find(t => t.name === name); if (!table) fail('ROW');
  const names = POLICY.columnsFor(name); exact(raw, names, 'ROW');
  const values = {};
  for (const column of table.columns.filter(c => names.includes(c.name))) {
    const value = raw[column.name];
    if (value === null) values[column.name] = null;
    else {
      if (typeof value !== 'string') fail('ROW');
      if (column.type === 'jsonb') values[column.name] = { json: exactJson(value) };
      else if (column.type === 'vector(1536)') { try { values[column.name] = JSON.parse(value); } catch { fail('ROW'); } }
      else if (column.type === 'integer' || column.type === 'double precision') {
        if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)) fail('ROW');
        values[column.name] = Number(value);
      } else if (column.type === 'boolean') { if (!['true', 'false'].includes(value)) fail('ROW'); values[column.name] = value === 'true'; }
      else values[column.name] = value;
    }
  }
  try { return POLICY.projectRow(name, values); } catch (error) { fail(error.code === 'ACTIVE_JOB' ? 'ACTIVE_JOB' : 'ROW'); }
}

const CATALOG_SQL = `jsonb_build_object(
 'tables',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,
   'forceRls',c.relforcerowsecurity,'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,
     'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,
     'generation',case when a.attidentity='a' then 'identity-always' when a.attidentity='d' then 'identity-by-default'
       when a.attgenerated<>'' then 'generated' when pg_get_expr(d.adbin,d.adrelid) like 'nextval(%' then 'serial' else 'none' end,
     'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
     from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
     where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)) order by c.relname),'[]'::jsonb)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
   and c.relkind in ('r','p','v','m','f') and c.relname<>'flyway_schema_history'),
 'constraints',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid),
   'validated',k.convalidated) order by c.relname,k.conname),'[]'::jsonb) from pg_constraint k join pg_class c on c.oid=k.conrelid
   join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname<>'flyway_schema_history'),
 'indexes',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',i.relname,'definition',pg_get_indexdef(i.oid),
   'valid',x.indisvalid,'ready',x.indisready) order by c.relname,i.relname),'[]'::jsonb)
   from pg_index x join pg_class c on c.oid=x.indrelid join pg_class i on i.oid=x.indexrelid
   join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname<>'flyway_schema_history'),
 'triggers',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid),
   'enabled',t.tgenabled) order by c.relname,t.tgname),'[]'::jsonb) from pg_trigger t join pg_class c on c.oid=t.tgrelid
   join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
 'functions',(select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid))
   order by p.proname,p.oid),'[]'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass
     and d.objid=p.oid and d.deptype='e')),
 'rules',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',r.rulename,'definition',pg_get_ruledef(r.oid))
   order by c.relname,r.rulename),'[]'::jsonb) from pg_rewrite r join pg_class c on c.oid=r.ev_class
   join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
 'sequences',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'type',pg_catalog.format_type(s.seqtypid,null),
   'start',s.seqstart::text,'increment',s.seqincrement::text,'min',s.seqmin::text,'max',s.seqmax::text,
   'cache',s.seqcache::text,'cycle',s.seqcycle) order by c.relname),'[]'::jsonb)
   from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
 'extensions',(select jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion) order by e.extname) from pg_extension e),
 'serverMajor',current_setting('server_version_num')::int/10000)`;
const HISTORY_SQL = `(select jsonb_agg(jsonb_build_object('version',version,'script',script,'checksum',checksum,
 'success',success,'type',type) order by installed_rank) from public.flyway_schema_history)`;
function headerSql(installationId, owner) {
  return `select jsonb_build_object('kind','header','catalog',${CATALOG_SQL},'history',${HISTORY_SQL},'owner',${owner ?
    `(select jsonb_build_object('ownerUserId',min(id) filter(where local_key=${jsonSql(installationId)}#>>'{}')::text,
       'valid',count(*) filter(where local_key is not null or identity_type in ('LOCAL','LOCAL_LINKED'))=1
       and count(*) filter(where local_key=${jsonSql(installationId)}#>>'{}' and identity_type in ('LOCAL','LOCAL_LINKED'))=1
       and count(*) filter(where (identity_type='GITHUB') is distinct from (local_key is null))=0)
       from public.users)` : `'null'::jsonb`},'activeJobs',${owner ?
    `(select count(*)::text from public.analysis_jobs where status in ('QUEUED','RUNNING','CANCELLING'))` : `'0'`},
    'activeSteps',${owner ? `(select count(*)::text from public.analysis_job_steps where status='RUNNING')` : `'0'`});\n`;
}
function validateHeader(value, migrations, needsOwner) {
  exact(value, ['kind', 'catalog', 'history', 'owner', 'activeJobs', 'activeSteps'], 'SCHEMA');
  if (value.kind !== 'header') fail('SCHEMA');
  exact(value.catalog, ['tables', 'constraints', 'indexes', 'triggers', 'functions', 'rules', 'sequences', 'extensions', 'serverMajor'], 'SCHEMA');
  try {
    const tables = value.catalog.tables.map(t => {
      if (t.kind !== 'r' || t.rls || t.forceRls) fail('SCHEMA');
      return { name: t.name, columns: t.columns.map(c => ({ name: c.name, nullable: c.nullable, generation: c.generation,
        type: c.type === 'timestamp with time zone' ? 'timestamptz' : c.type.replace(/^character varying\(/, 'varchar(').replace(/^character\(/, 'char(') })) };
    });
    createBackupExportPolicy({ migrations: REVIEWED_SCHEMA.migrations, tables });
    if (canonical(value.catalog.functions.map(f => f.name).sort()) !== canonical(FUNCTIONS)
        || value.catalog.rules.length !== 0 || value.catalog.triggers.some(t => t.enabled !== 'O')
        || value.catalog.constraints.some(c => !c.validated) || value.catalog.indexes.some(i => !i.valid || !i.ready)
        || canonical(value.catalog.extensions.map(e => e.name).sort()) !== canonical(['pg_trgm', 'plpgsql', 'vector'])
        || canonical(value.catalog.sequences.map(s => s.name).sort()) !== canonical(SEQUENCES.map(s => s.name).sort())) fail('SCHEMA');
    if (!Array.isArray(value.history) || value.history.length !== migrations.length) fail('SCHEMA');
    value.history.forEach((row, index) => { const m = migrations[index];
      exact(row, ['version', 'script', 'checksum', 'success', 'type'], 'SCHEMA');
      if (row.version !== String(m.version) || row.script !== m.filename || row.checksum !== m.checksum || row.success !== true || row.type !== 'SQL') fail('SCHEMA');
    });
  } catch { fail('SCHEMA'); }
  if (needsOwner) {
    exact(value.owner, ['ownerUserId', 'valid'], 'OWNER');
    if (!value.owner.valid || !positiveId(value.owner.ownerUserId)) fail('OWNER');
    if (value.activeJobs !== '0' || value.activeSteps !== '0') fail('ACTIVE_JOB');
  } else if (value.owner !== null || value.activeJobs !== '0' || value.activeSteps !== '0') fail('SCHEMA');
  return digest(canonical(value.catalog));
}

function orderBy(table) {
  const composite = { snapshot_inventory_measurements: ['snapshot_id'], source_blobs: ['project_id', 'sha256'], source_manifest_entries: ['manifest_id', 'path'],
    user_ai_preferences: ['user_id'], ai_budget_gate: ['installation_id'], ai_request_ledger: ['request_id'],
    ai_usage_evidence: ['request_id', 'proof_sha256'] };
  return (composite[table.name] || ['id']).map(quote).join(',');
}
function tableSql(table) {
  const names = POLICY.columnsFor(table.name);
  let sql = `select jsonb_build_object('kind','table','table','${table.name}');\n`;
  if (names.length) {
    const fields = names.map(name => {
      const c = table.columns.find(c => c.name === name);
      const v = c.type === 'timestamptz' ? `to_char(${quote(name)} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        : `${quote(name)}::text`;
      return `'${name}',${v}`;
    });
    sql += `select jsonb_build_object('kind','row','table','${table.name}','values',jsonb_build_object(${fields.join(',')}))
      from public.${quote(table.name)} order by ${orderBy(table)};\n`;
  }
  sql += `select jsonb_build_object('kind','end','table','${table.name}','count',${names.length ?
    `(select count(*)::text from public.${quote(table.name)})` : `'0'`});\n`;
  return sql;
}
function summary(ownerUserId, catalogSha256) {
  return { version: 1, schema: REVIEWED_SCHEMA, ownerUserId, catalogSha256,
    sequenceHighWater: Object.fromEntries(SEQUENCES.map(s => [s.key, '0'])),
    preferenceRevisionHighWater: {},
    tableCounts: Object.fromEntries(TABLES.map(t => [t.name, '0'])),
    tableSha256: Object.fromEntries(TABLES.map(t => [t.name, digest('')])), rowCount: '0' };
}
function validateSummary(value) {
  exact(value, ['version', 'schema', 'ownerUserId', 'catalogSha256', 'sequenceHighWater', 'preferenceRevisionHighWater', 'tableCounts', 'tableSha256', 'rowCount'], 'INTEGRITY');
  if (value.version !== 1 || !positiveId(value.ownerUserId) || !hash(value.catalogSha256)) fail('INTEGRITY');
  try { createBackupExportPolicy(value.schema); } catch { fail('SCHEMA'); }
  validateSequenceHighWater(value.sequenceHighWater);
  validateRevisions(value.preferenceRevisionHighWater);
  exact(value.tableCounts, TABLES.map(t => t.name), 'INTEGRITY'); exact(value.tableSha256, TABLES.map(t => t.name), 'INTEGRITY');
  let total = 0n;
  for (const t of TABLES) {
    const count = value.tableCounts[t.name];
    if (typeof count !== 'string' || !/^(0|[1-9][0-9]{0,6})$/.test(count) || BigInt(count) > BigInt(LIMITS.rows)
        || !hash(value.tableSha256[t.name]) || (!POLICY.columnsFor(t.name).length && count !== '0')) fail('INTEGRITY');
    total += BigInt(count);
  }
  if (total > BigInt(LIMITS.rows) || value.rowCount !== total.toString()) fail('INTEGRITY');
  return freeze(JSON.parse(JSON.stringify(value)));
}
function validateSequenceHighWater(value) {
  exact(value, SEQUENCES.map(s => s.key), 'INTEGRITY');
  for (const v of Object.values(value)) if (v !== '0' && !positiveId(v)) fail('INTEGRITY');
  return freeze({ ...value });
}
function sequenceSql() {
  return `select jsonb_build_object('kind','sequences','values',jsonb_build_object(${SEQUENCES.map(s =>
    `'${s.key}',(select case when is_called then last_value::text else '0' end from public.${quote(s.name)})`).join(',')}));\n`;
}
function validateRevisions(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INTEGRITY');
  const names = Reflect.ownKeys(value);
  if (names.length > LIMITS.rows) fail('LIMIT');
  exact(value, names, 'INTEGRITY');
  for (const key of names) if (!positiveId(key) || (value[key] !== '0' && !positiveId(value[key]))) fail('INTEGRITY');
  return freeze({ ...value });
}
function revisionSql() {
  return `select jsonb_build_object('kind','revisions','values',coalesce((select jsonb_object_agg(user_id::text,revision::text)
    from public.user_ai_preferences),'{}'::jsonb));\n`;
}
function valueSql(column, source = 'v') {
  const field = `${source}->'${column.name}'`;
  if (column.type === 'jsonb') return `case when ${field}='null'::jsonb then null else ${field}->'json' end`;
  if (column.type === 'vector(1536)') return `case when ${field}='null'::jsonb then null else (${field})::text::public.vector(1536) end`;
  return `(${source}->>'${column.name}')::${column.type}`;
}
function insertRowSql(projected, ownerUserId, installationId, revision = '0') {
  const table = TABLES.find(t => t.name === projected.table), names = POLICY.columnsFor(table.name);
  const json = jsonSql(projected.values);
  if (table.name === 'user_ai_settings') return `insert into pg_temp.backup_keyless(user_id,provider,model,created_at,updated_at)
    select (v->>'user_id')::bigint,v->>'provider',v->>'model',(v->>'created_at')::timestamptz,(v->>'updated_at')::timestamptz
    from(select ${json} v) x;\n`;
  let prefix = '';
  const changed = {};
  if (table.name === 'projects') {
    prefix = `insert into pg_temp.backup_project_pointers select (v->>'id')::bigint,(v->>'current_snapshot_id')::bigint,
      (v->>'current_generation_id')::uuid from(select ${json} v) x;\n`;
    changed.current_snapshot_id = 'null'; changed.current_generation_id = 'null';
  } else if (table.name === 'features') {
    prefix = `insert into pg_temp.backup_feature_parents select (v->>'id')::bigint,(v->>'parent_id')::bigint from(select ${json} v) x;\n`;
    changed.parent_id = 'null';
  } else if (table.name === 'source_manifests') {
    prefix = `insert into pg_temp.backup_manifest_seals select (v->>'id')::uuid,(v->>'sealed_at')::timestamptz from(select ${json} v) x;\n`;
    changed.sealed_at = 'null';
  }
  const fields = names.map(name => changed[name] ?? valueSql(table.columns.find(c => c.name === name)));
  const inserted = [...names];
  if (table.name === 'users') {
    inserted.push('local_key');
    fields.push(`case when (v->>'id')::bigint=${ownerUserId}::bigint then ${jsonSql(installationId)}#>>'{}' else null end`);
  } else if (table.name === 'user_ai_preferences') {
    inserted.push('connection_state', 'revision');
    fields.push("'OFF'", `${revision}::bigint`);
  }
  return prefix + `insert into public.${quote(table.name)}(${inserted.map(quote).join(',')})${table.name === 'analysis_generations' ? ' overriding system value' : ''}
    select ${fields.join(',')} from(select ${json} v) x;\n`;
}

async function createBackupPostgres(options) {
  if (!options || typeof options !== 'object') fail();
  const allowed = ['psqlPath', 'migrationRoot', 'installationId', 'connection', 'env', 'mode', 'spawn', 'timeoutMs', 'windowsBoundary'];
  if (Object.keys(options).some(k => !allowed.includes(k))) fail();
  const { psqlPath, migrationRoot, installationId, connection, mode } = options;
  if (!['export', 'staging'].includes(mode) || typeof installationId !== 'string' || installationId.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(installationId)) fail();
  if (typeof psqlPath !== 'string' || !path.isAbsolute(psqlPath) || path.resolve(psqlPath) !== psqlPath) fail();
  if (options.windowsBoundary) {
    const storage = await options.windowsBoundary.openStorage(path.dirname(psqlPath), { mode: 'source' });
    try { await storage.stat(path.basename(psqlPath)); } finally { await storage.close(); }
  } else {
    try { const info = await fs.lstat(psqlPath); if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)
        || await fs.realpath(psqlPath) !== psqlPath) fail(); } catch { fail(); }
  }
  const migrations = await migrationsAt(migrationRoot, options.windowsBoundary);
  exact(connection, ['host', 'port', 'user', 'database']);
  if (connection.host !== '127.0.0.1' || !Number.isInteger(connection.port) || connection.port < 1025 || connection.port > 65535
      || ![connection.user, connection.database].every(s => typeof s === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(s))) fail();
  if (mode === 'staging' && !/^ci_backup_stage_[0-9a-f]{16,32}$/.test(connection.database)) fail('STAGING');
  const environment = { ...(options.windowsBoundary ? require('./runtime-platform.cjs').inheritedEnvironment(process.env) : {}), PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8', PGTZ: 'UTC', LC_ALL: 'C', PGSSLMODE: 'verify-full' };
  if (!options.env || typeof options.env !== 'object') fail();
  if (options.env.PGSSLMODE !== undefined && options.env.PGSSLMODE !== 'verify-full') fail();
  if (options.env.PGSSLROOTCERT !== undefined && (typeof options.env.PGSSLROOTCERT !== 'string'
      || !path.isAbsolute(options.env.PGSSLROOTCERT) || path.normalize(options.env.PGSSLROOTCERT) !== options.env.PGSSLROOTCERT)) fail();
  for (const [key, value] of Object.entries(options.env)) {
    if (!['PGPASSWORD', 'PGSSLMODE', 'PGSSLROOTCERT', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'].includes(key) || typeof value !== 'string'
        || value.includes('\0') || value.length > 16384) fail();
    environment[key] = value;
  }
  if (!environment.PGPASSWORD) fail();
  const spawn = options.spawn || childProcess.spawn; if (typeof spawn !== 'function') fail();
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > LIMITS.timeoutMs) fail();
  const args = ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align', '--pset=pager=off', '--set=ON_ERROR_STOP=1',
    `--host=${connection.host}`, `--port=${connection.port}`, `--username=${connection.user}`, `--dbname=${connection.database}`, '--file=-'];
  let closed = false, queued = 0, serial = Promise.resolve(), active = null, terminationFailed = false;
  const closing = deferred();
  let initializedCatalog = null, stagingUsed = false, stagingLoaded = false;
  function run(script, onLine, readOnly) {
    if (closed) return Promise.reject(new BackupPostgresError('CLOSED'));
    if (queued >= LIMITS.queued) return Promise.reject(new BackupPostgresError('BUSY'));
    queued++; const enqueued = performance.now();
    const result = serial.then(async () => {
      if (closed) fail('CLOSED');
      const remaining = timeoutMs - (performance.now() - enqueued); if (remaining <= 0) fail('TIMEOUT');
      let child, reason, killTimer, reapTimer, timer, outputBytes = 0, inputBytes = 0, stderrBytes = 0, finished = false;
      const exit = deferred(), abort = deferred();
      function terminate(code) {
        if (finished) return;
        reason ||= code; abort.reject(new BackupPostgresError(reason));
        try { child?.kill('SIGTERM'); } catch {}
        killTimer ||= setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 200);
        reapTimer ||= setTimeout(() => { terminationFailed = true; exit.resolve('TERMINATION'); }, 2000);
      }
      try { child = spawn(psqlPath, args, { env: { ...environment }, cwd: path.dirname(psqlPath), shell: false,
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch { fail('PG_FAILED'); }
      active = { terminate };
      child.once('error', () => { if (child.pid) terminate('PG_FAILED'); else { reason ||= 'PG_FAILED'; abort.reject(new BackupPostgresError(reason)); exit.resolve(reason); } });
      child.once('close', code => { if (code !== 0) { reason ||= 'PG_FAILED'; abort.reject(new BackupPostgresError(reason)); } exit.resolve(reason || null); });
      child.stdin.on('error', () => terminate('PG_FAILED'));
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > LIMITS.stderrBytes) terminate('LIMIT'); });
      timer = setTimeout(() => terminate('TIMEOUT'), remaining);
      const checked = promise => Promise.race([promise, abort.promise]);
      const write = async text => {
        if (reason || closed) fail(reason || 'CLOSED');
        inputBytes += Buffer.byteLength(text); if (inputBytes > LIMITS.inputBytes) fail('LIMIT');
        if (!child.stdin.write(text)) await checked(once(child.stdin, 'drain'));
      };
      const writer = (async () => {
        await write(`${readOnly ? 'begin isolation level repeatable read read only;' : 'begin;'}\nset local search_path=pg_catalog,public;\nset local timezone='UTC';\nset local datestyle='ISO,YMD';\nset local extra_float_digits=3;\nset local standard_conforming_strings=on;\nset local statement_timeout='60000ms';\nset local lock_timeout='5000ms';\nset local idle_in_transaction_session_timeout='120000ms';\n`);
        const iterator = script()[Symbol.asyncIterator]();
        for (;;) { const next = await checked(iterator.next()); if (next.done) break; await write(next.value); }
        await write('commit;\n'); child.stdin.end();
      })();
      const reader = (async () => {
        const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '';
        for await (const chunk of child.stdout) {
          outputBytes += chunk.length; if (outputBytes > LIMITS.totalBytes) fail('LIMIT');
          pending += decoder.decode(chunk, { stream: true });
          let at;
          while ((at = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, at); pending = pending.slice(at + 1);
            if (Buffer.byteLength(line) > LIMITS.rowBytes) fail('LIMIT');
            if (line.length) { let value; try { value = JSON.parse(line); } catch { fail('PG_FAILED'); }
              await checked(Promise.resolve().then(() => onLine(value))); }
          }
          if (Buffer.byteLength(pending) > LIMITS.rowBytes) fail('LIMIT');
        }
        pending += decoder.decode(); if (pending.length) fail('PG_FAILED');
      })();
      // Observe both concurrent tasks immediately; either failure terminates the same transaction.
      const work = Promise.all([writer, reader]); work.catch(() => {});
      try {
        await checked(work); const outcome = await exit.promise; if (outcome) fail(outcome);
      } catch (error) {
        const code = error instanceof BackupPostgresError ? error.code.slice('BACKUP_PG_'.length) : 'PG_FAILED';
        terminate(code); const outcome = await exit.promise; if (outcome === 'TERMINATION') fail('TERMINATION'); fail(reason || code);
      } finally {
        finished = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(reapTimer); active = null;
      }
    });
    serial = result.catch(() => {}).finally(() => { queued--; });
    return result;
  }

  async function exportRows({ writeRow } = {}) {
    if (typeof writeRow !== 'function') fail();
    if (mode === 'staging' && !stagingLoaded) fail('STAGING');
    const accepted = deferred(); let result, sequencesSeen = false, revisionsSeen = false, tableIndex = -1, current = null, count = 0, rowHash, ended = false, total = 0;
    async function* script() {
      yield headerSql(installationId, true);
      await accepted.promise;
      yield sequenceSql();
      yield revisionSql();
      for (const table of TABLES) yield tableSql(table);
      yield "select jsonb_build_object('kind','done');\n";
    }
    try {
      await run(script, async value => {
        if (!result) {
          const fingerprint = validateHeader(value, migrations, true);
          result = summary(value.owner.ownerUserId, fingerprint); accepted.resolve(); return;
        }
        if (ended) fail('INTEGRITY');
        if (!sequencesSeen) {
          exact(value, ['kind', 'values'], 'INTEGRITY'); if (value.kind !== 'sequences') fail('INTEGRITY');
          result.sequenceHighWater = validateSequenceHighWater(value.values); sequencesSeen = true; return;
        }
        if (!revisionsSeen) {
          exact(value, ['kind', 'values'], 'INTEGRITY'); if (value.kind !== 'revisions') fail('INTEGRITY');
          result.preferenceRevisionHighWater = validateRevisions(value.values); revisionsSeen = true; return;
        }
        if (value.kind === 'table') {
          exact(value, ['kind', 'table'], 'INTEGRITY');
          if (current !== null || value.table !== TABLES[++tableIndex]?.name) fail('INTEGRITY');
          current = value.table; count = 0; rowHash = crypto.createHash('sha256'); return;
        }
        if (value.kind === 'row') {
          exact(value, ['kind', 'table', 'values'], 'ROW'); if (value.table !== current || current === null) fail('INTEGRITY');
          if (++total > LIMITS.rows) fail('LIMIT'); count++;
          const projected = decodeRow(current, value.values); rowHash.update(`${canonical(projected)}\n`);
          try { await writeRow(projected); } catch { fail('CALLBACK'); } return;
        }
        if (value.kind === 'end') {
          exact(value, ['kind', 'table', 'count'], 'INTEGRITY');
          if (current === null || value.table !== current || value.count !== String(count)) fail('INTEGRITY');
          result.tableCounts[current] = String(count); result.tableSha256[current] = rowHash.digest('hex'); current = null; return;
        }
        exact(value, ['kind'], 'INTEGRITY');
        if (value.kind !== 'done' || current !== null || tableIndex !== TABLES.length - 1) fail('INTEGRITY'); ended = true;
      }, true);
      if (!ended || !sequencesSeen || !revisionsSeen) fail('INTEGRITY'); result.rowCount = String(total); return freeze(result);
    } catch (error) { accepted.reject(error); throw error; }
  }

  async function initializeStaging() {
    if (mode !== 'staging' || initializedCatalog !== null || stagingUsed) fail('STAGING');
    stagingUsed = true; let headerSeen = false; const verified = deferred();
    async function* script() {
      yield `do $empty$ begin if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public') or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public') then raise exception 'staging not empty'; end if; end $empty$;\n`;
      yield 'set local search_path=public,pg_catalog;\n';
      for (const migration of migrations) yield `${migration.sql}\n`;
      yield 'set local search_path=pg_catalog,public;\n';
      yield `create table public.flyway_schema_history(installed_rank integer not null primary key,version varchar(50),
        description varchar(200) not null,type varchar(20) not null,script varchar(1000) not null,checksum integer,
        installed_by varchar(100) not null,installed_on timestamp not null default now(),execution_time integer not null,success boolean not null);
        create index flyway_schema_history_s_idx on public.flyway_schema_history(success);\n`;
      for (const m of migrations) {
        const values = jsonSql({ version: String(m.version), script: m.filename,
          description: m.filename.replace(/^V[0-9]+__/, '').replace(/\.sql$/, '').replace(/_/g, ' '), checksum: m.checksum });
        yield `insert into public.flyway_schema_history(installed_rank,version,description,type,script,checksum,installed_by,execution_time,success)
          select ${m.version},v->>'version',v->>'description','SQL',v->>'script',(v->>'checksum')::integer,current_user,0,true from(select ${values} v) x;\n`;
      }
      yield headerSql(installationId, false);
      await verified.promise;
    }
    try {
      await run(script, value => { if (headerSeen) fail('SCHEMA'); initializedCatalog = validateHeader(value, migrations, false);
        headerSeen = true; verified.resolve(); }, false);
    } catch (error) { initializedCatalog = null; verified.reject(error); throw error; }
    if (!headerSeen) fail('SCHEMA'); stagingUsed = false;
    return freeze({ version: 1, schema: REVIEWED_SCHEMA, catalogSha256: initializedCatalog });
  }

  async function readSequenceHighWater() {
    if (mode !== 'export' && !stagingLoaded) fail('STAGING');
    const accepted = deferred(); let headerSeen = false, result;
    async function* script() { yield headerSql(installationId, true); await accepted.promise; yield sequenceSql(); }
    try {
      await run(script, value => {
        if (!headerSeen) { validateHeader(value, migrations, true); headerSeen = true; accepted.resolve(); return; }
        exact(value, ['kind', 'values'], 'INTEGRITY'); if (value.kind !== 'sequences' || result) fail('INTEGRITY');
        result = validateSequenceHighWater(value.values);
      }, true);
      if (!result) fail('INTEGRITY'); return result;
    } catch (error) { accepted.reject(error); throw error; }
  }
  async function readPreferenceRevisionHighWater() {
    if (mode !== 'export' && !stagingLoaded) fail('STAGING');
    const accepted = deferred(); let headerSeen = false, result;
    async function* script() { yield headerSql(installationId, true); await accepted.promise; yield revisionSql(); }
    try {
      await run(script, value => {
        if (!headerSeen) { validateHeader(value, migrations, true); headerSeen = true; accepted.resolve(); return; }
        exact(value, ['kind', 'values'], 'INTEGRITY'); if (value.kind !== 'revisions' || result) fail('INTEGRITY');
        result = validateRevisions(value.values);
      }, true);
      if (!result) fail('INTEGRITY'); return result;
    } catch (error) { accepted.reject(error); throw error; }
  }
  async function readRetainedCommitTimes(argument) {
    if (mode !== 'export') fail('STAGING');
    exact(argument, ['snapshotIds']); const input = argument.snapshotIds;
    if (!Array.isArray(input) || isProxy(input) || input.length > 10000 || Reflect.ownKeys(input).length !== input.length + 1) fail();
    const ids = [];
    for (let i = 0; i < input.length; i++) {
      const d = Object.getOwnPropertyDescriptor(input, String(i));
      if (!d || !Object.hasOwn(d, 'value') || !positiveId(d.value) || d.value.match(/^[1-9][0-9]{0,18}$/)?.[0] !== d.value) fail();
      ids.push(d.value);
    }
    if (new Set(ids).size !== ids.length) fail();
    const accepted = deferred(); let headerSeen = false, result;
    async function* script() {
      yield headerSql(installationId, true); await accepted.promise;
      yield `with requested as (select value::bigint id from jsonb_array_elements_text(${jsonSql(ids)})),
        times as (select s.id,
          floor(extract(epoch from coalesce(c.committed_at,i.approved_at)))::text as seconds
        from requested q join public.snapshots s on s.id=q.id and s.source_contract_version=1
        join public.projects p on p.id=s.project_id join public.users u on u.id=p.user_id
        join public.source_manifests m on m.snapshot_id=s.id and m.project_id=p.id
          and m.contract_version=s.source_contract_version and m.source_kind='LOCAL' and m.sealed_at is not null
        left join public.commits c on c.project_id=p.id and c.sha=s.commit_sha
        left join public.analysis_jobs j on j.id=m.job_id and j.project_id=p.id and j.snapshot_id=s.id
        left join public.job_local_source_inputs i on i.job_id=j.id and i.project_id=m.project_id
          and i.schema_version=m.contract_version and i.manifest_sha256=m.approval_manifest_sha256
          and i.limits_sha256=m.limits_sha256 and i.policy_version=m.policy_version)
        select jsonb_build_object('kind','retained-times','values',coalesce(jsonb_object_agg(id::text,seconds),'{}'::jsonb)) from times;\n`;
    }
    try {
      await run(script, value => {
        if (!headerSeen) { validateHeader(value, migrations, true); headerSeen = true; accepted.resolve(); return; }
        exact(value, ['kind', 'values'], 'INTEGRITY'); if (value.kind !== 'retained-times' || result) fail('INTEGRITY');
        exact(value.values, ids, 'INTEGRITY');
        for (const seconds of Object.values(value.values)) {
          if (seconds !== null && (typeof seconds !== 'string' || seconds.match(/^(?:0|-?[1-9][0-9]{0,18})$/)?.[0] !== seconds
              || BigInt(seconds) < -9223372036854775808n || BigInt(seconds) > 9223372036854775807n)) fail('INTEGRITY');
        }
        result = freeze({ ...value.values });
      }, true);
      if (!result) fail('INTEGRITY'); return result;
    } catch (error) { accepted.reject(error); throw error; }
  }
  async function measureExport() {
    if (mode !== 'export') fail('STAGING');
    let rowFrameBytes = 0n;
    const measured = await exportRows({ writeRow: row => { rowFrameBytes += 4n + BigInt(Buffer.byteLength(canonical({ kind: 'ROW', row }))); } });
    const databaseFrameBytes = 4n + BigInt(Buffer.byteLength(canonical({ kind: 'DATABASE', summary: measured })));
    // Exact sizes of the existing typed payload frames. Source objects, HEADER/FOOTER,
    // AEAD envelope, physical PG storage/indexes/WAL and a later changed snapshot are separate.
    return freeze({ version: 1, rowCount: measured.rowCount, rowFrameBytes: String(rowFrameBytes),
      databaseFrameBytes: String(databaseFrameBytes), databasePayloadBytes: String(rowFrameBytes + databaseFrameBytes), summary: measured });
  }
  async function loadRows({ rows, expected: supplied, writeAccounting, liveSequenceHighWater, liveOwnerUserId,
    livePreferenceRevisionHighWater } = {}) {
    const started = performance.now();
    if (mode !== 'staging' || !initializedCatalog || stagingUsed) fail('STAGING');
    const expected = validateSummary(supplied);
    if (expected.catalogSha256 !== initializedCatalog) fail('SCHEMA');
    if (!positiveId(liveOwnerUserId) || liveOwnerUserId !== expected.ownerUserId) fail('OWNER');
    const liveRevisions = validateRevisions(livePreferenceRevisionHighWater);
    if (!rows || typeof writeAccounting !== 'function') fail();
    const iteratorFunction = rows[Symbol.asyncIterator] || rows[Symbol.iterator];
    if (typeof iteratorFunction !== 'function') fail();
    const floors = liveSequenceHighWater === undefined ? Object.fromEntries(SEQUENCES.map(s => [s.key, '0']))
      : validateSequenceHighWater(liveSequenceHighWater);
    stagingUsed = true;
    const accounting = [], preferences = new Map(), legacyPreferences = new Map(), users = new Map();
    let heldBytes = 0, ownerSeen = false, sourceComplete = false, readbackEnded = false, offSeen = false;
    const targetCounts = { ...expected.tableCounts }, targetHashes = { ...expected.tableSha256 };
    let inputRows = 0, readTable = null, readIndex = -1, readCount = 0, readHash, headerSeen = false;
    const accepted = deferred(), verified = deferred();
    function retain(value) { heldBytes += Buffer.byteLength(canonical(value)); if (heldBytes > LIMITS.accountingBytes) fail('LIMIT'); }
    function nextRevision(userId) {
      const old = BigInt(expected.preferenceRevisionHighWater[userId] || '0'), live = BigInt(liveRevisions[userId] || '0');
      const next = (old > live ? old : live) + 1n; if (next > 9223372036854775807n) fail('INTEGRITY'); return next.toString();
    }
    async function* script() {
      // Recheck the freshly created schema and emptiness in the actual load transaction.
      yield headerSql(installationId, false);
      await accepted.promise;
      yield `do $empty$ begin if ${TABLES.map(t => `exists(select 1 from public.${quote(t.name)})`).join(' or ')}
        then raise exception 'staging not empty'; end if; end $empty$;
        create temporary table backup_project_pointers(id bigint primary key,snapshot_id bigint,generation_id uuid) on commit drop;
        create temporary table backup_feature_parents(id bigint primary key,parent_id bigint) on commit drop;
        create temporary table backup_manifest_seals(id uuid primary key,sealed_at timestamptz) on commit drop;
        create temporary table backup_keyless(user_id bigint primary key,provider text,model text,created_at timestamptz,updated_at timestamptz) on commit drop;
        set constraints all deferred;\n`;
      const iterator = iteratorFunction.call(rows);
      for (const table of TABLES) {
        const count = Number(expected.tableCounts[table.name]), observedHash = crypto.createHash('sha256');
        for (let index = 0; index < count; index++) {
          const next = await iterator.next(); if (next.done) fail('INTEGRITY');
          const row = next.value;
          if (!row || typeof row !== 'object' || isProxy(row)) fail('ROW');
          // Policy checks all selected columns and does not invoke getters. Do the envelope shape first.
          const tableProperty = Object.getOwnPropertyDescriptor(row, 'table');
          const valuesProperty = Object.getOwnPropertyDescriptor(row, 'values');
          if (!tableProperty || !Object.hasOwn(tableProperty, 'value') || tableProperty.value !== table.name
              || !valuesProperty || !Object.hasOwn(valuesProperty, 'value')) fail('ROW');
          let projected;
          try { projected = POLICY.projectRow(table.name, valuesProperty.value); } catch (error) { fail(error.code === 'ACTIVE_JOB' ? 'ACTIVE_JOB' : 'ROW'); }
          exact(row, Object.keys(projected), 'ROW');
          for (const key of Object.keys(projected).filter(k => k !== 'values')) {
            if (projected[key] && typeof projected[key] === 'object') {
              exact(row[key], Object.keys(projected[key]), 'ROW');
              if (Object.keys(projected[key]).some(k => row[key][k] !== projected[key][k])) fail('ROW');
            } else if (row[key] !== projected[key]) fail('ROW');
          }
          observedHash.update(`${canonical(projected)}\n`); inputRows++;
          if (table.name === 'users') {
            const local = ['LOCAL', 'LOCAL_LINKED'].includes(projected.values.identity_type);
            if ((projected.values.id === expected.ownerUserId) !== local || (local && ownerSeen)) fail('OWNER');
            if (local) ownerSeen = true;
            if (Object.hasOwn(liveRevisions, projected.values.id)) { retain(projected); users.set(projected.values.id, projected.values); }
          }
          if (FINANCIAL.has(table.name)) { retain(projected); accounting.push(projected); continue; }
          if (table.name === 'user_ai_preferences') { retain(projected); preferences.set(projected.values.user_id, projected); }
          if (table.name === 'user_ai_settings') { retain(projected); legacyPreferences.set(projected.values.user_id, projected); }
          yield insertRowSql(projected, expected.ownerUserId, installationId,
            table.name === 'user_ai_preferences' ? nextRevision(projected.values.user_id) : '0');
        }
        if (observedHash.digest('hex') !== expected.tableSha256[table.name]) fail('INTEGRITY');
      }
      if (!(await iterator.next()).done || !ownerSeen || String(inputRows) !== expected.rowCount) fail('INTEGRITY');
      sourceComplete = true;
      if (canonical([...preferences.keys()].sort()) !== canonical(Object.keys(expected.preferenceRevisionHighWater).sort())) fail('INTEGRITY');
      for (const [userId, legacy] of legacyPreferences) {
        if (!preferences.has(userId)) {
          const values = Object.fromEntries(POLICY.columnsFor('user_ai_preferences').map(name => [name, legacy.values[name]]));
          preferences.set(userId, POLICY.projectRow('user_ai_preferences', values));
          yield insertRowSql(preferences.get(userId), expected.ownerUserId, installationId, nextRevision(userId));
        }
      }
      for (const [userId, user] of users) {
        if (!preferences.has(userId)) {
          const projected = POLICY.projectRow('user_ai_preferences', { user_id: userId, provider: null, model: null,
            created_at: user.created_at, updated_at: user.updated_at });
          preferences.set(userId, projected);
          yield insertRowSql(projected, expected.ownerUserId, installationId, nextRevision(userId));
        }
      }
      const preferenceHash = crypto.createHash('sha256');
      [...preferences.values()].sort((a, b) => BigInt(a.values.user_id) < BigInt(b.values.user_id) ? -1 : 1)
        .forEach(row => preferenceHash.update(`${canonical(row)}\n`));
      targetCounts.user_ai_preferences = String(preferences.size); targetHashes.user_ai_preferences = preferenceHash.digest('hex');
      for (const name of ['user_ai_settings', ...FINANCIAL]) { targetCounts[name] = '0'; targetHashes[name] = digest(''); }
      yield `update public.features f set parent_id=p.parent_id from pg_temp.backup_feature_parents p where f.id=p.id;
        update public.source_manifests m set sealed_at=s.sealed_at from pg_temp.backup_manifest_seals s where m.id=s.id and s.sealed_at is not null;
        update public.projects p set current_snapshot_id=t.snapshot_id,current_generation_id=t.generation_id
          from pg_temp.backup_project_pointers t where p.id=t.id;
        set constraints all immediate;\n`;
      for (const s of SEQUENCES) {
        const floor = BigInt(expected.sequenceHighWater[s.key]) > BigInt(floors[s.key]) ? expected.sequenceHighWater[s.key] : floors[s.key];
        const historical = s.table === 'analysis_jobs' ? ',coalesce((select max(job_id) from public.source_manifests),0),coalesce((select max(job_id) from public.analysis_generations),0)' : '';
        // setval is deliberately last: a failed staging load is never reused, even though sequence changes are nontransactional.
        yield `do $sequence$ declare high bigint; begin select greatest(${floor}::bigint,coalesce(max(${quote(s.column)}),0)${historical})
          into high from public.${quote(s.table)};
          if high=9223372036854775807 then raise exception 'sequence exhausted'; end if;
          perform setval('public.${s.name}'::regclass,greatest(high,1),high>0); end $sequence$;\n`;
      }
      yield headerSql(installationId, true);
      for (const table of TABLES) yield tableSql(table);
      const revisions = Object.fromEntries([...preferences.keys()].map(id => [id, nextRevision(id)]));
      yield `select jsonb_build_object('kind','off','valid',
        (select count(*) from public.user_ai_preferences)=${preferences.size}
        and not exists(select 1 from public.user_ai_preferences p left join jsonb_each_text(${jsonSql(revisions)}) r on r.key=p.user_id::text
          where r.key is null or p.revision<>(r.value)::bigint or p.connection_state<>'OFF'));\n`;
      yield "select jsonb_build_object('kind','done');\n";
      await verified.promise;
    }
    try {
      await run(script, value => {
        if (!headerSeen) {
          if (validateHeader(value, migrations, false) !== initializedCatalog) fail('SCHEMA');
          headerSeen = true; accepted.resolve(); return;
        }
        if (value.kind === 'header') {
          if (!sourceComplete || validateHeader(value, migrations, true) !== initializedCatalog
              || value.owner.ownerUserId !== expected.ownerUserId || readIndex !== -1) fail('INTEGRITY');
          readIndex = -2; return;
        }
        if (readbackEnded || readIndex === -1) fail('INTEGRITY');
        if (value.kind === 'table') {
          exact(value, ['kind', 'table'], 'INTEGRITY');
          readIndex = readIndex === -2 ? 0 : readIndex + 1;
          if (readTable !== null || value.table !== TABLES[readIndex]?.name) fail('INTEGRITY');
          readTable = value.table; readCount = 0; readHash = crypto.createHash('sha256'); return;
        }
        if (value.kind === 'row') {
          exact(value, ['kind', 'table', 'values'], 'ROW'); if (readTable === null || value.table !== readTable) fail('INTEGRITY');
          readCount++; if (readCount > Number(targetCounts[readTable])) fail('INTEGRITY');
          readHash.update(`${canonical(decodeRow(readTable, value.values))}\n`); return;
        }
        if (value.kind === 'end') {
          exact(value, ['kind', 'table', 'count'], 'INTEGRITY');
          if (value.table !== readTable || readTable === null || value.count !== String(readCount)
              || value.count !== targetCounts[readTable] || readHash.digest('hex') !== targetHashes[readTable]) fail('INTEGRITY');
          readTable = null; return;
        }
        if (value.kind === 'off') {
          exact(value, ['kind', 'valid'], 'INTEGRITY');
          if (offSeen || value.valid !== true || readTable !== null || readIndex !== TABLES.length - 1) fail('INTEGRITY');
          offSeen = true; return;
        }
        exact(value, ['kind'], 'INTEGRITY');
        if (value.kind !== 'done' || readTable !== null || readIndex !== TABLES.length - 1 || !offSeen) fail('INTEGRITY');
        readbackEnded = true; verified.resolve();
      }, false);
      if (!sourceComplete || !readbackEnded) fail('INTEGRITY');
      // Publication is after complete data validation, successful PG COMMIT, and full readback.
      for (const row of accounting) {
        if (closed) fail('CLOSED');
        const remaining = timeoutMs - (performance.now() - started); if (remaining <= 0) fail('TIMEOUT');
        let timer;
        try {
          const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new BackupPostgresError('TIMEOUT')), remaining); });
          await Promise.race([Promise.resolve().then(() => writeAccounting(row)), deadline, closing.promise]);
        } catch (error) {
          if (error instanceof BackupPostgresError && ['BACKUP_PG_TIMEOUT', 'BACKUP_PG_CLOSED'].includes(error.code)) throw error;
          fail('CALLBACK');
        } finally { clearTimeout(timer); }
      }
      stagingLoaded = true;
      return freeze({ version: 1, ownerUserId: expected.ownerUserId, catalogSha256: initializedCatalog,
        tableCounts: targetCounts, tableSha256: targetHashes, accountingRows: String(accounting.length),
        reconciliationRequired: true, credentialsRestored: false });
    } catch (error) { accepted.reject(error); verified.reject(error); throw error; }
  }
  let closePromise;
  function close() {
    if (closePromise) return closePromise;
    closed = true; closing.reject(new BackupPostgresError('CLOSED')); active?.terminate('CLOSED');
    closePromise = serial.then(() => { delete environment.PGPASSWORD; if (terminationFailed) fail('TERMINATION'); });
    return closePromise;
  }
  return Object.freeze({ exportRows, initializeStaging, loadRows, readSequenceHighWater, readPreferenceRevisionHighWater,
    readRetainedCommitTimes, measureExport, close });
}

// Pure manifest-shape validation only: this does not authenticate an archive or verify a live DB.
module.exports = Object.freeze({ createBackupPostgres, validateBackupSummary: validateSummary, BackupPostgresError, LIMITS });
