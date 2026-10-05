# Latest development candidate: route binding and reliable job completion

This continuation takes over the original checkout after the previous prime
released it. It completes the last package-entry guard, repairs a reproducible
job-completion notification race, and strengthens native shutdown verification.
The prior qUMAST candidate and all previous failures remain historical evidence.

## Current checkpoint

The current product sources have passed the focused and configured regression
suites below. Candidate **j5EJLB** contains those sources and passes the default
full native sequence: **36 recorded checks and six normal exits with COMPLETE
shutdown diagnostics**. No suite was omitted. The companion record identifies
the reviewed implementation commit; the GitHub PR and local publication receipt
identify its published revisions. Formal release remains **NO_GO**; this record
does not certify every release acceptance stage.

## Resulting behavior

React routes use supported lexical/import/export declarations instead of matching
component display names. The final guard opts out of speculative bare-package
`src/index` resolution, including when `package.json` declares a conflicting
`exports` or `main`. Explicit supported TypeScript path mappings remain usable.
Unresolved routes retain their reason rather than receiving a guessed component
edge. Existing snapshots are preserved; reanalysis retracts obsolete same-snapshot
links. The implementation does not execute repository scripts or resolve all
dynamic React/helper/anonymous/star-export patterns.

A job could finish between the authorization snapshot and SSE registration, so a
healthy stream could miss its final event. A terminal broadcast could also close
a later subscriber that had not received that broadcast. The controller now
authorizes first, registers the subscriber, and then reloads its owned snapshot.
Each subscriber serializes snapshot/update/completion through a bounded queue;
terminal completion affects only the broadcast's captured recipients. Database
and SSE operations run outside map and subscriber state locks. Failed initial
lookup, failed writes, overflow, callbacks and shutdown remove that subscription.
The bounds are 64 queued events and 512 Ki UTF-16 payload characters; frame
overhead and a currently executing send are separate. This is not an ordering
guarantee across every job retry or Redis delivery history.

The progress screen reconciles with the database three seconds after each prior
monitoring read settles, even while SSE remains connected. Slow reads do not
overlap other monitoring reads. Newer observations and remount/retry/cancel
fences reject stale results. Terminal state, authorization loss and unmount stop
the timer and stream. A rejected cancellation preserves existing recovery, and
an acknowledged retry can recover from a failed follow-up read. This does not
claim network-level cancellation of every outstanding HTTP request.

Desktop shutdown now emits fixed phase names and a fixed recovery error code,
without raw exceptions, source paths or credentials. The native driver records
at most 32 phase entries per launch and preserves the first failure. Validation
requires successful SDK close, natural direct-child exit0, a drained diagnostic
pipe, and a final COMPLETE record. A cleanup FAILED followed by exit0 is rejected.
The existing 30-second SDK-close limit and captured-child termination policy are
unchanged; the diagnostic drain has its own one-second limit. Markerless older
bundles are unconfirmed under this newer driver, not retroactively failed under
the driver that originally tested them.

## Executed checks

Paths below are relative to `validation/local/`. Raw logs and JUnit/Vitest results
remain there; the companion JSON identifies their hashes and sources.

| Check | Observed result | Evidence and scope |
| --- | --- | --- |
| TypeScript analyzer | Typecheck and 271/271 PASS | Actual terminal session8884; no separate raw report was written for this invocation. |
| Initial SSE race reproduction | 3 behavior FAIL, 1 ownership PASS | `docker-integration/events-BLvyIG`; original failures retained. |
| Fixed SSE MVC/lifecycle | 19/19 PASS | `docker-integration/events-kVcbwO`; real Spring emitters/MVC framing with synthetic job/Redis inputs. |
| Configured backend suite | 1,665 PASS, 12 explicit skips, 0 FAIL | `docker-integration/backend-gTRPPH`; 1,677 reported cases, specialized task exclusions remain separate. |
| Actual analyzer and PostgreSQL | 12/12 PASS | `docker-integration/accuracy-rKjsxz`; includes the final package-entry negative case and existing accuracy fixtures. |
| Golden corpus regression | 23/23 PASS | `docker-integration/corpus-f3mT7I`; unchanged 57-file corpus/thresholds. Timed Gradle:36s,955424KiB, not whole-app p95/RSS. |
| Initial frontend reproduction | 11 behavior FAIL | `pre-release-final/events-ui-red-ORcJXE`; original product before reconciliation. |
| All frontend source unit tests | 436/436 PASS, full ESLint PASS | `pre-release-final/frontend-final-LTOWvk`; its typecheck failed in a newly added test's mock declaration. |
| Corrected frontend test typing | Global typecheck, focused lint,11/11 PASS | `pre-release-final/frontend-type-final-D3fOCC`; the product is unchanged from the436-test run. |
| Native/candidate/actual-main contracts | 212/212 PASS | `pre-release-final/continuation-checks-dKnuib`; this run's frontend typecheck failure was corrected separately above. |

The first broad mock type and an intermediate plain-function type both failed
type checking. Both failed records remain intact; the final `Mock<() => void>`
declaration passes. A transient pre-dispatch tool safety-status failure executed
no command; one identical retry executed the212-case run. This was not a skipped
test or a change in filesystem authority.

All four Docker suites recorded unchanged source fingerprints, unchanged
preexisting container states, and no new containers remaining. Test workers use
fresh private data/home paths. Gradle reuses the existing local cache, and these
tests are not an OS network sandbox. Counts include overlaps between specialized
and default suites and must not be added into a unique-test total.

## Candidate and native acceptance

The exact local artifact is
`.native-product-j5EJLB/Code Intelligence Validation.app`, build sequence
`1791229598313`. `pre-release-candidate/build-BRdHCE` records a new development
package with750 compiled Java classes,27 migrations,120 static entries,30 rebuilt
analyzer files and43 packaged desktop source files read back against their
inputs. The previous qUMAST bundle is unchanged. Native/JRE/dependency supply was
validated and reused; it was not rebuilt from native source in this unit.

| Content | SHA-256 |
| --- | --- |
| app.asar | `31ddec1d3cc5a13fe44c68a5b76e7027e3075e8573213940b01a9bf01bc4f85d` |
| runtime-manifest.json | `f138415a5e390c150d2f62fb2788a81d038f03324cc30394c4d70e10bc9fb83f` |
| Packaged backend JAR | `bd20db8f69443eca950ff7b886454658548bf5ccb6b40ae807148c009858bbee` |

These are content-specific hashes, not a single digest of the entire `.app`.
The final source fingerprints and result hashes are in
`pre-release-continuation-validation-2026-10-06.json`.

`pre-release-final/product-h78Ocm` passed the default full packaged-app sequence.
It exercised approved local import and source navigation, historical/current
snapshot contracts, encrypted persistence, backup/quiescence, reanalysis, normal
restore and revoked old API authority, a recovery checkpoint, process restarts,
delete persistence, representative input, flow-to-snapshot source, and the React
binding fixture. The36 checks include repeated startup checks and are not36
independent end-to-end scenarios. The automation uses a mock Keychain and fresh
synthetic profiles. No manual screenshot review or real-account test is claimed.

All six SDK-owned app exits had code0, no signal and exactly15 shutdown phase
records ending COMPLETE. SDK close plus diagnostic confirmation took
2,981/3,921/2,904/3,359/2,889/3,473ms. These are direct process and product cleanup
acknowledgments, not independent OS process-tree forensics or20-run stability.
The driver and packaged content hashes remained unchanged.

The representative import accepted890 files/8,060,334 bytes and reached the
overview in60,167ms; search rendered in12ms and relations in1,137ms. Its164 SUCCESS,
638 PARTIAL,1 UNSUPPORTED and87 UNMEASURED outcomes are classifications, not
precision/recall.108 entrypoints and102 flows were returned; the chosen flow's
five steps linked to snapshot3 source. The React fixture linked only
`route:/chosen -> component:chosen.tsx#ActualPage`; parameter-shadow and conflicting
package-entry routes had no component edge, including after restart.

The prior `product-RkDN8L`35-check result belongs to qUMAST before the final
package-entry guard and completion/shutdown changes. It does not validate j5EJLB.
Earlier `product-q6v3EP` close timeout and `product-29qfSB` representative-phase
failure are retained with **unconfirmed causes**. The newly reproduced SSE race
and shutdown-validation hole do not prove either historical failure's root cause.

## Dependency review for this exact candidate

The new static inventory verified the runtime manifest's5,128 listed files and
recorded the candidate's actual packaged metadata. The offline Gradle inventory
provided169 resolved artifacts;152 packaged JARs matched a unique filename and
SHA-256. The public query checked276 registry-confirmed npm/Maven coordinates
and returned0 advisory matches at2026-10-05T19:49:17Z. The unmatched
`spring-boot-jarmode-tools-4.1.0.jar` was excluded and remains explicit.
Evidence is `pre-release-final/{inventory,advisory,runtime}-continuation-20261006.json`.
Only public dependency names/versions were sent; no source or credentials.

This is not a complete SBOM, license sign-off, reachability assessment or proof of
absence of vulnerabilities. Native libraries, JRE, Electron/Chromium/Node and
browser-bundled transitive components are outside this query set.

## Review and publication

Two reusable workers independently inspected the final frontend state fences and
the shutdown validator's call chain. Neither reported a remaining blocking
defect in its assigned scope. Their review was read-only; actual executions above
were performed by the prime. The shutdown review found the FAILED+exit0 gap,
which was then repaired and covered by seven additional close-contract cases.

The original feature branch contains the product changes and this source/result
record. Repository publication uses `[skip ci]` commits, PR review and merge;
it does not upload the candidate app or raw private validation directories to
GitHub. The final GitHub PR and merge receipt identify the published revisions.

## Remaining release acceptance

The immediate deliverable is a reviewed development candidate for macOS arm64.
Actual GitHub import of the retained failed project, refresh/revoke/SSO, existing
user DB/extension/locale application and rollback, complete crash/power-loss
coverage, independent repository quality and whole-app performance/security/UX,
clean-machine/minimum-OS/signed-upgrade validation, complete dependency/license
obligations and operational support decisions remain separate acceptance work.
The long-term T00–T15 expansion roadmap is not silently counted as this candidate.

No user profile, DB, Keychain or private key is used as test input. No paid AI,
GitHub Actions, Developer ID signing, notarization or public deployment is part
of this continuation. The build uses the existing ad-hoc development signing
path. Publication of reviewed source uses `[skip ci]` commits and merge messages.
