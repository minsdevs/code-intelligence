'use strict';

// Backend heap observation for one G-PERF size class below the packaged app: generates the
// workload fixture into a private temporary directory, starts the real local TS analyzer
// (analyzers/ts-analyzer/accuracy-server.cjs, loopback only) and runs every analysis step after
// IMPORT in a Gradle test JVM with the desktop backend's heap options (WorkloadMemoryHarnessTest).
// Step boundaries are printed as `[workload-memory]` lines. Not an acceptance measurement.
//
//   (cd analyzers/ts-analyzer && npm run build)
//   node validation/pre-release/workload-backend-memory.cjs --class medium [--heap 2048m]
//     [--files N --bytes B] [--heap-dump-dir <dir>] [--keep-fixture]
//     [--explain-ms <ms> --explain-log <file>]   plans of slower statements (auto_explain, PostgreSQL log)
//     [--jfr <file>]                             CPU profile of the test JVM (JFR, profile settings)
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SIZE_CLASSES, generateWorkload } = require('./workload-fixture.cjs');

const ROOT = path.resolve(__dirname, '../..');

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main() {
  const sizeClass = option('--class');
  const files = option('--files');
  const bytes = option('--bytes');
  assert(Object.hasOwn(SIZE_CLASSES, sizeClass ?? '') !== (files !== undefined),
    'usage: --class small|medium|large, or --files N --bytes B');
  const heap = option('--heap') ?? '2048m';
  assert(/^[0-9]+[mg]$/.test(heap), 'HEAP_INVALID');
  const dumpDir = option('--heap-dump-dir');
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ciwm-')));
  let analyzer;
  try {
    const manifest = generateWorkload(sizeClass
      ? { root: fixture, sizeClass }
      : { root: fixture, files: Number(files), bytes: Number(bytes) });
    console.log(JSON.stringify({ fixture: { sizeClass: manifest.sizeClass, files: manifest.files, bytes: manifest.bytes,
      treeSha256: manifest.treeSha256 } }));
    analyzer = spawn(process.execPath, [path.join(ROOT, 'analyzers/ts-analyzer/accuracy-server.cjs')],
      { cwd: path.join(ROOT, 'analyzers/ts-analyzer'), stdio: ['ignore', 'pipe', 'inherit'] });
    const url = await new Promise((resolve, reject) => {
      let text = '';
      analyzer.stdout.on('data', chunk => {
        text += chunk;
        if (text.includes('\n')) resolve(text.split('\n')[0].trim());
      });
      analyzer.once('exit', code => reject(new Error(`TS analyzer exited (${code})`)));
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
    const args = ['--offline', '-p', path.join(ROOT, 'backend'), 'workloadMemoryTest', '--console=plain',
      `-PworkloadFixture=${fixture}`, `-PworkloadTsUrl=${url}`, `-PworkloadHeap=${heap}`];
    if (dumpDir) args.push(`-PworkloadHeapDumpDir=${path.resolve(dumpDir)}`);
    const explainMs = option('--explain-ms');
    const explainLog = option('--explain-log');
    assert((explainMs === undefined) === (explainLog === undefined), 'usage: --explain-ms <ms> --explain-log <file>');
    if (explainMs !== undefined) {
      assert(/^[0-9]+$/.test(explainMs), 'EXPLAIN_MS_INVALID');
      args.push(`-PworkloadExplainMs=${explainMs}`, `-PworkloadExplainLog=${path.resolve(explainLog)}`);
    }
    const jfr = option('--jfr');
    if (jfr) args.push(`-PworkloadJfr=${path.resolve(jfr)}`);
    // The test JVM prints its pid; both processes' RSS is sampled every 500 ms.
    const peaks = { analyzer: 0, testJvm: 0 };
    let testJvm = null;
    const rssKib = pid => Number(spawnSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
      .stdout.trim()) || 0;
    const sampler = setInterval(() => {
      peaks.analyzer = Math.max(peaks.analyzer, rssKib(analyzer.pid));
      if (testJvm) peaks.testJvm = Math.max(peaks.testJvm, rssKib(testJvm));
    }, 500);
    const gradle = spawn(path.join(ROOT, 'backend/gradlew'), args, { stdio: ['ignore', 'pipe', 'inherit'] });
    gradle.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      const match = /\[workload-memory\] pid=([0-9]+)/.exec(String(chunk));
      if (match) testJvm = Number(match[1]);
    });
    const status = await new Promise(resolve => gradle.once('exit', code => resolve(code)));
    clearInterval(sampler);
    console.log(JSON.stringify({ gradleExit: status, tsAnalyzerPeakRssMiB: Math.round(peaks.analyzer / 1024),
      testJvmPeakRssMiB: Math.round(peaks.testJvm / 1024) }));
    process.exitCode = status === 0 ? 0 : 1;
  } finally {
    if (analyzer && analyzer.exitCode === null) analyzer.kill('SIGTERM');
    if (process.argv.includes('--keep-fixture')) console.log(JSON.stringify({ keptFixture: fixture }));
    else fs.rmSync(fixture, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
