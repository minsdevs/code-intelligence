# Packaged restore interruption / restart — 2026-10-05

## Scope and execution boundary

- Original repository: `/Users/minseokchae/Dev/code-intelligence` only. Started from `main=origin/main=380f67e` (PR #89); work branch `codex/restore-interruption-recovery-20261005`.
- This unit adds an opt-in validation driver, isolated in-memory fault/dialog controllers, and offline controller contracts. It does **not** change product code, migrations, runtime security policy or the retained app.
- Retained app: `.native-product-wXqDvU/Code Intelligence Validation.app`. Its inventory is validated before launch; `codesign --verify --deep --strict` is read-only. No rebuild, formal signing, notarization or deployment.
- Each invocation creates a new `/private/tmp/ciri-*/desktop-run-*` automation claim. The same newly created claim is reused only for that invocation's recovery and subsequent normal restart. Mock Keychain, synthetic local source, no real sign-in or paid AI request.
- Existing user app/profile/DB/Keychain, prior acceptance profiles, both retained bundles, source-build prefix, deleted workspaces/clones and historical PID-based termination routes are not used for mutations. New evidence and synthetic profiles are retained; no existing recovery artifact is deleted.

## Actual boundaries, not simulated successful restores

The app imports `recovery.ts` with a function returning `91`, creates a real encrypted backup, then imports a reviewed local change returning `92`. This produces snapshot 1 and snapshot 2 through the actual UI/API/backend analysis path.

Only after that baseline does the controller wrap `fs.promises.rename` / `unlink` in the SDK-owned main process. It matches only the exact newly owned profile and UUID-shaped transaction path, passes every unrelated operation through, trips once, and restores both original function references before closing the app. No imported product source or bundle file is patched.

| Point | Actual completed work before injected error | Recovery expectation |
| --- | --- | --- |
| `AFTER_SOURCE_RENAME` | Database swap and its recovery record have completed. The original `data/repos -> recovery/<tx>/previous-repos` rename returns, then the controller throws `EIO`. | Same-process rollback retains the newer pre-restore database/source. After verified recovery, snapshot 2 / source `92` remains. |
| `BEFORE_COMPLETED_CLEANUP` | Database/source publication, health verification, independent B maintenance completion and projection refresh have completed. The controller throws before unlinking `checkpoint/payload.bin`. | The committed restore must not be rolled back. Recovery finishes cleanup/records and retains snapshot 1 / source `91`. |

The first point is **namespace move succeeded, transition acknowledgement failed**. The moved directory's parent `fsync` and that move's transition acknowledgement have not completed at the injection point. It is not a power-loss durability result.

The second point depends on the unchanged product order in `backup-runtime.cjs:490-495,815-818`; no test-generated maintenance receipt is substituted. The driver reports the observed source/snapshot outcome, not an intercepted internal `recover()` return value.

## Assertions and diagnostic honesty

The final driver checks the real Settings restore failure message, unavailable backup/restore controls, `ready=false`, `recoveryOnly=true`, AI OFF, and no remaining ordinary backend/analyzer/cache writer. It verifies the selected archive, preserved input archive, encrypted checkpoint and wrapped keyring bytes; the pre-interruption safety journal remains an exact byte prefix after recovery. This is **not** a native nonzero cost-obligation fixture.

Recovery confirmation is controlled through the exact native `Verify interrupted recovery` dialog contract once, before the first window. The next normal restart must not request recovery again. Both recovered launches verify the exact current snapshot, displayed source and snapshot-specific Monaco URI.

After recovery the driver also checks registered checkpoint/incoming plaintext payload removal, preservation of the encrypted input/checkpoint, AI OFF, normal backup/restore availability, and unchanged app/manifest hashes.

Exit code and shutdown success are separate fields. Product `before-quit` can show `Code Intelligence shutdown requires recovery` and subsequently exit with code 0 after children/source handles have drained. That exit is recorded as `processExitedZero=true`, `shutdownRecoveryNotice=true`, **`cleanShutdownObserved=false`**. An actual native dialog is intercepted and classified, not manually rendered/accepted. Startup failure, unexpected confirmation and unexpected error codes cannot pass.

The controller emits only a nonce-bound fixed diagnostic code to the owned child's stderr. It does not export arbitrary exception details, tokens, keys or connection strings. The actual `ChildProcess` is captured at launch; even if the SDK discards its reference after early startup exit, cleanup never reacquires a process by numeric PID.

## Evidence / current validation status

Product identity used by this unit:

```text
app.asar SHA256       2d6f591a4f8d3448004d7914820d8e653be49951431f81f4ab686ce15f09808e
runtime-manifest      75a6e93f77cdd4fa03f7e99e25a2555e7aace89f643ee35f4dcd28aac7e8f87b
```

Results recorded so far:

| Evidence under `validation/local/restore-interruption/` | Result | Interpretation |
| --- | --- | --- |
| `native-nqH5kC/result.json` | FAIL, retained | Source-move fault, failure state and verified recovery to `92` passed. The third launch reported a MANIFEST-stage startup failure before a window. The first driver also failed to retain the SDK child reference after early exit, so its third exit record is missing. This run is not a clean/full success. |
| `native-mm6XFa/result.json` | PASS, earlier driver | Fresh profile, source-move fault once, recovery to `92`, another normal restart, all three process exits zero. The first exit correctly records a shutdown recovery notice rather than clean shutdown. This predates the additional explicit Settings failure-message assertion. |
| `native-fbwjDc/result.json` | PASS, final driver | Source-move fault once; explicit Settings error, recovery-only state, checkpoint/input/keyring/journal-prefix checks; recovery to snapshot 2 / `92`; another normal restart without consent; three zero/signal-free exits. First shutdown notice is correctly recorded as non-clean. |
| `native-CRrBPQ/result.json` | PASS, final driver | Post-B-completion cleanup fault once; explicit Settings error and preserved state; recovery to snapshot 1 / `91`; another normal restart without consent; three clean observed exits. |
| `unit-XXXXXX.log` | 535/535 PASS | Focused cost-state, recovery records, runtime coordinator, source swap, main lifecycle and six original controller contracts. No native opt-in crash suite was enabled. |
| `unit-final.FhH9mx` | 537/537 PASS | Same six-file focused regression with the final eight controller contracts. Failures 0, cancellations 0, skips 0; 112769.775875 ms. Native apps were no longer running when this final suite started. |

After the first failed run, read-only revalidation of the retained runtime inventory passed and both hashes above were unchanged; the third-launch process was no longer present. The exact first MANIFEST failure was not classified by the original dialog controller and **its cause is not established**. That first native run overlapped the initial focused regression command; later native runs were serialized without that suite. This is context for reproduction, not evidence of resource exhaustion or a causal explanation. Subsequent instrumentation adds static inventory/file-limit categories and correctly retains the live child handle. This does not constitute a product fix for that startup failure.

The two final native runs used identical source digests:

```text
native-interruption.cjs SHA256  88f68c18ded4d615094398955cc2f7a1bc797a0b7f0c891fc9fa711465b8a0d2
interruption-hooks.cjs SHA256   243d271a618679cfb7bf60463503ccf12ef541a0dc674d1b9ba9ac39b224811f
```

The final eight controller contracts pass independently, including early SDK exit
reference loss and redacted fixed diagnostics, and are included in the final 537/537
combined pass. `node --check` passes for both new validation modules and the test
file; the staged patch passes `git diff --cached --check`. No frontend product file
changed, and no unexecuted frontend/build/native suite is counted as a new pass.

### UI observation requiring follow-up

`native-CRrBPQ/interrupted.png` shows both the accurate recovery-required error and
the generic English notice `Backup and restore are unavailable in this build. Your
existing data is kept unchanged.` The generic notice is selected whenever either
availability flag is false (`SettingsPage.tsx:208,482`; `translations.ts:489,965`),
not just when the installed build lacks backup support. After the completed-restore
cleanup fault the live database/source has already changed to the backed-up state,
so **unchanged existing data is not a valid promise for this state**. The driver
verifies the actual failure and data outcome; it does not endorse that copy. Separate
unsupported-build and recovery-required messaging in the next product/UI unit and
rebuild/revalidate the changed app before claiming the message is fixed.

## Remaining release gates

This is a bounded injected-I/O-failure/restart unit, **not full G-RECOVERY approval**. SIGKILL, power loss, all fsync/receipt boundaries, native nonzero cost-obligation recovery, old physical-index/catalog conversion, real-account project 1 application and rollback, platform-wide acceptance, and formal release gates remain separate. User data compatibility must be established before any real-profile restore.

The first unclassified MANIFEST-stage startup failure and misleading unavailable
copy remain recorded follow-ups, not silently discarded observations. Repeated-start
stability, cause/fix evidence, and accurate recovery guidance are required before a
broader release claim. Final passing cases do not authorize real-profile mutation.

## Follow-up implementation

The misleading unavailable copy above was fixed in the next product unit; it is a
historical observation, not the current guidance. See
`recovery-guidance-diagnostics-2026-10-05.md` for the new `jXdOYk` package, explicit
support/recovery/pending/unknown UI states, fixed MANIFEST diagnostic codes and
fresh-profile native results. The original MANIFEST failure's cause remains
unconfirmed. Neither this follow-up nor its passing reruns upgrades the old failed
attempt to PASS or completes the full release gate.
