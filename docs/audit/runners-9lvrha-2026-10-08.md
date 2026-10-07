# Packaged runner adaptation to candidate 9lVRha — 2026-10-08

## Scope and result

Unit **w6-runners**, branch `gate/w6-runners` from integration `52e2e33`. Candidate
**9lVRha** (built from `52e2e33`, `adapterIsolation=xpc-required`, RunAsNode fuse off,
inspect fuse on only for the validation app id) failed the coordinator's stage-5
functional run for runner reasons (`stage5-9lVRha/summary.txt`). This unit changes
validation runners and their tests only; no product path (`desktop/src`,
`backend/src/main`, `frontend/src`, `analyzers/*/src`) changed, so 9lVRha stays the
candidate under test. Release verdict stays **NO_GO**; no timing gate was run.

Four runner causes, one more than the stage-5 summary named:

1. **Service list.** `native-acceptance-electron.cjs` (two places) and
   `packaged-keychain-acceptance.cjs` asserted `backend, postgres, redis, ts-analyzer`.
   They now use `expectedServices` from `validation/pre-release/adapter-mode.cjs`
   (commit 90fbc4b). `run-startup-benchmark.cjs`, `run-startup-probe.cjs`,
   `run-workload-benchmark.cjs`, `accuracy-packaged-export.cjs` and `job-race-product.cjs`
   already followed the adapter mode. `cost-egress-packaged-probe.cjs` asserts no
   service list.
2. **SEC-M-02 drop confirmation.** New `validation/pre-release/drop-confirmation.cjs`
   answers main's `dialog.showMessageBox` for a dropped folder through Playwright's
   main-process `evaluateHandle`, the same way runners already answer
   `showOpenDialog`. It accepts only the first request whose
   type/title/message/buttons/default/cancel/noLink and `detail` equal the canonical
   (`realpath`) dropped path, and it is parented to the window. Any other message box
   gets its refusing answer. After the action it restores the original handler and fails
   with `DROP_CONFIRMATION_NOT_REQUESTED`, `_REPEATED` or `_MISMATCH` unless exactly one
   matching request was seen. Each runner records the result
   (`dropConfirmation(s)` in its `result.json`). The CDP drop, the trusted IPC, realpath
   and the backend folder policy stay real.
3. **UI language.** This cause was not in the stage-5 summary. 9lVRha includes
   `e38796c`, which moved the formerly hard-coded Korean import, overview and refresh
   labels into translations. The product default is English (`DEFAULT_LANG = 'en'`).
   On 9lVRha, after the drop was confirmed, the button read "Preview files to import",
   not "가져올 파일 미리보기". The first two product runs below failed on this, and a
   debug launch showed it. Runners now match those labels in both languages:
   `/^(English|한국어)$/`, built from `frontend/src/lib/translations.ts`. This follows
   the existing `/^(Restore backup|백업 복원)$/` pattern, so older candidates still match.
   The `native-interruption` guidance check still toggles both languages explicitly.
   In the UX pilot, only the U5 recovery block changed. After an owner SIGKILL, the
   stored language choice did not survive and the Korean-only "상태 새로고침" lookup timed
   out in run `ux-757r1b`.
4. **RunAsNode probe hang.** `security-packaged-probe.cjs` ran `<app> -e …` with
   `spawnSync`. With RunAsNode off the binary started as the app, and the probe waited
   on it for 60 min. Each node-mode probe now spawns in its own process group and is
   bounded to 20 s. On timeout it SIGKILLs only that group, whose leader is still alive.
   It stops waiting 2 s after the child exits, even if a survivor holds the pipe. The
   probe also passes `-- --isolated-run-claim=<absent file>`: in Node mode that is
   argv, while a binary that refuses Node mode exits at the product's own isolated-run
   refusal before it opens a profile, the Keychain or the runtime. A new
   `expectations.nodeModes` check requires the script not to run when the fuse
   expectation (`fusesFor`) has RunAsNode off, with the refusal observed. It also
   requires NODE_OPTIONS `--require` never to be honored. No other runner spawns the
   app binary in Node or inspect mode. `security-analyzer-execution.cjs` already uses
   repository Electron for xpc-required.

## Unit tests (node --test, read from output)

| Test | Before fix | After |
|---|---|---|
| `validation/pre-release/test/drop-confirmation.test.cjs` (5, new) | module absent | 5/5 pass |
| `desktop/test/security-renderer-boundary.test.cjs` "validation drop-confirmation installer matches the real main-process confirmation" (new; runs the serialized installer against the real `main.cjs`) | — | pass |
| `validation/pre-release/test/security-packaged-probe.test.cjs` (5 new of 10) | 5 fail on HEAD `security-packaged-probe.cjs` (functions absent) | 10/10 pass |
| Affected suites: adapter-mode, job-race, native-close-contract, security-renderer-boundary, native-acceptance, native-acceptance-context | — | 83/83 pass |
| ux-accessibility, workload-metrics, cost-egress-packaged-ask, packaged-keychain-acceptance, backup-recovery-matrix, owned-crash | — | 80/80 pass |

## Packaged proof on 9lVRha

Run serially from the worktree under `with-native-lock.sh w6-runners`, clean env
(`env -i HOME PATH LANG=C LC_ALL=C`), app
`.native-product-9lVRha/Code Intelligence Validation.app` (APFS clone of the
coordinator's candidate). Evidence under `validation/local/`:

| Runner | Result | Evidence |
|---|---|---|
| run-product-candidate | FAIL: preview timeout; English label (cause 3) | `pre-release-final/product-1cePjC` |
| run-product-candidate | FAIL: same; diagnostics show the confirmation was requested once and matched | `pre-release-final/product-q7HoSE` |
| run-product-candidate | **PASS**, 36 checks (unchanged count), 3 drop confirmations, each 1 request accepted | `pre-release-final/product-QePxxg` |
| native-interruption AFTER_SOURCE_RENAME --owner-crash | **PASS**, 6 checks, 1 confirmation, dialog events `RECOVERY_ACCEPTED` only | `electron-crash/native-sWM2DE` |
| native-interruption BEFORE_COMPLETED_CLEANUP --owner-crash | **PASS**, 6 checks, 1 confirmation | `electron-crash/native-GSpJqB` |
| job-race-product | **PASS**, 8 checks (xpc bridge SIGKILL case), 2 confirmations | `job-race/product-Jqgh1b` |
| cost-egress-packaged-ask (PK-08) | **PASS**, failures `[]`, cleanup confirmed, bundle unchanged | `cost-egress-packaged-ask/ask-1o388T` |
| security-packaged-probe | **COMPLETE**; expectations fuses/nodeModes/rendererCsp **PASS**. Both node-mode probes exited 1 in about 130 ms through the isolated-run refusal; script not run; NODE_OPTIONS not honored; 0 plaintext-secret hits | `security-internal-review/packaged-DYHJTN` |
| ux-accessibility-pilot | COMPLETED_WITH_STEP_FAILURES (1): `u5-sigkill-owner` timed out on a Korean-only label | `pre-release-ux/ux-757r1b` |
| ux-accessibility-pilot | **COMPLETED**, 0 step errors, 190 screens, all four U5 cases ran | `pre-release-ux/ux-79C3XN` |

The UX pilot imports with the keyboard-driven folder picker, so its drop helper path
(fallback only) was not exercised in these runs.

## Not run, limits

- Timing gates (startup 20-run, workload series): left to the coordinator, as asked.
  `run-workload-benchmark.cjs` now answers the confirmation before any timed mark, and
  its in-page watchers accept both languages. It was not run.
- Changed but not run on 9lVRha: `accuracy-packaged-export`,
  `native-preflight`, `native-recovery-matrix`, `import-evidence-native`,
  `adapter-isolation-stage` (bilingual labels only; these two use the folder picker,
  which has no confirmation).
- `desktop/scripts/packaged-keychain-acceptance.cjs` uses the **real** Keychain and
  attaches through `connectOverCDP`, with no main-process access. It cannot answer the
  native drop confirmation, so its folder import would wait on a real dialog. Only its
  service list changed. It needs a decision: switch it to a human-confirmed step, or
  use a different import path. It was not run (real Keychain).
- Commit `0eb1d09` also carries the bilingual labels of `native-acceptance-electron.cjs`.
  The label change for the other runners is in `f062c18`.
- A runner that relaunches after SIGKILL cannot rely on the stored UI language. Runners
  therefore match both languages rather than selecting one.
