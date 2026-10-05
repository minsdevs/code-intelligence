'use strict';

// Opt-in public dependency-coordinate lookup. Sends no source, credentials, paths,
// root application package, runtime files or inventory hashes to the provider.
// Names/versions first go to public registries for anonymous publication checks;
// only confirmed coordinates go onward to OSV. This is not artifact provenance.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { ensureOutputParent } = require('./owned-output.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function queriesFromInventory(inventory, resolved) {
  assert.equal(inventory.kind, 'STATIC_COMPONENT_PROVENANCE_INVENTORY');
  assert(Array.isArray(inventory.packages) && Array.isArray(inventory.backend?.components));
  const queries = new Map(), omitted = []; let hashMatchedJars = 0;
  // Omitted input permits the explicitly documented legacy metadata mode.
  // Supplied malformed JSON values, including null/false/0, must not select it.
  const hasResolved = resolved !== undefined;
  if (hasResolved) {
    assert(resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved), 'RESOLVED_MAVEN_INVALID');
    assert.equal(resolved.kind, 'RESOLVED_GRADLE_RUNTIME_ARTIFACTS');
    assert(Array.isArray(resolved.components) && resolved.components.length <= 3000);
  }
  function add(ecosystem, name, version) {
    assert(typeof name === 'string' && name.length <= 320 && typeof version === 'string' && version.length <= 160);
    const query = { package: { ecosystem, name }, version };
    queries.set(JSON.stringify(query), query);
  }
  for (const item of inventory.packages) {
    // Root package.json identifies this user's app, not an external dependency.
    if (item.evidence?.entryPathSha256 === sha('package.json')) continue;
    if (item.declaredPrivate === true) { omitted.push({ kind: 'npm', reason: 'DECLARED_PRIVATE_EXCLUDED' }); continue; }
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(item.name || '')
        || !/^[0-9][A-Za-z0-9._+-]*$/.test(item.version || '')) { omitted.push({ kind: 'npm', reason: 'UNVERIFIED_COORDINATES' }); continue; }
    add('npm', item.name, item.version);
  }
  for (const item of inventory.backend.components) {
    const matches = hasResolved ? resolved.components.filter(artifact => artifact.sha256 === item.evidence?.sha256
      && /^[a-f0-9]{64}$/.test(artifact.sha256) && artifact.fileName === item.fileName) : [];
    const coordinates = new Map();
    for (const artifact of matches) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(artifact.groupId || '')
          || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(artifact.artifactId || '')
          || !/^[0-9][A-Za-z0-9._+-]*$/.test(artifact.version || '')) continue;
      coordinates.set(artifact.groupId + ':' + artifact.artifactId + ':' + artifact.version, artifact);
    }
    if (coordinates.size === 1) {
      const artifact = [...coordinates.values()][0];
      add('Maven', artifact.groupId + ':' + artifact.artifactId, artifact.version); hashMatchedJars++;
      continue;
    }
    if (coordinates.size > 1) { omitted.push({ kind: 'jar', fileName: item.fileName, reason: 'AMBIGUOUS_RESOLVED_COORDINATES' }); continue; }
    if (hasResolved) { omitted.push({ kind: 'jar', fileName: item.fileName, reason: 'NO_HASH_MATCHED_RESOLVED_COORDINATES' }); continue; }
    const poms = (item.metadata || []).filter(record => record.kind === 'pom' && record.status === 'DECLARED_STATIC_METADATA'
      && record.fields?.groupId && record.fields?.artifactId && record.fields?.version);
    if (!poms.length) { omitted.push({ kind: 'jar', fileName: item.fileName,
      reason: item.metadataInspection === 'UNSUPPORTED_ARCHIVE_LAYOUT' ? item.metadataInspection : 'NO_MAVEN_COORDINATES' }); continue; }
    for (const pom of poms) add('Maven', pom.fields.groupId + ':' + pom.fields.artifactId, pom.fields.version);
  }
  assert(queries.size > 0 && queries.size <= 3000);
  return { queries: [...queries.values()], omitted, hashMatchedJars };
}

function registryUrl(query) {
  const { ecosystem, name } = query.package; const version = query.version;
  assert(/^[0-9][A-Za-z0-9._+-]*$/.test(version));
  if (ecosystem === 'npm') {
    assert(/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name));
    return 'https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + encodeURIComponent(version);
  }
  assert.equal(ecosystem, 'Maven');
  const parts = name.split(':'); assert.equal(parts.length, 2);
  const [group, artifact] = parts;
  for (const value of parts) assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && !value.includes('..'));
  return 'https://repo.maven.apache.org/maven2/' + group.replaceAll('.', '/') + '/' + artifact + '/' + version + '/' + artifact + '-' + version + '.pom';
}
async function verifyPublicCoordinates(queries, get) {
  const checked = new Array(queries.length); let index = 0;
  async function worker() {
    while (index < queries.length) {
      const at = index++, query = queries[at];
      try {
        const response = await get(registryUrl(query));
        let publicVersion = response.status === 200;
        if (publicVersion && query.package.ecosystem === 'npm') {
          const data = JSON.parse(response.body);
          publicVersion = data.name === query.package.name && data.version === query.version && data.private !== true;
        } else if (publicVersion) publicVersion = /<project[\s>]/.test(response.body) && response.body.includes('<modelVersion>4.0.0</modelVersion>');
        checked[at] = { query, status: publicVersion ? 'ANONYMOUS_PUBLIC_REGISTRY_CONFIRMED' : 'PUBLICATION_UNVERIFIED',
          httpStatus: response.status, metadataSha256: sha(response.body) };
      } catch { checked[at] = { query, status: 'PUBLICATION_UNVERIFIED', httpStatus: null }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, queries.length) }, worker));
  return checked;
}

async function queryAll(queries, post) {
  const findings = queries.map(query => ({ query, ids: [] }));
  let requests = 0;
  for (let start = 0; start < queries.length; start += 100) {
    let pending = queries.slice(start, start + 100).map((query, i) => ({ index: start + i, query, seen: new Set() }));
    for (let page = 0; pending.length; page++) {
      assert(page < 20, 'ADVISORY_PAGE_LIMIT');
      const response = await post({ queries: pending.map(item => item.query) }); requests++;
      assert(Array.isArray(response.results) && response.results.length === pending.length, 'ADVISORY_RESPONSE');
      const next = [];
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i], result = response.results[i];
        assert(result && typeof result === 'object' && !result.error, 'ADVISORY_RESPONSE');
        assert(result.vulns === undefined || Array.isArray(result.vulns), 'ADVISORY_RESPONSE');
        for (const vuln of result.vulns || []) {
          assert(typeof vuln.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(vuln.id), 'ADVISORY_ID');
          if (!findings[item.index].ids.includes(vuln.id)) findings[item.index].ids.push(vuln.id);
        }
        if (result.next_page_token) {
          assert(typeof result.next_page_token === 'string' && result.next_page_token.length < 8192 && !item.seen.has(result.next_page_token), 'ADVISORY_PAGE_TOKEN');
          item.seen.add(result.next_page_token);
          next.push({ ...item, query: { ...queries[item.index], page_token: result.next_page_token } });
        }
      }
      pending = next;
    }
  }
  return { findings, requests };
}

async function main(argv = process.argv.slice(2)) {
  assert([5, 7].includes(argv.length)); assert.equal(argv[0], '--online-public-packages');
  assert.equal(argv[1], '--inventory'); assert.equal(argv[3], '--output');
  if (argv.length === 7) assert.equal(argv[5], '--resolved-maven');
  for (const name of [argv[2], argv[4], ...(argv.length === 7 ? [argv[6]] : [])]) assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.json$/.test(name));
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), parent = ensureOutputParent(repo, 'validation/local/pre-release-final');
  const input = path.join(parent, argv[2]), output = path.join(parent, argv[4]);
  const stat = fs.lstatSync(input); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024);
  let resolvedBytes, resolvedFile;
  if (argv.length === 7) {
    resolvedFile = path.join(parent, argv[6]); const checked = fs.lstatSync(resolvedFile);
    assert(checked.isFile() && !checked.isSymbolicLink() && checked.nlink === 1 && checked.size <= 4 * 1024 * 1024);
    resolvedBytes = fs.readFileSync(resolvedFile);
  }
  const bytes = fs.readFileSync(input), inventory = JSON.parse(bytes),
    selected = queriesFromInventory(inventory, resolvedBytes === undefined ? undefined : JSON.parse(resolvedBytes));
  const report = { format: 1, status: 'RUNNING', provider: 'OSV', endpoint: 'https://api.osv.dev/v1/querybatch',
    observedAt: new Date().toISOString(), inventorySha256: sha(bytes), candidate: inventory.candidate,
    sentFields: ['package ecosystem', 'package name', 'version', 'provider pagination token'],
    registryDisclosure: 'Selected dependency names/versions are sent to their public registry to check anonymous publication before OSV; no source or credentials.',
    selectedCoordinates: selected.queries.length, coordinates: 0, omitted: selected.omitted,
    hashMatchedResolvedJars: selected.hashMatchedJars, resolvedMavenSha256: resolvedBytes ? sha(resolvedBytes) : null,
    sourceSent: false, credentialsSent: false, completeSbom: false,
    coverageLimits: [resolvedBytes ? 'Observed npm manifests and exclusively filename+SHA256-matched Gradle runtime artifacts'
      : 'Observed npm manifests and declared nested Maven pom.properties; no resolved-artifact binding was supplied',
      'Root application packages excluded; unmatched and ambiguous coordinates excluded',
      'Native dependencies, JRE, Electron/Chromium/Node and bundled browser transitives are outside this query set',
      'No finding is not proof of safety, reachability or complete advisory coverage'] };
  const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const save = () => { fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(report, null, 2) + '\n', 0, 'utf8'); fs.fsyncSync(fd); };
  save();
  async function request(url, body) {
    assert(['https://api.osv.dev', 'https://registry.npmjs.org', 'https://repo.maven.apache.org'].includes(new URL(url).origin));
    const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000) });
    const reader = response.body.getReader(), pieces = []; let total = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.length;
      assert(total <= 4 * 1024 * 1024, 'ADVISORY_BODY_LIMIT'); pieces.push(Buffer.from(chunk.value)); } }
    finally { await reader.cancel(); }
    return { status: response.status, body: Buffer.concat(pieces).toString('utf8') };
  }
  async function jsonRequest(url, body) {
    assert.equal(new URL(url).origin, 'https://api.osv.dev');
    const response = await request(url, body); assert.equal(response.status, 200, 'ADVISORY_HTTP_STATUS');
    return JSON.parse(response.body);
  }
  try {
    report.registryChecks = await verifyPublicCoordinates(selected.queries, url => request(url));
    const publicQueries = report.registryChecks.filter(row => row.status === 'ANONYMOUS_PUBLIC_REGISTRY_CONFIRMED').map(row => row.query);
    for (const row of report.registryChecks.filter(row => row.status !== 'ANONYMOUS_PUBLIC_REGISTRY_CONFIRMED'))
      report.omitted.push({ kind: row.query.package.ecosystem, reason: 'PUBLICATION_UNVERIFIED', package: row.query.package.name, version: row.query.version });
    assert(publicQueries.length > 0, 'NO_PUBLIC_COORDINATES');
    report.coordinates = publicQueries.length; report.queriesSha256 = sha(JSON.stringify(publicQueries)); save();
    const result = await queryAll(publicQueries, body => jsonRequest(report.endpoint, body));
    report.results = result.findings; report.requests = result.requests;
    const ids = [...new Set(result.findings.flatMap(item => item.ids))];
    report.advisoryCount = ids.length; report.packagesWithAdvisories = result.findings.filter(item => item.ids.length).length;
    report.advisories = [];
    if (ids.length <= 200) for (const id of ids) {
      const advisory = await jsonRequest('https://api.osv.dev/v1/vulns/' + encodeURIComponent(id));
      assert.equal(advisory.id, id);
      report.advisories.push({ id, modified: advisory.modified, withdrawn: advisory.withdrawn || null,
        aliases: advisory.aliases || [], severity: advisory.severity || [],
        databaseSeverity: advisory.database_specific?.severity || null,
        affectedSeverity: (advisory.affected || []).map(item => item.ecosystem_specific?.severity).filter(Boolean) });
    }
    report.detailCoverage = ids.length <= 200 ? 'ALL_RETURNED_IDS' : 'LIMIT_EXCEEDED';
    assert.equal(sha(fs.readFileSync(input)), report.inventorySha256);
    if (resolvedFile) assert.equal(sha(fs.readFileSync(resolvedFile)), report.resolvedMavenSha256);
    report.status = ids.length ? 'ADVISORIES_REQUIRE_REVIEW' : 'NO_MATCHES_IN_QUERIED_COORDINATES';
  } catch { report.status = 'INCOMPLETE_QUERY'; report.failure = 'ADVISORY_QUERY_FAILED_OR_INVALID'; }
  finally { report.finishedAt = new Date().toISOString(); save(); fs.closeSync(fd); }
  console.log(JSON.stringify({ output: argv[4], status: report.status, coordinates: report.coordinates,
    advisoryCount: report.advisoryCount, packagesWithAdvisories: report.packagesWithAdvisories, omitted: report.omitted.length }));
  if (report.status === 'INCOMPLETE_QUERY') process.exitCode = 1;
}
module.exports = { queriesFromInventory, queryAll, registryUrl, verifyPublicCoordinates, main };
if (require.main === module) main().catch(() => { console.error('ADVISORY_SCAN_REFUSED'); process.exitCode = 1; });
