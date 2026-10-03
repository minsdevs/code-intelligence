# 2026-10-03 implementation continuation — backup/restore integration

The current candidate connects format3 typed PostgreSQL and verified-source backup/restore
through Electron main, preserves cost obligations in safety journal B, revokes credentials and
authority on restore, and verifies the restarted backend behind a startup maintenance barrier
before completing the transaction. New bundles require `backupProtocol: 3`.

Current changes, findings, test results and limits are in the
[backup/restore report](backup-restore-integration-2026-10-03.md) and
[validation record](backup-restore-validation-2026-10-03.json).
Release remains **No-Go**: recovery-only startup/resumption, source completeness and native
confinement, full capacity/retention policy, legacy conversion, real OAuth/Keychain and signed
clean-device installation/update, independent NestJS/React accuracy and large-repository
acceptance remain open. No deployment, paid request or actual user-data validation was performed.

The records below retain each earlier candidate and its original counts and limitations.
They do not certify the current source or override the latest report.

## Historical cost-integration checkpoint

# 2026-10-03 implementation continuation — current cost integration

The current V25 candidate connects one-use RequestPlan approval, explicit budget activation,
main-owned transport and journal/PostgreSQL accounting. The latest findings, final gate counts
and remaining release blockers are in [the cost integration report](strict-ai-cost-integration-2026-10-03.md)
and [validation record](strict-ai-cost-validation-2026-10-03.json).

Release remains **No-Go**: complete backup/restore, source/native confinement, real provider and
recovery acceptance, operational OAuth, signed clean-device installation/update and independent
NestJS/React accuracy/performance remain open. The earlier desktop AI blanket guard is historical;
unsupported desktop AI paths and legacy backup/restore are still unavailable.

## Historical V24 checkpoint

The following original text and counts describe the earlier candidate. They are retained as
history and do not certify the later cost integration or subsequent source changes.

Current candidate: V24 AI OFF/reconnect preferences, settings/provider guards and the actual main
safety lifecycle are implemented and verified within their bounded scope. See the
[app-safety report](app-safety-integration-2026-10-03.md) and
[machine-readable validation](app-safety-validation-2026-10-03.json).

The final candidate passed backend **889/889** (96 suites), separate real backend/PG/headless
source flows **12/12**, frontend **179/179** (27 files), and desktop **572/572**, with no
failures/errors/skips. Formatter, lint, typecheck and build passed. Independent main probes passed
**17/17**; V24 temporary PostgreSQL catalog checks passed **8/8** (49 tables, 395 columns).
These overlapping scopes must not be added together as product coverage or completion percentage.

Whole-product release remains **No-Go**. Desktop AI and legacy backup/restore are explicitly
unavailable at their entry points. Strict cost/request authorization, safe format3 loading,
source-consumer/native isolation, operational OAuth, signed clean-device installation/update and
independent NestJS/React accuracy/performance acceptance remain open. The final source hashes show
no post-gate drift; all 857 resume-baseline files remain and all 21 frozen documents are unchanged.

## Earlier continuation history

The records below retain earlier candidate counts, failures and pending work as historical evidence.
For the final state, use the current report linked above; earlier counts do not certify later changes.

The user renewed the full approved execution roadmap after a usage-limit interruption.
Existing working changes, branch `codex/e2e-docs-scripts`, frozen planning documents and
the execution roadmap are preserved. This paragraph records the earlier resumption checkpoint.
The prior Fast OFF request was withdrawn. Current model/service-tier UI values cannot be
verified through the tools available in this session; no private API or session file was used.

## Resumed defects and changes

| Severity / priority | Evidence and user impact | Current correction / validation |
|---|---|---|
| High / P0 | `safety-journal.cjs` RESTORE_BEGIN saved high-water but not the complete incoming obligation set. Interruption before/between rows followed by a different restore could omit liabilities and later permit AI activation. | Input commitment, durable row progress and exact-input resume implemented. New 101-case run passed; independent review closed the counterexample. Subsequent key-ownership fix passed 106 journal cases and 3 real-module integration cases. Historical 72 passing tests did not cover this counterexample. |
| High / P0 | `FinalizeStep` did not lock/recheck RUNNING job ownership before publishing. Concurrent cancellation could publish a new source and end as CANCELLED. | Project→job→snapshot locking; scoped generation checks; current pointer, FINALIZE checkpoint and terminal DONE in one transaction. Actual DB regressions passed in the 747-case run below. |
| High / P1 | A missing/deleted retained manifest made `LocalSnapshotStore.read` return empty and invoke legacy Git fallback. | Immutable `snapshots.source_contract_version`; missing retained data fails with 410. Standalone manifest deletion is rejected; parent project/snapshot cascades remain supported. |
| Medium / P1 | `source_blobs` metadata could be updated despite sealed references, breaking retained reads and future dedup imports. | UPDATE and referenced DELETE rejected by V23 triggers, including DELETE→INSERT replacement in one transaction. Real SQL regression passed in the full run below. |
| Medium / P1 | A publisher error after final publication could overwrite a DONE checkpoint with FAILED. | Step DONE/FAILED transitions require RUNNING. A real worker with an injected post-commit notification failure passed in the 747-case run below. |
| Medium / P1 | Immediate blob foreign-key checking depended on project cascade trigger order; real project deletion failed. | Deferred FK checks the completed transaction; immediate blob deletion guard still prevents metadata replacement. Real project deletion/unchanged original source regression passed. |
| Medium / P1 | The journal copied caller-owned MAC key bytes but cleared only its second copy. | Ownership contract corrected; both copies cleared on success and failure. Independent real-module reproduction changed from two residual key buffers to zero while retaining the keyring original. |
| Medium / P1 | New capture/read coupling introduced an `analysis.core→project→analysis.core` dependency cycle. | Snapshot reading extracted into `RetainedSnapshotReader`. All three architecture rules passed in the focused run. |
| High / P1 | Legacy AI context read the live working file after resolving a historical snapshot. Preview/normal retrieval could send B as snapshot A, and missing Git source silently fell back to live bytes. | Three real Git/PostgreSQL regressions failed before correction (14 other cases passed). Legacy context now uses `SnapshotBlobReader` with owner-scoped inventory OID/size and DB clone path; live file readers removed. All 17 cases passed after correction. |
| High / P1 | Retained IMPORT DONE retry required the removed shared clone; a durable capture before IMPORT DONE reopened the missing original folder. | Public `JobService.retry` plus the real worker reproduced both failures. Retained metadata is checked before enqueue; the worker verifies/reconstructs exact blobs, and IMPORT reentry preserves published input/diagnostics. Both corrected cases passed in the 34-case retained run. |
| Medium / P1 | Import diagnostics could fail after source metadata and job attachment had already committed. | A spy that writes real evidence then fails reproduced partial publication. Diagnostics now join the capture transaction; metadata, evidence and job attachment roll back together. Regression passed. |
| High / P1 | A same-JVM workspace contender opened and closed the owner's lock file. On this Mac/JDK21, this released the actual OS lock while the original `FileLock.isValid()` stayed true, allowing another process to acquire it. | Generic probe and two actual workspace subprocess regressions reproduced it. JVM identity reservation now precedes opening a channel, alongside the real OS lock. All 80 workspace cases passed, including the actual case-alias case with no skip. |
| High / P1 | `ContextRetrievalService.retrieveWithExclusions` generated/embedded source summaries before filtering. An excluded source became a generated summary, and an excluded cached summary reappeared as a related summary. | Three real PostgreSQL/Git regressions failed before correction. Nonempty exclusions now use local-only assembly; missing/changed IDs abort with 409 `AI_CONTEXT_CHANGED` before provider calls or writes. Empty-exclusion behavior remains separate. |
| High / P1 | `AiPanel.copyPrompt` copied the original full prompt after the user unchecked SOURCE. The preview endpoint ignored `excludedContextIds`. | API and UI regressions reproduced it. Preview and ask share the local filter; copying an excluded selection revalidates the original preview request locally, and a failure leaves the clipboard unchanged. |
| Medium / P1 | A fresh UI preview retained invisible obsolete exclusion IDs, causing repeated conflicts and incorrect selected counts. | A stale selection now starts with every new context item excluded and asks the user to choose included items. The UI regression verifies only current IDs are sent. |

V23 is additive. Legacy source/notes/tasks keep their IDs and content; no source is inferred
from a changed folder. The new source store remains opt-in via a private main-owned socket;
production desktop main is not yet wired. Transitional encrypted blobs alongside plaintext
clones do not constitute encryption at rest. Per-job scratch reconstruction now has synthetic
integration coverage; native isolation,
pin/grace/GC, format3 recovery, strict provider-wide cost/egress enforcement and operational
acceptance remain open. Purpose-separated backup/safety keyring development is proceeding
with synthetic wrapping only, not the user's OS vault.

## Current verification

The first focused 56-case DB run had 55 passes and one real cascade-order failure. After
the FK correction the same 56 cases passed. The subsequent full backend run contained
747 tests: 746 passed and only the architecture cycle rule failed; 22 retained-source
integration cases passed, including the new blob DELETE→INSERT and project cascade tests.
That failed build did not reach `snapshotSourceTest`. Logs/XML are preserved under
`/tmp/ci-t02-full-2026-10-03-first-*` and `/tmp/ci-t02-integration-2026-10-03-*`.
The read/capture separation, retained AI preview tests and run-workspace integration are
later edits; none inherits the earlier passing result. A focused run passed 154 cases
(architecture 3, AI context 17, jobs 11, local approval 22, draft workspace 71, retained 30).
It is saved under `/tmp/ci-workspace-focused-first-2026-10-03*`; the workspace author edited
that primitive during the run, so it is explicitly not final primitive validation.
The legacy context counterexample has its own before-fix evidence:
`/tmp/ci-ai-source-context-red-2026-10-03.log` and `.xml` (17 cases, 3 failures).
Four further retained integration cases then brought that class to 34. The before-fix
run had three failures and 31 passes (alongside 74 passing workspace cases); the corrected
retained-only run passed 34/34. Evidence: `/tmp/ci-retained-retry-red-2026-10-03*` and
`/tmp/ci-retained-retry-green-first-2026-10-03.*`. This now exercises the public retry service
and worker with synthetic keys/data, including the capture/checkpoint gap. A later import
attempt still conservatively blocks an older completed import even when that later attempt
failed; producer rule/config/dependency fingerprints and whole T02 acceptance remain open.
The OS lock counterexample is separately preserved in `/tmp/ci-filelock-probe-2026-10-03.log`
and `/tmp/ci-workspace-lock-red-2026-10-03.log`/`.xml` (2/2 failed before correction).

Vault/broker root run passed 61 cases in `/tmp/ci-t02-vault-broker-2026-10-03.*` before a
later identifier-terminator hardening review. Purpose keyring author tests passed 79 cases;
journal/keyring author tests passed 106+3 distinct cases. Independent review checked
hashes/XML and reran the two-module key-cleanup reproduction; it did not independently
rerun the whole suites. The combined root run then passed **188/188** (106 journal +
79 purpose keyring + 3 real-module integration), with failure/error/skip/cancel zero:
`/tmp/ci-safety-keyring-root-2026-10-03.log` and `.xml`. Synthetic keys and disposable
storage are used throughout. Historical E2 results remain separate.

At that checkpoint, the complete desktop Node run passed **388/388**, including the 84-case encrypted
opaque backup-container primitive: `/tmp/ci-desktop-root-2026-10-03.log`/`.xml`. The archive
also received a separate five-case synthetic probe review; it does not yet export/scrub DB
credentials, restore product state, or integrate with main/real secure storage. Explicit
identifier matching is defense/coverage work, not a reproduced regex bug. The later complete
backend/frontend/source-browser results are recorded below.

## Latest candidate and audit boundaries

The next full backend attempt ran **845 tests: 842 passed, 3 failed**. The workspace 80 and
retained-source 37 cases all passed, with no skips. Two old AI API fixtures supplied fake Git
hashes instead of stored objects; one local-import mock retained the previous job's snapshot
after switching job IDs. These fixtures now create actual Git blobs/commits and read the
snapshot attachment from the current database job. Production source guards were not weakened.
Evidence: `/tmp/ci-continuation-backend-full-first-2026-10-03-xml/` and its `-summary.json`.
The failed build did not run `snapshotSourceTest`.

AI exclusion evidence is separate: `/tmp/ci-ai-exclusion-red-2026-10-03.xml` has 3/3 failures;
`/tmp/ci-ai-exclusion-copy-red-2026-10-03.xml` has 2 failures plus 2 passing ask/SSE cases.
After correction the focused backend run passed **38/38** (preview unit 6, provider-guarded
local retrieval 20, HTTP exclusion 8, local ingest 4). All three public endpoints—preview,
ask, and SSE ask—return a safe 409 for unknown exclusions. UI **9/9** passed after completing
its path/file/graph fixture responses; the first UI run had the three new regressions plus
an unrelated pre-existing route-fixture dependency, and two intermediate runs exposed
missing mock endpoints. No assertion was relaxed to hide a product failure.
Evidence: `/tmp/ci-ai-exclusion-green-second-2026-10-03-xml/` and
`/tmp/ci-ai-exclusion-ui-green-third-2026-10-03.log`.

This binds **excluded IDs**, not the complete preview/request identity. A new cached block,
changed included context, and empty-exclusion helper requests still need the planned immutable
request plan and provider-wide gateway. Context-item exclusion is not a promise to erase the
same words from an independently included note/summary or from the user's own question.
The independent review also noted pre-existing loss of NODE file-reference metadata when
filtering; its text remained included. The subsequent reference correction and its new verification
are recorded below; that metadata issue was not a source leak.

The [T09 export design](t09-export-design-2026-10-03.md) inventories 48 current application
tables and 388 columns from V1–V23. It is a read-only design, not an exporter acceptance result.
The current main backup still exports unrestricted DB/Git data and restores SQL into the normal
database. A credential-free encrypted format3 pipeline requires explicit schema projection,
isolated staging, durable OFF/reconnect behavior, and safety-ledger reconciliation. Deleting AI
key rows alone is insufficient because environment-key fallback remains. Product choices about
all-owner preservation, legacy/GitHub source coverage, and historical retry are recorded there;
no new DB format or destructive migration was silently installed.

## Completed full gate for the AI/workspace candidate

`spotlessApply spotlessCheck build snapshotSourceTest` completed successfully in one serialized
root invocation. Whole backend: **852/852, 92 suites**; separate real backend/DB/headless source
contract: **12/12**, failure/error/skip zero in both. Frontend `tsc -b` and Vite production build
ran as part of that command. Separate frontend lint passed and **152/152 tests, 27 files** passed.
The 704 captured backend/desktop/frontend/analyzer source hashes remained unchanged during
the final gate. Relevant logs and copied XML:

- `/tmp/ci-continuation-backend-full-final-2026-10-03.log`
- `/tmp/ci-continuation-backend-full-final-2026-10-03-summary.json` and `-xml/`
- `/tmp/ci-frontend-lint-final-2026-10-03.log`
- `/tmp/ci-frontend-test-final-2026-10-03.log`
- `/tmp/ci-continuation-final-gate-sources-2026-10-03.json`

`./accuracy-gate` also passed **7/7** with the actual isolated local TypeScript analyzer and
temporary PostgreSQL pipeline. Its spring/react/fullstack fixtures are reviewed development
examples, not independent real-repository or blind-holdout accuracy acceptance.
Artifacts: `/tmp/ci-accuracy-final-2026-10-03.log`, `-summary.json`, and `-xml/`.
Gradle emitted recurring local connection-handshake warnings, and the frontend build reported
large bundles; exit status and XML show successful completion, not absence of warnings.

Preservation comparison: all 743 original S1 baseline files, 797 E3 baseline files, and 849
pre-gate files still exist. The original 20 planning files and frozen execution roadmap match
their baseline hashes. New later policy modules have their own verification; these counts do
not certify code added after this gate.

Whole-product release remains **No-Go**. No installed application, real userData, credential,
GUI/browser/audio session, paid provider, public deployment, commit, push or PR is used.

## Subsequent T09 pure export-policy gate

The schema/row-projection primitive is implemented and frozen. It validates 23 migration hashes,
48 application tables and all 388 columns; rejects unknown schema; selects no designated credential,
path or approval columns; preserves allowed note/task text, exact bigint/numeric strings and typed
nullable values. OFF/reconnect and historical-job annotations are data, not runtime enforcement.
There is no database/file I/O or Electron/main connection in this module.

Author tests passed 68/68. Root's later complete desktop candidate passed **456/456**, with zero
failure/error/skip/cancel, in `/tmp/ci-desktop-final-2026-10-03.log`/`.xml`. Root also ran the final
cached-image, network-disabled temporary PostgreSQL catalog probe: **8/8 PASS** (baseline plus seven
real DDL mutations), `/tmp/ci-backup-export-catalog-final-2026-10-03.log`. It executes bundled SQL via
psql and checks column/type/nullability/generation, not full Flyway/default/constraint/function/grant
authority. The source and unit guards now compare all top-level SQL filenames before DB access.

Independent review passed 21 synthetic probe groups with 904 explicit rejection assertions and
checked the author/root artifacts separately. The non-versioned SQL inventory gap was corrected and
verified; no unresolved C/H/M finding remains within the reviewed primitive. See
`/tmp/ci-backup-export-policy-independent-review-2026-10-03.md`/`.json` and
[the contract](backup-export-policy-contract-2026-10-03.md). Product backup/restore remains **No-Go**:
trusted owner/catalog scope, precision-safe PG codecs, writer drain, source pin/coverage, actual
payload/staging loader, durable OFF and safety-state merge are still integration gates.

## Subsequent structured source-reference correction and final gate

A real PostgreSQL regression run reproduced four reference errors: excluding an unrelated VIEW
dropped the included focus NODE's reference; a budget-rejected SOURCE or NODE still contributed a
reference; arbitrary note text matching `file:path:line` became a structured reference only after
filtering. The pre-fix class ran **25 tests, 4 failures**. Evidence:
`/tmp/ci-ai-reference-red-2026-10-03.log`/`.xml`. Severity **Medium / P2** for incorrect provenance;
the original NODE-reference loss alone was a lower-impact metadata issue.

`ContextBlock` now owns an immutable reference list. SOURCE and focus NODE producers attach refs
when their blocks are admitted to the budget; normal and filtered assembly both collect refs only
from included blocks. Filtering does not interpret user-authored prose as source provenance.
The public preview DTO and provider-dispatch behavior are unchanged. Five new real-DB tests include
Unicode/space/colon paths, misleading node-name text, excluding a NODE while retaining the SOURCE,
both budget cases and a quoted note reference. Provider calls and usage writes remain zero.
NODE refs identify the snapshot's scoped file/line metadata; they do not by themselves certify that
the node's source bytes were read or are currently available. This correction does not upgrade that
existing metadata contract into content verification or a full approved RequestPlan.

Focused formatter/check and tests passed **43/43** (25 local retrieval, 6 preview unit, 8 HTTP
exclusion, 4 assistant exclusion): `/tmp/ci-ai-reference-green-2026-10-03.log`, `-summary.json`, `-xml/`.
After freezing this candidate, root ran `spotlessCheck build snapshotSourceTest`: backend
**857/857, 92 suites**, separate real backend/DB/headless source **12/12**, failure/error/skip zero.
The command exited 0 in 2m54s. TypeScript/Vite production build ran in the same command; previous
frontend 152 and desktop 456 test candidates remain unchanged. Gradle local handshake/deprecation
warnings and Vite bundle warnings remain nonfatal observations, not release acceptance.

Final artifacts: `/tmp/ci-continuation-backend-post-reference-2026-10-03.log`, `-summary.json`, `-xml/`.
`/tmp/ci-continuation-post-reference-gate-sources-2026-10-03.json` captures **707 files**: previous
704 candidates plus export policy source/test and the executable catalog probe. Only the retrieval
source and its integration test changed after the previous backend gate; both were revalidated.
All 707 hashes remained unchanged during and after the final gate. All baseline files remain;
the original 20 planning files, frozen roadmap and original main V1–V20 migrations retain their SHA.

The safe scope does not include enabling main's new source/safety/backup modules. Current history
still opens a shared Git clone, IDE open depends on the original local path, and legacy backup copies
the repo directory. Their joint migration, source/key pinning and full RequestPlan/egress binding
remain explicit integration work. No live-account, native signed-app or release acceptance was run.

Independent read review found no additional unresolved C/H/M defect within this correction. It
directly counted the pre-fix 25/4-failed XML, the 43/43 focused XML, and the final 857+12 XML, and
matched source/test hashes to the frozen manifest; it did not rerun those tests. Four of the five new
cases fail before the correction; the NODE-excluded/SOURCE-kept case is a passing control. Evidence:
`/tmp/ci-ai-reference-read-review-2026-10-03.md` and `.json`. Native UI link navigation and the full
RequestPlan/main/backup contracts remain outside this review.
