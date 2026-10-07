'use strict';

// Generates the third-party notices packaging input from one offline SBOM run:
//   node validation/pre-release/licence-notices.cjs --sbom-run run-XXXXXX
// Writes desktop/build/third-party-notices/{THIRD-PARTY-NOTICES.txt,third-party-notices.json}
// (packaged by electron-builder under Contents/Resources/legal/third-party).
// Licence texts come only from the candidate's own shipped files, the checkout's
// frontend node_modules at the exact locked version, or reference copies the
// SBOM run recorded. Nothing is fetched or invented: a component without an
// available text is listed as TEXT_MISSING and stays an open obligation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const licence = require('./licence-obligations.cjs');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const OUTPUT = 'desktop/build/third-party-notices';
const TEXT_FILE = /^(?:licen[cs]e|copying|notice|thirdpartynotices?|third-party-notices)(?:[._-][A-Za-z0-9._-]*)?$/i;
// These runtimes ship their own legal files elsewhere in the bundle.
const ELSEWHERE = Object.freeze({
  electron: 'Contents/Resources/legal/electron/LICENSE', chromium: 'Contents/Resources/legal/electron/LICENSES.chromium.html',
  v8: 'Contents/Resources/legal/electron/LICENSES.chromium.html', nodejs: 'Contents/Resources/legal/electron/LICENSES.chromium.html',
  ffmpeg: 'Contents/Resources/legal/electron/LICENSES.chromium.html', swiftshader: 'Contents/Resources/legal/electron/LICENSES.chromium.html',
  crashpad: 'Contents/Resources/legal/electron/LICENSES.chromium.html', 'squirrel-mac': 'Contents/Resources/legal/electron/LICENSES.chromium.html',
  'temurin-jre': 'Contents/Resources/runtime/jre/legal/', postgresql: 'Contents/Resources/runtime/postgres/share/code-intelligence-notices/',
  pgvector: 'Contents/Resources/runtime/postgres/share/code-intelligence-notices/', openssl: 'Contents/Resources/runtime/postgres/share/code-intelligence-notices/',
  redis: 'Contents/Resources/runtime/postgres/share/code-intelligence-notices/',
});
class NoticesError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }
const need = (ok, code, detail) => { if (!ok) throw new NoticesError(code, detail); };

function argumentsFor(argv) {
  need(Array.isArray(argv) && argv.length === 2 && argv[0] === '--sbom-run' && /^run-[A-Za-z0-9]{6}$/.test(argv[1]), 'ARGUMENTS');
  return { run: argv[1] };
}

// Frontend assets are minified bundles; their notices come from the checkout's
// installed module at the lock path (nested copies included) only when its
// version equals the locked version.
const LOCK_PATH = /^node_modules\/(?:(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+\/node_modules\/)*(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
function frontendTexts(frontendRoot, lockPath, name, version) {
  if (!LOCK_PATH.test(lockPath) || lockPath.split('/').some(part => part === '.' || part === '..')) return { status: 'LOCK_PATH_INVALID', texts: [] };
  const directory = path.join(frontendRoot, ...lockPath.split('/'));
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')); } catch { return { status: 'MODULE_MISSING', texts: [] }; }
  if (manifest.name !== name || manifest.version !== version) return { status: 'VERSION_MISMATCH', texts: [] };
  const texts = [];
  for (const file of fs.readdirSync(directory).filter(entry => TEXT_FILE.test(entry)).sort()) {
    const stat = fs.lstatSync(path.join(directory, file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(path.join(directory, file), 'utf8');
    texts.push({ sha256: sha256(text), text, location: `frontend/${lockPath}/${file}` });
  }
  return { status: texts.length ? 'CHECKOUT_MODULE_TEXT' : 'NO_TEXT_IN_MODULE', texts };
}

// Choose a deterministic reference text for a licence from shipped texts that
// identify unambiguously as that licence (most frequently shipped first).
function canonicalText(textsBySha, usage, spdx) {
  const candidates = [...textsBySha.entries()].filter(([, text]) => licence.identifyText(text) === spdx)
    .sort((a, b) => (usage.get(b[0]) || 0) - (usage.get(a[0]) || 0) || (a[0] < b[0] ? -1 : 1));
  return candidates.length ? candidates[0][0] : null;
}

function build({ obligations, textIndex, readText, frontendRoot, candidate }) {
  const textsBySha = new Map(), usage = new Map();
  const remember = (digest, text) => { if (!textsBySha.has(digest)) textsBySha.set(digest, text); };
  const indexByRef = new Map(textIndex.components.map(item => [item.ref, item]));
  for (const item of textIndex.components) for (const text of item.texts) {
    remember(text.sha256, readText(text.sha256)); usage.set(text.sha256, (usage.get(text.sha256) || 0) + 1);
  }
  const rows = [];
  for (const comp of [...obligations.components].sort((a, b) => `${a.kind}:${a.name}:${a.version}`.localeCompare(`${b.kind}:${b.name}:${b.version}`))) {
    const base = { ref: comp.ref, name: comp.name, version: comp.version || null, kind: comp.kind, expression: comp.expression, elected: comp.elected };
    if (ELSEWHERE[comp.ref]) { rows.push({ ...base, status: 'BUNDLED_ELSEWHERE', location: ELSEWHERE[comp.ref], licenceTextSha256: [] }); continue; }
    const noNoticeRequired = comp.elected?.length && comp.elected.every(term => (licence.POLICY.licences[term]?.obligations || ['X']).length === 0);
    if (['electron-part', 'native-runtime', 'native-embedded'].includes(comp.kind)) {
      rows.push(noNoticeRequired ? { ...base, status: 'NO_NOTICE_REQUIRED', licenceTextSha256: [] }
        : { ...base, status: 'TEXT_MISSING', licenceTextSha256: [], reason: 'Upstream text not available offline.' });
      continue;
    }
    let digests = [], source = null;
    const indexed = indexByRef.get(comp.ref);
    if (indexed?.texts.length) { digests = [...new Set(indexed.texts.map(text => text.sha256))]; source = indexed.texts.every(text => text.shipped) ? 'SHIPPED_IN_ARTEFACT' : 'REFERENCE_COPY'; }
    else if (comp.kind === 'npm-bundled' && frontendRoot && comp.version) {
      // Lock-declared rows carry their lock path; banner-only rows (build-time packages whose
      // licence banner is in the bundle) are looked up at the top-level install.
      const lockPath = comp.ref.startsWith('npm:frontend:') ? comp.ref.slice('npm:frontend:'.length) : `node_modules/${comp.name}`;
      const found = frontendTexts(frontendRoot, lockPath, comp.name, comp.version);
      for (const text of found.texts) remember(text.sha256, text.text);
      digests = found.texts.map(text => text.sha256); source = found.status;
    }
    if (!digests.length && comp.elected?.length === 1 && ['Apache-2.0', 'EPL-2.0'].includes(comp.elected[0])) {
      const canonical = canonicalText(textsBySha, usage, comp.elected[0]);
      if (canonical) { digests = [canonical]; source = `CANONICAL_${comp.elected[0]}_TEXT`; }
    }
    if (!digests.length && noNoticeRequired) { rows.push({ ...base, status: 'NO_NOTICE_REQUIRED', licenceTextSha256: [] }); continue; }
    rows.push({ ...base, status: digests.length ? 'INCLUDED' : 'TEXT_MISSING', textSource: source, licenceTextSha256: digests,
      ...(digests.length ? {} : { reason: 'No licence text in the artefact, the checkout module or an offline reference.' }) });
  }
  const used = [...new Set(rows.flatMap(row => row.licenceTextSha256))].sort();
  const lines = ['THIRD-PARTY SOFTWARE NOTICES', '', 'Code Intelligence includes the third-party components listed below.',
    'Each entry names the licence terms under which the component is redistributed and refers to the licence or',
    'notice text(s) reproduced in the second part of this file by their SHA-256 marker.', '',
    'Runtimes with their own legal files in this application bundle:',
    '  Electron, Chromium, V8, Node.js, FFmpeg and other Chromium components: Contents/Resources/legal/electron/',
    '  Eclipse Temurin Java runtime: Contents/Resources/runtime/jre/legal/',
    '  PostgreSQL, pgvector, OpenSSL and Redis: Contents/Resources/runtime/postgres/share/code-intelligence-notices/', '',
    `Generated from candidate bundle digest ${candidate}.`, '', '== Components =='];
  for (const row of rows) {
    const label = `${row.name}${row.version ? ' ' + row.version : ''} [${row.kind}] - ${row.expression || 'licence not identified'}`
      + (row.elected?.length && row.expression && row.elected.join(' AND ') !== row.expression ? ` (distributed under ${row.elected.join(' AND ')})` : '');
    const detail = row.status === 'INCLUDED' ? row.licenceTextSha256.map(digest => `[text ${digest}]`).join(' ')
      : row.status === 'BUNDLED_ELSEWHERE' ? `see ${row.location}` : row.status === 'NO_NOTICE_REQUIRED' ? 'no notice required by the licence' : 'licence text not yet available';
    lines.push(`- ${label}: ${detail}`);
  }
  lines.push('', '== Licence and notice texts ==');
  for (const digest of used) lines.push('', `===== [text ${digest}] =====`, textsBySha.get(digest).replace(/\r\n/g, '\n').trimEnd());
  const text = lines.join('\n') + '\n';
  for (const digest of used) need(sha256(textsBySha.get(digest)) === digest, 'TEXT_DIGEST', digest);
  const index = { format: 1, generatedFrom: { candidateBundleDigest: candidate }, policy: licence.POLICY.status,
    counts: rows.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {}), texts: used.length,
    components: rows.map(({ name, version, kind, expression, elected, status, licenceTextSha256, textSource, location }) =>
      ({ name, version, kind, expression, elected, status, licenceTextSha256, ...(textSource ? { textSource } : {}), ...(location ? { location } : {}) })) };
  return { text, index };
}

function main(argv) {
  const options = argumentsFor(argv);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const run = path.join(repo, 'validation/local/sbom', options.run);
  need(fs.lstatSync(run).isDirectory() && !fs.lstatSync(run).isSymbolicLink(), 'RUN_DIRECTORY');
  const json = name => JSON.parse(fs.readFileSync(path.join(run, name), 'utf8'));
  const summary = json('summary.json');
  need(summary.status === 'SBOM_WRITTEN' && /^[a-f0-9]{64}$/.test(summary.candidate?.bundleTreeDigest || ''), 'RUN_SUMMARY');
  const readText = digest => {
    need(/^[a-f0-9]{64}$/.test(digest), 'TEXT_DIGEST', digest);
    const text = fs.readFileSync(path.join(run, 'licence-texts', `${digest}.txt`), 'utf8');
    need(sha256(text) === digest, 'TEXT_DIGEST', digest); return text;
  };
  const { text, index } = build({ obligations: json('licence-obligations.json'), textIndex: json('licence-texts.json'), readText,
    frontendRoot: path.join(repo, 'frontend'), candidate: summary.candidate.bundleTreeDigest });
  const output = path.join(repo, OUTPUT);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), text);
  fs.writeFileSync(path.join(output, 'third-party-notices.json'), JSON.stringify(index, null, 2) + '\n');
  return { status: 'NOTICES_WRITTEN', output: OUTPUT, counts: index.counts, texts: index.texts,
    sha256: { text: sha256(text), index: sha256(JSON.stringify(index, null, 2) + '\n') } };
}

module.exports = { OUTPUT, ELSEWHERE, argumentsFor, frontendTexts, canonicalText, build, main };
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ status: 'NOTICES_FAILED', code: error.code || error.name, detail: error.detail || null }) + '\n'); process.exitCode = 1; }
}
