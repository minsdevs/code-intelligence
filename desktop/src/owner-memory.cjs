'use strict';

// 05 §4 (R10): main measures its own process tree (backend, analyzers, databases) and reports the
// resident total to the backend's 6 GiB analysis watchdog. The backend never starts a process for
// it (05 §1); main runs one fixed /bin/ps. Shared pages are counted once per process, as the
// workload runner's owner-tree samples count them.
const PS = '/bin/ps';
const PS_ARGS = Object.freeze(['-axo', 'pid=,ppid=,rss=']);
const MAX_OUTPUT = 4 * 1024 * 1024;
const PS_TIMEOUT_MS = 2_000;
// The backend samples every 2 s while a run is watched; otherwise a slower report keeps
// admission current without a constant process-table scan.
const WATCH_MS = 2_000;
const IDLE_MS = 5_000;

function ownerTreeBytes(table, root) {
  const rssKib = new Map(); const children = new Map();
  for (const line of String(table).split('\n')) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || fields.some(value => !/^[0-9]{1,15}$/.test(value))) return null;
    const [pid, parent, rss] = fields.map(Number);
    rssKib.set(pid, rss);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  if (!rssKib.has(root)) return null;
  let total = 0; const seen = new Set(); const pending = [root];
  while (pending.length) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rssKib.get(pid) ?? 0;
    for (const child of children.get(pid) ?? []) if (child !== pid) pending.push(child);
  }
  return total * 1024;
}

function sampleOwnerTree(execFile, root) {
  return new Promise((resolve) => {
    execFile(PS, [...PS_ARGS], { encoding: 'latin1', env: {}, shell: false, windowsHide: true,
      timeout: PS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT }, (error, stdout) => resolve(error ? null : ownerTreeBytes(stdout, root)));
  });
}

// report(bytes) resolves true while the backend watches a run. Sampling happens only while
// active() holds; failures are skipped until the next report.
function startOwnerMemoryReporter({ root, execFile, report, active, setTimeout, clearTimeout }) {
  let timer = null; let stopped = false;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(tick, delay);
    timer?.unref?.();
  };
  async function tick() {
    timer = null;
    let watching = false;
    try {
      if (active()) {
        const bytes = await sampleOwnerTree(execFile, root);
        if (bytes !== null && !stopped && active()) watching = (await report(bytes)) === true;
      }
    } catch {}
    schedule(watching ? WATCH_MS : IDLE_MS);
  }
  schedule(0);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
}

module.exports = { ownerTreeBytes, sampleOwnerTree, startOwnerMemoryReporter, PS, PS_ARGS, WATCH_MS, IDLE_MS };
