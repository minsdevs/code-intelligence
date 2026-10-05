# GitHub credential lifecycle and consumers — 2026-10-05

## Resumed work and stage position

The original checkout is `/Users/minseokchae/Dev/code-intelligence`. Work resumes
on `codex/pre-release-github-lifecycle-20261005`, based on merged PR92 / `9d77a70`.
The interrupted turn had already implemented the code below; it was preserved,
reviewed and tested rather than discarded or re-created. This is implementation
and synthetic/isolated validation for stages 2–3 of the eight-stage pre-release
plan. It does not assert successful use of the existing real-account project1.

## Implemented contract

Device-origin GitHub App credentials can now store an encrypted access/refresh
pair with the issuing client, GitHub identity, expiration and lifecycle state.
The v2 AES-GCM envelope is bound to local owner/kind/version, strictly validates
UTF-8/JSON structure, rejects duplicate/extra fields and oversized material, and
does not reuse the legacy v1 token or AI-key format. Plaintext buffers are erased
where owned; Java strings and third-party HTTP/parser lifetimes are not claimed to
provide guaranteed memory erasure. Public renderings are redacted.

Before a refresh POST, a REQUIRES_NEW database transaction commits a token-free
pending claim. The provider response is checked for a new pair, expiry and the
original GitHub identity. Final publication is a committed compare-and-set of the
same ciphertext/nonce/owner/expiry revision and the same in-process connection
generation. No upsert resurrects deleted credentials. A crash or ambiguous refresh
result leaves reauthentication required; pending material is not replayed after
restart. Concurrent callers join the same pending flight, not separate exchanges.

The provider flow uses `client_id`, `grant_type` and `refresh_token`; no client
secret or GitHub App private key is bundled. The reviewed upstream contract is
[GitHub's refreshing user access tokens documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens),
which distinguishes device-origin refresh from the client-secret web flow. This
implementation has not been validated against a real user's refresh exchange.
Legacy OAuth/PAT credentials stay compatible; access-only OAuth with missing or
expired validity is not silently treated as anonymous or as a renewable pair.

Repository listing, Git clone/import and PR metadata consumers now borrow a
revision-bound backend-only credential capability. Checks occur before and after
requests and inside publication of branch/snapshot/metadata results. An old 401
cannot invalidate a newly encrypted revision, even when the PAT string is the
same. Only an actual upstream 401 establishes rejection: 403 permission/SSO,
rate-limit and transport failures do not revoke the credential. A clone transport
failure can run a bounded `/user` check, not guess rejection from JGit's message.
The production HTTP client has finite connect/read timeouts and rejects redirects;
mock transports in tests do not measure wall-clock timeout behavior.

Device login, PAT connection, refresh and disconnect share a short publication
fence. Valid desktop launch authority always resolves to the installation-local
owner rather than a stale browser/PAT session. Browser PAT login remains a
separate session path. Mutation retries are limited to the explicit CSRF filter
rejection code; arbitrary 403 responses cannot replay a mutation. Connection
status and import failures now distinguish GitHub reauthentication reasons.

## Executed validation

| Evidence | Result and scope |
| --- | --- |
| `validation/local/pre-release-final/auth-backend-first.log`, `auth-backend-summary.json`, `auth-junit/` | **277 tests, 277 passed, 0 failed/errors/skipped**, 16 suites. Offline compile, formatter, codec, lifecycle, native OAuth, PAT, desktop authentication/CSRF, repository/import/metadata lease consumers, architecture, retry and semantic-oracle unit selection |
| `validation/local/pre-release-final/auth-frontend.json` | **146/146 passed**, no pending tests. Client mutation retry/redaction, Settings and import DOM/API fixtures |
| `validation/local/pre-release-auth/auth-store-nox56E/result.json`, `junit.xml` | **6/6 passed**, actual new PostgreSQL database, all 27 migrations, independent committed JDBC transactions/CAS/outer rollback/concurrent claims/deletion/owner/nonce behavior. PostgreSQL exited0; source and supplied bundle hashes unchanged |
| `validation/local/pre-release-final/auth-typecheck.log`, `auth-lint.log` | TypeScript noEmit and changed frontend ESLint both exit0 |
| `validation/local/pre-release-final/core-contracts.log` | **231/231 passed**, T00 contract tests and model/runtime-supply unit checks. Not an independent real-repository accuracy assessment |

The final single-flight test waits for the actual second caller to read the same
pending claim while holding the coordinator monitor before releasing the first
provider response. It verifies both calls remain pending, one exchange, no early
identity lookup, two equal successful results and exactly two committed mock
revision transitions. A sequential valid-token lookup cannot satisfy this case.

The 277-test selection uses mocks for external HTTP/clone/storage boundaries as
specified by each test. The separate six-test database fixture exercises real
JDBC transactions, not the entire Spring/JPA AccountService publication path.
`AuthIntegrationTest` and other Docker-backed suites compiled but were not run:
`docker-check.json` records the daemon unavailable. Repeated Gradle loopback
handshake warnings were retained in logs; the cause was not established, and the
successful test task is not evidence that those warnings were fixed.

Earlier `pre-release-auth/first.log`, `reviewed.log`, `reviewed-second.log` and
`auth-store-DgM2mX` results remain separate historical attempts. Final source hashes
and report digests are bound in `pre-release-github-lifecycle-validation-2026-10-05.json`.

## Remaining conditions

The unified candidate still has to include this backend/frontend and PR92's
desktop ownership fix. Real provider refresh/revocation/SSO, real project1
reanalysis, broad concurrency across processes and full transactional application
integration are not replaced by these passing fixtures. The old string-token
provider methods remain compatibility paths; new consumers must use the borrowed
revision capability. No actual user DB/profile/Keychain/private key, paid provider,
GitHub Actions, formal signing, notarization or deployment was used.
