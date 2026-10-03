// These focused tests must use their mocked API, never an actual transport.
const blocked = () => { throw new Error('Network access is disabled in focused progress tests') }
globalThis.fetch = blocked
XMLHttpRequest.prototype.send = blocked
