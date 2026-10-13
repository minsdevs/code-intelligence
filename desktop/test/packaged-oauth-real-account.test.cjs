'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { argumentsFor, redactConnection } = require('../scripts/packaged-oauth-real-account.cjs');

test('arguments require an absolute --app and accept only owner/name repositories and bounded timeouts', () => {
  const options = argumentsFor(['--app', '/r/.native-product-abc123/Code Intelligence Validation.app', '--repo', 'octocat/Hello-World', '--authorize-timeout-ms', '120000', '--skip-external-revoke']);
  assert.equal(options.repo, 'octocat/Hello-World'); assert.equal(options.authorizeTimeoutMs, 120000); assert.equal(options.externalRevoke, false);
  assert.equal(argumentsFor(['--app', '/a']).externalRevoke, true);
  for (const argv of [[], ['--app', 'relative'], ['--app', '/a', '--repo', 'no-slash'], ['--app', '/a', '--repo', 'a/b/c'],
    ['--app', '/a', '--authorize-timeout-ms', '10'], ['--app', '/a', '--revoke-timeout-ms', 'x'], ['--app', '/a', '--token', 't']]) {
    assert.throws(() => argumentsFor(argv));
  }
});

test('the report keeps no token, login or full URL from a connection', () => {
  const kept = redactConnection({ identityType: 'GITHUB_OAUTH', connected: true, reauthenticationReason: null, githubId: 42, oauthAvailable: true,
    githubRevocationUrl: 'https://github.com/settings/connections/applications/abc', accessToken: 'gho_secret', login: 'someone' });
  assert.deepEqual(kept, { connected: true, identityType: 'GITHUB_OAUTH', githubIdPresent: true, oauthAvailable: true, reauthenticationReason: null, revocationHost: 'github.com' });
  assert.doesNotMatch(JSON.stringify(kept), /gho_secret|someone|applications\/abc/);
  assert.equal(redactConnection({ connected: false, githubId: null, githubRevocationUrl: 'not a url' }).revocationHost, null);
  assert.throws(() => redactConnection(null));
});
