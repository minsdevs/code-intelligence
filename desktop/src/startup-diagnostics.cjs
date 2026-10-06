'use strict';

// Fixed diagnostic vocabulary only. Never serialize the original message, cause,
// stack, path, filename, connection string or bytes into startup evidence.
const INTEGRITY_CODES = Object.freeze([
  'SAFETY_BUILD_SEQUENCE_INVALID',
  'RUNTIME_MANIFEST_INVALID', 'RUNTIME_MANIFEST_MISSING', 'RUNTIME_MANIFEST_JSON',
  'RUNTIME_MANIFEST_PLATFORM', 'RUNTIME_MANIFEST_BUILD', 'RUNTIME_MANIFEST_PROTOCOL',
  'RUNTIME_MANIFEST_PATH', 'RUNTIME_INVENTORY_LIMIT', 'RUNTIME_INVENTORY_TYPE',
  'RUNTIME_INVENTORY_UNEXPECTED', 'RUNTIME_INVENTORY_MISSING', 'RUNTIME_INVENTORY_CHANGED',
  'RUNTIME_INVENTORY_HASH', 'RUNTIME_IO_EACCES', 'RUNTIME_IO_EPERM', 'RUNTIME_IO_ENOENT',
  'RUNTIME_IO_EMFILE', 'RUNTIME_IO_ENFILE', 'RUNTIME_IO_EIO', 'RUNTIME_IO_ENOMEM',
  'RUNTIME_IO_ENOSPC', 'RUNTIME_INTEGRITY_FAILED',
  'RUNTIME_IO_EBADF', 'RUNTIME_IO_EINTR', 'RUNTIME_IO_EAGAIN', 'RUNTIME_IO_ECANCELED',
  'RUNTIME_STREAM_CLOSED', 'RUNTIME_STREAM_DESTROYED', 'RUNTIME_OPERATION_ABORTED',
  'RUNTIME_NODE_ARGUMENT', 'RUNTIME_NODE_RANGE', 'RUNTIME_NODE_STATE',
  'RUNTIME_JS_TYPE_ERROR', 'RUNTIME_JS_RANGE_ERROR',
]);
const INTEGRITY_OPERATIONS = Object.freeze([
  'STRUCTURE', 'LSTAT', 'READDIR', 'OPEN', 'HANDLE_STAT_PRE', 'READ', 'STREAM', 'HASH',
  'HANDLE_STAT_POST', 'LSTAT_POST', 'CLOSE', 'FINALIZE',
]);
const integrityCodes = new Set(INTEGRITY_CODES);
const integrityOperations = new Set(INTEGRITY_OPERATIONS);
const ioCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'EIO', 'ENOMEM', 'ENOSPC',
  'EBADF', 'EINTR', 'EAGAIN', 'ECANCELED']);
const nodeCodes = Object.freeze({ ERR_STREAM_PREMATURE_CLOSE: 'RUNTIME_STREAM_CLOSED',
  ERR_STREAM_DESTROYED: 'RUNTIME_STREAM_DESTROYED', ABORT_ERR: 'RUNTIME_OPERATION_ABORTED',
  ERR_INVALID_ARG_TYPE: 'RUNTIME_NODE_ARGUMENT', ERR_INVALID_ARG_VALUE: 'RUNTIME_NODE_ARGUMENT',
  ERR_OUT_OF_RANGE: 'RUNTIME_NODE_RANGE', ERR_INVALID_STATE: 'RUNTIME_NODE_STATE' });
const diagnosticNodeCodes = new Set([...Object.keys(nodeCodes), 'ERR_STREAM_WRITE_AFTER_END',
  'ERR_FS_FILE_TOO_LARGE', 'ERR_INTERNAL_ASSERTION', 'ERR_OPERATION_FAILED']);
const errnoCodes = new Set(Object.keys(require('node:os').constants.errno));
const diagnosticKinds = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'RuntimeIntegrityError']);
const startupCodes = new Set(['EACCES', 'ENOENT', 'SAFETY_RECOVERY_REQUIRED',
  'SAFETY_STORAGE_UNAVAILABLE', 'SAFETY_OWNER_LOST', 'MAIN_STARTUP_FAILED', ...INTEGRITY_CODES]);
const phases = new Set(['MANIFEST', 'PROFILE', 'CREDENTIALS', 'PRIVATE_IPC', 'TLS', 'OWNER_LOCKS',
  'SAFETY', 'GATEWAY', 'BACKUP', 'AUTHORIZED_ROOTS', 'POSTGRES', 'CACHE_AND_ANALYZER', 'BACKEND',
  'BACKEND_SOURCES', 'BACKEND_PROCESS', 'BACKEND_HEALTH', 'BACKEND_ROOTS', 'WINDOW', 'READY']);
const shutdownPhases = new Set(['QUEUED', 'STOPPING', 'SAFETY_OFF', 'BACKEND', 'ANALYZER', 'REDIS',
  'POSTGRES', 'SOURCES', 'SAFETY', 'CONNECTIONS', 'OWNER_LOCKS', 'TRANSPORT', 'STORAGE', 'PRIVATE_IPC', 'COMPLETE']);

class RuntimeIntegrityError extends Error {
  constructor(code) {
    const safe = integrityCodes.has(code) ? code : 'RUNTIME_INTEGRITY_FAILED';
    super(safe.startsWith('RUNTIME_IO_')
      ? `Bundled runtime verification could not read or close a file (${safe}).`
      : `Bundled runtime manifest or inventory is invalid (${safe}).`);
    this.name = 'RuntimeIntegrityError'; this.code = safe;
  }
}
function integrityError(error) {
  let code, kind;
  try {
    code = error?.code;
    // Reconstruct even our own error: a changed message/cause is not public evidence.
    if (error instanceof RuntimeIntegrityError && integrityCodes.has(code)) return new RuntimeIntegrityError(code);
    if (error instanceof TypeError) kind = 'RUNTIME_JS_TYPE_ERROR';
    else if (error instanceof RangeError) kind = 'RUNTIME_JS_RANGE_ERROR';
  } catch { code = undefined; kind = undefined; /* Getters and prototype traps are not diagnostics. */ }
  if (code === 'SAFETY_BUILD_SEQUENCE_INVALID') return new RuntimeIntegrityError(code);
  if (typeof code === 'string' && Object.hasOwn(nodeCodes, code)) return new RuntimeIntegrityError(nodeCodes[code]);
  if (kind) return new RuntimeIntegrityError(kind);
  return new RuntimeIntegrityError(ioCodes.has(code) ? 'RUNTIME_IO_' + code : 'RUNTIME_INTEGRITY_FAILED');
}
function startupFailureCode(error) {
  let code; try { code = error?.code; } catch { /* Never stringify arbitrary thrown values. */ }
  return startupCodes.has(code) ? code : 'MAIN_STARTUP_FAILED';
}
const physicalKinds = new Set(['DIRECTORY', 'FILE', 'SYMLINK', 'OTHER', 'UNAVAILABLE']);
function integrityDiagnostic(operation, error, details) {
  const safeOperation = integrityOperations.has(operation) ? operation : 'FINALIZE';
  let code = 'UNCLASSIFIED', kind = 'OTHER';
  try {
    const value = error?.code;
    if (typeof value === 'string' && (integrityCodes.has(value) || errnoCodes.has(value) || diagnosticNodeCodes.has(value))) code = value;
  } catch { /* A hostile code getter is never evidence. */ }
  try {
    const value = error?.name;
    if (typeof value === 'string' && diagnosticKinds.has(value)) kind = value;
  } catch { /* A hostile name getter is never evidence. */ }
  let pathSha256, physicalKindBeforeFailure, physicalKindAfterFailure;
  if (safeOperation === 'READDIR' && details !== undefined) {
    try {
      if (!details || typeof details !== 'object' || Array.isArray(details)) return Object.freeze({ operation: safeOperation, code, kind });
      const keys = Reflect.ownKeys(details);
      if (keys.length !== 3 || !['pathSha256', 'physicalKindBeforeFailure', 'physicalKindAfterFailure'].every(key => keys.includes(key))) {
        return Object.freeze({ operation: safeOperation, code, kind });
      }
      pathSha256 = details?.pathSha256;
      physicalKindBeforeFailure = details?.physicalKindBeforeFailure;
      physicalKindAfterFailure = details?.physicalKindAfterFailure;
    } catch { return Object.freeze({ operation: safeOperation, code, kind }); }
    if (typeof pathSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pathSha256)
        || physicalKindBeforeFailure !== 'DIRECTORY'
        || !physicalKinds.has(physicalKindAfterFailure)) {
      return Object.freeze({ operation: safeOperation, code, kind });
    }
    return Object.freeze({ operation: safeOperation, code, kind, pathSha256,
      physicalKindBeforeFailure, physicalKindAfterFailure });
  }
  return Object.freeze({ operation: safeOperation, code, kind });
}
function formatIntegrityDiagnostic(value) {
  let operation, code, kind, pathSha256, physicalKindBeforeFailure, physicalKindAfterFailure;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (!keys.every(key => typeof key === 'string')) return null;
    operation = value?.operation; code = value?.code; kind = value?.kind;
    pathSha256 = value?.pathSha256; physicalKindBeforeFailure = value?.physicalKindBeforeFailure;
    physicalKindAfterFailure = value?.physicalKindAfterFailure;
    const detailed = pathSha256 !== undefined || physicalKindBeforeFailure !== undefined || physicalKindAfterFailure !== undefined;
    const allowed = detailed
      ? ['operation', 'code', 'kind', 'pathSha256', 'physicalKindBeforeFailure', 'physicalKindAfterFailure']
      : ['operation', 'code', 'kind'];
    if (keys.length !== allowed.length || allowed.some(key => !keys.includes(key))) return null;
  }
  catch { return null; }
  if (!integrityOperations.has(operation)
      || !(integrityCodes.has(code) || errnoCodes.has(code) || diagnosticNodeCodes.has(code) || code === 'UNCLASSIFIED')
      || !(diagnosticKinds.has(kind) || kind === 'OTHER')) return null;
  const hasDetails = pathSha256 !== undefined || physicalKindBeforeFailure !== undefined || physicalKindAfterFailure !== undefined;
  if (hasDetails) {
    if (operation !== 'READDIR' || typeof pathSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pathSha256)
        || physicalKindBeforeFailure !== 'DIRECTORY' || !physicalKinds.has(physicalKindAfterFailure)) return null;
    return `DESKTOP_INTEGRITY ${operation} ${code} ${kind} ${pathSha256} ${physicalKindBeforeFailure} ${physicalKindAfterFailure}`;
  }
  return `DESKTOP_INTEGRITY ${operation} ${code} ${kind}`;
}
function parseIntegrityLine(line) {
  if (typeof line !== 'string' || line.length > 256) return null;
  const parts = line.split(' ');
  if (![4, 7].includes(parts.length) || parts[0] !== 'DESKTOP_INTEGRITY') return null;
  const [, operation, code, kind] = parts;
  if (!integrityOperations.has(operation)
      || !(integrityCodes.has(code) || errnoCodes.has(code) || diagnosticNodeCodes.has(code) || code === 'UNCLASSIFIED')
      || !(diagnosticKinds.has(kind) || kind === 'OTHER')) return null;
  if (parts.length === 7) {
    const [, , , , pathSha256, physicalKindBeforeFailure, physicalKindAfterFailure] = parts;
    if (operation !== 'READDIR' || typeof pathSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pathSha256)
        || physicalKindBeforeFailure !== 'DIRECTORY' || !physicalKinds.has(physicalKindAfterFailure)) return null;
    return { operation, code, kind, pathSha256, physicalKindBeforeFailure, physicalKindAfterFailure };
  }
  return { operation, code, kind };
}
function parseStartupLine(line) {
  if (typeof line !== 'string' || line.length > 256) return null;
  const parts = line.split(' ');
  if (parts[0] !== 'DESKTOP_STARTUP' || !phases.has(parts[1])) return null;
  if (parts.length === 2) return { phase: parts[1], state: 'RUNNING' };
  if (parts.length === 4 && parts[2] === 'FAILED' && startupCodes.has(parts[3])) {
    return { phase: parts[1], state: 'FAILED', code: parts[3] };
  }
  return null;
}

function parseShutdownLine(line) {
  if (typeof line !== 'string' || line.length > 256) return null;
  const parts = line.split(' ');
  if (parts[0] !== 'DESKTOP_SHUTDOWN' || !shutdownPhases.has(parts[1])) return null;
  if (parts.length === 2) return { phase: parts[1], state: parts[1] === 'COMPLETE' ? 'COMPLETE' : 'RUNNING' };
  if (parts.length === 4 && parts[1] !== 'COMPLETE' && parts[2] === 'FAILED' && parts[3] === 'SAFETY_RECOVERY_REQUIRED') {
    return { phase: parts[1], state: 'FAILED', code: 'SAFETY_RECOVERY_REQUIRED' };
  }
  return null;
}

module.exports = Object.freeze({ RuntimeIntegrityError, integrityError, startupFailureCode, integrityDiagnostic,
  formatIntegrityDiagnostic, parseIntegrityLine, parseStartupLine, parseShutdownLine, INTEGRITY_CODES, INTEGRITY_OPERATIONS });
