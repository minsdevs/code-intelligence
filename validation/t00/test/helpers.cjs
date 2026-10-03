'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256 } = require('../lib/safe-io.cjs');
const { sourceDigest } = require('../lib/contracts.cjs');
const ROOT = path.resolve(__dirname, '..');
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, json(value));
const digest = file => sha256(fs.readFileSync(file));

function sandbox(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't00-test-'));
  const inputs = path.join(temp, 'inputs'); fs.mkdirSync(inputs);
  for (const name of ['fixtures', 'selftest', 'corpus.json', 'capability-manifest.json']) {
    fs.cpSync(path.join(ROOT, name), path.join(inputs, name), { recursive: true });
  }
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const env = { temp, inputs, corpus: path.join(inputs, 'corpus.json'),
    capabilities: path.join(inputs, 'capability-manifest.json'),
    observations: path.join(inputs, 'selftest/known-good-observations.json'), sequence: 0 };
  env.build = read(env.observations).provenance.productBuildSha256;
  return env;
}

function rebind(env) {
  const observations = read(env.observations), corpus = read(env.corpus);
  observations.corpusSha256 = digest(env.corpus);
  observations.capabilityManifestSha256 = digest(env.capabilities);
  for (const reference of corpus.fixtures) {
    const fixture = read(path.join(env.inputs, reference.path));
    const run = observations.runs.find(item => item.fixtureId === fixture.fixtureId);
    if (run) { run.sourceDigest = sourceDigest(fixture.source); run.versions = fixture.versions; }
  }
  write(env.observations, observations);
}

// Test setup only: changes explicitly authored expectations, then restores their
// reference hashes. The CLI exposes no gold-update or product-to-gold operation.
function editFixture(env, id, edit) {
  const corpus = read(env.corpus), reference = corpus.fixtures.find(item => item.path.includes('/' + id + '/'));
  const file = path.join(env.inputs, reference.path), root = path.dirname(file), fixture = read(file);
  const gold = read(path.join(root, fixture.gold.path)), negatives = read(path.join(root, fixture.negatives.path));
  const review = read(path.join(root, fixture.review.path));
  edit({ fixture, gold, negatives, review, root });
  write(path.join(root, fixture.gold.path), gold); write(path.join(root, fixture.negatives.path), negatives);
  fixture.gold.sha256 = digest(path.join(root, fixture.gold.path));
  fixture.negatives.sha256 = digest(path.join(root, fixture.negatives.path));
  review.goldSha256 = fixture.gold.sha256; review.negativesSha256 = fixture.negatives.sha256;
  write(path.join(root, fixture.review.path), review); fixture.review.sha256 = digest(path.join(root, fixture.review.path));
  write(file, fixture); reference.sha256 = digest(file); write(env.corpus, corpus); rebind(env);
}

function editObservations(env, edit) { const value = read(env.observations); edit(value); write(env.observations, value); }

function run(env, options = {}) {
  const mode = options.mode ?? 'gate', output = options.output ?? path.join(env.temp, 'out-' + env.sequence++);
  const args = [path.join(ROOT, 'runner.cjs'), '--mode', mode, '--corpus', env.corpus,
    '--capabilities', env.capabilities, '--output', output, '--offline'];
  if (mode === 'gate' && options.observations !== false) args.push('--observations', options.observations ?? env.observations);
  if (mode === 'gate' && options.build !== false) args.push('--product-build-sha256', options.build ?? env.build);
  if (options.extra) args.push(...options.extra);
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 });
  if (child.error) throw child.error;
  const summary = JSON.parse(child.stdout);
  const reportFile = path.join(output, 'report.json');
  return { ...child, summary, output, report: fs.existsSync(reportFile) ? read(reportFile) : null };
}
const cell = (report, id) => report.cells.find(item => item.cellId === id);
module.exports = { ROOT, sandbox, read, write, digest, rebind, editFixture, editObservations, run, cell };
