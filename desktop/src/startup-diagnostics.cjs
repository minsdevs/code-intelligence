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
]);
const integrityCodes = new Set(INTEGRITY_CODES);
const ioCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'EIO', 'ENOMEM', 'ENOSPC']);
const startupCodes = new Set(['EACCES', 'ENOENT', 'SAFETY_RECOVERY_REQUIRED',
  'SAFETY_STORAGE_UNAVAILABLE', 'SAFETY_OWNER_LOST', 'MAIN_STARTUP_FAILED', ...INTEGRITY_CODES]);
const phases = new Set(['MANIFEST', 'PROFILE', 'CREDENTIALS', 'PRIVATE_IPC', 'TLS', 'OWNER_LOCKS',
  'SAFETY', 'GATEWAY', 'BACKUP', 'AUTHORIZED_ROOTS', 'POSTGRES', 'CACHE_AND_ANALYZER', 'BACKEND', 'WINDOW', 'READY']);

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
  let code;
  try {
    code = error?.code;
    // Reconstruct even our own error: a changed message/cause is not public evidence.
    if (error instanceof RuntimeIntegrityError && integrityCodes.has(code)) return new RuntimeIntegrityError(code);
  } catch { /* A hostile getter is not a diagnostic. */ }
  if (code === 'SAFETY_BUILD_SEQUENCE_INVALID') return new RuntimeIntegrityError(code);
  return new RuntimeIntegrityError(ioCodes.has(code) ? 'RUNTIME_IO_' + code : 'RUNTIME_INTEGRITY_FAILED');
}
function startupFailureCode(error) {
  let code; try { code = error?.code; } catch { /* Never stringify arbitrary thrown values. */ }
  return startupCodes.has(code) ? code : 'MAIN_STARTUP_FAILED';
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

module.exports = Object.freeze({ RuntimeIntegrityError, integrityError, startupFailureCode, parseStartupLine, INTEGRITY_CODES });
