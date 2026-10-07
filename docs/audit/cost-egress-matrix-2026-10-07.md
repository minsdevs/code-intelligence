# G-COST cost-egress matrix (C13) — 2026-10-07

Scope: release gate **G-COST** — AI cost ledger, safety journal, dispatch permit, AI OFF
latch and egress safety, across every AI entry point, with a fake provider only. No paid
call, real account, real Keychain or real profile was used. The restore crash states of
C16 belong to `gate-recovery` and are cited, not repeated. Overall release stays
**NO_GO**; this report gives row facts, not a gate verdict.

Base `bcd8081` (candidate **1lvULq** source, docs-only difference). Branch
`worktree-agent-af7be1bbb66cbe34a`. Machine-readable record:
[cost-egress-matrix-2026-10-07.json](cost-egress-matrix-2026-10-07.json).

## What was built

| Piece | File | Level |
| --- | --- | --- |
| Full-stack harness | `backend/src/test/java/dev/codeintelligence/ai/CostEgressHarness.java` | Spring HTTP/CSRF → RequestPlan → Java `AiCostLedger` on Testcontainers PostgreSQL → private UDS → real Node main (lifecycle, keyring, journal, `ai-desktop-gateway`, `ai-egress`, psql adapter, production catalog) → call-counting fake provider |
| Fake provider + seams | `desktop/test/fixtures/ai-cost-egress-runtime.cjs` | Records every invocation with PG status, journal intent and sequence at send time. Seams: the core's documented `clock` option (wall offset), the journal's existing `fault` hook, a catalog wrapper (stale / changed price). Everything else unmodified |
| C13 matrix | `AiCostEgressMatrixIntegrationTest` (29), `…FirstRun…`, `…Overbill…`, `…JournalIntentFailure…`, `…JournalSettlementFailure…`, `…SettlementProjectionFailure…`, `…Privacy…` | Terminal fault states get their own context, PostgreSQL, installation and main process |
| Backend guard | `AiProviderEgressArchitectureTest` (ArchUnit + source scan) | Outbound HTTP client inventory; provider constructors only in the factory; `chat/stream/embed/testConnection` only via guarded callers; desktop factory never touches `RestClient`; provider hosts only in `AiProperties`/`application.yml` |
| Desktop/renderer guard | `desktop/test/ai-egress-boundary.test.cjs` | Network-module inventory of `desktop/src`; no fetch/WebSocket/Electron net/curl; provider hosts only in the endpoint table and transport; transport composed only by the gateway; exactly one send site, after reserve→intent→DISPATCHED→permit→barrier with no await; no AI IPC channel; renderer fetches only same-origin API. A mutation probe (new module with `https`+`fetch`+provider host) failed 3 rules as intended |
| Packaged probe | `validation/pre-release/cost-egress-packaged-probe.cjs` | See packaged row below |

Every full-stack case asserts: integer microUSD in PG, journal and budget API
(reserved 22,472 = ceil((128000×0.15+2048×0.60)×1.10); actual 42), journal/PG
agreement row by row and in sum, provider call count, `ledgerStatusAtSend=DISPATCHED`
and `journalIntentAtSend=true` for every call, and no request UUID sent twice
(checked over all 30+ calls of the matrix context).

## Entry-point inventory

| Entry point | Reachable in desktop product | Gate / disabling mechanism | Evidence |
| --- | --- | --- | --- |
| Ask / ask-stream (`AssistantController`) | Yes | One-use RequestPlan (preview) → main QUOTE → Java row-locked reserve → APPROVE → journal RESERVED+DISPATCH_INTENT → one-use permit → single send → journal-then-PG settlement | C13-01…35 |
| Request plan / preview | Yes | Preview is local; plan QUOTE refused while AI OFF, catalog stale/unknown, model unsupported | C13-20, 23–27, 34–35 |
| What-if, PR review, playground ask | Routes yes, sending no | `AiUsageService.requireRequestPlan()` always throws; desktop provider is metadata-only and throws on every network method | C13-34/35 (503 before key, 409 after), `AiProviderEgressArchitectureTest` |
| Embedding (semantic search, summaries) | No | Desktop `embed()` throws; production catalog has no EMBEDDING contract; HTTPS transport accepts only `/v1/chat/completions` | C13-24, architecture + boundary guards |
| Summary, explanation, why, alternatives, architecture, area analysis | No provider | Deterministic local services; no `AIProvider` dependency | Source inventory (no provider type in these classes) |
| Task drafts, notes | No provider | Local; only `SecretMask` on stored text | Source inventory |
| Key save / validation (`PUT /api/ai/settings`) | Yes | Desktop skips the connection probe; main latched OFF on save | C13-35, packaged probe |
| Model listing | Yes | Static list in desktop, no network | `AiSettingsService.models` |
| Budget configure/activate | Yes | Configure latches; activation needs a one-use token bound to journal position, nonzero limits, ENABLED settings | C13-34/35, existing `budgetActivation…` |
| Retry | Yes (user) | Consumed plan → 409; retry needs a new plan/UUID/reservation; frontend `ask` disables CSRF auto-retry | C13-03…13, `api/ai.test.ts` |
| Background/automatic jobs | None | No `@Scheduled`/`@Async`/listener calls a provider | Source inventory |
| Browser-development backend (no main) | Not in the packaged product | `AiSafetyPolicy` blocks any desktop-configured backend without main; OpenAI/Gemini `RestClient` providers are reachable only in non-desktop mode | `AiProviderEgressArchitectureTest`, existing `AiSafetyPolicyTest` |
| Desktop main | Only `ai-https-transport` | Fixed `https://api.openai.com/v1/chat/completions`, DNS answers must all be public, no redirect/retry/proxy | `ai-egress-boundary`, `ai-https-transport` tests |
| Renderer / IPC | No AI channel | Preload exposes 11 fixed members; IPC channels have no AI operation | `ai-egress-boundary` |

## Results

| Run | Result |
| --- | --- |
| New full-stack classes (7) | **35 cases PASS**, 0 fail (matrix 29 incl. 10+2+5 parameterized) |
| Backend affected set: `ai.*`, `evidence.*`, `export.*`, `note.*`, `task.*`, `backup.*`, `ArchitectureTest` + `spotlessCheck` | **528/528 PASS**, 38 suites, 0 skip |
| Desktop affected: `ai-*.test.cjs`, `safety-journal`, `safety-lifecycle`, `main-runtime-gateway`, `backup-cost-*` | **913 PASS / 0 FAIL / 2 SKIP** (915); skips are the opt-in real-PG cases, run below |
| `verify-ai-egress-postgres.cjs` (real psql, disposable PG) | 1st run **FAIL** 44/45 (verifier lacked TLS; record kept). After the verifier fix: **59/59 PASS** |
| Baseline `AiDesktopCostFlowIntegrationTest` before any change | 12/12 PASS |
| **Final rerun on `5c47f3b`** (Gradle `--offline`): `SecretMaskTest`, `AiProviderEgressArchitectureTest`, `AiCostEgress*` (7 classes) | **43/43 PASS**, 9 suites, 0 fail, 0 skip (`final-targeted-20261007.log`, `final-targeted-xml/`) |
| **Final rerun** `desktop/test/ai-egress-boundary.test.cjs` | **7/7 PASS** (`final-boundary-20261007.log`) |
| Packaged probe on 1lvULq (native lock) | runs 1–3 stopped before launch (harness; records kept), run 4 **PASS** — see below |

Authoring iterations of the new tests are kept as records, not hidden: `matrix-run1.log`
(28/29), `matrix-run2.log` (33/34, FirstRun assertion), `firstrun-run1/2.log`,
`arch-run1/2.log` (3/4) failed while the tests were being written; `privacy-run1.log` and
`red-db-uri-2026-10-07/` are the D1 red runs on unchanged product code. All final reruns
above are green.

### C13 matrix

New full-stack cases (all **PASS** on HEAD):

| ID | Case | Calls | Money result |
| --- | --- | --- | --- |
| C13-01 | Settle once after durable intent; replay refused | 1 | SETTLED 42, held +0, daily +42 |
| C13-02 | Two concurrent asks, budget fits one | 1 | winner SETTLED 42; loser 429, no row |
| C13-03 | Timeout **before** send (body never received) | 1 attempt, 0 received | UNKNOWN_HELD 22,472 |
| C13-04 | Timeout **after** send | 1 | UNKNOWN_HELD 22,472 |
| C13-05/06 | HTTP 500 / 429 | 1 | UNKNOWN_HELD 22,472 |
| C13-07…12 | Usage missing, cached detail missing, reasoning tokens (unbounded dimension), total mismatch, malformed body, wrong model | 1 each | UNKNOWN_HELD 22,472; reactivation keeps it |
| C13-13 | User retry after unknown outcome | 2 (distinct UUIDs) | 22,472 held + 42 settled |
| C13-14 | Reconciliation ×2 with an outstanding hold | 1 | liability unchanged, no budget minted |
| C13-15 | DB failure before reserve | 0 | no row (HTTP 500, see D2) |
| C13-16 | DB failure publishing DISPATCHED after intent | 0 | UNKNOWN_HELD 22,472 |
| C13-17 | DB failure writing usage evidence | 1 | UNKNOWN_HELD 22,472, no answer |
| C13-18 | PG clock high-water ahead of wall clock | 0 | no row, budget unchanged |
| C13-19 | Main wall clock regresses after reserve | 0 | UNKNOWN_HELD 22,472, latched |
| C13-20 | Catalog older than 30 days | 0 | no quote, no row |
| C13-21/22 | Catalog stale / price changed between approval and send | 0 | UNKNOWN_HELD 22,472 (no proof of non-send) |
| C13-23…27 | Unknown model, EMBEDDING, unpriced body field, caller endpoint field, no output cap | 0 | no quote, no row |
| C13-28 | Second APPROVE/EXECUTE/QUOTE for a settled UUID | 0 extra | unchanged |
| C13-29 | EXECUTE without approval; approved but no PG reservation | 0 | no row, no journal entry, latched |
| C13-30 | Provider over-bills (16,384 output tokens) | 1 | SETTLED 29,031 > 22,472 recorded, RECOVERY_REQUIRED, activation refused |
| C13-31 | Journal DISPATCH_INTENT fsync fault | 0 | UNKNOWN_HELD 22,472; process fails closed |
| C13-32 | Journal SETTLED append fault after response | 1 | 22,472 held, no answer, no re-send |
| C13-33 | PG SETTLED projection fails after journal settlement | 1 | PG held 22,472 until reconciliation; reconciliation projected the journal's proven SETTLED 42 (proof equal), activation 200 |
| C13-34 | First run: AI OFF, budget 0 | 0 | ask/what-if/review/playground 503 |
| C13-35 | Key saved, budget 0 | 0 | no token, fabricated activation 409, plan 503, routes 409 |

Mapped existing cases (cited assertions read and run today, **PASS**):

| ID | Case | Test |
| --- | --- | --- |
| C13-36…43 | Third concurrent request busy; same approval twice; OFF during flight; policy change; exhausted budget; answer persistence failure; auth/CSRF; one-use activation | `AiDesktopCostFlowIntegrationTest` (12/12, full stack) |
| C13-44 | Outstanding hold across UTC day/month reset | `AiCostLedgerIntegrationTest.allOldHeldStillConsumesTodaysAndThisMonthsBudget`, `yesterdaysSettlement…`; `ai-egress.test.cjs` "day/month rollover never removes prior unknown liability" |
| C13-45 | Clock regression grants no budget / old-day approval | ledger `clockRegressionDoesNotGrantNewBudget`, `aPreviousUtcDaysApprovalCannotDispatchAfterMidnight` |
| C13-46 | Embedding reservation/settlement arithmetic | `ai-egress.test.cjs` "embedding contract and fixed Gemini endpoint…", ledger `embeddingRequiresEmbeddingUsage…` |
| C13-47 | 1.10 factor single ceil; settlement without factor | `ai-egress.test.cjs` "reservation uses one final integer ceil…" |
| C13-48 | 30-day catalog boundary | `ai-egress.test.cjs` "catalog boundary has no usable quote at the 30-day deadline…" |
| C13-49 | Restart never re-sends | `ai-egress.test.cjs` "settlement survives … restart", "restart imports a committed reservation … never sends it" |
| C13-50 | Restore budget: union, larger liability on UUID collision | `ai-egress.test.cjs` "restore union…", "restore UUID collision…"; ledger union tests; native 173/202 in `pre-release-cost-recovery-2026-10-05.md` (crash states: gate-recovery) |
| C13-51 | Hold released only with proof | ledger `provenNotSentRequiresMainEvidenceAndZeroCost`; core emits no PROVEN_NOT_SENT |
| C13-52 | Row-locked reserve, max 2 | ledger `twoParallelReservationsCannotBothSpend…`, `onlyTwoConcurrentRequestsMayBeReserved` |

Module/ledger rows 44–52 are not full-stack runs; their level is stated, not upgraded.

### Privacy and egress

| ID | Check | Result |
| --- | --- | --- |
| P-01 | Auth header, PEM block and fragment, `sk-` key, `token=` in question: absent from provider body and preview | PASS |
| P-02 | DB URI password (`postgresql://user:pw@host`) | **FAIL on candidate 1lvULq source** (sent to provider and shown unmasked in preview); fixed in `3c9ec31`, **PASS on HEAD**. Candidate not rebuilt |
| P-03 | Forbidden sentinels in any persisted text/json column | PASS (0) |
| P-04 | Forbidden sentinels in captured backend output and main stderr | PASS (0) |
| P-05 | Prompt-injection lure to an unselected repo file and a file outside the repo | PASS (neither sent) |
| P-06 | Injection text inside the approved span | Sent as data (observed, expected) |
| P-07 | Dummy personal data inside the approved span | **FAIL against the fixture list**: sent unredacted (shown in preview); not persisted or logged. Needs a product decision (D4) |
| E-01 | Every provider invocation: fixed origin/path, POST, redirects 0, retries 0, fixed headers | PASS (all matrix calls) |
| E-02 | Redirect 3xx, userinfo, HTTP, alternate hosts, private/loopback/link-local/mapped/CGNAT DNS, proxy env | PASS (`ai-https-transport.test.cjs`, injected DNS/HTTPS; no real network) |
| E-03 | Alternative base URL | Desktop never builds a base-URL provider (architecture test); browser-mode allowlist in `AiProperties` |

### Packaged app

Probe `validation/pre-release/cost-egress-packaged-probe.cjs` (SHA-256 `e502f9e7…b48c9`,
committed in `5c47f3b`) against the unmodified retained candidate
`.native-product-1lvULq` (build sequence 1791292686000, `app.asar` `fe08c457…80acc`,
codesign verified, runtime manifest validated), fresh isolated profile under
`/private/tmp`, `--use-mock-keychain`, no real account, AI never activated.

| Run | Result |
| --- | --- |
| 1 (`packaged-probe-run1.log`) | `OWNED_OUTPUT_REFUSED` before launch: evidence parent was the 0755 `validation/local/cost-egress`; the probe now uses its own 0700 family |
| 2 (`packaged-probe-run2.log`) | Stopped while waiting for the native lock (previous session ended); never launched |
| 3 (`packaged-probe-run3.log`, empty `cost-egress-packaged/probe-AfmQDq/`) | `ISOLATED_RUN_INVALID` before launch: from this worktree `<repo>/.nr` exceeds the 100-byte private-socket budget. Fixed in `5c47f3b` (short `/private/tmp/cicp-*` parent, as `run-integrity-diagnostic.cjs`) |
| 4 (`packaged-probe-run4.log`, `cost-egress-packaged/probe-SdlUNk/result.json`) | **PASS**, 0 failures, cleanup confirmed (shutdown COMPLETE, exit 0), bundle unchanged, profile removed |

Run 4 checks:

| ID | Check | Result |
| --- | --- | --- |
| PK-01 | Packaged `ai-desktop-gateway`, `ai-egress*`, `ai-https-transport`, `ai-model-contracts`, `main`, `preload`, `safety-journal`, `safety-lifecycle` byte-identical to this branch's `desktop/src` | PASS (10/10 identical) |
| PK-02 | First run: runtime ready, `aiOff=true` | PASS |
| PK-03 | Renderer bridge exposes 11 fixed members, none AI-related | PASS |
| PK-04 | First-run budget: daily/monthly 0, held 0, no activation token (state `RECOVERY_REQUIRED`, see D3) | PASS |
| PK-05 | Fabricated activation refused: first run 503 `DESKTOP_AI_SAFETY_UNAVAILABLE`; after key save 409 `AI_REQUEST_PLAN_REQUIRED` | PASS |
| PK-06 | Synthetic key save: 200 `ENABLED`, key never echoed; budget still 0/0/0, no token; main stays `aiOff=true`; clear → `OFF` | PASS |
| PK-07 | No non-loopback inet socket in the app process tree (24 processes) at ready, after first-run probes, after key save, after key clear | PASS (0 remote at all 4 samples) |
| PK-08 | Packaged ask with a fake provider (C13 on the app) | **BLOCKED**: the packaged transport is fixed to `https://api.openai.com` with public-DNS pinning; no fake-provider seam exists in a shipped build |

Classification: 1lvULq predates `3c9ec31`. PK-01…07 exercise AI OFF / budget 0 / key
save paths that `3c9ec31` (backend `SecretMask` only) does not touch, and the desktop
modules are byte-identical, so these rows hold for the candidate as built. P-02 stays
**FAIL on 1lvULq**; a rebuilt candidate must rerun this probe. The ask probe used an
unknown project id (404) and therefore proves nothing about the ask gate itself; the
Settings text check after a `pushState` navigation found 0 matches (not asserted).

## Requirement matrix

Full per-row ledger in the JSON. Counts over 75 rows: **69 PASS, 2 FAIL, 2 NOT RUN,
2 BLOCKED**.

| Group | Rows | Status |
| --- | --- | --- |
| C13-01…35 full stack (HEAD modules, Testcontainers PG, real Node main, fake provider) | 35 | PASS |
| C13-36…52 mapped existing (full stack 36–43; ledger/module 44–52, level not upgraded) | 17 | PASS |
| P-01, P-03…P-06 privacy | 5 | PASS |
| E-01…E-03 egress | 3 | PASS |
| ENTRY: every AI entry point gated or provider-free (inventory + architecture + boundary guards) | 1 | PASS (independent review still open, see G-SEC row) |
| VERIFY-PG: real psql adapter on disposable TLS PostgreSQL | 1 | PASS 59/59 (earlier 44/45 FAIL record kept) |
| PK-01…PK-07 packaged first run on 1lvULq | 7 | PASS |
| P-02 DB-URI password | 1 | **FAIL on 1lvULq** (PASS on HEAD source after `3c9ec31`; candidate not rebuilt) |
| P-07 dummy personal data in approved span | 1 | **FAIL** against the fixture list; product decision D4 |
| PK-08 packaged ask through a fake provider | 1 | **BLOCKED**: no fake-provider seam in a shipped build |
| REBUILD: rerun probe + P-02 on a candidate containing `3c9ec31` | 1 | **BLOCKED**: new candidate build not permitted in this phase |
| C16 native crash/restore states | 1 | **NOT RUN** here (gate-recovery owns it; module/native restore-budget evidence cited in C13-50) |
| G-SEC independent review of inventory and guards | 1 | **NOT RUN** (needs an independent reviewer) |

Recommendation: G-COST is not PASS. Remaining blockers are the candidate rebuild with
`3c9ec31`, the D4 decision and its test, C16 from gate-recovery, and independent review.

## Defects

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| D1 | High | `SecretMask` did not redact connection-URI passwords; an approved span containing one reached the provider body and the preview (05 §3 lists DB URI as a privacy fixture; 06 threshold is hard FAIL). Reproduced by `AiCostEgressPrivacyIntegrationTest` and a new `SecretMaskTest` case | **Fixed** `3c9ec31` (`backend/src/main/java/dev/codeintelligence/evidence/SecretMask.java`); invalidates 1lvULq |
| D2 | Low | DB failure inside the reservation transaction escapes `AiDesktopGateway.execute`'s try block and returns a generic 500 instead of a stable code. No row, no send, nothing echoed | Open; proposed: map non-ledger reserve failures to `AiSafetyUnavailableException` |
| D3 | Low (UX) | A fresh installation's budget API state is `RECOVERY_REQUIRED` (gate starts reconciliation-required; seen in C13-34 and packaged PK-04). `SettingsPage` maps `available && RECOVERY_REQUIRED` to "Budget reconciliation needed"; the packaged probe did not observe that text (navigation by `pushState`), so visibility in the UI is unconfirmed | Open; proposed: report OFF when no obligations exist and the policy was never configured |
| D4 | Medium (spec) | No personal-data redaction exists; dummy PII inside an approved span is transmitted after preview | Open: decide redaction vs explicit consented scope, then test |
| D5 | Low (harness) | `verify-ai-egress-postgres.cjs` started plaintext PG while the adapter test requires `verify-full` | Fixed `4cb2788` |

Observations: an approval-time catalog change (C13-21/22) leaves a PG-only hold without
latching main until the next request or a budget save; money stays held, nothing is
sent. The renderer has no CSP `connect-src` (G-SEC scope; the provider key never
reaches the renderer after save).

## Limits

- The packaged provider transport cannot target a fake provider; no packaged run
  activates AI. Full-stack cases use current modules with Testcontainers, not the app.
- Seams used: core `clock` injection, journal `fault` hook, catalog wrapper, PG test
  triggers. No product logic was patched in tests.
- Journal faults are injected at append stages, not real disk full or power loss.
- Timing numbers are not acceptance data on this shared machine.
- Packaged socket evidence is four `lsof` samples of the app process tree, not a
  continuous capture; the probe has no network namespace or firewall of its own.
- The packaged probe ran from a worktree; its isolated profile lived under
  `/private/tmp/cicp-*` (removed after confirmed shutdown).

## Remaining conditions

Rebuild a candidate containing `3c9ec31` and rerun the packaged probe plus
`AiCostEgressPrivacyIntegrationTest` evidence for P-02 on it; product decision on D4;
fix D2/D3 if accepted; gate-recovery's C16 native crash/restore matrix; independent
review (G-SEC) of the inventory and guards.
