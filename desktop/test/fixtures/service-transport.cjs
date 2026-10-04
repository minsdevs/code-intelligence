'use strict';
const path = require('node:path');

// Lifecycle tests intentionally do not open sockets. Real TLS peer checks are exercised separately.
function transportFixture({ userData, ports, getApiToken }, request) {
  const materials = Object.fromEntries(['backend', 'analyzer', 'postgres', 'redis'].map(name =>
    [name, { cert: path.join(userData, `${name}.crt`), key: path.join(userData, `${name}.key`), pin: 'a'.repeat(64) }]));
  const backend = { origin: `https://127.0.0.1:${ports.backend}`,
    request: (url, options = {}) => request(url, { ...options,
      headers: { ...options.headers, 'X-Code-Intelligence-Token': getApiToken() } }) };
  return { materials, backend, analyzer: { origin: `https://127.0.0.1:${ports.analyzer}`, request },
    analyzerToken: 'b'.repeat(64), redisPassword: 'c'.repeat(64),
    callbackUrl: 'http://127.0.0.1:45551/api/auth/github/native/callback',
    backendConfigUrl: 'file:///synthetic/backend.properties', redisConfig: path.join(userData, 'redis.conf'), hba: path.join(userData, 'pg_hba.conf'),
    jdbcUrl: `jdbc:postgresql://127.0.0.1:${ports.postgres}/codeintel?sslmode=verify-full&sslrootcert=${encodeURIComponent(materials.postgres.cert)}`,
    postgresEnvironment: { PGSSLMODE: 'verify-full', PGSSLROOTCERT: materials.postgres.cert },
    redisReady: async () => true, verifyBackendCertificate: () => false, close: async () => {} };
}
module.exports = { transportFixture };
