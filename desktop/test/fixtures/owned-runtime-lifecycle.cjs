'use strict';

// Fixture-only lifetime bookkeeping. A launch-bound handle is never reconstructed
// from its numeric PID, and failed writer cleanup never authorizes releasing B.
function trackManagedProcess(child, name, records, onProcess) {
  if (!child || typeof child.kill !== 'function' || !child.termination
      || typeof child.termination.then !== 'function') throw new Error('FIXTURE_OWNER_MISSING');
  const record = { child, name, stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0,
    stopped: false, error: null, guarded: true, helperPid: child.helperPid };
  records.add(record);
  child.on('error', () => { record.error = true; });
  record.done = child.termination.then(proof => {
    record.stopped = proof.stopped === true; record.code = proof.exitCode; record.signal = proof.signalCode;
  }, () => { record.error = true; });
  // Registration precedes reporting; diagnostics cannot throw away ownership.
  try { onProcess?.({ name, pid: child.pid ?? null, helperPid: child.helperPid ?? null, guarded: true }); }
  catch { record.error = true; }
  return record;
}

async function closeInOrder({ writers, stop, closeSources, closeRuntime, closeSafety, closeTransport }) {
  let writersStopped = true;
  for (const writer of writers) {
    try { await stop(writer); } catch { writersStopped = false; }
  }
  if (!writersStopped) return { safe: false, barrier: 'WRITERS' };
  try { await closeSources(); } catch { return { safe: false, barrier: 'SOURCE_DRAIN' }; }
  try { await closeRuntime(); } catch { return { safe: false, barrier: 'RUNTIME_DRAIN' }; }
  try { await closeSafety(); } catch { return { safe: false, barrier: 'SAFETY_CLOSE' }; }
  try { await closeTransport(); } catch { return { safe: false, barrier: 'TRANSPORT_CLOSE' }; }
  return { safe: true, barrier: null };
}

module.exports = Object.freeze({ trackManagedProcess, closeInOrder });
