# React route → exported component binding — 2026-10-06

> Historical qUMAST/checkpoint record. The subsequent
> [pre-release continuation](pre-release-continuation-2026-10-06.md) executes the
> final package-entry guard and builds candidate j5EJLB together with job-event
> reconciliation and shutdown diagnostics. Its current results supersede the
> pending checkpoint below; the original results and failed request are retained.

## Scope / eight-stage position

Original checkout `/Users/minseokchae/Dev/code-intelligence`, base PR95 / `2abfa1d`,
branch `codex/react-default-export-routes-20261006`. This is a **stage4 analysis
correctness** follow-up, with stage6 candidate packaging verification. It is not a
new release approval or a claim that the other mandatory eight-stage gates passed.

**Checkpoint before continuation:** qUMAST's default full native sequence subsequently passed35
recorded checks. A further package-entry false-positive guard is now implemented
in the working tree but has not been revalidated or included in a new candidate.
The combined analyzer/typecheck/Java formatting-and-compilation request for that
last change was blocked at the tool security-decision boundary and did not execute.
It was not repeated or delegated through an alternate route. This unit is therefore
**not ready to merge**; the validated candidate and unvalidated final changes are
explicitly separated below.

The previous mapper compared an imported name `default` with a component's actual
declaration name. A valid default import, including a renamed local binding, could
therefore have no route→component edge. Its downstream API propagation separately
used a snapshot-wide display-name map, which could connect a different module's
same-named component even when the structural edge was absent.

## Implemented contract

React Route results now carry an explicit component-resolution result. The analyzer
starts at the root JSX value, verifies its lexical binding, resolves only modules
present in the supplied input, and follows an explicit value export to a collected
component declaration. File, declared name and source range identify the reference.
The existing input-only module resolver supplies tsconfig aliases and runtime-source
extension handling; duplicate package names are now unresolved rather than last-wins.

Final review also found that the shared resolver's legacy `package/src/index`
heuristic could ignore package.json `exports`/`main` and select the wrong component.
The pending final guard adds an opt-out of that fallback for React binding; relative
imports and explicit supplied tsconfig paths remain the supported paths. Bare
package entry inference is unresolved rather than silently treated as exact export
evidence. Five new analyzer cases and one real-sidecar case were added for this
boundary but **have not been executed**. Existing266/11 results predate this change.

Supported static paths include named default functions, top-level const component
declarations exported as default, named/default aliases, namespace import members,
explicit value re-export chains and immutable const aliases. Same-module non-exported
declarations can be valid local bindings. No repository code, import or helper is
executed to find a component.

Missing/non-exported values, type-only hops, parameter/destructuring shadows,
observed binding writes, duplicate graph identities and ambiguous route paths do
not authorize an edge. Because existing graph keys omit lexical scope, even an
exact position cannot distinguish two same-file/name component declarations.
Alias/re-export traversal is bounded to64 steps and rejects cycles. Anonymous
defaults, star exports, computed/helper/memo/lazy values and conditional/fragment
root expressions remain unresolved; this is not complete JavaScript runtime analysis.
JSX spreads or duplicate element attributes also prevent a resolution claim.

Java independently checks status, complete reference, canonical relative path,
kind, exact lines and uniqueness. The JSON creator distinguishes an omitted legacy
field from explicit null/false/array/malformed metadata. New unresolved or invalid
results never fall back to matching names. Old five-argument DTO callers and
non-React route formats retain a labelled legacy path; type-only legacy imports
cannot authorize value components. The edge remains **LIKELY**, not proof that the
application actually executes the route.

Downstream route→API propagation follows only a unique COMPONENT CONTAINS edge
in the same snapshot, never the route's display/import alias. Explicit route
re-interpretation replaces only that route's outgoing component/API links inside
the existing graph transaction. A later unresolved result removes stale links;
incoming file provenance and other snapshots are outside that replacement.
Duplicate route paths cannot retain the first resolved occurrence's link.

## Executed evidence and failed attempts

New local evidence family: `validation/local/react-route-binding/`. Docker evidence
continues under `validation/local/docker-integration/`. The final JSON ledger binds
the selected runner reports/logs, source hashes and packaged candidate identities.
Backend totals below are the runner's recorded Gradle suite totals, not a claim
that a separate raw-JUnit recount was performed in this finalization.

The initial TypeScript regression (`repro-4pMS6Z/ts-red.json`) failed on the original
response lacking explicit declaration resolution. The first actual DB run
`accuracy-u3tIIj` was **not** a successful reproduction of the missing graph edge:
its new fixture violated the users identity constraint. `accuracy-VHhvgT` retained
the same setup failure. After assigning a synthetic LOCAL/local_key identity,
`accuracy-riIwMe` exposed another new fixture omission: no Git repository existed
for the actual inventory scanner. These attempts remain FAILs and are not counted
as product regressions or successful baseline graph reproduction.

The fixture now initializes/commits only its new synthetic source directory with
a fixed test identity and no signing, and records the real commit in its snapshot.
No production constraint was relaxed. Existing oracle expectations and
`quality-baseline.env` were not changed.

`accuracy-cZABNm` passed11/11: the existing7 accuracy tests plus four new real-sidecar
HTTP/DTO/mapper/PostgreSQL cases. They cover default alias selection, named/const
export paths and type/missing/shadow refusals, downstream wrong-module API refusal,
same-snapshot resolved→shadow link removal, and duplicate route keys. This run
preceded the final shorthand-assignment guard refinement; it is kept distinct from
subsequent exact-source results.

`final-Y2wTER` passed TypeScript typecheck, all266 configured analyzer tests, and122
selected validation/desktop contracts. The shorthand write regression uses the
actual value symbol, not the object property-name symbol. Tests are not summed
across reruns or treated as independent accuracy data.

Final exact-source `accuracy-ddkIbj` passed11/11 after the shorthand fix, with the
owned local analyzer exited0, prior container states unchanged and no new
containers remaining. The configured default backend run `backend-dsTFei` recorded
1,658 results: **1,646 passed,0 failed,12 explicitly conditional skips**. The four
new real-sidecar tests belong to `accuracyTest`, not the default backend task;
neither the skips nor the excluded specialized task are counted as passed.

After adding native diagnostics and the explicit analysis-only mode, the final
`publication-wjLKyA` selection again passed122/122 with no skips. This run binds
the exact current native runner/wrapper and candidate builder. It does not replace
the actual native observations below with unit-test evidence.

## Candidate build boundary

The previous candidate builder reused the old analyzer code along with native
dependencies. That would not validate this change. It now compiles the analyzer in
a private dependency/source copy, verifies unchanged package/lock compatibility
with the retained supply, replaces exactly the staged dist files, rebuilds their
manifest entries and checks the resulting app's analyzer file hashes. The previous
staged code is preserved separately; the baseline app is never patched in place.
Synthetic tests cover exact replacement, stale-file removal, external/linked paths
and existing preserved-output refusal. Java classes and frontend/desktop output
continue through the existing candidate readback checks.

The native product runner now additionally imports a new synthetic React project
through the real folder/preview/approval UI, checks the default alias's exact graph
target and the shadowed route's absence, displays the retained snapshot source and
checks both graph results after another app restart. This uses a fresh automation
claim and mock Keychain, not an existing account or user profile.

### Built candidate identity

```text
app                 .native-product-qUMAST/Code Intelligence Validation.app
buildSequence       1791226001813
app.asar SHA256     7317187afaa9364651dd0a289130f4b07750890731600e0695c43e37582fc6e7
runtime-manifest    5bf6d210371bd2dfa8b08e398a8f3abc769516730a14ad5ee999bf25f66fcaa2
backend JAR         859662f88015451efbb7fb15891fc6b30b3d7db2d7ad1530dc189b361306c6ab
analyzer dist       4d434bc592dab7e781094250756cf543dadcca93bd433877140a202ca85cb00f
```

`validation/local/pre-release-candidate/build-J7ljCZ/result.json` records748
compiled Java classes,27 migrations,120 frontend static assets and30 analyzer
JavaScript/source-map files. The analyzer was rebuilt and current compiled Java
classes were read back; the build log marks compileJava UP-TO-DATE, so this does not
assert that Java was freshly recompiled during that particular packaging command.
The desktop ASAR
is unchanged because product desktop sources did not change. The old Imupzt app
and its inventory were retained unchanged; ad-hoc signature checks are not
Developer ID/notarization or clean-machine installation acceptance.

### Actual app runs: keep the scopes and failures separate

All three runs used this same candidate and new synthetic claims. No candidate
rebuild or product code change was made between these executions.

| Report under `validation/local/pre-release-final/` | Result and exact scope |
| --- | --- |
| `product-q6v3EP/result.json` | **FAIL**,16 recorded checks. Backup/reanalysis/restore/checkpoint substeps completed, then `NATIVE_ELECTRON_CLOSE_TIMEOUT`. The first driver lacked the final exit record; a clean final exit is not asserted. |
| `product-29qfSB/result.json` | **FAIL**,24 recorded checks. The backup/restore sub-sequence recorded PASS and all four recorded app exits were0/no signal, but the later representative-repository phase returned a generic step failure. This is not an overall PASS and did not reach the React fixture. |
| `product-Pt5oyx/result.json` | **PASS, explicit analysis-only**,13 recorded checks including repeated startup assertions. Real representative import/flow/snapshot source and React default alias/shadow graph assertions, each with restart, passed. Three app exits were0/no signal. **Backup/restore, safeStorage roundtrip and delete-persistence were intentionally not executed in this mode.** |
| `product-RkDN8L/result.json` | **PASS, full default sequence**,35 recorded checks including repeated startup assertions. Initial import/reanalysis/current and previous snapshot, safeStorage, backup/restore/checkpoint, old-authority rejection, deletion persistence, later representative import and React binding/restart all completed. Six direct app exits were0/no signal. This is the pre-package-entry-guard qUMAST candidate, not a validation of subsequent working-tree changes. |

The first broad close timeout and second broad representative-phase failure have
**unconfirmed causes**. The narrowed analysis run does not resolve them, turn
earlier FAILs into PASS, or establish complete native acceptance. It provides a
separate product-path result for the change under review. The later full-sequence
PASS supplies missing sequence coverage for that same candidate, but does not
establish why the earlier attempts failed or rewrite their outcomes. Close timing was not
relaxed. The observer now records actual owned-process exits and bounded import/job
status codes without publishing raw exception details.

The explicit analysis-only mode also skips initial synthetic import/reanalysis,
historical/current snapshot contracts and the transition from restore/delete to
representative import. Its omission list was expanded to name these in the pending
working version. This reporting-only update has not been re-executed. Seven new
direct `closeOwnedApplication` contract tests passed from console output: natural/
already-completed exit0, timeout despite exit0, nonzero/signalled exits, unconfirmed
escalation and preservation of the primary error. Those fake-child tests do not
prove sidecar-tree termination; `appExits` likewise records the direct Electron child.

The passing React case has exactly
`route:/chosen -> component:chosen.tsx#ActualPage` and no outgoing component for
`route:/shadow`. The real UI selected and displayed the retained `chosen.tsx`
snapshot text and its matching Monaco snapshot URI. These are automated UI/API
assertions; no manual screenshot review is claimed. The graph remained correct
after app restart.

The analysis-only representative input accepted887 files /8,001,715 bytes with
61,118ms import-to-overview,12ms search and1,122ms relation rendering on this host.
Those are single-run observations, not p95, precision/recall or a comparison with
previous runs using different inputs. Its164 success/635 partial/1 unsupported/
87 unmeasured file outcomes remain coverage classifications, not correctness scores.

The validated pre-guard source/result association and the unvalidated working-tree
checkpoint are distinguished in
`react-route-binding-validation-2026-10-06.json`. Existing supply/advisory reports
remain dated records; no new whole-product vulnerability assessment is claimed for
this rebuilt candidate.

## Remaining conditions at this checkpoint

This static binding fix is not full dynamic routing support, an independent
real-repository precision/recall result, or proof of every graph deletion/race path.
Old snapshots are not bulk rewritten. The immediate remaining work is authorized
validation of the last package-entry guard, then a candidate incorporating that
guard; no existing native result covers it. The retained intermittent close/import
failures also still need cause/stability evidence rather than retries counted as fixes.
Real-account import/refresh/revoke/SSO,
complete crash/power-loss and independent performance/security/UX, clean-machine
minimum-OS/signed update acceptance and operational release requirements remain
separate. No paid AI, real keys, GitHub Actions, Developer ID signing, notarization
or public deployment is part of this unit.
