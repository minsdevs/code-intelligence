'use strict';

// Engineering checklist for licence obligations of a closed desktop bundle. The
// policy table (licence-policy.json) is reviewed engineering input, not legal
// advice: every LEGAL_REVIEW result must be confirmed by counsel and is never
// converted into a pass by this module.
const POLICY = require('./licence-policy.json');

const SEVERITY = Object.freeze({ PERMISSIVE: 0, WEAK_COPYLEFT: 1, STRONG_COPYLEFT: 2, SOURCE_AVAILABLE_RESTRICTED: 3, UNKNOWN: 4 });
const ALIASES = Object.freeze({ 'GPL-2.0': 'GPL-2.0-only', 'GPL-3.0': 'GPL-3.0-only', 'LGPL-2.1': 'LGPL-2.1-only',
  'LGPL-3.0': 'LGPL-3.0-only', 'AGPL-3.0': 'AGPL-3.0-only', 'GPL-2.0+': 'GPL-2.0-or-later', 'GPL-3.0+': 'GPL-3.0-or-later',
  'LGPL-2.1+': 'LGPL-2.1-or-later', 'LGPL-3.0+': 'LGPL-3.0-or-later', 'Apache 2.0': 'Apache-2.0', 'Apache2': 'Apache-2.0' });
const IDENT = /^[A-Za-z0-9][A-Za-z0-9.+:-]*$/;

class LicenceError extends Error { constructor(code) { super(code); this.code = code; } }

function canonicalId(value) { return ALIASES[value] || value; }

// SPDX expression -> disjunctive normal form: an array of alternatives, each an
// array of licence terms ("X WITH Y" stays one term). Unparseable input throws.
function parseExpression(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 512) throw new LicenceError('LICENCE_EXPRESSION');
  const tokens = text.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/);
  let index = 0;
  const peek = () => tokens[index], take = () => tokens[index++];
  function primary() {
    const token = take();
    if (token === '(') { const value = or(); if (take() !== ')') throw new LicenceError('LICENCE_EXPRESSION'); return value; }
    if (!token || ['AND', 'OR', 'WITH', ')'].includes(token.toUpperCase()) || !IDENT.test(token)) throw new LicenceError('LICENCE_EXPRESSION');
    let term = canonicalId(token);
    if (peek()?.toUpperCase() === 'WITH') {
      take(); const exception = take();
      if (!exception || !IDENT.test(exception)) throw new LicenceError('LICENCE_EXPRESSION');
      term = `${term} WITH ${exception}`;
    }
    return [[term]];
  }
  function and() {
    let left = primary();
    while (peek()?.toUpperCase() === 'AND') {
      take(); const right = primary(), product = [];
      for (const a of left) for (const b of right) product.push([...new Set([...a, ...b])]);
      left = product;
    }
    return left;
  }
  function or() {
    let left = and();
    while (peek()?.toUpperCase() === 'OR') { take(); left = [...left, ...and()]; }
    return left;
  }
  const result = or();
  if (index !== tokens.length) throw new LicenceError('LICENCE_EXPRESSION');
  return result;
}

function termInfo(term, policy = POLICY) {
  const entry = policy.licences[term];
  return entry ? { term, ...entry } : { term, class: 'UNKNOWN', obligations: ['IDENTIFY_LICENCE'] };
}
function alternativeRank(alternative, policy) {
  const severity = Math.max(...alternative.map(term => SEVERITY[termInfo(term, policy).class]));
  const preference = alternative.reduce((sum, term) => {
    const at = policy.preference.indexOf(term); return sum + (at === -1 ? policy.preference.length : at);
  }, 0);
  return [severity, preference];
}
// Choose the least-burdensome alternative a distributor may elect. The election
// itself is recorded so that a human can confirm or change it.
function elect(expression, policy = POLICY) {
  const alternatives = parseExpression(expression);
  const ranked = alternatives.map(value => ({ value, rank: alternativeRank(value, policy) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
  return { alternatives, chosen: ranked[0].value, electionRequired: alternatives.length > 1 };
}

function spdxFromName(name, url, policy = POLICY) {
  const normal = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (normal && policy.licences[name]) return name;
  for (const rule of policy.names) if (normal && new RegExp(rule.match).test(normal)) return rule.spdx;
  const link = String(url || '').toLowerCase();
  for (const rule of policy.urls) if (link && new RegExp(rule.match).test(link)) return rule.spdx;
  return null;
}
// Maven POMs list one <license> per option; Maven semantics treat several
// entries as alternatives unless the project says otherwise.
function expressionFromDeclarations(declarations, policy = POLICY) {
  const ids = [], unknown = [];
  for (const item of declarations) {
    const id = spdxFromName(item.name, item.url, policy);
    if (id) { if (!ids.includes(id)) ids.push(id); } else unknown.push(item);
  }
  if (!ids.length) return { expression: null, unknown };
  const terms = ids.map(id => (id.includes(' WITH ') ? `(${id})` : id));
  return { expression: terms.length > 1 ? terms.join(' OR ') : ids[0], unknown };
}

// Last-resort identification of a shipped licence text when no metadata declares
// one. Only exact anchor phrases of whole licence texts are accepted, and a text
// matching several entries is not identified.
function identifyText(text, policy = POLICY) {
  if (typeof text !== 'string') return null;
  const normal = text.replace(/\s+/g, ' ');
  const hits = (policy.texts || []).filter(entry => entry.all.every(phrase => normal.includes(phrase)));
  return hits.length === 1 ? hits[0].spdx : null;
}

// noticeEvidence: [{ kind: 'LICENCE'|'NOTICE'|'SOURCE_STATEMENT', visibility: 'ARTEFACT'|'BUNDLE_LEGAL', location }]
function evaluate({ expression, noticeEvidence = [], replaceable = 'UNKNOWN', legalReview = null }, policy = POLICY) {
  if (!expression) {
    return { class: 'UNKNOWN', chosen: [], electionRequired: false,
      obligations: [{ code: 'IDENTIFY_LICENCE', status: 'UNMET' }],
      findings: [{ code: 'UNKNOWN_LICENCE', blocking: true, reason: 'No reviewed licence declaration; redistribution terms unknown.' }] };
  }
  let election;
  try { election = elect(expression, policy); }
  catch { return { class: 'UNKNOWN', chosen: [], electionRequired: false, obligations: [{ code: 'IDENTIFY_LICENCE', status: 'UNMET' }],
    findings: [{ code: 'UNPARSEABLE_LICENCE', blocking: true, reason: 'Declared licence is not a parseable SPDX expression.' }] }; }
  const infos = election.chosen.map(term => termInfo(term, policy));
  const klass = infos.reduce((worst, info) => (SEVERITY[info.class] > SEVERITY[worst] ? info.class : worst), 'PERMISSIVE');
  const codes = [...new Set(infos.flatMap(info => info.obligations))];
  const has = kind => noticeEvidence.filter(item => item.kind === kind);
  const obligations = codes.map(code => {
    if (code === 'NOTICE_TEXT' || code === 'LICENCE_TEXT') {
      const found = has('LICENCE');
      return { code, status: found.length ? 'MET' : 'UNMET',
        visibility: found.some(item => item.visibility === 'BUNDLE_LEGAL') ? 'BUNDLE_LEGAL' : found.length ? 'ARTEFACT_ONLY' : null };
    }
    if (code === 'NOTICE_FILE_IF_PRESENT') return { code, status: has('NOTICE').length ? 'MET' : 'MET_NONE_OBSERVED' };
    if (code === 'SOURCE_AVAILABILITY_STATEMENT') return { code, status: has('SOURCE_STATEMENT').length ? 'MET' : 'UNMET' };
    if (code === 'SOURCE_OR_WRITTEN_OFFER') return { code, status: has('SOURCE_STATEMENT').length ? 'LEGAL_REVIEW' : 'UNMET' };
    if (code === 'ALLOW_RELINK_OR_REPLACE') return { code, status: replaceable === 'YES' ? 'MET' : 'LEGAL_REVIEW', replaceable };
    if (code === 'IDENTIFY_LICENCE') return { code, status: 'UNMET' };
    return { code, status: 'LEGAL_REVIEW' };
  });
  const findings = [];
  const unmet = obligations.filter(item => item.status === 'UNMET').map(item => item.code);
  if (klass === 'UNKNOWN') findings.push({ code: 'UNKNOWN_LICENCE', blocking: true, reason: 'A chosen term has no reviewed policy entry.' });
  if (klass === 'SOURCE_AVAILABLE_RESTRICTED') findings.push({ code: 'RESTRICTED_LICENCE', blocking: true, reason: 'Source-available licence; redistribution needs legal confirmation.' });
  if (infos.some(info => info.network)) findings.push({ code: 'NETWORK_COPYLEFT', blocking: true, reason: 'Network copyleft term elected; Corresponding Source and combination scope need legal confirmation.' });
  if (klass === 'STRONG_COPYLEFT') findings.push({ code: 'STRONG_COPYLEFT_SOURCE_OBLIGATION', blocking: true, reason: 'Binary redistribution requires source availability (written offer or accompanying source).' });
  if (unmet.some(code => code === 'NOTICE_TEXT' || code === 'LICENCE_TEXT')) findings.push({ code: 'MISSING_LICENCE_TEXT', blocking: true, reason: 'Licence or copyright notice text is not shipped with this component.' });
  if (unmet.includes('SOURCE_AVAILABILITY_STATEMENT')) findings.push({ code: 'MISSING_SOURCE_STATEMENT', blocking: true, reason: 'Weak-copyleft object code is shipped without a statement of where its source is available.' });
  if (obligations.some(item => item.status === 'LEGAL_REVIEW') || legalReview) findings.push({ code: 'LEGAL_REVIEW', blocking: false, reason: legalReview || 'One or more obligations need confirmation by counsel.' });
  if (election.electionRequired) findings.push({ code: 'LICENCE_ELECTION', blocking: false, reason: `Elected ${election.chosen.join(' AND ')} from ${expression}.` });
  return { class: klass, chosen: election.chosen, electionRequired: election.electionRequired, obligations, findings };
}

module.exports = Object.freeze({ POLICY, SEVERITY, LicenceError, parseExpression, elect, spdxFromName, expressionFromDeclarations,
  identifyText, evaluate, canonicalId });
