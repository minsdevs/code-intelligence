# G-IMPORT grant, submodule exclusion and UX P4 — 2026-10-07

Unit **w3-import**, branch `gate/w3-import` from `d7c8952`. Fixes the two open Medium
G-IMPORT findings of [import-safety-matrix](import-safety-matrix-2026-10-07.md)
(F-1 path grant, F-2 submodule working tree), SEC-M-02 of
[security-internal-review](security-internal-review-2026-10-07.md) and the P4 gap recorded in
[ux-a11y-fixes](ux-a11y-fixes-2026-10-07.md). Evidence is unit, real-filesystem, real-PostgreSQL
(Testcontainers), synthetic-Electron and Vitest/JSDOM runs on this branch. No packaged candidate
contains these commits, so the matrix rows I-02, I-17, I-23 and SEC-R01b stay **FAIL** until the
coordinator rebuilds a candidate and reruns C05 and the packaged import check. Release verdict stays
**NO_GO**.

## Behaviour after the fix

- **Grant (F-1, SEC-M-02).** `POST /api/desktop/paths` (main only, path token) now returns
  `{path, grant, expiresAt}`: a grant for exactly one canonical root, pinned to its `dev:ino`
  identity, valid for 15 minutes and holding a 256-bit one-time nonce. An initial preview needs
  that grant (or a configured server root) for exactly that root; descendants, siblings, forged or
  expired nonces and a folder swapped in at the same path are refused (400). Previews may repeat
  within the grant's lifetime; the confirming `POST /api/projects/local` (or a relink) spends the
  grant once, after the approval is bound, so a failed confirmation leaves it usable and a replay
  is refused. A spent grant's root then serves only that project's refresh and approved copy.
  Roots main persisted earlier are re-registered with `purpose: "RESTORE"` and never yield a grant.
  A confirmation whose root lost authority (swap) reports `LOCAL_SOURCE_CHANGED` (409).
- **Dropped folders (SEC-M-02).** `folder:authorize` resolves the dropped path in main and grants
  it only after a native `dialog.showMessageBox` confirmation showing the canonical path (default
  and cancel = refuse); the grant must be for that same canonical path. `folder:pick` and a
  confirmed drop return the grant object, never a bare path.
- **Submodules (F-2).** A non-root directory with a `.git` entry (gitlink file or nested clone) is
  pruned whole and unread, counted once as `excludedEntriesByReason.SUBMODULE` (the recorded
  `excludedSubmodules` count); `.gitmodules` remains ordinary content. Policy version stays
  `local-ingest-v1` (a pending pre-upgrade approval fails closed as a source change).
- **P4.** The preview response adds `languages` (`language`, `files`, `expectedDepth` from
  `LocalLanguageCapabilities`: Java `SYMBOLS_AND_CALLS`; TS/JS `SYMBOLS_AND_CALLS` only when the TS
  analyzer is configured, else `INVENTORY_ONLY`; Python/Go `STRUCTURE` under the TS analyzer;
  recognised config languages `CONFIGURATION`; everything else `INVENTORY_ONLY`), `directories`
  (top-level, `.` = root files) and `scope`. An optional request `scope`
  (`directories` and/or `languages`, validated) narrows the shared selection policy before the
  manifest digest; the canonical scope is stored with the approval and job input (V29), so the
  worker re-selects and copies exactly the approved scope; out-of-scope entries count as
  `OUT_OF_SCOPE`. Refresh previews and the source status reuse the project's last approved scope.
  The preview UI shows a language table (caption, column headers), a depth disclaimer and a
  checkbox scope fieldset that requests a new preview; all text is in `translations.ts` (en/ko).

## Red → green

| Defect | Test | Red (unchanged code) | Green |
|---|---|---|---|
| F-2 | `LocalIngestPolicyTest.submoduleWorkingTreesAreExcludedAndCountedOnce` [gitlink-file, nested-clone] | 2/2 failed: selection contained `libs/sub/lib.ts`, `libs/sub/deep/more.ts` | class 69/69 |
| F-2 | `ImportSecretsCorpusIntegrationTest` C05-18 (deviation removed), new C05-72 nested clone | C05-18 was `FAIL_SPEC_DEVIATION` in `targeted-sJi3wp` | 73/73 (72 cases + sweep) |
| F-1 | `LocalImportServiceTest.desktopGrantCoversOnlyTheChosenRootNotItsDescendants`, `…IsRefusedWhenTheChosenFolderIsSwapped` | 2 failed: "Expecting code to raise a throwable" | class 17/17 |
| F-1 | `DesktopRequestSecurityTest.pathGrantRequiresSeparateMainCapability…`, `restoringAPersistedRootReturnsNoSelectionGrant` | 2 failed: `No value at JSON path "$.grant"`; status 200 instead of 400 | class 6/6 |
| F-1 | `DesktopPathAuthorizationServiceTest` (expiry, exact root, swap, spend once, restore) | new API, did not compile on old code (not counted as a red run) | 7/7 |
| F-1 | `DesktopPathGrantIntegrationTest` (repeat preview, confirm once, replay, missing grant, swap, relink) | written with the fix | 4/4 |
| SEC-M-02 | `security-renderer-boundary.test.cjs` todo flipped + 2 new cases | 3 of 13 failed: `folder:authorize '/'` reached the backend request and persistence (`safeStorage.encryptString is not a function`); no grant object | 13/13; with `main-runtime-gateway`, `ai-egress-boundary`, `runtime`: 171/171 |
| SEC-M-02 | `localImportWizard.test.tsx` "sends the folder grant…" | 2 failed: grant object rendered as a React child; create arguments | 5/5 |
| P4 | `LocalPreviewApiIntegrationTest` languages/areas, scoped approval imports exactly the scope (+ refresh keeps it), unsafe scope refused | 3 of 8 failed: no `languages`; scope ignored (`""` stored); invalid scope 200 | 8/8 |
| P4 | `localSourceApproval.test.tsx` language table, scoped preview and approval | 2 of 19 failed: no table / scope group | 19/19 |

Directly affected suites, final runs: `LocalSourceApprovalIntegrationTest` 22/22,
`LocalSourceStatusServiceTest` 6/6, `LocalSourceBindingTest` 41/41, `RetainedRunWorkspaceTest`
80/80, `RetainedSourceIntegrationTest` 37/37, `BackupSourceWorkerTest` 111/111,
`LocalIngestIntegrationTest` 4/4, `CoverageServiceTest` 46/46, `EvidenceHistoryIntegrationTest`
(C06, real TS sidecar built locally and removed afterwards) 14 pass + 1 explicit skip (C06-15 R2).
Frontend regression set (`validation/pre-release/frontend-regression.config.mjs`, same
directories as w3-a11y): 42 files, 384 tests passed; `src/api` 88/88; `tsc -b` exit 0; ESLint on
changed files 0 errors; `ux-accessibility.test.cjs` 7/7.

Recorded non-passes: `LegacyMigrationWalkTest` **fails on this branch alone** (`No migration with
a target version 28`) because V29 is here and V28 is w2-perf's; with w2-perf's
`V28__foreign_key_lookup_indexes.sql` copied in temporarily (not committed) it passed 1/1. One
combined 11-class Gradle run had `LocalSourceApprovalIntegrationTest.expiryIsEvaluatedAfterWaiting…`
fail with `CannotGetJdbcConnectionException`; the class passed 22/22 in two other runs.

## Changed paths

- Backend: `project/{DesktopPathAuthorizationService,DesktopPathAuthorizationController,
  LocalImportService,LocalSourceApprovalService,LocalSourceStatusService,LocalSourcePolicy,
  LocalSourceBinding,LocalSourcePreview,ProjectController,ProjectService}.java`, new
  `project/{LocalImportScope,LocalLanguageCapabilities}.java`,
  `analysis/core/LanguageDetector.java` (`knownLanguages()`),
  `analysis/coverage/CoverageService.java` (reasons `SUBMODULE`, `OUT_OF_SCOPE`),
  `db/migration/V29__local_source_scope.sql`.
- Desktop: `desktop/src/main.cjs` (`authorizePath`, new `authorizeDroppedPath`, both
  `authorizePath(root, { restore: true })` call sites, `folder:authorize` handler). Preload unchanged.
- Frontend: `src/desktop.d.ts` (`FolderGrant`), `src/api/{projects,types}.ts`,
  `features/import/{ConnectStep,ImportWizardPage}.tsx`,
  `features/projects/{LocalSourceApproval,LocalSourceStatus}.tsx`, `features/projects/localSourcePreview.ts`,
  `features/analysis/CoveragePanel.tsx`, `lib/translations.ts`.
- Docs: `docs/audit/local-ingest-policy.md` (nested repository rule), this file.
- Shared files also edited by other units: `desktop/src/main.cjs` (folder grant functions only),
  `desktop/test/main-runtime-gateway.test.cjs` (restore body now carries `purpose: "RESTORE"`),
  `LanguageDetector.java`, `CoverageService.java`, `lib/translations.ts`, migration number V29.

## Limits and remaining

- Not packaged-verified: needs a new candidate, then C05 (`import-evidence-backend.cjs`) and
  `import-evidence-native.cjs`; the native runner's existing refusals (ungranted preview 400,
  sibling 400) remain valid. Suggested additions there: grant replay after confirmation, drop
  confirmation declined, and a scoped import.
- The drop confirmation is a native message box, not a Finder-level drop record; a real person
  clicking it is not part of any run (as for the folder dialog, I-22b).
- Expected depth is a static expectation per language and analyzer configuration, not a measured
  per-cell capability manifest (doc 02 `capability-manifest.json` does not exist yet).
- Grants are per backend process; a backend restart drops unspent grants (re-pick needed). The
  15-minute lifetime and the one-time spend are not configurable.
- I-05b (descriptor `fstat` confinement), I-06b, I-12b, I-14b, I-15b, I-21b, I-22b are untouched.
