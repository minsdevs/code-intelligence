# Startup and idle-memory acceptance on candidate xb6Kxe — 2026-10-06

This unit continues the stage-5 performance follow-up after PR101 without repeating
its 194/15/41/4-test units. It removes measured startup work, lowers idle memory,
fixes an intermittent PostgreSQL origin-proof failure, and packages candidate
**xb6Kxe** from clean commit `ecf6344`. On that candidate the unchanged twenty-run
warm-start/idle-RSS gate **passes**: p95 ready **8,380ms** (limit 10,000ms) and
maximum sampled idle RSS **1,525,200KiB** (limit 1,572,864KiB). The full native
product sequence, both owner-crash boundaries and the Electron inventory loop also
pass. Formal release remains **NO_GO** because other stage gates are still open.

Exact identities, hashes and raw-result references are in the
[companion ledger](startup-acceptance-xb6kxe-2026-10-06.json). Raw evidence is under
`validation/local/` and is not part of the source PR.

## Starting state found in the original repository

The branch `codex/final-candidate-follow-up-20261006` already held six unpushed
commits from an earlier session (shaded control-member verification, a rejected
ParallelGC experiment and its revert, Spring Framework 7.0.9/proxy-addr 2.0.8
patches, analyzer count separation and a measured candidate copy budget). Their
retained evidence is reported, not rewritten:

| Candidate | Source | Result |
| --- | --- | --- |
| SE9wxZ | `f65ec59` (PR100+PR101) | 36-check product PASS, both crash cases PASS; 20-run series **INCOMPLETE**: 9 completed, run 9 failed sampling, 11 not run, AC not confirmed, load average 46.95 before the series. |
| 1fMhFG | `517ef12` ParallelGC | Diagnostic only; idle peaks 2.02–2.13GB, rejected. |
| 62hLL3 | `035b334` | Product sequence **FAIL** at `real-main-backup` with an unclassified step error; cause not recorded by the runner. |

SE9wxZ and 1fMhFG were earlier archived to verified ZIPs by that session. Their
unit tests (11/8/14/3 for builder, capacity budget, control members, proxy-addr)
were rerun here and pass.

## Measured causes

The packaged SE9wxZ probe (`startup-probe/run-ZSNlsb`) showed warm ready about
11.0s. The backend health wait took 6.0–6.4s; the remaining time was spread
across the pre-profile runtime inventory check, TLS generation (~0.6s), two
SAFETY/GATEWAY/BACKUP passes, PostgreSQL (~0.33s) and Redis/analyzer (~0.74s).
In SE9wxZ's nine completed benchmark runs the two gateway passes grew from 496ms
to 1,266ms: journal replay re-verified the keyring for every record, so each
launch made the next one slower.

Component measurements (`startup-performance/micro-measurements-20261006.json`,
single host shared with other work; not whole-app results):

- Runtime inventory: 5,130 files/215MB took 714–886ms sequentially; SHA-256 alone
  is ~100ms. Eight overlapping slots took 454–527ms.
- TLS: eight RSA-2048 keys (four services) took 364–607ms sequentially and
  175–316ms when issued concurrently.
- Analyzer: loading `ts-morph` costs ~130ms and ~94MiB; deferring it lowered the
  sidecar's plain-HTTP health time from ~365ms to ~245ms and idle RSS from
  ~171MB to ~86MB.
- Idle process tree: 10 PostgreSQL client backends (~10.5MB each) came from
  Hikari's default ten idle connections. Seven control JVMs use ~400MB in total;
  flag variants changed them by at most ~6MiB each, and the bundled JRE has no
  default CDS archive, which did not change summed RSS in these measurements.
- Backend (read-only analysis by a subagent, dry runs to context refresh): health
  answers 200 about 236ms before `Started`; deferred JPA bootstrap saved ~0.9s;
  the serial collector cost ~0.1s and saved ~60MiB of refresh-time RSS. Unpacking
  the Spring Boot fat jar (~1.0s) and AppCDS (~1.4s more) were not adopted: they
  change runtime packaging, integrity inventory and Windows staging.

## Changes

| Commit | Change | Safety boundary kept |
| --- | --- | --- |
| `36c8f61` | Native acceptance failures add a fixed `signal`/`errorName`; the existing code is unchanged. | Raw messages, paths and page data are never persisted. |
| `3771b4f` | Runtime inventory content checks run in eight slots after the unchanged sequential tree walk. | Every lstat/open/fstat/read/EOF/hash/post-stat check remains; all slots close their handles before the earliest failed entry is reported; fixed operation vocabulary; buffers are per slot of one invocation. |
| `4cdd873` | The four services' CA/leaf keys and certificates are issued concurrently. | Private keys are exported, written and zeroized one service at a time in the original order. |
| `1a5cfa8` | Local readiness polling 250ms → 50ms. | Deadlines and checks are unchanged. |
| `0672cf6` | The analyzer imports its TypeScript engine on the first analysis request. | Same request validation and HTTP results; the first analysis is ~0.14s slower. |
| `f87b580` | Desktop Hikari `minimum-idle: 2` (maximum pool unchanged). | Connections are opened on demand. |
| `d9d74cd` | Journal replay verifies each key id through the keyring before first use and again after the last record (equality check), then zeroes the copies. | Every record MAC is still authenticated; no key outlives one replay; a keyring change during replay fails before any restart write. |
| `acb553c` | The journal probe expects history-independent counts (6/8/16). | Diagnostic only. |
| `2b1e3d7` | Desktop profile: deferred JPA bootstrap, readiness included in root health, SpringDoc and Redis repository scanning off. | Health stays OUT_OF_SERVICE until `ApplicationReadyEvent`, so startup recovery and repository/EMF failures cannot hide behind an earlier UP. |
| `420bce0` | Backend `-XX:+UseSerialGC`. | Heap budget unchanged; `TieredStopAtLevel=1` is not reintroduced. |
| `cf1f0e0` | Redis/analyzer are spawned first, then the backend; their readiness waits overlap backend JVM startup. | A helper spawn failure still prevents the backend spawn; `assertSafetyReady` precedes the backend; all waits settle with a cancel flag before the first failure is thrown; authorized roots are restored only after all three are ready. Maintenance paths keep their sequential helpers. |
| `6b91c0f` | Whole-stage tests supply the control-runtime proof required since `dac77cc`. | Restores five tests that had failed since PR99. |
| `ecf6344` | PostgreSQL origin proof accepts a SQL start second equal to or up to 2s after `postmaster.pid`'s. | PID, port, data directory, cluster identifier, user and database checks are unchanged; earlier or larger differences still fail. |

Rejected in this unit: starting PostgreSQL concurrently with Redis/analyzer. It
broke deliberate tests that require an origin or guardian failure to prevent any
further service, and was reverted before commit.

### Intermittent origin-proof failure

Candidate mEbIBC (`6b91c0f`) failed its product sequence after a successful
backup, restore and recovery checkpoint: the post-restore launch stopped in
POSTGRES with `MAIN_STARTUP_FAILED`. The PostgreSQL log shows a client reset
with an open transaction 45ms after readiness, which matches the origin proof
terminating its psql session. PostgreSQL writes `postmaster.pid` at process start
and sets `pg_postmaster_start_time()` a few milliseconds later. Eighty starts of
the bundled PostgreSQL 16.15 on a disposable cluster produced **3 mismatches**
(each SQL time .003–.004s past a second boundary;
`startup-performance/pg-origin-TY3f3F`). An exact whole-second comparison
therefore rejects a genuine owned server about 4% of the time. The exact cause of
the earlier 62hLL3 backup-step failure was not recorded and remains unconfirmed.

## Candidate xb6Kxe validation

Built by `validation/pre-release/build-candidate.cjs` from baseline tZgvV7 with
build sequence `1791289739000`, clean source `ecf6344`, Java recompilation, the
static/JAR readback, the control-runtime member verification (1,221 members) and
analyzer production dependencies from the offline cache. It is an ad-hoc
Validation app: not Developer ID signed, notarized or released.

| Check | Result | Evidence |
| --- | --- | --- |
| Full native product sequence | **PASS**, 36 checks, omitted `[]`, six COMPLETE/code0 exits, backup/restore PASS | `pre-release-final/product-ziBnjK` |
| Owner crash at `AFTER_SOURCE_RENAME` | **PASS**, 6 checks, one intentional SIGKILL, two COMPLETE/code0 | `electron-crash/native-SKhSk7` |
| Owner crash at `BEFORE_COMPLETED_CLEANUP` | **PASS**, 6 checks, same pattern | `electron-crash/native-E9iGRo` |
| Electron runtime inventory loop | **PASS**, 20 validations, no failures or traces | `pre-release-final/integrity-Lh28xe` |
| Twenty-run warm startup/idle RSS | **PASS**, 20/20, p95 8,380ms, p95 idle 1,522,528KiB, max 1,525,200KiB | `startup-performance/run-3XPeCJ` |

The benchmark's series observed AC at the start and at both boundaries of every
run, kept source and bundle identities unchanged, had at most 157ms between
samples and at least 29 idle samples per run, and confirmed cleanup each time.
Gateway time stayed 440–496ms across all twenty runs. The initialization launch
(8,403ms, 1,557,072KiB) is outside the assessment, as before.

The three-run probe on mEbIBC (`startup-probe/run-SYz5BB`, same performance
changes without the origin fix) recorded warm ready 8,300–8,628ms and idle peaks
1,503,104–1,526,672KiB; role totals were backend JVM 441–460MB, analyzer ~98MB
and 8–9 PostgreSQL children.

The representative import of the repository's own source (978 files) took 65.4s
versus 61.7s on SE9wxZ: one observation each, recorded rather than interpreted.
The serial collector's effect on large analyses and pause times is unmeasured.

## Tests executed for this unit

- Desktop: full `node --test desktop/test/*.test.cjs` 3,106 tests, 3,064 pass,
  0 fail, 42 environment-gated skips (Windows/PostgreSQL), run before the origin
  fix; then `backup-product-state` 124/124 after it.
- Journal/keyring/lease/gateway files: 254/254 here; the implementing subagent
  reported 622/622 across eleven related files.
- Analyzer: TypeScript check and 271/271 Vitest.
- Backend (Testcontainers PostgreSQL/Redis): new `DesktopStartupSettingsIntegrationTest`
  3/3, `ApplicationIntegrationTest` 4/4, `DesktopSecurityConfigurationTest` 4/4;
  the candidate build ran `spotlessCheck` and `bootJar`.
- Validation runners: journal probe 15/15, builder 11/11, capacity 8/8, control
  members 14/14, proxy-addr 3/3, native acceptance/close contract 38/38.
- Journal probe before/after (one observation per size): 148/306/912ms with
  5/69/261 key fetches (`journal-replay/probe-CImDWe`) versus 155/151/174ms with
  6/6/6 (`journal-replay/probe-EImD7H`, committed runner).

## Independent review

A read-only subagent review of `035b334..HEAD` reran the affected suites and found
no P1/P2. It confirmed that health becomes UP only after startup recovery, that the
overlapped readiness waits leave no loop behind a failure, and that the inventory,
journal, TLS and origin changes keep their checks. Eight P3 items are deferred to a
follow-up unit with its own candidate so that xb6Kxe keeps matching this source:
a cached rejected analyzer-engine import, an open-ended `errorName`, a weak
earliest-failure test, 50ms `pg_isready` polling on the main thread during
restarts, a possible delayed job pub/sub subscription if Redis is slower than the
backend, the wider meaning of a `BACKEND_HEALTH` failure, the pre-existing
first-rejection `Promise.all` for helper spawns, and a loose API-docs assertion.

## Space handling

Free space was 4.64GiB at the start. Following the earlier session's verified
retirement pattern, only reproducible copies were removed after digest, ownership,
manifest/signature and open-file checks: the 62hLL3, mEbIBC and xb6Kxe build-stage
dependency/runtime copies and fourteen `/private/tmp/cnpc-*/work/owned/source`
repository copies whose recomputed digests matched their own product results.
Every candidate app, result, artifact, profile and failure record was kept. One
retirement attempt was refused while Spotlight held files open and succeeded later.

## Limits and remaining release gates

This is a warm, initialized empty synthetic profile with OS caches not flushed,
on one MacBookPro18,4. It is not cold-cache, workload-size, minimum-OS or
clean-machine evidence. Sampled RSS sums process RSS and is not private memory.
Idle RSS is measured before the first analysis; the analyzer and backend grow when
work runs. Open items: real GitHub account/refresh/revoke/SSO acceptance, broader
crash/power-loss and existing-user data acceptance, independent security and
usability acceptance, complete SBOM/licence/provenance, clean-machine install and
update, and Developer ID signing/notarization with explicit approval. The double
SAFETY/GATEWAY/BACKUP pass on warm starts and the seven control JVMs remain
documented optimisation candidates. Overall release: **NO_GO**.
