'use strict';

class ContractError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireThat(condition, code) { if (!condition) throw new ContractError(code); }
module.exports = { ContractError, requireThat };
