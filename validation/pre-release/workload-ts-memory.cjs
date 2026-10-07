'use strict';

// In-process TS/JS extraction observation for one G-PERF size class: the workload fixture's
// TS/JS subset (generated in memory, nothing written) through a built ts-analyzer `extractTs`.
// Prints one JSON line: input size, wall time, peak process RSS (50 ms samples, including the
// generated input), a digest of the full result and its counts. Not an acceptance measurement.
//
//   (cd analyzers/ts-analyzer && npx tsc -p tsconfig.json --outDir <dist>)
//   NODE_PATH=analyzers/ts-analyzer/node_modules \
//     node validation/pre-release/workload-ts-memory.cjs --dist <dist> --class medium [--single]
const crypto = require('node:crypto');
const path = require('node:path');
const { SIZE_CLASSES, planWorkload } = require('./workload-fixture.cjs');

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const dist = option('--dist');
const sizeClass = option('--class');
if (!dist || !Object.hasOwn(SIZE_CLASSES, sizeClass ?? '')) {
  console.error('usage: workload-ts-memory.cjs --dist <built ts-analyzer dist> --class small|medium|large [--single]');
  process.exit(2);
}
const { extractTs } = require(path.resolve(dist, 'ts-extractor.js'));
const input = planWorkload({ ...SIZE_CLASSES[sizeClass], seed: 'g-perf-1' }).files
  .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.path))
  .map(({ path: file, content }) => ({ path: file, content }));
let peak = process.memoryUsage().rss;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
const started = Date.now();
try {
  // --single forces one whole-manifest program (the pre-slicing behavior) for comparison.
  const result = extractTs(input, process.argv.includes('--single') ? { singleProgramBytes: Number.MAX_SAFE_INTEGER } : {});
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(JSON.stringify({
    sizeClass, files: input.length, mib: +(input.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) / 1048576).toFixed(1),
    ms: Date.now() - started, peakRssMiB: Math.round(peak / 1048576),
    digest: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    nodes: result.nodes.length, edges: result.edges.length, endpoints: result.endpoints.length, routes: result.routes.length,
    imports: result.imports.length, unresolvedCalls: result.unresolvedCalls.length,
  }));
} catch (error) {
  console.log(JSON.stringify({ sizeClass, files: input.length, ms: Date.now() - started,
    peakRssMiB: Math.round(Math.max(peak, process.memoryUsage().rss) / 1048576), error: String(error).slice(0, 200) }));
  process.exitCode = 1;
} finally { clearInterval(timer); }
