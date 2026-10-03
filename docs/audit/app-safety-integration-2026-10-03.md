# App safety integration — historical V24 checkpoint

This page preserves the earlier 889/179/572 candidate and its failure history.
The later V25 implementation wires actual desktop request approval, main transport and durable
cost settlement; see [the current report](strict-ai-cost-integration-2026-10-03.md) and
[validation record](strict-ai-cost-validation-2026-10-03.json). The blanket desktop AI guard and
unimplemented cost path described below are historical. Legacy product backup/restore remains blocked.

Status: this bounded app-safety integration is implemented and verified. Whole-product release remains **No-Go**.
Earlier 857/152/456 results describe the prior candidate, not the changes on this page.
No installed application, actual userData/Keychain, personal repository data, paid provider,
credentials, user's GUI/browser session, package publication, commit or push is used in this work.

## Defects and corrections

| Severity / priority | Evidence and user impact | Change / current validation |
| --- | --- | --- |
| High / P1 | `AiProperties` nested OpenAi/Gemini records have overloaded constructors. Actual Spring binding silently produced empty provider settings, rejecting every model at Save. | Explicit canonical `ConstructorBinding`. Binder RED 2/2 then PASS 2/2; real HTTP flows also pass. The first two 23-test runs failed 11 cases each; they are product binding failures, not merely fixture failures. |
| High / P1 | Missing key rows previously selected environment credentials; slow Save could recreate keys after OFF, and a previously resolved provider could continue new operations. | V24 keyless preferences, revision CAS, committed OFF and guarded chat/embed/stream/testConnection. Environment credentials never opt users in. |
| Medium / P1 | ENABLED rows with damaged ciphertext, authentication tags, nonce or unknown wrapping-key version caused GET settings/status to return 500. | Decryption failure alone becomes effective RECONNECT_REQUIRED. DB errors still fail. Four actual HTTP RED cases pass after correction, including an earlier provider object rejected after damage. |
| Medium / P2 | UI Save put plaintext API keys in React Query mutation variables, retained beyond input clearing and OFF. | Component-only short-lived handoff and sanitized mutation errors; cache regressions pass; independent re-review resolved the finding. No heap/string erasure claim. |
| High / P0 | Desktop had no durable budget/permit gateway; legacy backup exported unrestricted SQL/Git data and restored SQL into the normal database. | Desktop provider admission and legacy product backup/restore are disabled at actual entry points; startup/latch/shutdown own the safety lifecycle. This is an explicit unavailable feature, not strict budget or format3 acceptance. |
| High / P1 | Missing desktop identity could trigger fallback generation even when old data/safety state existed. | Main preserves identity and distinguishes fresh enrollment from open/recovery. A durable marker outside B detects loss of the entire safety directory. Missing keys/history are never reinitialized; final Node and independent probes pass. |
| Medium / P1 | A synchronous child `kill()` error removed ownership from main's map before exit was confirmed. Shutdown could then close safety state while that child still lived. | Independent synthetic main probe failed before correction. Failed termination now retains the child and safety ownership; final combined verification passed. |
| Medium / P2 | A quit requested during startup was misclassified as recovery failure, preventing normal shutdown latching. | Independent VM reproduction failed after the earlier termination fix. Startup cancellation now yields to serialized shutdown; final combined verification passed. |
| Medium / P1 | Bundled subprocesses inherited the complete host environment, including unrelated credentials and Node/Java injection options. | Main now passes a short system allowlist plus its explicit service values to spawn, utility commands and PG readiness checks. Synthetic sentinel regression; no actual host secrets inspected. |

Constructor binding follows the [Spring Boot constructor-binding contract](https://docs.spring.io/spring-boot/reference/features/external-config.html#features.external-config.typesafe-configuration-properties.constructor-binding).
Actual macOS wrapping and consistent signed Keychain access remain unverified; see the
[Electron safeStorage contract](https://www.electronjs.org/docs/latest/api/safe-storage).

## State and admission contract

V24 keeps the existing credential rows and IDs intact while migrating explicit saved BYOK
settings to ENABLED preferences. An absent preference is OFF. OFF deletes the credential,
increments the preference revision and preserves provider/model in one committed transaction.
A failed deletion rolls back all three. Save probes outside its DB transaction and enables only
the unchanged starting revision; a later OFF or Save wins. No migration resets original data.

The monitor serializes request admission and settings commits within one backend. Network calls
run outside it. A call admitted before OFF can send or finish after OFF, even if HTTP had not
started. Transient active counts and a concurrency cap of two are not a durable cost ledger,
confirmed cancellation, or restoration drain. Browser development remains outside strict T08
monetary guarantees.

Desktop profile or even partial desktop authentication configuration selects a fixed
`DESKTOP_AI_SAFETY_UNAVAILABLE` release guard. It blocks provider creation, every guarded
operation and Save's connection probe; OFF and core local analysis remain available. Neither
renderer input nor a settings/environment switch can authorize desktop AI in this candidate.
This is not a live main-to-backend reservation/permit bridge. It must not be removed until real
RequestPlan, pricing/output bounds, durable reservation/settlement and recovery checks exist.

The build manifest now requires `buildSequence`, supplied explicitly by
`CODE_INTELLIGENCE_BUILD_SEQUENCE` before staging mutates files. It is a canonical decimal string
in 0..9223372036854775807 and is compared exactly. No semantic-version/time/default is invented.
The release owner must assign monotonically increasing values and bind them to signed artifacts;
that release authority, signing and recovery override are not validated by this syntax check.

## Focused validation and preserved failure history

- OFF/decrypt/binding focused candidate: 29/29 PASS; `/tmp/ci-ai-off-focused-green-2026-10-03-xml/`.
- Binding RED: 2/2 failures; `/tmp/ci-ai-properties-binding-red-2026-10-03.xml`.
- Damaged key RED: 4 failures / 29 tests; `/tmp/ci-ai-off-decrypt-red-2026-10-03-xml/`.
- V24 actual temporary catalog: 8/8 PASS, 24 migrations / 49 tables / 395 columns;
  `/tmp/ci-backup-export-catalog-v24-2026-10-03.log`. Isolated catalog/mutants only, no product restore.
- Later desktop guard focused attempt: 37/38 PASS; the 21st repeated fixture PAT login hit the
  production default limit of 20. Only this class's test login allowance was raised; the normal
  application rate limit is unchanged. The corrected focused run passed **38/38**, failure/error/skip
  zero: `/tmp/ci-ai-desktop-guard-focused-final-2026-10-03-xml/` and the matching log/summary.
- Stage transaction and explicit build-sequence tests: **23/23 PASS**, failure/skip/cancel zero;
  `/tmp/ci-build-sequence-stage-2026-10-03.log` and `.xml`. No real staging or package was created.
- Complete backend test candidate: see `/tmp/ci-ai-app-backend-full-2026-10-03-summary.json`
  and `-xml/`; **889/889 PASS, 96 suites**, failure/error/skip zero. All 531 captured backend
  source hashes are unchanged. The completed build/headless, desktop and UI gates are recorded below.
- Final UI author candidate: **179/179 PASS**, lint/typecheck PASS. Root independently checked
  the XML counts; independent review found no remaining C/H/M in its narrow scope.
  `/tmp/ci-ai-desktop-ready-full-2026-10-03.xml` and matching logs.
- Actual staging entrypoint with the build-sequence variable explicitly absent: expected exit 1
  before any staging entry changed; `/tmp/ci-stage-no-build-sequence-2026-10-03.log`.

Independent reviews distinguish static code reading from root executions. The backend review is
`/tmp/ci-ai-off-backend-independent-review-2026-10-03.md`; UI/policy review is
`/tmp/ci-ai-off-ui-policy-independent-review-2026-10-03.md`. Their candidate hashes/scopes must be
matched to the final run; a prior green run is not proof for subsequent main/UI changes.


## Completed candidate gate

| Area | Result | Evidence and limits |
| --- | --- | --- |
| Backend formatter/full test | **889/889 PASS**, 96 suites; failure/error/skip 0 | Root `spotlessCheck test`, then `build snapshotSourceTest` rebuilt resources and ran the full classpath again. `/tmp/ci-ai-app-backend-full-2026-10-03*`, `/tmp/ci-ai-app-build-source-2026-10-03*` |
| Build + source user flow | **PASS**, separate **12/12** source contract | Java artifacts and TypeScript/Vite production build; actual temporary backend/PG plus a separate headless browser. No installed Electron app or user browser session. |
| Frontend | **179/179 PASS**, 27 files; lint/typecheck PASS | Author execution, root XML/hash verification, independent read review. `ci-ai-desktop-ready-*` artifacts. Prior 42 scoped cases are included, not extra product scenarios. |
| Desktop main/modules | **572/572 PASS**, failure/error/skip/cancel 0 | Root complete Node run; includes 118 lifecycle/main author cases, 77 export-policy cases and 23 stage cases. `/tmp/ci-ai-app-desktop-full-2026-10-03.log`/`.xml` |
| Independent main probe | **17/17 PASS** | Different synthetic VM/wrapping probes, including two before-fix counterexamples; `/tmp/ci-safety-main-independent-probe-2026-10-03-final.log`. Not an OS Keychain/termination test. |
| V24 live catalog | **8/8 PASS**, 24 migrations, 49 tables, 395 columns | Disposable cached-image PostgreSQL without network; schema/type/nullability/generation mutants. No product archive/load. |
| Build-sequence entrypoint | **PASS, expected exit 1** | Missing explicit sequence refuses actual stage entrypoint without changing stage entries. No package/staged runtime replacement. |
| Preservation | **PASS** | 857 resume-baseline files remain; 20 frozen planning documents plus roadmap are byte-identical. 531 backend + 135 frontend + 25 desktop captured source hashes show zero post-gate drift. |

The [machine-readable validation record](app-safety-validation-2026-10-03.json) stores commands,
counts, source hashes, artifact hashes, failures and limits. Existing Gradle loopback handshake
warnings and Vite's large Monaco/editor bundles remain warnings in successful runs; these runs do
not establish large-repository performance or a clean-machine distribution.

Independent backend, UI/policy and main reviews report no unresolved critical/high/medium finding
**inside their reviewed slices**. They do not close the larger product requirements. The prior
source/workspace/accuracy evidence remains in [the continuation history](continuation-2026-10-03.md).

## Actual remaining blockers and decisions

1. **P0 — AI cost and request authorization:** desktop egress is deliberately unavailable. Implement
   immutable approved RequestPlan, supported tokenizer/output upper bounds, reviewed versioned prices,
   daily/monthly reservations, request UUID permits, usage settlement and PG↔journal reconciliation
   across every provider path before enabling it. The diagnostic admission cap is not monetary control.
2. **P0 — Complete backup/restore:** choose all installation-owned users versus a current-owner export,
   and complete legacy/GitHub source backup versus an explicitly labelled metadata-only export.
   Preserve IDs/notes/task bodies and refuse ambiguous ownership. The default formerly exported the
   whole installation; this change does not silently narrow it or remap owners. A typed PG row codec,
   consistent export, isolated loader, source pins/keys and B liability merge are still required.
   See [the recorded alternatives](t09-export-design-2026-10-03.md#product-decisions-and-release-blockers-to-keep-explicit).
   Existing exports are retained; no raw SQL loader was presented as safe format3.
3. **P1 — Source and native runtime integration:** the source broker/vault cannot simply be enabled
   while history opens shared Git clones and IDE links depend on original folders. Migrate these
   consumers together, then validate signed native file/network confinement and descriptor handling.
4. **P1 — Operational input and clean-device acceptance:** the owner must supply the actual GitHub
   application registration/callback scope, release build-sequence authority and signing/notarization
   setup. No credential or signed artifact was created. Real OAuth, safeStorage prompts/upgrades,
   fresh Mac installation without developer tools, signed updates and recovery remain unverified.
5. **P1 — Product accuracy/performance:** independent representative NestJS+React repositories,
   annotations/holdout and user tasks are still needed for screen→API→service→data flow, impact,
   evidence honesty and large-repository budgets. Small synthetic fixtures are insufficient.

These are concrete remaining implementation/acceptance gates, not reasons to discard the existing
architecture. No reset, original-file deletion, commit, push, PR, external upload or deployment occurred.
