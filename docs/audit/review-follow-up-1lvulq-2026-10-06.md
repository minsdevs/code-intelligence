# Review follow-up on candidate 1lvULq — 2026-10-06

This unit addresses the P3 findings of the independent review of PR #102 and
repackages the product as candidate **1lvULq** from clean commit `9211e88`. It
repeats the affected native checks and the unchanged twenty-run gate, which
**passes** again: p95 ready **8,466ms** and maximum sampled idle RSS
**1,519,408KiB** (limits 10,000ms / 1,572,864KiB). xb6Kxe and its results remain
the record for PR #102. Formal release remains **NO_GO**.

Identities and raw-result references are in the
[companion ledger](review-follow-up-1lvulq-2026-10-06.json).

## Changes

| Commit | Finding | Change |
| --- | --- | --- |
| `05f092c` | A rejected TypeScript-engine import stayed cached until restart. | A failed load is cleared, so the next analysis retries. New Vitest case fails without the fix. |
| `ee2ad39` | Pre-existing: helper spawns used `Promise.all`, so a failure could propagate while the sibling spawn was still registering a child. | Both spawns settle first; the first failure is then thrown. New runtime case fails with the old code. |
| `9211e88` | `errorName` accepted any alphabetic name; the earliest-failure test could not tell entries apart; the API-docs test only asserted "not 200". | Fixed allowlist of error names; the inventory test now makes a lower entry fail later with a different code (fails without the index rule); the desktop API-docs request must return 404. |

Recorded, not changed:

- Readiness polling stays at 50ms. For PostgreSQL this runs `pg_isready` with
  `spawnSync` on the main thread about five times as often during its short
  start; at first launch no window exists, and restarts show a maintenance state.
- If Redis became ready later than the backend's Tomcat start, the job pub/sub
  listener would retry and SSE progress in that window could be missed. Redis was
  ready well before the backend in every measured start.
- `DESKTOP_STARTUP BACKEND_HEALTH FAILED` can now mean that Redis or the analyzer
  failed readiness (documented in `validation/pre-release/README.md`).
- `dependency-downloader.test.cjs` "upstream HTTP failures retain the stable
  builder server-error retry behavior" is flaky and unrelated to these changes:
  one of three standalone runs counted three requests instead of two, and the
  other runs passed.

## Validation on 1lvULq

Built from baseline tZgvV7 with build sequence `1791292686000`, Java
recompilation, JAR readback and control-member verification (1,221 members). It
is an ad-hoc Validation app, not signed, notarized or released.

| Check | Result | Evidence |
| --- | --- | --- |
| Full native product sequence | **PASS**, 36 checks, omitted `[]`, six COMPLETE/code0 exits | `pre-release-final/product-9epbSW` |
| Owner crash `AFTER_SOURCE_RENAME` | **PASS**, 6 checks | `electron-crash/native-vZcaMh` |
| Owner crash `BEFORE_COMPLETED_CLEANUP` | **PASS**, 6 checks | `electron-crash/native-DoJ2Zj` |
| Electron runtime inventory loop | **PASS**, 20 validations | `pre-release-final/integrity-c6uTdi` |
| Twenty-run warm startup/idle RSS | **PASS**, 20/20, p95 8,466ms, p95 idle 1,514,880KiB, max 1,519,408KiB | `startup-performance/run-uvEMJ8` |

AC was observed at the start and at both boundaries of every run, source and
bundle stayed unchanged, the largest sample gap was 174ms and every run had at
least 29 idle samples. Ready times ranged 7,988–8,686ms.

Tests for this unit: analyzer 272/272 (one new case); desktop full suite 3,112
tests with 3,069 pass, 42 environment skips and the one flaky downloader test
above; runtime 60/60, runtime-manifest and native-acceptance 94/94; backend
`DesktopStartupSettingsIntegrationTest` 3/3.

## Space handling

To meet the unchanged candidate copy budget, superseded candidates 62hLL3 and
mEbIBC were archived losslessly with extracted inventory and signature readback
(`final-candidate/archival-jZfi0r`); their failed product results are kept. The
synthetic profile of the passing product run `product-ziBnjK` was removed after
its runtime logs were copied beside its result. The mEbIBC failure profile cited
in the previous audit is kept. Build-stage and temporary source copies were
retired with the same digest, ownership and open-file checks as before.

## Remaining gates

Real GitHub account and credential lifecycle acceptance, broader crash/power-loss
and existing-user data acceptance, cold-cache and workload-size performance,
independent security and usability review, complete SBOM/licence/provenance,
clean-machine and minimum-OS install/update, and Developer ID signing/notarization
with explicit approval remain open. Overall release: **NO_GO**.
