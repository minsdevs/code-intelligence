'use strict';

// Licence expression, election, obligation and notice-generation checks with
// authored inputs only. The policy is engineering input, not legal advice; these
// tests pin that LEGAL_REVIEW and missing texts are never turned into passes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const licence = require('../licence-obligations.cjs');
const notices = require('../licence-notices.cjs');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const codes = result => result.findings.map(item => item.code).sort();

test('SPDX expressions parse into alternatives with WITH terms kept intact', () => {
  assert.deepEqual(licence.parseExpression('MIT'), [['MIT']]);
  assert.deepEqual(licence.parseExpression('(MIT OR Apache-2.0) AND BSD-3-Clause'), [['MIT', 'BSD-3-Clause'], ['Apache-2.0', 'BSD-3-Clause']]);
  assert.deepEqual(licence.parseExpression('EPL-2.0 OR (GPL-2.0-only WITH Classpath-exception-2.0)'),
    [['EPL-2.0'], ['GPL-2.0-only WITH Classpath-exception-2.0']]);
  assert.deepEqual(licence.parseExpression('GPL-2.0'), [['GPL-2.0-only']]);
  for (const bad of ['', 'MIT OR', '(MIT', 'MIT AND AND ISC', 'MIT )', 'M I T', 'a'.repeat(600)]) {
    assert.throws(() => licence.parseExpression(bad), { code: 'LICENCE_EXPRESSION' }, bad);
  }
});

test('election picks the least-burdensome alternative and records that an election was made', () => {
  assert.deepEqual(licence.elect('LGPL-3.0-or-later OR Apache-2.0').chosen, ['Apache-2.0']);
  assert.deepEqual(licence.elect('EPL-2.0 OR LGPL-2.1-only').chosen, ['EPL-2.0']);
  assert.deepEqual(licence.elect('LicenseRef-RSALv2 OR SSPL-1.0 OR AGPL-3.0-only').chosen, ['AGPL-3.0-only']);
  assert.equal(licence.elect('MIT').electionRequired, false);
  assert.equal(licence.elect('MIT OR Apache-2.0').electionRequired, true);
});

test('Maven licence names and URLs map to SPDX; unknown names are reported, not guessed', () => {
  assert.equal(licence.spdxFromName('The Apache Software License, Version 2.0'), 'Apache-2.0');
  assert.equal(licence.spdxFromName('Eclipse Public License - v 2.0'), 'EPL-2.0');
  assert.equal(licence.spdxFromName('GPL2 w/ CPE'), 'GPL-2.0-only WITH Classpath-exception-2.0');
  assert.equal(licence.spdxFromName(null, 'https://opensource.org/licenses/MIT'), 'MIT');
  assert.equal(licence.spdxFromName('Some Custom Licence'), null);
  const mapped = licence.expressionFromDeclarations([{ name: 'EPL 2.0' }, { name: 'GPL2 w/ CPE' }, { name: 'Custom' }]);
  assert.equal(mapped.expression, 'EPL-2.0 OR (GPL-2.0-only WITH Classpath-exception-2.0)');
  assert.deepEqual(mapped.unknown, [{ name: 'Custom' }]);
  assert.equal(licence.expressionFromDeclarations([]).expression, null);
});

test('text identification accepts only one exact whole-licence match', () => {
  const mit = 'Permission is hereby granted, free of charge, to any person obtaining a copy ... The above copyright notice and this permission notice shall be included ... THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND';
  assert.equal(licence.identifyText(mit), 'MIT');
  assert.equal(licence.identifyText('Permission is hereby granted, free of charge'), null);
  assert.equal(licence.identifyText(null), null);
});

test('obligation evaluation: missing notice text, unknown licence and copyleft source duties are blocking', () => {
  const shipped = [{ kind: 'LICENCE', visibility: 'ARTEFACT', location: 'x/LICENSE' }];
  const met = licence.evaluate({ expression: 'MIT', noticeEvidence: shipped });
  assert.equal(met.class, 'PERMISSIVE'); assert.deepEqual(met.findings, []);
  assert.equal(met.obligations[0].visibility, 'ARTEFACT_ONLY');
  assert.deepEqual(codes(licence.evaluate({ expression: 'MIT' })), ['MISSING_LICENCE_TEXT']);
  assert.deepEqual(codes(licence.evaluate({ expression: null })), ['UNKNOWN_LICENCE']);
  assert.deepEqual(codes(licence.evaluate({ expression: 'NOT A ( LICENCE' })), ['UNPARSEABLE_LICENCE']);
  assert.deepEqual(codes(licence.evaluate({ expression: 'LicenseRef-Unreviewed', noticeEvidence: shipped })), ['UNKNOWN_LICENCE']);
  assert.ok(licence.evaluate({ expression: null }).findings.every(item => item.blocking));

  const jre = licence.evaluate({ expression: 'GPL-2.0-only WITH Classpath-exception-2.0', noticeEvidence: shipped, legalReview: 'source offer' });
  assert.equal(jre.class, 'STRONG_COPYLEFT');
  assert.deepEqual(codes(jre), ['LEGAL_REVIEW', 'STRONG_COPYLEFT_SOURCE_OBLIGATION']);
  // A source statement moves the duty to legal review; it never becomes MET automatically.
  const offered = licence.evaluate({ expression: 'GPL-2.0-only WITH Classpath-exception-2.0',
    noticeEvidence: [...shipped, { kind: 'SOURCE_STATEMENT', visibility: 'BUNDLE_LEGAL', location: 'notices' }] });
  assert.equal(offered.obligations.find(item => item.code === 'SOURCE_OR_WRITTEN_OFFER').status, 'LEGAL_REVIEW');

  const redis = licence.evaluate({ expression: 'LicenseRef-RSALv2 OR SSPL-1.0 OR AGPL-3.0-only', noticeEvidence: shipped, legalReview: 'election' });
  assert.deepEqual(codes(redis), ['LEGAL_REVIEW', 'LICENCE_ELECTION', 'NETWORK_COPYLEFT', 'STRONG_COPYLEFT_SOURCE_OBLIGATION']);
  assert.ok(redis.findings.find(item => item.code === 'NETWORK_COPYLEFT').blocking);

  const ffmpeg = licence.evaluate({ expression: 'LGPL-2.1-or-later', noticeEvidence: shipped, replaceable: 'SIGNED_BUNDLE' });
  assert.equal(ffmpeg.class, 'WEAK_COPYLEFT');
  assert.equal(ffmpeg.obligations.find(item => item.code === 'ALLOW_RELINK_OR_REPLACE').status, 'LEGAL_REVIEW');
  assert.deepEqual(codes(licence.evaluate({ expression: 'EPL-2.0', noticeEvidence: shipped })), ['MISSING_SOURCE_STATEMENT']);
  assert.deepEqual(codes(licence.evaluate({ expression: 'MIT-0' })), []);
});

test('policy table is self-consistent and names every runtime needing individual treatment', () => {
  const { POLICY } = licence;
  assert.equal(POLICY.status, 'ENGINEERING_REVIEW_NOT_LEGAL_ADVICE');
  for (const [id, entry] of Object.entries(POLICY.licences)) {
    assert.ok(Object.hasOwn(licence.SEVERITY, entry.class), id);
    assert.ok(POLICY.preference.includes(id), `preference lists ${id}`);
  }
  for (const id of POLICY.preference) assert.ok(POLICY.licences[id], `preference ${id} has a policy entry`);
  for (const ref of ['redis', 'temurin-jre', 'chromium', 'ffmpeg', 'postgresql', 'pgvector', 'electron', 'openssl']) {
    const entry = POLICY.components[ref]; assert.ok(entry, ref);
    assert.doesNotThrow(() => licence.parseExpression(entry.expression), ref);
  }
  for (const ref of ['redis', 'temurin-jre', 'ffmpeg']) assert.ok(POLICY.components[ref].legalReview, `${ref} needs counsel`);
  for (const item of POLICY.embedded) {
    assert.match(item.ref, /^(?:redis|postgresql):[a-z_-]+$/);
    assert.ok(['redis', 'postgresql'].includes(item.parent));
    assert.doesNotThrow(() => licence.parseExpression(item.expression), item.ref);
    assert.ok(item.witness === null || typeof item.witness === 'string');
  }
  for (const rule of [...POLICY.names, ...POLICY.urls]) assert.ok(POLICY.licences[rule.spdx], rule.spdx);
});

// ---------------------------------------------------------------- notices generation
function noticesInput() {
  const apache = 'Apache License\nVersion 2.0, January 2004\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n';
  const mitText = 'MIT text for pkg-a\n';
  const texts = new Map([[sha256(apache), apache], [sha256(mitText), mitText]]);
  const obligations = { components: [
    { ref: 'npm:app.asar:node_modules/pkg-a', name: 'pkg-a', version: '1.0.0', kind: 'npm', expression: 'MIT', elected: ['MIT'] },
    { ref: 'maven:g:shipped:1', name: 'shipped', version: '1', kind: 'maven', expression: 'Apache-2.0', elected: ['Apache-2.0'] },
    { ref: 'maven:g:bare:2', name: 'bare', version: '2', kind: 'maven', expression: 'Apache-2.0', elected: ['Apache-2.0'] },
    { ref: 'maven:g:bsd:3', name: 'bsd', version: '3', kind: 'maven', expression: 'BSD-3-Clause', elected: ['BSD-3-Clause'] },
    { ref: 'redis', name: 'redis', version: '8.10.2', kind: 'native-runtime', expression: 'LicenseRef-RSALv2 OR SSPL-1.0 OR AGPL-3.0-only', elected: ['AGPL-3.0-only'] },
    { ref: 'redis:lua', name: 'Lua (bundled in Redis)', version: '5.1', kind: 'native-embedded', expression: 'MIT', elected: ['MIT'] },
    { ref: 'npm:frontend:node_modules/zero', name: 'zero', version: '1.0.0', kind: 'npm-bundled', expression: 'MIT-0', elected: ['MIT-0'] },
  ] };
  const textIndex = { components: [
    { ref: 'npm:app.asar:node_modules/pkg-a', texts: [{ sha256: sha256(mitText), shipped: true }] },
    { ref: 'maven:g:shipped:1', texts: [{ sha256: sha256(apache), shipped: true }] },
  ] };
  return { obligations, textIndex, readText: digest => texts.get(digest), frontendModules: null, candidate: 'c'.repeat(64), apache, mitText };
}

test('notices generation includes shipped texts, keeps missing texts visible and never invents a text', () => {
  const input = noticesInput();
  const { text, index } = notices.build(input);
  const row = name => index.components.find(item => item.name === name);
  assert.equal(row('pkg-a').status, 'INCLUDED'); assert.equal(row('pkg-a').textSource, 'SHIPPED_IN_ARTEFACT');
  assert.equal(row('bare').status, 'INCLUDED'); assert.equal(row('bare').textSource, 'CANONICAL_Apache-2.0_TEXT');
  assert.deepEqual(row('bare').licenceTextSha256, [sha256(input.apache)]);
  assert.equal(row('bsd').status, 'TEXT_MISSING');
  assert.equal(row('redis').status, 'BUNDLED_ELSEWHERE');
  assert.equal(row('Lua (bundled in Redis)').status, 'TEXT_MISSING');
  assert.equal(row('zero').status, 'NO_NOTICE_REQUIRED');
  assert.deepEqual(index.counts, { INCLUDED: 3, TEXT_MISSING: 2, BUNDLED_ELSEWHERE: 1, NO_NOTICE_REQUIRED: 1 });
  assert.equal(index.texts, 2);
  assert.ok(text.includes(`===== [text ${sha256(input.apache)}] =====`));
  assert.ok(text.includes(input.mitText.trimEnd()));
  assert.match(text, /- bsd 3 \[maven\] - BSD-3-Clause: licence text not yet available/);
  assert.match(text, /- redis 8\.10\.2 \[native-runtime\] - LicenseRef-RSALv2 OR SSPL-1\.0 OR AGPL-3\.0-only \(distributed under AGPL-3\.0-only\): see /);
  assert.equal(index.generatedFrom.candidateBundleDigest, 'c'.repeat(64));
  // Deterministic for the same inputs.
  assert.equal(notices.build(noticesInput()).text, text);
});

test('notices generation rejects a text whose bytes do not match its digest', () => {
  const input = noticesInput();
  input.readText = () => 'tampered';
  assert.throws(() => notices.build(input), { code: 'TEXT_DIGEST' });
  assert.throws(() => notices.argumentsFor(['--sbom-run', '../run-abcdef']), { code: 'ARGUMENTS' });
  assert.deepEqual(notices.argumentsFor(['--sbom-run', 'run-ozgVww']), { run: 'run-ozgVww' });
});
