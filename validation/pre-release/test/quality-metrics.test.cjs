'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRssKiB, evaluateQualityMetrics, main } = require('../quality-metrics.cjs');

// Authored time-output examples only: these are not measurements of an app/build.
const darwin = value => `        ${value}  maximum resident set size\n`;
const linux = value => `\tMaximum resident set size (kbytes): ${value}\n`;
const input = overrides => ({
  platform: 'Linux', timeOutput: linux('127584'), commandExitCode: '0',
  elapsedSeconds: '28', maxSeconds: '300', maxRssKiB: '2097152', ...overrides,
});

test('Darwin bytes and Linux KiB yield the same KiB with unrelated time output', () => {
  const mac = '        28.00 real         0.10 user         0.04 sys\n'
    + darwin('130646016') + '               0  page reclaims\n';
  const gnu = '\tCommand being timed: "gradlew --offline test"\n'
    + linux('127584') + '\tExit status: 0\n';
  assert.equal(parseRssKiB('Darwin', mac), 127584);
  assert.equal(parseRssKiB('Linux', gnu), 127584);
  assert.equal(parseRssKiB('Darwin', mac.replaceAll('\n', '\r\n')), 127584);
  assert.equal(parseRssKiB('Linux', gnu.replaceAll('\n', '\r\n')), 127584);
});

test('Darwin rounds up instead of losing sub-KiB usage or a one-byte excess', () => {
  for (const [bytes, kib] of [['1', 1], ['1023', 1], ['1024', 1], ['1025', 2]]) {
    assert.equal(parseRssKiB('Darwin', darwin(bytes)), kib);
  }
  const boundary = evaluateQualityMetrics(input({ platform: 'Darwin', timeOutput: darwin('2147483648') }));
  const excess = evaluateQualityMetrics(input({ platform: 'Darwin', timeOutput: darwin('2147483649') }));
  assert.equal(boundary.rssKiB, 2097152);
  assert.equal(boundary.exitCode, 0);
  assert.equal(excess.rssKiB, 2097153);
  assert.equal(excess.exitCode, 1);
  assert.deepEqual(excess.failures, ['RSS_LIMIT_EXCEEDED']);
});

for (const [platform, format] of [['Darwin', darwin], ['Linux', linux]]) {
  test(`${platform} requires a present, nonzero, unambiguous measurement`, () => {
    for (const output of ['', 'BUILD SUCCESSFUL\n', '  123  average resident set size\n']) {
      assert.throws(() => parseRssKiB(platform, output), { code: 'RSS_MISSING' });
    }
    assert.throws(() => parseRssKiB(platform, null), { code: 'TIME_LOG_UNREADABLE' });
    assert.throws(() => parseRssKiB(platform, format('0')), { code: 'RSS_ZERO' });
    for (const second of [format('1024'), format('0'), format('invalid')]) {
      assert.throws(() => parseRssKiB(platform, format('1024') + second), { code: 'RSS_AMBIGUOUS' });
      assert.throws(() => parseRssKiB(platform, second + format('1024')), { code: 'RSS_AMBIGUOUS' });
    }
  });

  test(`${platform} refuses malformed, signed, fractional, localized and unsafe values`, () => {
    for (const value of ['', '-1', '+1024', '1.5', '1e6', 'NaN', 'Infinity', '1,024', '001024',
      '1024KiB', '1 024', '９９９', '9007199254740992', '9'.repeat(400), '1024\0']) {
      assert.throws(() => parseRssKiB(platform, format(value)), { code: 'RSS_INVALID' }, value);
    }
  });
}

test('a value in the other OS format cannot be given the wrong units', () => {
  assert.throws(() => parseRssKiB('Darwin', linux('1024')), { code: 'RSS_INVALID' });
  assert.throws(() => parseRssKiB('Linux', darwin('1024')), { code: 'RSS_INVALID' });
  assert.throws(() => parseRssKiB('Linux', 'Maximum resident set size (bytes): 1024\n'), { code: 'RSS_INVALID' });
  for (const platform of ['darwin', 'linux', 'FreeBSD', 'win32', '', undefined]) {
    assert.throws(() => parseRssKiB(platform, linux('1024')), { code: 'TIME_PLATFORM_UNSUPPORTED' });
  }
});

test('existing exact limits pass and both independent limit failures are retained', () => {
  const atLimit = evaluateQualityMetrics(input({ elapsedSeconds: '300', timeOutput: linux('2097152') }));
  assert.equal(atLimit.exitCode, 0);
  assert.deepEqual(atLimit.failures, []);
  const elapsedOnly = evaluateQualityMetrics(input({ elapsedSeconds: '301' }));
  assert.deepEqual(elapsedOnly.failures, ['ELAPSED_LIMIT_EXCEEDED']);
  assert.equal(elapsedOnly.exitCode, 1);
  const rssOnly = evaluateQualityMetrics(input({ timeOutput: linux('2097153') }));
  assert.deepEqual(rssOnly.failures, ['RSS_LIMIT_EXCEEDED']);
  assert.equal(rssOnly.exitCode, 1);
  const both = evaluateQualityMetrics(input({ elapsedSeconds: '301', timeOutput: linux('2097153') }));
  assert.deepEqual(both.failures, ['ELAPSED_LIMIT_EXCEEDED', 'RSS_LIMIT_EXCEEDED']);
  assert.equal(both.exitCode, 1);
});

test('whole-second elapsed zero is legitimate, but missing or invalid elapsed never passes', () => {
  assert.equal(evaluateQualityMetrics(input({ elapsedSeconds: '0' })).exitCode, 0);
  for (const elapsedSeconds of ['', undefined, '-1', '1.5', 'NaN', '300s', '300\n', ' 300', '9007199254740992']) {
    const result = evaluateQualityMetrics(input({ elapsedSeconds }));
    assert.equal(result.exitCode, 1);
    assert.equal(result.elapsedSeconds, null);
    assert.deepEqual(result.failures, ['ELAPSED_INVALID']);
  }
});

test('missing, zero or invalid limits cannot disable their gate', () => {
  for (const [field, code] of [['maxSeconds', 'SECONDS_LIMIT_INVALID'], ['maxRssKiB', 'RSS_LIMIT_INVALID']]) {
    for (const value of [undefined, '', '0', '-1', 'NaN', 'Infinity', '300.5', '300\n', '300\r', '9007199254740992']) {
      const result = evaluateQualityMetrics(input({ [field]: value }));
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.failures, [code]);
    }
  }
});

test('valid measurements cannot hide a failed timed command, including a signal exit', () => {
  for (const commandExitCode of ['1', '7', '127', '137', '255']) {
    const result = evaluateQualityMetrics(input({ commandExitCode }));
    assert.equal(result.exitCode, Number(commandExitCode));
    assert.deepEqual(result.failures, ['BACKEND_COMMAND_FAILED']);
  }
  for (const commandExitCode of [undefined, '', '-1', '256', '1.5', 'NaN', '00', '0\n', '0\r', ' 0']) {
    const result = evaluateQualityMetrics(input({ commandExitCode }));
    assert.equal(result.exitCode, 1);
    assert.equal(result.commandExitCode, null);
    assert.deepEqual(result.failures, ['COMMAND_EXIT_INVALID']);
  }
});

test('command and missing/invalid measurement failures both survive with the original exit', () => {
  for (const [timeOutput, code] of [['', 'RSS_MISSING'], [linux('0'), 'RSS_ZERO'],
    [linux('invalid'), 'RSS_INVALID'], [null, 'TIME_LOG_UNREADABLE']]) {
    const result = evaluateQualityMetrics(input({ commandExitCode: '7', timeOutput }));
    assert.equal(result.exitCode, 7);
    assert.equal(result.rssKiB, null);
    assert.deepEqual(result.failures, ['BACKEND_COMMAND_FAILED', code]);
  }
  const all = evaluateQualityMetrics(input({ commandExitCode: '137', elapsedSeconds: '301', timeOutput: linux('2097153') }));
  assert.equal(all.exitCode, 137);
  assert.deepEqual(all.failures, ['BACKEND_COMMAND_FAILED', 'ELAPSED_LIMIT_EXCEEDED', 'RSS_LIMIT_EXCEEDED']);
});

function cli({ output = linux('127584'), command = '0', elapsed = '28', unreadable = false, args } = {}) {
  let stdout = '', stderr = '', reads = 0;
  const exitCode = main(args ?? ['Linux', 'authored-time-log', command, elapsed, '300', '2097152'], {
    readText(file, encoding) {
      reads++;
      assert.equal(file, 'authored-time-log'); assert.equal(encoding, 'utf8');
      if (unreadable) throw new Error('private path or command stderr must not leak');
      return output;
    },
    stdout: { write: text => { stdout += text; } },
    stderr: { write: text => { stderr += text; } },
  });
  return { exitCode, stdout, stderr, reads };
}

test('CLI emits a numeric value only when the command and every metric check pass', () => {
  assert.deepEqual(cli(), { exitCode: 0, stdout: '127584\n', stderr: '', reads: 1 });
  for (const options of [{ output: '' }, { output: linux('0') }, { output: linux('invalid') },
    { output: linux('2097153') }, { elapsed: '301' }, { command: '7' }, { unreadable: true }]) {
    const result = cli(options);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^\[FAIL\] quality metrics:/);
    assert.doesNotMatch(result.stderr, /private path|command stderr/);
  }
});

test('CLI preserves simultaneous command/log failure and reports both instead of a metric', () => {
  const result = cli({ command: '19', unreadable: true });
  assert.equal(result.exitCode, 19);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /BACKEND_COMMAND_FAILED, TIME_LOG_UNREADABLE/);
  assert.match(result.stderr, /command-exit=19/);
  assert.match(result.stderr, /rss=unavailable\/2097152KiB/);
});

test('CLI rejects missing or surplus arguments before reading a log', () => {
  for (const args of [[], ['Linux'], Array(7).fill('unused')]) {
    const result = cli({ args });
    assert.equal(result.exitCode, 1); assert.equal(result.reads, 0); assert.equal(result.stdout, '');
    assert.equal(result.stderr, '[FAIL] quality metrics: ARGUMENTS_INVALID\n');
  }
});
