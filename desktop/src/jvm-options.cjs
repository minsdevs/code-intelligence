'use strict';

// Heap budgets for the desktop's distinct Java roles. Heap is only part of RSS;
// native memory, class metadata and the other app processes are measured separately.
// Keep analysis headroom without scaling the backend to a fraction of a large host.
// The single-user backend uses the serial collector: G1's concurrent threads and region
// bookkeeping cost about 60MiB of resident memory before any analysis runs.
// Committed heap is returned between pipeline steps (backend StepHeapRelease): after the explicit
// collection the serial collector shrinks the heap to at most 50% free in one step instead of
// keeping the analysis-time maximum committed while the TS analyzer worker runs beside it
// (05 §4 incremental RSS cap, 2026-10-11). Growth behaviour (MinHeapFreeRatio) is unchanged.
const BACKEND_JVM_OPTIONS = Object.freeze(['-Xms64m', '-Xmx2048m', '-XX:+UseSerialGC', '-XX:MaxHeapFreeRatio=50', '-XX:-ShrinkHeapInSteps']);

// Lease and process-guardian workers handle bounded control frames, not analysis.
// Fixed small heaps also avoid multiplying host-sized JVM startup ergonomics.
// Lease/guardian workers retain small control state and mostly wait on IO.
// Keep their collector and compiler overhead separate from the analysis backend.
const CONTROL_JVM_OPTIONS = Object.freeze(['-Xms16m', '-Xmx64m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1']);

module.exports = Object.freeze({ BACKEND_JVM_OPTIONS, CONTROL_JVM_OPTIONS });
