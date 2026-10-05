# GitHub failed-project recovery verification

This runner uses the production backend JAR, PostgreSQL 16, Redis, Flyway V1–V27,
the job pipeline and, with `--browser`, the production frontend in Chromium.
Only the GitHub API, credentials and input repository are synthetic. It does not
validate GitHub device OAuth, a user's project, a packaged Electron application,
the minimum supported OS, signing or installation/update compatibility.

It creates a new private directory on every invocation under
`validation/local/github-recovery-20261005/`. It never resumes or deletes a prior
run, launches an existing application, reads a user's profile/keychain/token, or
sends code to an AI service. Child services are stopped using the handles created
by that invocation. Generated fixture credentials and the test database remain
private inside the ignored run directory; do not commit these directories.

## Inputs

Build `frontend/dist` and `backend/build/libs/backend-0.0.1-SNAPSHOT.jar` from the
same reviewed source first. Frontend development dependencies must include the
locked Playwright version and an already installed Chromium. Use an explicitly
verified JDK 21 through `RECOVERY_JAVA_HOME`. The host must provide PostgreSQL 16
via `pg_config` and Redis at `/opt/homebrew/bin/redis-server`.

Provide `RECOVERY_PGVECTOR_ROOT` pointing to a matching, verified PostgreSQL 16
extension tree with `lib/postgresql/` and `share/postgresql/extension/`. The current
local default is the session's `validation/local/github-recovery-20261005/pgvector`
tree, whose 43 inputs were checked against the preserved artifact manifest. The
runner does not install or download missing tools/extensions. It copies the
PostgreSQL inputs into the new run and preserves the compiled Cellar/opt layout.
These host-service copies are **not distributable desktop runtime artifacts**.

```sh
rtk proxy env RECOVERY_JAVA_HOME=/absolute/path/to/jdk21 \
  RECOVERY_PGVECTOR_ROOT=/absolute/path/to/verified-pgvector \
  node validation/github-recovery/verify.cjs --browser
```

Omit `--browser` for the real backend API variant. The runner starts a generic PR
403 failure, rejects a duplicate import, changes only its synthetic clone to
exercise `RETRY_SOURCE_UNVERIFIED`, and starts three fresh analyses under the same
project ID. The provider then returns the explicit optional PR-permission denial.
All fresh jobs must pass `GIT_METADATA` and `FINALIZE`; the original failure and
its steps and note must survive while successful legacy retention stays at two
READY snapshots. Browser mode exercises the new recovery button and the internal
checkpoint-recovery link instead of sending reanalysis POSTs from the test driver.

`result.json` records individual checks, the backend JAR hash, retained snapshot
states and owned-service cleanup. Initial failure and each successful job have
separate JSON records. Browser screenshots are supplementary UI evidence. Keep
environment/setup failures and later successful runs separate. Unit and
Testcontainers results are separate evidence and must not be inferred from this
runner's success.
