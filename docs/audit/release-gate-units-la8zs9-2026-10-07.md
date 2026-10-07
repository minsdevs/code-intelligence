# Release-gate units and candidate LA8ZS9 — 2026-10-07

Ten release-gate units ran on 2026-10-07, each in its own worktree from `bcd8081`.
The coordinator reran each unit's key commands, merged all ten branches into
`worktree/calm-meadow-7229` without conflicts, fixed two integration defects, ran
the regression suites and built candidate **LA8ZS9** from the clean merged commit
`19300fa`. LA8ZS9 passes the full 36-check product sequence, both owner-crash
boundaries and the twenty-run warm-startup gate (p95 **8,734ms**, maximum sampled
idle RSS **1,513,568KiB**). No gate is declared PASS by this record, and open High
findings remain. **Formal release remains NO_GO.**

Commands, identities and raw-result hashes are in the
[companion ledger](release-gate-units-la8zs9-2026-10-07.json).

## Units

Each unit's audit holds its full requirement matrix and limits. Counts are the
units' own row counts; the coordinator did not reclassify rows.

| Gate | Audit | Rows (PASS/FAIL/NOT RUN/BLOCKED) | Product change | Main open items |
| --- | --- | --- | --- | --- |
| G-COST | [cost-egress-matrix](cost-egress-matrix-2026-10-07.md) | 75 (69/2/2/2) | `SecretMask` redacts connection-URI passwords (High, fixed) | No personal-data redaction (Medium, needs a product decision); no fake-provider seam in a shipped build; independent review |
| G-IMPORT | [import-safety-matrix](import-safety-matrix-2026-10-07.md) | 30 (20/4/4/2) | none | Path grant has no expiry/nonce/root identity; submodule working tree copied (both Medium) |
| G-EVIDENCE | [evidence-integrity-matrix](evidence-integrity-matrix-2026-10-07.md) | 17 (11/4/2/0) | none | CONFIG/MIGRATION spans end one line late; note-pinned v0 snapshots pruned; no per-capability coverage (all Medium) |
| G-RECOVERY | [recovery-crash-matrix](recovery-crash-matrix-2026-10-07.md) | 45 (40/0/2/3) | none | 26/26 C16 SIGKILL boundaries on 1lvULq (one first-attempt failure retained); power loss, real profile, older binary, format-2 conversion |
| G-JOB | [job-race-matrix](job-race-matrix-2026-10-07.md) | 27 (19/2/2/2, 2 N/A) | `JobWorker` fences a stale worker's final transitions (High, fixed) | Cancel does not stop a running step within 10s (T03); power loss |
| G-PERF | [workload-performance](workload-performance-2026-10-07.md) | 18 (5/1/8/4) | `LocalStagingVerifier` excludes retained-source writes from the inspection limit (High, fixed) | Medium/large classes exceed product limits; cancel release ~25s; slow project delete |
| G-SEC | [security-internal-review](security-internal-review-2026-10-07.md) | 51 (26/10/13/2) | `GitCloneService` ignores user-configured filter drivers (High, fixed) | ADR-01 isolation not implemented (High); no CSP, open fuses, renderer path grant, redirect credentials (Medium); independent review, C15 |
| G-ACCURACY | [accuracy-baseline](accuracy-baseline-2026-10-07.md) | 22 (11/2/0/9) | none | No independent evaluation annotations; Java call-site spans and abstentions, interface dispatch semantics |
| G-UX | [ux-accessibility](ux-accessibility-2026-10-07.md) | 54 (23/21/4/6) | Relation verdict labels, empty-result wording, flow wording, analysis progress live region (High F1–F4, A11 fixed) | Flow/impact verdicts (F5/F6, High); contrast, focus, `lang`; 8-participant study |
| G-NATIVE / G-UPDATE | [native-update-readiness](native-update-readiness-2026-10-07.md) | 33 (11/13/1/8) | none (a signing-script edit without a reproduced defect was reverted) | No updater, migration checkpoint or rollback floor (High); broad entitlements; Developer ID, notarization, clean Macs |
| Stage 7 | [supply-chain-sbom](supply-chain-sbom-2026-10-07.md) | 33 (18/3/9/3) | Electron/Chromium licence files and generated third-party notices packaged | Counsel decisions (Redis, JRE source offer, FFmpeg); JRE supply record; 15 components without offline licence text; jmh-core in the backend JAR |

## Coordinator verification

Every rerun used the unit's own worktree and command; Gradle runs used
`cleanTest`/`--rerun` so no cached result was counted.

| Unit | Rerun | Result |
| --- | --- | --- |
| G-RECOVERY | desktop `backup-runtime`, `backup-recovery-matrix` | 145/145 |
| G-COST | backend `SecretMaskTest`, `AiProviderEgressArchitectureTest`, `AiCostEgress*`; desktop `ai-egress-boundary` | 43/43 (9 suites); 7/7 |
| G-IMPORT/EVIDENCE | Docker-isolated C05/C06/legacy-walk; desktop source vault/broker | 88 (87 pass, 1 skip C06-15 R2); 74/74 |
| G-JOB | `aFailedWorker*` regression; pipeline + analyzer-worker race set; runner tests | 2/2; 60/60; 3/3 |
| Stage 7 | SBOM/licence tests; offline SBOM of 1lvULq | 82/82; 350 components, 0 unattributed |
| G-PERF | workload fixture/metrics; `LocalSourceBindingTest` | 24/24; 39/39 |
| G-SEC | backend security/github/auth set; red/green of `GitCloneService`; renderer boundary; rendering test | 279 (0 fail, 7 skip); HEAD version fails the hostile smudge-driver test, fix passes; 10 (8 pass, 2 todo); 3/3 |
| G-ACCURACY | T00 + observation tests; spotless; backend export | 125/125; pass; 69 facts, scoring FAIL as reported |
| G-NATIVE/UPDATE | signing/update/staging tests; signing readiness on 1lvULq | 119 (118 pass, 1 todo); `READY_FOR_DEVELOPER_ID_SIGNING_PASS` |
| G-UX | targeted frontend set; runner tests; app typecheck; red check with the six `bcd8081` product files | 188/188; 7/7; pass; 7 failures without the fixes |

## Integration

The ten merges had no textual conflicts; agents had left the shared documents to
the coordinator. Two integration defects were found and fixed:

- `6f4bc76`: the new G-SEC rendering test imported `node:fs`, so the frontend app
  typecheck (`tsc -b`, part of the build) failed. The source-sink scan now reads the
  product sources through Vite's `import.meta.glob` (`?raw`). A probe file containing
  an `innerHTML` assignment is detected; the test passes without it.
- `640b038`: Spotless formatting of four new G-SEC backend tests; the isolated
  backend runner stops at `spotlessCheck` otherwise.

Regressions on the merged source (`validation/local/post-merge-20261007`,
`docker-integration/backend-Y5G30G`, `events-zHI2gu`):

| Suite | Result |
| --- | --- |
| Frontend vitest / typecheck / eslint | 449/449; pass; pass |
| Validation runner tests (`validation/pre-release/test`, `validation/t00/test`) | 368/368 |
| Desktop full suite | 3,197: 3,150 pass, 2 fail, 42 skip, 3 todo |
| Backend isolated Docker suite | 1,886: 1,852 pass, 1 fail, 33 skip |
| Backend events suite | 19/19 |

The desktop failures: `backup-product-state` "commit receipt guard: timeout during
final post-close validation" passed 3/3 when run alone (a 222ms timing case under
full-suite load); `dependency-downloader` "upstream HTTP failures retain the stable
builder server-error retry behavior" fails the same way (3 requests instead of 2)
on unchanged `main` (`bcd8081`), so it is a pre-existing failure outside this work.
The backend failure is `LocalIngestPolicyTest.specialFilesAreRejectedAndTheOldRepositorySurvives`
with `Unix domain path too long` under the worktree path; the class passes 67/67
with the default temporary directory.

## Candidate LA8ZS9

Built from baseline tZgvV7 at clean `19300fa` with build sequence `1791352154748`:
Java recompiled, JAR readback, control JAR 6 classes, native runtime reused after
inventory/signature checks, source and baseline unchanged
(`pre-release-candidate/build-tOuqNl`). It is an ad-hoc Validation app, not signed,
notarized or released. `app.asar` is byte-identical to 1lvULq (no desktop source
change); the backend JAR, frontend assets and `Contents/Resources/legal/` differ.

Owner-crash and later native runs used a temporary short-path worktree of the same
commit (`~/Dev/ci-gate`, APFS clones) because the crash driver's isolated-run claim
is refused under the long integration-worktree path: both first attempts stopped
with `ISOLATED_RUN_INVALID` before the app was launched or an evidence directory created.

| Check | Result | Evidence |
| --- | --- | --- |
| Full native product sequence | **PASS**, 36 checks, omitted `[]` | `pre-release-final/product-VrW0p3` |
| Owner crash `AFTER_SOURCE_RENAME` | **PASS**, 6 checks | `electron-crash/native-6iKBDr` |
| Owner crash `BEFORE_COMPLETED_CLEANUP` | **PASS**, 6 checks | `electron-crash/native-nLTJxs` |
| Twenty-run warm startup / idle RSS | **PASS**, 20/20, p95 8,734ms, p95 idle 1,512,752KiB, max 1,513,568KiB; AC at run boundaries; source and bundle unchanged; ready 8,536–8,768ms | `startup-performance/run-S5I7cy` |
| G-JOB packaged races (now with the fencing fix) | **PASS**, 8 checks, clean shutdowns | `job-race/product-CpsTpL` |
| G-COST packaged first-run probe | **PASS**, no failures | `cost-egress-packaged/probe-BTcHgg` |
| G-UX scripted pilot | COMPLETED, 190 states, 0 step errors | `pre-release-ux/ux-6PUoj4` |
| Offline SBOM | 350 components, 0 unattributed, third-party notices index PRESENT, missing licence text 96 → 15 | `sbom/run-Ekjp6L` |
| G-PERF small `--series-20` | **FAIL / INCOMPLETE**: 12 of 20 runs executed, 11 PASS functionally, run 12 ended by an external SIGKILL; every executed analysis 55.1–60.6 s (p95 limit 30 s) and 3.03–3.27 GiB peak RSS (ceiling 3 GiB); see below | `workload-performance/run-vSLN0r` |

On the pilot, the strings behind F1 ("확인된 정적 관계") and F4 ("확인된 흐름 따라가기")
no longer appear, the overview link reads "기록된 정적 흐름", and analysis progress is
now announced through a status region (A11; 1lvULq announced nothing). F2/F3 remain
covered by the unit tests only. The G-UX, G-JOB and stage 7 audits record the
1lvULq results; these LA8ZS9 observations are added here, not rewritten there.

## G-PERF small twenty-run series (interrupted)

`env -i … node validation/pre-release/run-workload-benchmark.cjs --app <LA8ZS9> --class small --series-20`,
started 15:33 KST under the native lock from `~/Dev/ci-gate`, one warm-up launch, a new synthetic
profile per run, fixture tree `88140e38…6254e` (1,000 files, 5,242,880 bytes). Raw result
`workload-performance/run-vSLN0r/result.json` (SHA-256 `fdb202ce…7c06d5`), samples
`resource-samples.csv` (`87d7f389…cab`), runner stdout `series-stdout.log`, runtime logs of the
warm-up and the killed run in `profile-logs/`.

The series did not finish. At 18:10 KST, during the 1% refresh of run 12, the app process tree
received SIGKILL from outside the runner (`STARTUP_PROCESS_EXITED`, exit signal `SIGKILL`, shutdown
phase `SAFETY_OFF`/`RUNNING`, backend log ends without a shutdown record). [INFERENCE] The session
that had launched the series ended at that time and its process group was killed; the runner then
wrote its result. The runner's own assessment is `FAIL`, `measurementStatus: INCOMPLETE`
(`ANALYSISMS_P95_EXCEEDED`, `RSS_CEILING_EXCEEDED`, `RUN_FAILED`, `RUN_NOT_EXECUTED`,
`SAMPLING_INCOMPLETE`, `CLEANUP_UNCONFIRMED`). The machine was not quiet: 1-minute load at run start
was 4.5–9.0 in eleven runs and 33.3 in run 9 (series start 4.01). The numbers below are therefore
observations of a failing candidate, not acceptance measurements, and they are kept as recorded.

| Observation (executed runs) | Result | Limit |
| --- | --- | --- |
| Functional status | 11 PASS, 1 FAIL (external SIGKILL), 8 not executed | 20 runs |
| Analysis, approve → overview | 55,120–60,570 ms in all 12 analyses, median 58,023 ms | p95 ≤ 30,000 ms |
| Peak owner-tree RSS, analysis | 3,179,104–3,424,448 KiB; 12 of 12 over the ceiling | ≤ 3,145,728 KiB |
| Analysis steps (run 12) | `IMPORT` 25.8 s, `SOURCE_PARSING` 18.1 s, `TS_PARSING` 8.7 s, all others ≤ 1.3 s | — |
| 1% refresh (full reanalysis) | 678,689–701,680 ms in 11 of 11; `CROSS_DOMAIN` 643,834–662,990 ms of it; counts equal to the full analysis in 11 of 11 | — (medium: p95 ≤ 30 s) |
| Cancel UI ack / lock release | 0–1 ms / 23,171–27,398 ms in 11 of 11 | ≤ 500 ms / p95 ≤ 5 s, max 10 s |
| Graph API search / node page / relations | 29–46 / 206–260 / 7–16 ms | p95 ≤ 500 ms (medium) |
| Warm startup ready | 9,004–10,321 ms | (startup gate measured separately) |

What this settles: G-PERF small analysis fails on LA8ZS9 independent of the incomplete series,
because every executed run exceeds both limits. Finding 5 of the
[workload-performance audit](workload-performance-2026-10-07.md) is no longer a single observation:
the refresh's `CROSS_DOMAIN` step took 644–663 s in 11 of 11 runs while the same step took 36 ms in
the first analysis (High, open, root cause not yet identified). The cancel release (finding 4 and
G-JOB D2/T03) exceeded the 10 s maximum in 11 of 11 runs. Per the user's decision, no second LA8ZS9
series was run; the next twenty-run series runs on the next candidate that carries the cancel and
performance fixes, on a quiet machine.

## Space handling

Five superseded candidates (jXdOYk, wXqDvU, yGBKOK, 5MOKBa, Imupzt) were archived
losslessly with the same pattern as `archival-jZfi0r`: ditto ZIP, extraction,
full inventory (path, type, size, SHA-256, exec bit, link target) comparison and
ad-hoc signature verification of the extracted copy before the expanded `.app`
was retired; each directory keeps an `ARCHIVED.json` marker
(`final-candidate/archival-3VboGQ`, free space 6.82 → 8.01 GiB). Synthetic profiles of
the passing LA8ZS9 product, job-race and pilot runs were removed after their
runtime logs were copied beside each result (`profile-logs/`).

## Remaining conditions

No gate is complete. Open product work before a release candidate: ADR-01
analyzer isolation and Electron fuses/CSP (G-SEC), the updater with migration
checkpoint and rollback floor (G-UPDATE), working cancel within 10s (G-JOB/G-PERF), small-class
analysis time and RSS and the refresh `CROSS_DOMAIN` slowdown (G-PERF),
flow/impact verdicts (G-UX), CONFIG/MIGRATION spans, v0 pin pruning and capability
coverage (G-EVIDENCE), medium/large workload limits (G-PERF), and the licence
obligations listed in the stage 7 audit. User or external input is needed for the
real GitHub account lifecycle (G-OAUTH), existing-data application, Developer ID
signing/notarization and clean/minimum-OS Macs (G-NATIVE/G-UPDATE), an independent
security review, independent annotators and blind real-repository review
(G-ACCURACY), eight usability participants (G-UX) and counsel decisions (stage 7).
Overall release: **NO_GO**.
