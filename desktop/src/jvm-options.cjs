'use strict';

// Heap budgets for the desktop's distinct Java roles. Heap is only part of RSS;
// native memory, class metadata and the other app processes are measured separately.
// Keep analysis headroom without scaling the backend to a fraction of a large host.
const BACKEND_JVM_OPTIONS = Object.freeze(['-Xms64m', '-Xmx2048m']);

// Lease and process-guardian workers handle bounded control frames, not analysis.
// Fixed small heaps also avoid multiplying host-sized JVM startup ergonomics.
const CONTROL_JVM_OPTIONS = Object.freeze(['-Xms16m', '-Xmx64m']);

module.exports = Object.freeze({ BACKEND_JVM_OPTIONS, CONTROL_JVM_OPTIONS });
