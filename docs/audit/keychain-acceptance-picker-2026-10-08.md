# Real-Keychain packaged runner: folder-picker import — 2026-10-08

## Scope and result

Unit **w9-keychain**, branch `gate/w9-keychain` from integration `dba2557`
(`codex/perf-medium-20261008`). Candidate under test stays **9lVRha**; this unit changes
validation runners and their tests only. No product path (`desktop/src`,
`backend/src/main`, `frontend/src`, `analyzers/*/src`) changed. Release verdict stays
**NO_GO**.

Problem (from `runners-9lvrha-2026-10-08.md`, item 2 and the "Not run" note):
`desktop/scripts/packaged-keychain-acceptance.cjs` launches the retained bundle directly,
uses the real macOS Keychain and attached only to the renderer (`connectOverCDP`). It
imported the fixture with a CDP drop. Since SEC-M-02, main asks a native
`dialog.showMessageBox` drop confirmation, which this runner could not answer, so its
import would wait on a real dialog.

User decision (2026-10-08): import through the folder picker instead (no drop, no drop
confirmation), as the UX pilot and `adapter-isolation-stage` do. The drop confirmation
stays covered by `run-product-candidate` and the security probe.

## What changed

1. **Shared helper** `validation/pre-release/folder-picker.cjs` (commit `29d5b6a`). It is the
   UX pilot's single-use picker answer, extracted: the serialized installer replaces main's
   `dialog.showOpenDialog`, answers only the first request with the title
   `Choose a source folder to analyze` and properties `['openDirectory']`, and refuses any
   other picker request (`FOLDER_PICKER_REFUSED`). New: during the same window it also
   replaces `dialog.showMessageBox` with a refusing answer (`cancelId`, else 1) and counts
   the requests. After the action it restores both handlers (`FOLDER_PICKER_REPLACED` if
   someone else replaced them) and fails with `UNEXPECTED_DROP_CONFIRMATION` (action
   failure kept as `cause`), `FOLDER_PICKER_REFUSED` or `FOLDER_PICKER_NOT_REQUESTED`
   unless exactly one matching picker request and no message box were seen. A relative
   folder is refused before install (`FOLDER_PICKER_FOLDER_INVALID`).
   `ux-accessibility-pilot.cjs` now calls this helper; its call sites and return shape
   (`{ result, pickerCalls }`) are unchanged. Its old error codes `UX_PICKER_REFUSED` /
   `UX_PICKER_REPLACED` become `FOLDER_PICKER_REFUSED` / `FOLDER_PICKER_REPLACED`, and a
   picker that was never asked now fails the step instead of recording `pickerCalls: 0`.
2. **Keychain runner** (commit `4c486f9`).
   - The CDP drop (`Input.dispatchDragEvent`) is removed. The runner focuses
     "Choose folder", presses Enter (keyboard-driven like the UX pilot) and waits for the
     preview button inside `withFolderPicker`, via the exported
     `importThroughFolderPicker(attach, folder, choose)`.
   - Main-process access: there is no Playwright `ElectronApplication` here (that path
     loads Playwright's Electron script and appends `--use-mock-keychain`). The **first**
     launch therefore adds `--inspect=127.0.0.1:<port>`, which the Validation app id keeps
     enabled for `_electron.launch` (`desktop/scripts/electron-fuses.cjs`; the product app id
     has the fuse off). The exported `attachMainProcess(port)` reads `/json/list`, accepts
     exactly one `ws://127.0.0.1:<port>/<uuid>` target and mirrors `evaluateHandle` with
     `Runtime.evaluate` (`require('electron')`, `includeCommandLineAPI`),
     `Runtime.callFunctionOn` and `Runtime.releaseObject`. Only an error code crosses back
     from a main-process exception (`MAIN_PROCESS_EVALUATION_FAILED` otherwise). The
     socket is opened only for the import and closed in `finally`.
   - Launch checks: the inspector listener must be the owned PID's only
     `127.0.0.1:<port>` listener (`lsof`), and `ps` must show `--inspect=127.0.0.1:<port>`
     on the first launch and no `--inspect` at all on the same-profile restart. The existing
     refusal of `--use-mock-keychain|--password-store=basic|--require|--inspect-brk` stays.
   - Fail closed: no inspector target, a non-loopback/ambiguous target or a failed attach
     gives `PACKAGED_FOLDER_PICKER_UNAVAILABLE` before the UI action starts; any message box
     during the import gives `UNEXPECTED_DROP_CONFIRMATION`; the whole picker step is
     bounded by `OWNED_FOLDER_PICKER_TIMEOUT` (60 s). `result.json` records
     `folderImport: { importPath: 'folder-picker', pickerCalls: 1, messageBoxes: 0,
     dropDispatched: false }` and `launches[].mainInspector`.

## Red / green

All runs: `node --test <files>` after `wait-quiet.sh`, unit doubles only (no app, profile,
Keychain or OS dialog).

| Step | Files | Result (read from output) |
|---|---|---|
| Baseline before edits | keychain, drop-confirmation, ux-accessibility tests | tests 24, pass 24, fail 0 |
| Red: new tests on old code | `desktop/test/packaged-keychain-acceptance.test.cjs`, `validation/pre-release/test/folder-picker.test.cjs` | tests 21, pass 12, fail 9: the 8 new keychain tests failed (`launchArguments` returned 3 args; `importThroughFolderPicker is not a function`; source matched `dispatchDragEvent`; `attachMainProcess` missing) and the folder-picker file failed with `Cannot find module '../folder-picker.cjs'` |
| Green: helper + pilot | folder-picker, ux-accessibility, drop-confirmation tests | tests 18, pass 18, fail 0 (folder-picker 6/6) |
| Green: runner | keychain, folder-picker, drop-confirmation, ux-accessibility tests | tests 38, pass 38, fail 0 |

One intermediate failure was in the new client, not the tests: the open listener was
attached after the synthetic socket's `open` event; the listener is now attached right
after construction.

New keychain tests: inspector argument only when requested and loopback-only; picker used
once with no message-box answer; unexpected drop confirmation refused and fails closed;
import never started without a main-process picker answer; source has no drop or
drop-confirmation answer and requires the shared helper; inspector client attaches to the
one loopback target and evaluates by reference; main-process exception keeps only its code;
missing/remote/ambiguous target leaves the picker path unavailable.

## Changed paths

- `validation/pre-release/folder-picker.cjs` (new)
- `validation/pre-release/test/folder-picker.test.cjs` (new)
- `validation/pre-release/ux-accessibility-pilot.cjs`
- `desktop/scripts/packaged-keychain-acceptance.cjs`
- `desktop/test/packaged-keychain-acceptance.test.cjs`

## Not run, limits

- **Packaged runner: NOT RUN (real Keychain).** Real-Keychain use is outside this unit's
  permissions. A human would run, on a quiet machine and under the native lock:

  ```sh
  COORD/with-native-lock.sh keychain env -i HOME="$HOME" \
    PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
    node desktop/scripts/packaged-keychain-acceptance.cjs \
    --app "$PWD/.native-product-9lVRha/Code Intelligence Validation.app"
  ```

  from a checkout containing this branch, with `frontend/node_modules` present and the
  candidate inside that checkout (the runner requires the bundle under the repository
  root). Evidence lands in `validation/local/packaged-keychain/run-*/result.json`.
- The inspector client was exercised only against a synthetic socket. Its behavior against
  Electron's real main-process inspector (target list shape, `includeCommandLineAPI`
  `require`) follows what Playwright's `_electron` does but is unverified here.
- Design note for review: the real-Keychain run now has main-process code execution on its
  first launch, limited to the picker answer and message-box refusal. Keys stay out of
  the driver, but the inspector could reach them; reviewers may prefer a human-confirmed
  import step instead.
- The UX pilot was not rerun on a packaged app; only its unit tests ran.
- `adapter-isolation-stage.cjs` keeps its own laxer copy of the picker answer (title check
  only, no restore check). Moving it to the shared helper is a small follow-up.

## 2026-10-08 후속 상태

위 미실행 표기는 w9 단위 완료 시점의 기록이다. w15에서 `adapter-isolation-stage.cjs`의 느슨한 사본을 제거하고 공유 picker로 통합했다. 통합 담당자가 별도 ad-hoc staged 앱의 실제 분석과 p6yGme UX pilot 190상태를 확인했다([w15 후속 감사](w15-runner-2026-10-08.md)). 실제 Keychain 러너·main inspector 수용은 실행하지 않았으며 사람이 실행해야 한다.
