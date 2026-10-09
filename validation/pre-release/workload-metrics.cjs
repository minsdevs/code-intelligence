'use strict';

// Fixed G-PERF workload assessment. The limits are copied unchanged from
// docs/multilanguage-plan-2026-10-02/05-security-performance-operations.md section 4;
// the series rules follow 06-benchmarks-validation.md section 5 item 4.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { memoryForOwner } = require('./startup-metrics.cjs');

const GiB_KiB = 1024 * 1024;
const SLO = Object.freeze({
  'preview.medium': Object.freeze({ sizeClass: 'medium', p95: { previewCompleteMs: 10000 }, ceiling: { previewFirstResponseMs: 500 } }),
  'analysis.small': Object.freeze({ sizeClass: 'small', p95: { analysisMs: 30000 }, rssKiB: 3 * GiB_KiB }),
  'analysis.medium': Object.freeze({ sizeClass: 'medium', p95: { analysisMs: 180000 }, rssKiB: 4 * GiB_KiB }),
  'analysis.large': Object.freeze({ sizeClass: 'large', p95: { analysisMs: 600000 }, rssKiB: 6 * GiB_KiB, hardTimeoutMs: 900000 }),
  'incremental.medium': Object.freeze({ sizeClass: 'medium', p95: { refreshMs: 30000 }, requires: ['resultEqualsFull'] }),
  'cancel.medium': Object.freeze({ sizeClass: 'medium', ceiling: { cancelUiAckMs: 500, cancelReleaseMs: 10000 }, p95: { cancelReleaseMs: 5000 } }),
  'graph.medium': Object.freeze({ sizeClass: 'medium', p95: { searchApiMs: 500, nodePageApiMs: 500, relationsApiMs: 500 },
    ceiling: { firstPageRenderMs: 2000 } }),
});
const STATUSES = new Set(['PASS', 'FAIL', 'NOT_RUN']);

// p95 is the value at rank ceil(0.95*n) after ascending sort. Failed samples stay in the
// denominator as +Infinity, so they can only move the percentile up.
function percentile95(values) {
  assert(Array.isArray(values) && values.length > 0, 'PERCENTILE_INPUT_INVALID');
  for (const value of values) assert(value === Infinity || (Number.isFinite(value) && value >= 0), 'PERCENTILE_INPUT_INVALID');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function finiteOrFailed(sample, metric) {
  const value = sample.metrics?.[metric];
  return sample.status === 'PASS' && Number.isFinite(value) && value >= 0 ? value : Infinity;
}

// samples: [{ sequence, status, failure, metrics: { name: number | number[] }, peakRssKiB, samplingComplete,
// cleanupConfirmed, checks: { name: boolean } }]. Array metrics (several API calls in one run) are pooled.
function evaluateRow(row, samples, { expectedRuns = 20 } = {}) {
  assert(Object.hasOwn(SLO, row), 'WORKLOAD_ROW_INVALID');
  assert(Array.isArray(samples), 'WORKLOAD_SAMPLES_INVALID');
  assert(Number.isSafeInteger(expectedRuns) && expectedRuns > 0, 'WORKLOAD_CONFIG_INVALID');
  const slo = SLO[row], failures = new Set();
  let failedRuns = 0, notRun = 0;
  for (const sample of samples) {
    assert(sample && typeof sample === 'object' && STATUSES.has(sample.status), 'WORKLOAD_SAMPLES_INVALID');
    if (sample.status === 'NOT_RUN') { notRun++; failures.add('RUN_NOT_EXECUTED'); continue; }
    if (sample.status === 'FAIL') { failedRuns++; failures.add('RUN_FAILED'); }
    if (slo.rssKiB !== undefined && sample.samplingComplete !== true) failures.add('SAMPLING_INCOMPLETE');
    if (sample.cleanupConfirmed !== true) failures.add('CLEANUP_UNCONFIRMED');
  }
  if (samples.length > expectedRuns) failures.add('RUN_COUNT_INVALID');
  const missing = Math.max(0, expectedRuns - samples.length);
  if (missing) { notRun += missing; failures.add('RUN_NOT_EXECUTED'); }
  const executed = samples.filter(sample => sample.status !== 'NOT_RUN');
  const result = { row, status: 'FAIL', requestedRuns: expectedRuns, executedRuns: executed.length, failedRuns,
    unexecutedRuns: notRun, p95: {}, maximum: {}, limits: { p95: slo.p95 ?? {}, ceiling: slo.ceiling ?? {},
      rssKiB: slo.rssKiB ?? null }, maxPeakRssKiB: null, failures: [] };
  // Every executed run contributes to the denominator. Unexecuted runs are not invented values.
  const pooled = (sample, metric) => {
    const value = sample.metrics?.[metric];
    if (Array.isArray(value)) return value.length && sample.status === 'PASS' && value.every(v => Number.isFinite(v) && v >= 0)
      ? value : [Infinity];
    return [finiteOrFailed(sample, metric)];
  };
  for (const metric of new Set([...Object.keys(slo.p95 ?? {}), ...Object.keys(slo.ceiling ?? {})])) {
    const values = executed.flatMap(sample => pooled(sample, metric));
    if (!values.length) { result.p95[metric] = null; result.maximum[metric] = null; continue; }
    const p95 = percentile95(values), maximum = Math.max(...values);
    result.p95[metric] = Number.isFinite(p95) ? p95 : null;
    result.maximum[metric] = Number.isFinite(maximum) ? maximum : null;
    if (slo.p95?.[metric] !== undefined && !(p95 <= slo.p95[metric])) failures.add(`${metric.toUpperCase()}_P95_EXCEEDED`);
    if (slo.ceiling?.[metric] !== undefined && !(maximum <= slo.ceiling[metric])) failures.add(`${metric.toUpperCase()}_MAXIMUM_EXCEEDED`);
  }
  if (slo.rssKiB !== undefined) {
    // A ceiling, not a percentile: one run above it fails. A run without a valid peak cannot pass.
    const peaks = executed.map(sample => Number.isSafeInteger(sample.peakRssKiB) && sample.peakRssKiB > 0 ? sample.peakRssKiB : Infinity);
    const maximum = peaks.length ? Math.max(...peaks) : Infinity;
    result.maxPeakRssKiB = Number.isFinite(maximum) ? maximum : null;
    if (!(maximum <= slo.rssKiB)) failures.add('RSS_CEILING_EXCEEDED');
  }
  for (const check of slo.requires ?? []) {
    if (!executed.length || executed.some(sample => sample.checks?.[check] !== true)) failures.add(`${check.toUpperCase()}_NOT_CONFIRMED`);
  }
  if (slo.hardTimeoutMs !== undefined && executed.some(sample => sample.failure === 'ANALYSIS_HARD_TIMEOUT')) failures.add('HARD_TIMEOUT_REACHED');
  result.failures = [...failures].sort();
  result.status = failures.size === 0 && executed.length === expectedRuns ? 'PASS' : 'FAIL';
  return result;
}

// One or two smoke runs are observations, never an assessment. They are compared with the
// unchanged limits only to show the distance, and are labelled as such.
function describeSmoke(row, samples) {
  assert(Object.hasOwn(SLO, row), 'WORKLOAD_ROW_INVALID');
  const slo = SLO[row];
  return { row, status: 'SINGLE_OBSERVATION_NOT_ASSESSED', runs: samples.length,
    observations: samples.map(sample => {
      const values = {};
      for (const metric of new Set([...Object.keys(slo.p95 ?? {}), ...Object.keys(slo.ceiling ?? {})])) {
        const value = sample.metrics?.[metric];
        const limit = slo.p95?.[metric] ?? slo.ceiling?.[metric];
        const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
        values[metric] = { values: list, limitMs: limit,
          withinLimit: sample.status === 'PASS' && list.length > 0 ? list.every(v => Number.isFinite(v) && v >= 0 && v <= limit) : null };
      }
      return { sequence: sample.sequence, status: sample.status, failure: sample.failure ?? null, values,
        peakRssKiB: sample.peakRssKiB ?? null, rssLimitKiB: slo.rssKiB ?? null,
        rssWithinLimit: slo.rssKiB === undefined || !Number.isSafeInteger(sample.peakRssKiB) ? null : sample.peakRssKiB <= slo.rssKiB };
    }) };
}

// Owner-tree RSS sampler with named phases, for runs of up to tens of minutes.
const SAMPLE_INTERVAL_MS = 100;
const MAX_CSV_BYTES = 256 * 1024 * 1024;
function startPhaseSampler(ownerPid, fd, sequence, started, { read, now = () => performance.now(), intervalMs = SAMPLE_INTERVAL_MS,
  maxCsvBytes = MAX_CSV_BYTES, maxSamples = 40000, initialPhase = 'STARTUP', stopTimeoutMs = 6000 } = {}) {
  assert(Number.isSafeInteger(ownerPid) && ownerPid > 1, 'MEMORY_OWNER_INVALID');
  assert.equal(typeof read, 'function');
  assert(Number.isSafeInteger(maxCsvBytes) && maxCsvBytes > 0 && maxCsvBytes <= MAX_CSV_BYTES);
  assert(Number.isSafeInteger(maxSamples) && maxSamples > 0 && maxSamples <= 40000);
  let stopped = false, timer, releaseSleep, phase = initialPhase, lastAt = null, stoppedAt, csvBytes = 0;
  const observed = new Set();
  const phases = {};
  const result = { samples: 0, peakRssKiB: 0, maximumGapMs: 0, maximumReadMs: 0, missingOwnerSamples: 0,
    requestedIntervalMs: intervalMs, failure: null, failureDetail: null, phases,
    scope: 'PID/PPID discovery then targeted owner-tree RSS; processes born and gone between two samples are not observed' };
  const enter = name => { phases[name] ??= { samples: 0, peakRssKiB: 0, maximumGapMs: 0, maximumReadMs: 0,
    maximumSchedulingDelayMs: 0, startedAtMs: now() - started, endedAtMs: null, firstAtMs: null, lastAtMs: null }; };
  const finishPhase = at => {
    const entry = phases[phase];
    entry.endedAtMs = at - started;
    entry.maximumGapMs = Math.max(entry.maximumGapMs, entry.endedAtMs - (entry.lastAtMs ?? entry.startedAtMs));
  };
  let scheduledAt = now();
  enter(phase);
  const task = (async () => {
    while (!stopped) {
      const begin = now(), sampledPhase = phase;
      const entry = phases[sampledPhase];
      entry.maximumSchedulingDelayMs = Math.max(entry.maximumSchedulingDelayMs, begin - scheduledAt);
      let operation = 'READ';
      try {
        const table = await read();
        if (stopped) break;
        const at = now(), value = memoryForOwner(table, ownerPid);
        result.maximumReadMs = Math.max(result.maximumReadMs, at - begin);
        entry.maximumReadMs = Math.max(entry.maximumReadMs, at - begin);
        if (!value || value.rssKiB <= 0) { result.missingOwnerSamples++; throw new Error('MEMORY_SAMPLE_FAILED'); }
        const text = value.processes.map(row => [sequence, Math.round(at - started), sampledPhase, row.pid, row.ppid, row.rssKiB].join(',') + '\n').join('');
        if (result.samples >= maxSamples || csvBytes + Buffer.byteLength(text) > maxCsvBytes) { result.failure = 'MEMORY_EVIDENCE_LIMIT'; break; }
        operation = 'WRITE';
        fs.writeSync(fd, text); csvBytes += Buffer.byteLength(text);
        const gap = lastAt === null ? at - started : at - lastAt;
        result.maximumGapMs = Math.max(result.maximumGapMs, gap);
        lastAt = at; result.samples++; result.peakRssKiB = Math.max(result.peakRssKiB, value.rssKiB);
        // Phase boundary gaps count even when the sampler never throws.
        entry.samples++; entry.peakRssKiB = Math.max(entry.peakRssKiB, value.rssKiB);
        entry.maximumGapMs = Math.max(entry.maximumGapMs, at - started - (entry.lastAtMs ?? entry.startedAtMs));
        entry.firstAtMs ??= Math.round(at - started); entry.lastAtMs = Math.round(at - started);
        for (const row of value.processes) observed.add(row.pid);
      } catch (error) {
        const reasons = new Set(['ENOSPC', 'EIO', 'EBADF', 'EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN', 'ETIMEDOUT',
          'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'OWNED_PROCESS_NOT_OBSERVED', 'PROCESS_TABLE_INVALID',
          'PROCESS_TABLE_LIMIT', 'MEMORY_TABLE_INVALID', 'MEMORY_TABLE_UNEXPECTED_PID', 'OBSERVED_TREE_LIMIT']);
        let reason = 'UNCLASSIFIED';
        try {
          if (reasons.has(error?.code)) reason = error.code;
          else if (reasons.has(error?.message)) reason = error.message;
          else if (error?.killed === true) reason = 'PROCESS_READ_TIMEOUT';
        } catch { /* Raw error text can contain private paths or command output. */ }
        result.failure = 'MEMORY_SAMPLE_FAILED';
        result.failureDetail = { operation, reason, phase: sampledPhase, elapsedMs: Math.round(now() - started) };
        break;
      }
      if (!stopped) await new Promise(resolve => {
        releaseSleep = resolve;
        const delay = Math.max(0, intervalMs - (now() - begin));
        scheduledAt = now() + delay;
        timer = setTimeout(resolve, delay);
      });
    }
  })();
  return {
    phase(name) { assert(/^[A-Z_]{1,32}$/.test(name)); if (phase === name) return; finishPhase(now()); phase = name; enter(name); },
    snapshot() { return { failure: result.failure, peakRssKiB: result.peakRssKiB, samples: result.samples,
      phases: JSON.parse(JSON.stringify(phases)) }; },
    async stop() {
      if (stoppedAt === undefined) { stoppedAt = now(); finishPhase(stoppedAt); }
      stopped = true; clearTimeout(timer); releaseSleep?.();
      // A read that never settles is a sampling failure, not a reason to hang the run.
      let bound;
      const settled = await Promise.race([task.then(() => true),
        new Promise(resolve => { bound = setTimeout(() => resolve(false), stopTimeoutMs); })]);
      clearTimeout(bound);
      if (!settled && !result.failure) {
        result.failure = 'MEMORY_SAMPLE_FAILED';
        result.failureDetail = { operation: 'STOP', reason: 'READ_DID_NOT_SETTLE', phase, elapsedMs: Math.round(stoppedAt - started) };
      }
      const trailing = lastAt === null ? null : Math.max(0, stoppedAt - lastAt);
      if (trailing !== null) result.maximumGapMs = Math.max(result.maximumGapMs, trailing);
      return { ...result, trailingGapMs: trailing, observedPids: [...observed].sort((a, b) => a - b) };
    },
  };
}

// A phase peak is usable only when that phase was sampled without a failure and without long gaps.
function phaseSamplingComplete(memory, phase, { maximumGapMs = 250, minimumSamples = 1 } = {}) {
  const entry = memory?.phases?.[phase];
  return Boolean(memory && !memory.failure && memory.missingOwnerSamples === 0 && entry
    && entry.samples >= minimumSamples && entry.maximumGapMs <= maximumGapMs);
}

function installWorkloadClick(name) {
  window.__workload ??= { marks: {} };
  delete window.__workload.marks[name];
  document.addEventListener('click', () => { window.__workload.marks[name] ??= performance.now(); }, { capture: true, once: true });
}

// Serialized into the renderer: action and acknowledgement share performance.now().
function installWorkloadWatch({ name, condition }) {
  window.__workload ??= { marks: {} };
  const marks = window.__workload.marks; delete marks[name];
  const holds = () => {
    if (condition.after && !Number.isFinite(marks[condition.after])) return false;
    if (condition.kind === 'button') {
      const labels = Array.isArray(condition.text) ? condition.text : [condition.text];
      return [...document.querySelectorAll('button')].some(button => {
        const text = button.textContent.trim();
        return text.length > 0 && labels.includes(text);
      });
    }
    if (condition.kind === 'region') return condition.label.some(label => document.querySelector(`section[aria-label="${label}"]`));
    if (condition.kind === 'rows') return new RegExp(condition.path).test(location.pathname)
      && document.querySelectorAll(condition.RESULT_ROWS).length >= condition.minimum;
    return false;
  };
  const observer = new MutationObserver(() => { if (holds()) { marks[name] ??= performance.now(); observer.disconnect(); } });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  if (holds()) { marks[name] = performance.now(); observer.disconnect(); }
}

module.exports = { SLO, percentile95, evaluateRow, describeSmoke, startPhaseSampler, phaseSamplingComplete, SAMPLE_INTERVAL_MS, installWorkloadWatch, installWorkloadClick };
