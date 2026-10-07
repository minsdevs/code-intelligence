# Product-fix wave and candidate 9lVRha — 2026-10-07/08

After candidate LA8ZS9, sixteen product-fix units closed most open High findings of the
2026-10-07 gate audits. The coordinator verified each unit (key tests rerun), merged them into
`codex/product-fixes-20261007`, fixed the integration defects listed below, ran the full
regression suites and built candidate **9lVRha** from clean `52e2e33` with the ADR-01 analyzer
isolation enabled (`adapterIsolation=xpc-required`). 9lVRha passes the 36-check product
sequence, both owner-crash boundaries, the twenty-run warm-startup gate and, for the first time,
the G-PERF small twenty-run series. The medium class fails with a backend heap exhaustion
(High, open), the large class was not run, and user/external inputs remain.
**Formal release remains NO_GO.**

Commands, identities and raw-result hashes are in the
[companion ledger](candidate-9lvrha-2026-10-08.json).

## Product decisions recorded by the user (2026-10-07)

| Item | Decision |
| --- | --- |
| G-COST D4 | Personal data in outgoing AI prompts is masked by default; the approved preview shows the masked text |
| G-RECOVERY format 2 | Documented refusal satisfies the row (no format-2 users exist before release) |
| G-ACCURACY D1 | Interface/abstract receiver calls are INFERRED implementation candidates |
| G-PERF size classes | Support all three classes up to large (50,000 files / 200 MiB) |
| G-COST PK-08 | Validation-build-only loopback fake provider; release builds keep the fixed endpoint and pinning |

## Units

Each unit's audit holds its red/green evidence and limits. "Verified" lists what the coordinator reran.

| Unit | Audit | Product change | Verified |
| --- | --- | --- | --- |
| w1-cancel (T03, G-JOB D2, G-PERF 4) | [bounded-cancel](bounded-cancel-2026-10-07.md) | Per-run cancellation token, checks in import and long steps, abort of in-flight analyzer requests | race classes with real analyzer 62/62; job/import classes 71/71 |
| w1-isolation (G-SEC) | [security-hardening-adr01](security-hardening-adr01-2026-10-07.md) | CSP, `https:`-only external opens, origin-bound Git credentials, Electron fuses, ADR-01 stdio transport | desktop security 109 (1 todo); analyzers 283 + 12; backend github 74 |
| w2-adr01 (SEC-H-02) | [adr01-production-path](adr01-production-path-2026-10-07.md) | XPC supervisor + bridge, worker Electron inside the service, backend→main control socket, `ADAPTER_ISOLATION_UNAVAILABLE` | adapter tests 30/30; backend `analysis.ts.*` 63/63; staged packaged job race 8/8 |
| w1-verdicts (G-UX F5/F6) | [flow-impact-verdicts](flow-impact-verdicts-2026-10-07.md) | Flow step verdicts and badge; impact one row per node, unique-node score, three groups | backend 12/12; vitest 16/16 |
| w3-a11y (G-UX) | [ux-a11y-fixes](ux-a11y-fixes-2026-10-07.md) | AA contrast tokens and Monaco theme, focus placement, `<html lang>`, graph names | frontend 474/474 |
| w2-updater (G-UPDATE NU-01..03) | [updater-nu01-03](updater-nu01-03-2026-10-07.md) | User-confirmed updater with pinned keys (empty in this build), pre-migration checkpoint, rollback floor | update tests 136/136 with real PostgreSQL |
| w2-cost (G-COST D4, PK-08) | [cost-redaction-pk08](cost-redaction-pk08-2026-10-07.md) | `PersonalDataMask`; validation-only loopback provider | backend 15/15; desktop 13/13 |
| w3-evidence (G-EVIDENCE, D1/D2) | [evidence-d1-fixes](evidence-d1-fixes-2026-10-07.md) | CONFIG/MIGRATION span end, note-pinned v0 retention, per-capability coverage, INFERRED interface calls with call-site spans | merged backend 81/81; race classes 62/62 |
| w3-import (G-IMPORT, SEC-M-02, P4) | [import-grant-p4](import-grant-p4-2026-10-07.md) | Grants bound to root, dev:ino, expiry and nonce; native confirmation for drops; nested repositories excluded; preview languages/depth/scope (V29) | merged backend 186/186 |
| w2-perf (G-PERF) | [perf-fixes](perf-fixes-2026-10-07.md) | ANALYZE before cross-domain linking, FK indexes (V28), batched persistence, lazy Java parse, TS sessions, 50k admission | merged backend 186/186; ts-analyzer 288/288 |
| w4-scale (G-PERF large, R10) | [scale-large](scale-large-2026-10-07.md) | Batched vault durability barrier, bounded TS extraction, 6 GiB watchdog | vault 152/152; ts-analyzer 292/292; backend 346/346 |
| w3-supply (stage 7) | [supply-chain-fixes](supply-chain-fixes-2026-10-07.md) | jmh-core excluded from the backend JAR; JRE supply record; JGit licence text | SBOM/licence 32/32; merged JAR exclusion check PASS (150 JARs, 0 excluded) |
| w5-backup | [backup-policy-v28-v29](backup-policy-v28-v29-2026-10-07.md) | Backup policy reviews V28/V29; V27/V26 archives restore into V29 | backup 177/180 (3 skip); compatibility fixture 11/11 |
| w5-arch | [arch-guard-fixes](arch-guard-fixes-2026-10-07.md) | Owner-tree RSS measured by desktop main (no backend process start); package cycles removed | backend Docker suite 1,947/1,979, 0 fail |
| w6-runners | [runners-9lvrha](runners-9lvrha-2026-10-08.md) | none (validation runners only) | all functional runs below |

## Integration defects found and fixed by the coordinator

| Defect | Found by | Fix |
| --- | --- | --- |
| Packaged app stopped at startup: `update-startup.cjs` hashed `app.asar` through the asar-patched `fs` (ENOENT) | w2-adr01 staged run | `13ee9ed`: `original-fs` under Electron; new test red with ENOENT, green after; checked under real Electron |
| `runtime-stage-containment` broken by the adr01 branch | coordinator regression | fixed on the unit branch before merge |
| V28/V29 not in the backup policy (75 desktop failures, updater target 27) | full desktop suite | w5-backup |
| New process start in the backend and nine package cycles | full backend Docker suite | w5-arch |
| C05-45/46 assumed the old 20,000-file admission | corpus suite | `687d961`: shipped limit 50,000 equals the entry ceiling; 50,001 refused |
| Spotless violations in merged sources | backend suites | `485d782`, `0be7c30` |
| Candidate builder could not add migrations to a reused runtime (ENOENT) | build `build-xRFxPR` | `c4543e5`: append-only, order and hash checked (tests 26/26) |
| Candidate builder omitted `desktop/native` (supervisor entitlements) | build `build-K1WkCC` | `52e2e33`: copied with its inventory (27/27) |

Both failed builds keep their result and logs; the partial app of `build-K1WkCC` was removed with a
`REMOVED-PARTIAL-APP.json` record.

## Regression on the merged source (`cfaa3ae`)

Short-path detached worktree, evidence `validation/local/post-merge-20261007c`:
frontend vitest 480/480 and `tsc -b`; validation runner tests 392/392; desktop 3,300 (3,255 pass,
0 fail, 45 skip); backend Docker suite 1,979 (1,947 pass, 0 fail, 32 skip; `backend-kQ0Ryh`);
events 19/19. The earlier run on `5b8f8f8` (`post-merge-20261007b`) is kept with its failures.

## Candidate 9lVRha

Built from baseline tZgvV7 at clean `52e2e33`, build sequence `1791383066676`,
`--adapter-isolation xpc-required` (`pre-release-candidate/build-gFIP8F`): Java and analyzer rebuilt,
V28/V29 appended to the staged backup migrations, `Contents/XPCServices/AdapterSupervisor.xpc` and
`Contents/MacOS/adapter-bridge` present, no `runtime/ts-analyzer`, RunAsNode fuse off, inspect fuse on
only for the validation app id, 816 MB. Ad-hoc Validation app; not signed, notarized or released.
Integration HEAD `34b9293` differs from the candidate source only in validation runners.

The first functional pass failed for runner reasons (drop confirmation, three services, a RunAsNode
probe that hung 60 minutes and was stopped; `stage5-9lVRha/summary.txt`); w6-runners fixed the runners
without product changes. Results:

| Check | Result | Evidence |
| --- | --- | --- |
| Full native product sequence | **PASS**, 36 checks (two earlier runner-label failures kept) | `pre-release-final/product-QePxxg` |
| Owner crash `AFTER_SOURCE_RENAME` / `BEFORE_COMPLETED_CLEANUP` | **PASS**, 6 / 6 | `electron-crash/native-sWM2DE`, `native-GSpJqB` |
| Packaged job races | **PASS**, 8 | `job-race/product-Jqgh1b` |
| G-COST packaged first-run probe | **PASS** | `cost-egress-packaged/probe-dtdojr` |
| PK-08 packaged ask through the loopback provider | **PASS**, 9 checks | `cost-egress-packaged-ask/ask-1o388T` |
| Packaged security probe | COMPLETE: CSP delivered, eval/inline/cross-origin blocked, RunAsNode and NODE_OPTIONS refused, profile 0700/0600, 0 plaintext secrets | `security-internal-review/packaged-DYHJTN` |
| UX scripted pilot | COMPLETED, 190 states, 0 errors; contrast failures 0 (LA8ZS9: 2,400); flow badge shown with per-step verdicts; impact 0 duplicate rows, three groups; `lang` follows the UI | `pre-release-ux/ux-79C3XN` |
| Twenty-run warm startup / idle RSS | **PASS**, 20/20, p95 7,908 ms, max idle 1,346,352 KiB | `startup-performance/run-QOZD9P` |
| G-PERF small `--series-20` | **PASS** (runner assessment), 20/20 | `workload-performance/run-oH16Fl` |
| G-PERF medium `--smoke-1` | **FAIL**: backend `OutOfMemoryError: Java heap space` after 10,000 files were admitted | `workload-performance/run-abPyCb`, `run-u8ObYG` (logs kept) |
| G-PERF large `--smoke-1` | NOT RUN: runner refused, 5.8 GB free < 6 GiB reserve | `stage5-9lVRha/timing-summary-2.txt` |

The first startup series (`run-pYYlyE`) stopped after run 4 because one memory-sampling gap was
316 ms (`samplingComplete: false`); all four completed runs were ready in 7.8–7.9 s. It is kept;
the rerun above passed.

### G-PERF small series

| Observation (20 runs) | 9lVRha | LA8ZS9 (interrupted, 12 runs) | Limit |
| --- | --- | --- | --- |
| Analysis, approve → overview | 21,417–22,344 ms, p95 22,043 ms | 55,120–60,570 ms | p95 ≤ 30,000 ms |
| Peak owner-tree RSS, analysis | 2,441,664–2,511,568 KiB | 3,179,104–3,424,448 KiB | ≤ 3,145,728 KiB |
| 1% refresh | 21,073–24,030 ms | 678,689–701,680 ms | — (medium p95 ≤ 30 s) |
| Cancel → lock release | 228–1,380 ms | 23,171–27,398 ms | p95 ≤ 5 s, max 10 s |

The series started at 1-minute load 2.25 after a quiet wait, but individual runs started at load
2.98–13.14, so the machine was not quiet throughout. The UI-acknowledgement metric is recorded as
−19 to −14 ms (acknowledgement observed before the trigger mark), a runner timing defect to fix;
it is not counted as evidence.

## Remaining conditions

- G-PERF: medium heap exhaustion (High, open; unit w7-medium), then medium/large series with enough
  disk; R11 quotas; finding 6.
- G-SEC: Developer ID path and C15 OS denial with a signed helper, independent review; broad
  entitlements remain.
- G-UPDATE: release key, update host and Team ID (O2); C14 U1–U10 on real inputs.
- G-JOB: power loss. G-RECOVERY: power loss, real profile, older binary; packaged recovery matrix not
  rerun on 9lVRha.
- G-ACCURACY: independent annotations and blind review; D3–D9.
- G-UX: eight-participant study and VoiceOver.
- Stage 7: counsel decisions; 13 licence texts not available offline; SBOM not yet rerun on 9lVRha.
- Not run on 9lVRha: accuracy packaged export, native preflight/recovery matrix, import-evidence
  native, `packaged-keychain-acceptance` (cannot answer the drop confirmation through a real-Keychain
  CDP attach; needs a decision).

Overall release: **NO_GO**.
