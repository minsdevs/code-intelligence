'use strict';

// Synthetic-only smoke of the production framed entrypoints. Every analysis starts a fresh worker.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../..');
const { FrameDecoder, encodeFrame, ADAPTER_STDIO_PROTOCOL, ADAPTER_STDIO_VERSION } =
  require(path.join(root, 'analyzers/ts-analyzer/dist/stdio-transport.js'));
const { planWorkload, generateWorkload, mutateWorkload, SIZE_CLASSES } = require('../pre-release/workload-fixture.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const cacheKey = crypto.randomBytes(32).toString('hex');

async function worker(adapter) {
  const runToken = crypto.randomBytes(32).toString('hex');
  const timed = process.platform === 'darwin' && process.argv.includes('--medium');
  const child = spawn(timed ? '/usr/bin/time' : process.execPath,
    timed ? ['-l', process.execPath, 'dist/stdio.js'] : ['dist/stdio.js'], {
    cwd: path.join(root, 'analyzers', adapter),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C', ADAPTER_RUN_TOKEN: runToken },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const done = once(child, 'exit');
  const decoder = new FrameDecoder(64 * 1024 * 1024);
  const pending = [];
  const ready = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); assert.ok(stderr.length < 64 * 1024); });
  child.stdout.on('data', chunk => {
    for (const frame of decoder.push(chunk)) {
      const resolve = pending.shift();
      if (resolve) resolve(frame); else ready.push(frame);
    }
  });
  const receive = () => ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('adapter response timeout')), 120_000);
    pending.push(value => { clearTimeout(timer); resolve(value); });
  });
  const send = value => child.stdin.write(encodeFrame(value, 10 * 1024 * 1024 + 4096));
  send({ protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, runToken });
  assert.equal((await receive()).ready, true);
  let id = 0;
  return {
    async analyze(body) {
      const expected = ++id;
      send({ id: expected, op: 'analyze', body });
      const response = await receive();
      assert.equal(response.id, expected);
      assert.equal(response.ok, true, 'adapter rejected synthetic analysis');
      return response.result;
    },
    async close() {
      child.stdin.end();
      const [code] = await done;
      assert.equal(code, 0);
      const metrics = stderr.split('\n').filter(line => /^(TS|TREE)_INCREMENTAL /.test(line))
        .map(line => JSON.parse(line.slice(line.indexOf(' ') + 1)));
      if (timed) {
        const peak = stderr.match(/^\s*(\d+)\s+maximum resident set size$/m);
        assert.ok(peak, 'native worker peak RSS measurement missing');
        metrics.peakRssBytes = Number(peak[1]);
      }
      return metrics;
    },
  };
}

async function tsSession(files, incremental, phase) {
  const started = performance.now();
  const transport = await worker('ts-analyzer');
  const manifest = { fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
    digest: sha(files.map(file => `${file.path}\n${sha(file.content)}\n`).join('')) };
  const opened = await transport.analyze({ files: [], session: { op: 'open', ...manifest, ...(incremental ? { cacheKey } : {}) } });
  const id = opened.session.id;
  for (let seq = 0; seq < files.length; seq++) {
    await transport.analyze({ files: [], session: { op: 'put', id, seq, files: [files[seq]] } });
  }
  await transport.analyze({ files: [], session: { op: 'seal', id, ...manifest } });
  const first = await transport.analyze({ files: [], session: { op: 'analyze', id } });
  const { session, ...result } = first;
  for (let page = 1; page < session.pages; page++) {
    const response = await transport.analyze({ files: [], session: { op: 'page', id, page } });
    for (const name of Object.keys(result)) result[name].push(...(response[name] || []));
  }
  await transport.analyze({ files: [], session: { op: 'close', id } });
  const metrics = await transport.close();
  const resources = { elapsedMs: Math.round(performance.now() - started), peakRssBytes: metrics.peakRssBytes };
  if (phase && process.argv.includes('--medium')) console.log(JSON.stringify({ phase, metrics: metrics[0], resources, cache: backendBudget(result).stats }));
  return { result, metrics, resources };
}

function withCache(files, result) {
  const entries = new Map((result.cache || []).map(entry => [JSON.parse(entry).path, entry]));
  return files.map(file => ({ ...file, cache: entries.get(file.path) || '' }));
}

function backendBudget(result) {
  const entries = result.cache || [];
  const retained = new Map();
  let chargedBytes = 0, evicted = 0, oversized = 0;
  for (const token of entries) {
    const bytes = token.length * 2;
    if (bytes > 128 * 1024) { oversized++; continue; }
    const key = JSON.parse(token).path;
    chargedBytes += bytes - (retained.get(key)?.length || 0) * 2;
    retained.set(key, token);
    while (chargedBytes > 16 * 1024 * 1024 || retained.size > 50_000) {
      const oldest = retained.keys().next().value;
      chargedBytes -= retained.get(oldest).length * 2;
      retained.delete(oldest);
      evicted++;
    }
  }
  return { result: { ...result, cache: [...retained.values()] }, stats: {
    entries: entries.length,
    tokenUtf8Bytes: entries.reduce((sum, token) => sum + Buffer.byteLength(token), 0),
    serializedArrayUtf8Bytes: Buffer.byteLength(JSON.stringify(entries)),
    offeredOwnerChargedBytes: entries.reduce((sum, token) => sum + token.length * 2, 0),
    retained: retained.size, retainedOwnerChargedBytes: chargedBytes, evicted, oversized,
  } };
}


async function treeHttp(input, incremental) {
  const net = require('node:net');
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.join(root, 'analyzers/tree-analyzer'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C', TREE_ANALYZER_HOST: '127.0.0.1', TREE_ANALYZER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); assert.ok(stderr.length < 64 * 1024); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tree HTTP startup timeout')), 10_000);
      child.stdout.on('data', chunk => { if (chunk.toString().includes('tree-analyzer listening')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('tree HTTP startup failed')); });
    });
    const response = await fetch('http://127.0.0.1:' + port + '/analyze', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: input, localPaths: input.map(file => file.path), ...(incremental ? { cacheKey } : {}) }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    return { result, metrics: stderr.split('\n').filter(line => line.startsWith('TREE_INCREMENTAL '))
      .map(line => JSON.parse(line.slice(line.indexOf(' ') + 1))) };
  } finally {
    child.kill('SIGTERM');
    await done;
  }
}

async function tsRevisionSmoke(spec = { files: 1200, bytes: 6 * 1024 * 1024, seed: 'g-perf-1' }) {
  const fs = require('node:fs');
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'adapter-revision-smoke-')));
  try {

    const manifest = generateWorkload({ root: temporary, ...spec });
    // Match TsParsingStep's source/config inventory; Java belongs to its separate parser.
    const files = planWorkload(spec).files.filter(file => /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|py|go)$/.test(file.path)
      || /(?:^|\/)(?:package|(?:tsconfig|jsconfig)(?:\.[^/]+)?)\.json$/.test(file.path))
      .map(({ path, content }) => ({ path, content }));
    const cold = await tsSession(files, true, 'cold');
    const mutation = mutateWorkload({ root: temporary, manifest });
    const changed = files.map(file => ({ path: file.path, content: fs.readFileSync(path.join(temporary, file.path), 'utf8') }));
    const edited = changed.filter((file, index) => file.content !== files[index].content).map(file => file.path);
    assert.ok(edited.some(file => file.endsWith('.service.ts')));
    const refresh = await tsSession(withCache(changed, cold.result), true, 'refresh');
    const clean = await tsSession(changed, false, 'clean-full');
    const { cache: _cache, ...graph } = refresh.result;
    assert.deepEqual(graph, clean.result);
    assert.ok(refresh.metrics[0].programFiles < cold.metrics[0].programFiles);
    assert.ok(refresh.metrics[0].reused > 0);
    const unchanged = await tsSession(withCache(changed, refresh.result), true, 'unchanged');
    const { cache: _unchangedCache, ...unchangedGraph } = unchanged.result;
    assert.deepEqual(unchangedGraph, clean.result);
    assert.equal(unchanged.metrics[0].programFiles, 0);
    const boundedCold = backendBudget(cold.result);
    assert.equal(boundedCold.stats.retained, files.filter(file => /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(file.path)).length);
    const boundedRefresh = await tsSession(withCache(changed, boundedCold.result), true, 'backend-capped-refresh');
    const { cache: _boundedCache, ...boundedGraph } = boundedRefresh.result;
    assert.deepEqual(boundedGraph, clean.result);
    assert.ok(boundedRefresh.metrics[0].reused > 0);
    assert.ok(boundedRefresh.metrics[0].metadataReused > 0);
    return { workloadFiles: manifest.files, changedFiles: mutation.changedFiles, adapterChangedFiles: edited.length,
      cold: cold.metrics[0], refresh: refresh.metrics[0], unchanged: unchanged.metrics[0],
      backendBudget: { cold: boundedCold.stats, refresh: backendBudget(boundedRefresh.result).stats,
        refreshMetrics: boundedRefresh.metrics[0], fullEquality: true },
      workerResources: { cold: cold.resources, refresh: refresh.resources, full: clean.resources,
        unchanged: unchanged.resources, backendCappedRefresh: boundedRefresh.resources },
      canonicalSha256: sha(JSON.stringify(graph)), fullEquality: true };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}


async function main() {
  if (process.argv.includes('--medium')) {
    const medium = await tsRevisionSmoke({ ...SIZE_CLASSES.medium, seed: 'g-perf-1' });
    console.log(JSON.stringify({ kind: 'production-stdio-medium-cache-diagnostic', packaged: false,
      timingGate: false, workersDestroyedBetweenRuns: true, ...medium }, null, 2));
    return;
  }
  const files = planWorkload({ files: 240, bytes: 1024 * 1024, seed: 'incremental-transport' }).files
    .map(({ path, content }) => ({ path, content }));
  const cold = await tsSession(files, true);
  const target = files.find(file => /web\/.*\.tsx$/.test(file.path));
  assert.ok(target, 'workload needs a real TSX body edit');
  const changed = files.map(file => file.path === target.path ? { ...file, content: file.content.replace('return (', "fetch('/api/incremental-body-edit'); return (") } : file);
  assert.notEqual(changed.find(file => file.path === target.path).content, target.content);
  const refresh = await tsSession(withCache(changed, cold.result), true);
  const clean = await tsSession(changed, false);
  const { cache: _cache, ...graph } = refresh.result;
  assert.deepEqual(graph, clean.result);
  assert.notDeepEqual(graph.apiCalls, cold.result.apiCalls, 'the body edit must change extracted facts');
  const coldMetrics = cold.metrics[0], refreshMetrics = refresh.metrics[0];
  assert.ok(refreshMetrics.reused > 0);
  assert.ok(refreshMetrics.programFiles < coldMetrics.programFiles);
  const unchanged = await tsSession(withCache(changed, refresh.result), true);
  assert.equal(unchanged.metrics[0].programFiles, 0);
  const { cache: _nextCache, ...unchangedGraph } = unchanged.result;
  assert.deepEqual(unchangedGraph, clean.result);
  const revision = await tsRevisionSmoke();

  const treeFiles = [
    { path: 'api.py', content: 'from model import Model\ndef run():\n    return Model()\n', cache: '' },
    { path: 'model.py', content: 'class Model:\n    pass\n', cache: '' },
    { path: 'main.go', content: 'package main\nfunc Run() int { return 1 }', cache: '' },
    { path: 'App.vue', content: '<script>export default { name: "App" }</script>', cache: '' },
    { path: 'routes/+page.svelte', content: '<script>let count = 0</script>', cache: '' },
  ];
  async function treeRun(input, incremental) {
    const transport = await worker('tree-analyzer');
    const result = await transport.analyze({ files: input, localPaths: input.map(file => file.path), ...(incremental ? { cacheKey } : {}) });
    return { result, metrics: await transport.close() };
  }
  const treeCold = await treeRun(treeFiles, true);
  const treeChanged = treeFiles.map(file => file.path === 'model.py' ? { ...file, content: 'class Model:\n    value = 1\n' } : file);
  const treeRefresh = await treeRun(withCache(treeChanged, treeCold.result), true);
  const treeClean = await treeRun(treeChanged, false);
  const { cache: _treeCache, ...treeGraph } = treeRefresh.result;
  assert.deepEqual(treeGraph, treeClean.result);
  assert.equal(treeRefresh.metrics[0].parsed, 1);
  assert.equal(treeRefresh.metrics[0].reused, 4);
  const httpCold = await treeHttp(treeFiles, true);
  const httpRefresh = await treeHttp(withCache(treeChanged, httpCold.result), true);
  const httpClean = await treeHttp(treeChanged, false);
  const { cache: _httpCache, ...httpGraph } = httpRefresh.result;
  assert.deepEqual(httpGraph, httpClean.result);
  assert.deepEqual(httpGraph, treeGraph);
  assert.equal(httpRefresh.metrics[0].parsed, 1);
  assert.equal(httpRefresh.metrics[0].reused, 4);
  if (process.env.ADAPTER_REFRESH_SMOKE_DIR) {
    const fs = require('node:fs');
    const destination = path.resolve(process.env.ADAPTER_REFRESH_SMOKE_DIR);
    assert.ok(destination.startsWith(path.join(root, 'validation/local') + path.sep));
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const [name, value] of Object.entries({ 'ts-incremental': graph, 'ts-full': clean.result,
      'tree-incremental': httpGraph, 'tree-full': httpClean.result })) {
      fs.writeFileSync(path.join(destination, name + '.json'), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    }
  }
  console.log(JSON.stringify({ kind: 'production-stdio-incremental-smoke', packaged: false,
    ts: { cold: coldMetrics, refresh: refreshMetrics, unchanged: unchanged.metrics[0], canonicalSha256: sha(JSON.stringify(graph)), fullEquality: true },
    seededOnePercentRevision: revision,
    tree: { cold: treeCold.metrics[0], refresh: treeRefresh.metrics[0], httpRefresh: httpRefresh.metrics[0], canonicalSha256: sha(JSON.stringify(treeGraph)), fullEquality: true },
    workersDestroyedBetweenRuns: true }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
