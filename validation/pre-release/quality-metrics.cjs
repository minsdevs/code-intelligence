'use strict';

// Checks the existing single-invocation quality baseline. This does not measure
// the application's process tree, repeat a workload or establish G-PERF readiness.
// CLI: node quality-metrics.cjs <Darwin|Linux> <time-log> <command-exit>
//      <elapsed-seconds> <max-seconds> <max-rss-kib>
const fs = require('node:fs');

class QualityMetricsError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function integer(value, code, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string' || value.match(/^(?:0|[1-9][0-9]*)$/)?.[0] !== value) {
    throw new QualityMetricsError(code);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new QualityMetricsError(code);
  }
  return parsed;
}

function parseRssKiB(platform, output) {
  if (platform !== 'Darwin' && platform !== 'Linux') throw new QualityMetricsError('TIME_PLATFORM_UNSUPPORTED');
  if (typeof output !== 'string') throw new QualityMetricsError('TIME_LOG_UNREADABLE');
  if (output.includes('\0')) throw new QualityMetricsError('RSS_INVALID');
  // A malformed or second matching record must not be hidden by taking the last one.
  const records = output.split(/\r?\n/).filter(line => /maximum resident set size/i.test(line));
  if (records.length === 0) throw new QualityMetricsError('RSS_MISSING');
  if (records.length !== 1) throw new QualityMetricsError('RSS_AMBIGUOUS');
  const pattern = platform === 'Darwin'
    ? /^[ \t]*([0-9]+)[ \t]+maximum resident set size[ \t]*$/
    : /^[ \t]*Maximum resident set size \(kbytes\):[ \t]*([0-9]+)[ \t]*$/;
  const match = pattern.exec(records[0]);
  if (!match) throw new QualityMetricsError('RSS_INVALID');
  const raw = integer(match[1], 'RSS_INVALID');
  if (raw === 0) throw new QualityMetricsError('RSS_ZERO');
  // Darwin reports bytes; GNU time's kbytes are KiB. Round UP so even one byte
  // beyond the existing integer-KiB ceiling fails instead of being truncated away.
  return platform === 'Darwin' ? Math.ceil(raw / 1024) : raw;
}

function evaluateQualityMetrics({ platform, timeOutput, commandExitCode, elapsedSeconds, maxSeconds, maxRssKiB } = {}) {
  const failures = [];
  const check = callback => {
    try { return callback(); }
    catch (error) {
      if (!(error instanceof QualityMetricsError)) throw error;
      failures.push(error.code);
      return null;
    }
  };
  const command = check(() => integer(commandExitCode, 'COMMAND_EXIT_INVALID', 0, 255));
  if (command !== null && command !== 0) failures.push('BACKEND_COMMAND_FAILED');
  // The shell measures whole seconds, so a sub-second successful run may be zero.
  const elapsed = check(() => integer(elapsedSeconds, 'ELAPSED_INVALID'));
  const secondsLimit = check(() => integer(maxSeconds, 'SECONDS_LIMIT_INVALID', 1));
  const rssLimit = check(() => integer(maxRssKiB, 'RSS_LIMIT_INVALID', 1));
  const rss = check(() => parseRssKiB(platform, timeOutput));
  if (elapsed !== null && secondsLimit !== null && elapsed > secondsLimit) failures.push('ELAPSED_LIMIT_EXCEEDED');
  if (rss !== null && rssLimit !== null && rss > rssLimit) failures.push('RSS_LIMIT_EXCEEDED');
  return {
    scope: 'TIMED_GRADLE_REGRESSION',
    exitCode: command !== null && command !== 0 ? command : failures.length ? 1 : 0,
    commandExitCode: command,
    elapsedSeconds: elapsed,
    maxSeconds: secondsLimit,
    rssKiB: rss,
    maxRssKiB: rssLimit,
    failures,
  };
}

// Injectable I/O keeps CLI failure/exit tests local and avoids spawning any tools.
function main(argv, { readText = fs.readFileSync, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (!Array.isArray(argv) || argv.length !== 6) {
    stderr.write('[FAIL] quality metrics: ARGUMENTS_INVALID\n');
    return 1;
  }
  const [platform, logFile, commandExitCode, elapsedSeconds, maxSeconds, maxRssKiB] = argv;
  let timeOutput;
  try { timeOutput = readText(logFile, 'utf8'); }
  catch { timeOutput = null; }
  const result = evaluateQualityMetrics({ platform, timeOutput, commandExitCode, elapsedSeconds, maxSeconds, maxRssKiB });
  if (result.exitCode !== 0) {
    const show = value => value === null ? 'unavailable' : String(value);
    stderr.write(`[FAIL] quality metrics: ${result.failures.join(', ')}; `
      + `command-exit=${show(result.commandExitCode)}, `
      + `elapsed=${show(result.elapsedSeconds)}/${show(result.maxSeconds)}s, `
      + `rss=${show(result.rssKiB)}/${show(result.maxRssKiB)}KiB\n`);
    return result.exitCode;
  }
  // stdout is consumed by quality-gate; never emit a number when any check failed.
  stdout.write(`${result.rssKiB}\n`);
  return 0;
}

module.exports = { parseRssKiB, evaluateQualityMetrics, main };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch {
    process.stderr.write('[FAIL] quality metrics: INTERNAL_ERROR\n');
    process.exitCode = 1;
  }
}
