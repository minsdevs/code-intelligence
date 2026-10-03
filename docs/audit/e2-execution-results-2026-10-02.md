# E2 approval and local AI preview — verified checkpoint

2026-10-02 UTC. This is a checkpoint in continuing implementation, not the end of the approved
roadmap. The preceding E3 report remains historical evidence. Production release remains **No-Go**.

## Implemented behavior

Local import and refresh now require an explicit bounded preview and one-use server approval.
The private binding includes owner/purpose/project/base snapshot, canonical root identity, effective
policy limits and a framed SHA-256 manifest of actual selected bytes. The DB stores only the token
hash. Consumption, project/job creation and immutable job receipt commit before worker dispatch.
Unconsumed approvals expire after ten minutes; the consumed receipt remains valid for that same job.

The worker compares the approved input with actual staged files, including unexpected ignored/empty
entries, before repository replacement. Policy/source failures persist `LOCAL_PREVIEW_REQUIRED` and
require a new preview. Null-baseline initial failures recover through the existing project. Relinking
shares the project writer lock and rejects an active analysis. Old counts-only requests are rejected.

Confirmation is never automatically resent. An uncertain response uses the same token's atomic
outcome operation: return the existing owned job, or revoke the unused token before allowing a new
preview. Thirty-second response deadlines prevent stalled HTTP bodies from stranding this recovery.
Late responses cannot restart a settled flow. Tokens remain in component memory.

AI preview now uses bounded local context and matching existing summaries without generating
summaries or embeddings. The follow-up task-goal query and graph context enforce project/snapshot
scope. Preview and normal ask need not contain identical context; this does not complete strict costs.

## Findings and disposition

| Severity / priority | Evidence | User impact | Disposition |
|---|---|---|---|
| High / P1 | Previous ProjectService count confirmation + ImportStep live-folder copy; equal-count/equal-size byte changes and queue changes are regression cases | Analysis could differ from what the user confirmed | E2 manifest, immutable job receipt and actual staging verification implemented |
| High / P1 | AiPreviewService → shared retrieval → SummaryService; real PostgreSQL/provider-spy tests | A nominally local preview could call paid chat/embed and write summaries | Separate local retrieval; zero-call/zero-write regressions pass |
| High / P1 | ContextRetrievalService task goals queried a task ID without project predicate | Foreign project goals could enter AI context | Owning task join and project predicate; graph snapshot joins tightened |
| Medium / P2 | Preview cleanup locked approval before project while refresh consumed project before approval | Concurrent requests could deadlock instead of returning a controlled conflict | Project-first ordering and quota `FOR NO KEY UPDATE` fixed |
| Medium / P2 | Approved unsafe `.gitignore` raised generic LocalImportException | UI offered generic retry for changed input | Safe structured recovery code; real worker persistence/retry regression |
| Medium / P2 | LocalSourceApproval awaited confirmation and outcome without deadlines | A stalled response blocked recovery indefinitely | Bounded waits, lookup-only retry and late-response tests |
| Medium / P2 | Source-status computed `total()` was not explicitly serialized | Compact changed-file count could be absent | JSON property plus real HTTP assertion |

Production evidence is in `project/LocalSourceApprovalService`, `LocalImportService`,
`LocalStagingVerifier`, `ProjectService`, `ImportStep`, V22, `job/JobWorker`, and the frontend
`LocalSourceApproval`/API flow. The detailed contract is [E2](e2-approval-contract-2026-10-02.md).
Independent scoped final review: **Critical0 / High0 / Medium0**. This excludes the documented
native-confinement, immutable-store and crash-atomicity work, which remains open.

## Executed verification

| Gate | Result | Evidence |
|---|---|---|
| Offline backend formatter/check/build | PASS647 tests,89 suites; failure/error/skip0 | `/tmp/ci-e2-backend-final.log`, `/tmp/ci-e2-test-final-summary.json`, `/tmp/ci-e2-final-xml/test/` |
| Real backend + temporary PostgreSQL + headless UI | PASS12/12, Java/TypeScript ×6 scenarios | Same final command; `/tmp/ci-e2-snapshotSourceTest-final-summary.json`, `/tmp/ci-e2-final-xml/snapshotSourceTest/` |
| Frontend lint/typecheck/unit | PASS149 tests,27 files; no failure/skip | `/tmp/ci-e2-frontend-final.log`, `/tmp/ci-e2-frontend-final.json` |
| Frontend production build | PASS, invoked by source gate | Backend final log; existing bundle-size/output-name warnings remain |
| Actual approval DB/HTTP focused run | PASS25 before additional restart test | `/tmp/ci-e2-approval-db-summary.json`; all final cases included in647 |
| Low-level approval + AI focused run | PASS63 | `/tmp/ci-e2-focused-summary.json`; included in647 |
| Additional quota regression | PASS22 approval DB cases, including one added after the full build | `/tmp/ci-e2-quota-final.log`, `/tmp/ci-e2-quota-final.xml`;21 overlap the647, not an extra22 |

The DB tests force both token-lock commit orderings and expiry while waiting, verify no dispatch
before commit, rollback/replay/owner/purpose/base/root changes, receipt immutability and cleanup.
The restart test invokes actual startup recovery, same-job retry, import, inventory and finalization.
This is **simulated restart recovery**, not a separate OS/backend process restart. Preview expiry is
SQL-forced; a separate historical receipt tests an approval older than ten minutes.

The first source run had8 passes/4 failures because independent scenarios shared one fixture user
and exceeded the new16 previews/10-minute limit. The fixture now isolates transient preview grants
between scenarios while retaining immutable receipts. Product quotas were not relaxed. All12 then
passed in one full command. One initial compile encountered a test-only package-private shutdown
method; reflection in the test fixes cleanup without expanding the production API.

No paid provider, GitHub operational OAuth, installed app, userData, GUI browser, native signing,
notarization, external upload, publication, commit or push was used. Existing Gradle handshake
warnings were nonfatal; final process exit and JUnit artifacts establish success.

## Remaining release blockers and ongoing work

T02 durable encrypted source/manifests/generations, temporary analysis workspaces and pin/grace/GC
remain under implementation. T03 signed native isolation, T07 operational GitHub flow, T08 strict
reservation/dispatch/journal/restore, T09 credential-free backup and signed packaging still need
their full gates. Public corpus accuracy, clean-Mac installation and independent user acceptance
cannot be inferred from these regression counts. All16 roadmap tasks remain incomplete against
their whole-task acceptance. Current next work is [T02 source generation](t02-source-generation-contract-2026-10-02.md)
and the purpose-separated safety journal, using synthetic keys/providers without touching live data.
