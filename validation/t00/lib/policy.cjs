'use strict';

const VERSION = '1.0.0';
const THRESHOLDS = Object.freeze({ parseSuccess: 0.99, invalidDiagnostics: 1,
  symbolPrecision: 0.99, symbolRecall: 0.95, resolvedPrecision: 0.99, resolvedRecall: 0.90,
  wilsonLower: 0.95, candidatePrecision: 0.90, candidateRecall: 0.90, candidateExactSet: 0.85,
  falseResolved: 0 });
const requirements = parser => ({ positive: 200, negative: 100, independentProjects: 3,
  scenarios: 10, parserFiles: parser ? 50 : 0, holdoutPositive: 50, holdoutNegative: 25 });
const versions = (...items) => items.map(([name, prefix]) => ({ name, prefix }));
const java = ['java', '21'], ts = ['typescript', '5.9'], js = ['ecmascript', '2022'];
const ui = [['react', '19'], ['react-router', '7']];
function cell(id, capability, versionRequirements, patterns, strata = []) {
  return { cellId: id, capability, required: true, publicSupported: false,
    versions: versionRequirements, patterns, patternAllocationStatus: 'PENDING_INDEPENDENT_REVIEW',
    sampleRequirements: requirements(capability === 'P'), strata };
}
const CELLS = Object.freeze([
  cell('J-P', 'P', versions(java), ['valid-syntax', 'invalid-syntax']),
  cell('J-S', 'S', versions(java), ['type-declaration', 'method-declaration', 'inheritance-span']),
  cell('J-C', 'C', versions(java), ['direct-source-call', 'overload', 'external-unresolved', 'dynamic-unresolved']),
  cell('J-F', 'F', versions(java, ['spring-mvc', '6.2'], ['spring-boot', '3.4']), ['literal-route', 'mapping-conditions', 'composed-mapping', 'inherited-mapping', 'dynamic-bean-unresolved']),
  cell('J-D', 'F', versions(java, ['jakarta-persistence', '3.1']), ['entity', 'schema-table', 'runtime-naming-unresolved']),
  cell('T-P', 'P', versions(ts), ['valid-syntax', 'invalid-syntax']),
  cell('T-S', 'S', versions(ts), ['function', 'type', 'module', 'component-span']),
  cell('T-C', 'C', versions(ts), ['direct-source-call', 'config-alias', 'reexport', 'dynamic-unresolved']),
  cell('T-F', 'F', versions(ts, ['nest', '11']), ['controller-route', 'global-prefix', 'module', 'dynamic-unresolved']),
  cell('T-UI', 'F', versions(ts, ...ui), ['component', 'literal-route', 'http-callsite', 'dynamic-url-unresolved']),
  cell('JS-P', 'P', versions(js), ['valid-syntax', 'invalid-syntax']),
  cell('JS-S', 'S', versions(js), ['function', 'module', 'component-span']),
  cell('JS-C', 'C', versions(js), ['direct-source-call', 'explicit-import', 'prototype-unresolved', 'computed-unresolved']),
  cell('JS-UI', 'F', versions(js, ...ui), ['literal-route', 'http-callsite', 'dynamic-url-unresolved']),
  cell('SQL-P', 'P', versions(['postgresql', '16']), ['create-table', 'alter-add-column', 'alter-drop-column', 'invalid-syntax']),
  cell('SQL-S', 'S', versions(['postgresql', '16']), ['schema-table', 'column-span']),
  cell('X-HTTP', 'X', [], ['service-origin-method-path', 'conditions', 'ambiguous-service'],
    [['TSX_SPRING', ts, java, ['spring-mvc', '6.2'], ['spring-boot', '3.4']],
      ['TSX_NEST', ts, ['nest', '11']], ['JSX_SPRING', js, java, ['spring-mvc', '6.2'], ['spring-boot', '3.4']],
      ['JSX_NEST', js, ['nest', '11']]].map(([stratumId, ...targetVersions]) => ({ stratumId,
      minimumPositive: 50, minimumNegative: 25, versions: versions(...targetVersions, ...ui) }))),
  cell('X-DATA', 'X', versions(java, ['jakarta-persistence', '3.1'], ['postgresql', '16']), ['datasource-schema-table', 'name-only', 'different-database']),
]);

module.exports = { VERSION, THRESHOLDS, CELLS };
