'use strict';

// Production runtime exclusion check (supply-chain defect D2). Fails when the
// backend runtime contains a Maven artefact that licence-policy.json lists under
// excludedRuntime. Usage from the repository root:
//   node validation/pre-release/sbom-runtime-exclusions.cjs --jar <absolute Spring Boot JAR>
//   node validation/pre-release/sbom-runtime-exclusions.cjs --resolved runtime-resolved-X.json
// A JAR is read into memory and its BOOT-INF/lib members are identified by their
// own pom.properties and by class prefix; nothing is extracted or run. A
// resolution file is the output of runtime-inventory.init.gradle in
// validation/local/pre-release-final.
const fs = require('node:fs');
const path = require('node:path');
const zip = require('./sbom-zip.cjs');
const inventory = require('./inventory-candidate.cjs');
const licence = require('./licence-obligations.cjs');

const MiB = 1024 * 1024;
class ExclusionError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }
const need = (ok, code, detail) => { if (!ok) throw new ExclusionError(code, detail); };

function argumentsFor(argv) {
  need(Array.isArray(argv) && argv.length === 2, 'ARGUMENTS');
  if (argv[0] === '--jar') { need(path.isAbsolute(argv[1]) && path.normalize(argv[1]) === argv[1], 'ARGUMENTS'); return { jar: argv[1] }; }
  need(argv[0] === '--resolved' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.json$/.test(argv[1]), 'ARGUMENTS');
  return { resolved: argv[1] };
}

// One row per nested JAR; a JAR with several pom.properties (a shaded JAR) is
// reported under each of them.
function bootJarCoordinates(bytes) {
  const members = zip.listZip(bytes);
  need(members.some(item => item.name.startsWith('BOOT-INF/')), 'NOT_A_BOOT_JAR');
  const rows = [];
  for (const member of members.filter(item => item.type === 'file' && /^BOOT-INF\/lib\/[^/]+\.jar$/.test(item.name))) {
    const nested = zip.readMember(bytes, member, 128 * MiB), entries = zip.listZip(nested);
    const fileName = path.posix.basename(member.name);
    const classes = entries.filter(item => item.type === 'file' && item.name.endsWith('.class')).map(item => item.name);
    const poms = entries.filter(item => item.type === 'file' && /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/.test(item.name));
    const coordinates = poms.map(item => inventory.javaMetadata(zip.readMember(nested, item, MiB), 'pom'))
      .filter(fields => fields.groupId && fields.artifactId);
    if (!coordinates.length) rows.push({ fileName, groupId: null, artifactId: null, version: null, classes });
    for (const fields of coordinates) rows.push({ fileName, groupId: fields.groupId, artifactId: fields.artifactId, version: fields.version || null, classes });
  }
  return rows;
}

function resolvedCoordinates(resolved) {
  need(resolved?.kind === 'RESOLVED_GRADLE_RUNTIME_ARTIFACTS' && Array.isArray(resolved.components), 'RESOLVED_MAVEN_INVALID');
  return resolved.components.map(({ groupId, artifactId, version, fileName }) => ({ fileName, groupId, artifactId, version, classes: [] }));
}

function check(coordinates, policy = licence.POLICY) {
  const excluded = [];
  for (const item of coordinates) {
    let rule = licence.excludedRuntime(item, policy), matchedBy = rule ? 'MAVEN_COORDINATE' : null;
    if (!rule) {
      rule = (policy.excludedRuntime || []).find(entry => item.classes.some(name => name.startsWith(entry.classPrefix))) || null;
      matchedBy = rule ? 'CLASS_PREFIX' : null;
    }
    if (rule) excluded.push({ fileName: item.fileName, groupId: item.groupId, artifactId: item.artifactId, version: item.version,
      rule: rule.artifact ? `${rule.group}:${rule.artifact}` : rule.group, matchedBy, reason: rule.reason });
  }
  // A nested JAR listed under several coordinates counts once.
  return { status: excluded.length ? 'FAIL' : 'PASS', checked: new Set(coordinates.map(item => item.fileName)).size, excluded };
}

function main(argv) {
  const options = argumentsFor(argv);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  if (options.jar) {
    const stat = fs.lstatSync(options.jar);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * MiB, 'JAR_UNSAFE_OR_LIMIT');
    return { input: options.jar, ...check(bootJarCoordinates(fs.readFileSync(options.jar))) };
  }
  const file = path.join(repo, 'validation/local/pre-release-final', options.resolved);
  return { input: path.relative(repo, file), ...check(resolvedCoordinates(JSON.parse(fs.readFileSync(file, 'utf8')))) };
}

module.exports = { argumentsFor, bootJarCoordinates, resolvedCoordinates, check, main };
if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'EXCLUSION_CHECK_FAILED', code: error.code || error.name, detail: error.detail || null }) + '\n');
    process.exitCode = 1;
  }
}
