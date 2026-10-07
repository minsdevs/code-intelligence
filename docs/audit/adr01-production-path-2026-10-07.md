# ADR-01 production isolation path (G-SEC SEC-H-02) — 2026-10-07

Unit `w2-adr01`, branch `gate/w2-adr01` from `f89fabb`, worktree `/Users/minseokchae/Dev/ciw/adr01`.
Continues `security-hardening-adr01-2026-10-07.md` ("What remains" 1–5). Ad-hoc signatures only; no candidate was
built and the shipped `adapterIsolation` flag is unchanged (`legacy-http`). G-SEC stays NOT PASS: Developer ID, C15
and the independent review are open (see "What remains").

## Design as built

```
Electron main ──spawn, stdio──▶ Contents/MacOS/adapter-bridge  (hardened runtime, no entitlements)
   ▲  "open ts-analyzer <run-token>\n" then framed bytes       │ xpc_connection_create(<appId>.adapter-supervisor)
   │                                                           ▼
   │ Unix socket 0600 in a 0700 dir      Contents/XPCServices/AdapterSupervisor.xpc  (app-sandbox only)
   │ + per-backend capability              peer requirement from its signed Info.plist (ad-hoc: bridge CDHash;
backend (TsAnalyzerControlClient)          Developer ID: Team ID + identifier), worker table in the same Info.plist
                                           │ posix_spawn (setsid, cloexec, stderr /dev/null, per-run scratch in its container)
                                           ▼
                                  MacOS/adapter-node (npm Electron 44.4.5 copy, RunAsNode fuse on, NODE_OPTIONS and
                                  inspector fuses off, app-sandbox+inherit+allow-jit) Resources/ts-analyzer/dist/stdio.js
```

- One bridge → supervisor → worker session per analysis (fresh 64-hex run token on the bridge's stdin, never in argv or
  env); the host checks the handshake and every frame (unchanged `createStdioAdapterClient`). Closing the bridge ends the
  XPC connection and the supervisor kills the worker's process group and removes its scratch directory.
- Supervisor checks before every launch: own sandbox active, worker id in the signed table, SHA-256 of the worker
  executable and entry script, resolved path inside its bundle without links; after spawn it kills a worker that is not
  sandboxed. At most 2 sessions; input/output relay capped at 10 MiB+16 KiB / 64 MiB+16 KiB per session.
- Main attestation (startup, overlapping the backend JVM start): `runtime-manifest.json` section
  `adapterSupervisor {format, supervisorSha256, bridgeSha256}`, regular files, `codesign --verify --strict` (also checks the
  service's sealed resources and Info.plist), supervisor entitlements app-sandbox only, bridge without any entitlement.
  The first health request also runs one live handshake session (cached per runtime start).
- Location change: the service must sit in `Contents/XPCServices` to be found, and its framework symlinks are not allowed
  in the symlink-free runtime tree, so the first draft's runtime path (`runtime/adapter-supervisor/...`) is replaced.
- Backend: `TS_ANALYZER_CONTROL_SOCKET` + `TS_ANALYZER_CONTROL_CAPABILITY` (rotated per backend process) replace
  `TS_ANALYZER_BASE_URL`/TLS/token when the mode is not `legacy-http`; the HTTP client stays for dev/test. Socket path
  checked against the 103-byte sun_path budget (app temp dir, then `os.tmpdir()`, else `ADAPTER_CONTROL_PATH_TOO_LONG`).
  `TsAdapterIsolationException` (a `RecoveryActionFailure`) sets job `failureCode = ADAPTER_ISOLATION_UNAVAILABLE`; the
  progress view shows `progress.isolationUnavailable` (en/ko). No TS_PARSING/job class was changed.
- TEST_ONLY: `test-only-unsigned` only when `app.isPackaged === false` and
  `CODE_INTELLIGENCE_ADAPTER_TEST_ONLY=synthetic-fixtures`; analyzes only requests whose root `package.json` has
  `"codeIntelligenceSyntheticFixture": "TEST_ONLY"` (others: `TEST_ONLY_FIXTURE_REQUIRED`, no process started).

## Red / green

| Piece | Red (as read) | Green (as read) |
|---|---|---|
| Desktop isolation + main wiring (`adapter-isolation.test.cjs`, `adapter-control.test.cjs`) | on `f89fabb` sources: control file `Cannot find module '../src/adapter-control.cjs'`; isolation 15 tests, 7 pass, 8 fail (`BRIDGE_EXECUTABLE is not iterable`, `createBridgeAdapter is not a function`, `adapterIsolationRuntimeMode is not a function`, `analyzerEnvironment is not defined`) | 22/22 |
| Packaging (`adapter-supervisor.test.cjs`) | `Cannot find module '../scripts/adapter-supervisor.cjs'` | 8/8 |
| Native acceptance (`adapter-supervisor-native.test.cjs`, opt-in `ADAPTER_SUPERVISOR_NATIVE=1`) | first smoke: Node worker exit 71, AMFI `Library Validation failed ... different Team IDs` → ad-hoc-only `worker-adhoc.plist`; ts-analyzer session hung → `dispatch_io_set_low_water(1)` | 8/8 (default run: 1 skipped) |
| Backend (`TsAnalyzerControlClientTest`, `TsAnalyzerPropertiesTest`) | `compileTestJava`: `no suitable constructor found for TsAnalyzerProperties(String,int,String,String,String,String)`, `cannot find symbol` | `dev.codeintelligence.analysis.ts.*` 63 tests, 0 failures, 0 errors (ControlClient 5, Properties 21) |
| Frontend (`isolationFailure.test.tsx`) | 1 failed, 1 passed | 2/2; with `syntaxFailure` + `recoveryNavigation` 15/15 |
| Runners (`validation/pre-release/test/adapter-mode.test.cjs`) | `Cannot find module '../adapter-mode.cjs'` | 1/1; with startup-benchmark, startup-probe, security-packaged-probe, workload-fixture tests 31/31 |
| Desktop regression set (15 files incl. main-runtime-gateway, security-renderer-boundary, macos-signing, electron-fuses, runtime-manifest, ai-egress-boundary) | — | 374: 372 pass, 0 fail, 1 skipped (native opt-in), 1 todo (SEC-M-02, other unit) |

`ai-egress-boundary.test.cjs` network inventory gained one reviewed entry: `adapter-control.cjs` (`net`, private
backend↔main Unix socket).

## Staged end-to-end proof (`adapter-isolation-stage.cjs`, native lock held, evidence in `adr01-production-path-2026-10-07/`)

APFS clone of the LA8ZS9 Validation app (candidate directory not written) → this checkout's `desktop/src` in app.asar
(flag set in the staged copy only, asar integrity hash updated), this checkout's backend jar with frontend, analyzer
moved into the service, RunAsNode fuse off on the app binary, product supervisor/bridge assembled and signed by the
packaging helpers (signed table + the two test-only probes), ad-hoc `codesign --verify --strict --deep` ok.

| Observation | Result |
|---|---|
| Runtime services | `backend, postgres, redis` (no ts-analyzer child) |
| Synthetic TS fixture import through the folder picker | job `DONE`, `TS_PARSING DONE`; `src/App.tsx SUCCESS TS_PARSED`, `src/api.ts PARTIAL UNRESOLVED_CALLS`; 9 graph nodes incl. `COMPONENT App`, `METHOD loadItems` |
| Processes seen during the job | 2 sessions (health check, analysis): `adapter-bridge` ← app, `AdapterSupervisor` ← launchd, `adapter-node` ← AdapterSupervisor; none left after exit; app exit 0, shutdown COMPLETE |
| Spike denial probes run by the staged supervisor | native probe and Node grandchild: `sandboxed 1`; read/create outside file, TCP connect/listen, UDP send `DENIED(Operation not permitted)`; DNS refused; Node `listen` and home `EPERM`; listener: no probe payload; unknown worker → bridge exit 70 `WORKER_UNKNOWN` |
| Service resource changed after signing (`stdio.js` +1 line), relaunch | `DESKTOP_ADAPTER_ISOLATION ADAPTER_ISOLATION_UNAVAILABLE SUPERVISOR_UNSIGNED`; job `FAILED`, `failureCode ADAPTER_ISOLATION_UNAVAILABLE`; UI alert shows the job error and the new guidance; no bridge or worker process started |

Native test only (ad-hoc test app): a re-signed copy of the bridge (different CDHash) gets exit 69 (requirement refused);
a probe changed after signing → exit 70 `WORKER_HASH_MISMATCH`; the inherit-signed worker run directly → `SIGTRAP`;
unsandboxed control probe → everything `ALLOWED`. `attestSupervisor` took 509–518 ms wall there (service carrying the
development `node_modules`); `codesign --verify --strict` of a service with the production analyzer took 0.40 s wall,
2.6 s CPU (smoke app).

## Can the coordinator flip `adapterIsolation` to `xpc-required` for the next candidate?

Product code is ready; the candidate builder is not. Required with the flip:
1. `validation/pre-release/build-candidate.cjs` (not changed here, it cannot be run by this unit): after it builds the
   analyzer (`dist` + production deps), call `adapterSupervisor.compile(desktop/stage/adapter-supervisor/bin)` and
   `assembleService({ destination: desktop/stage/adapter-supervisor, electronApp: desktop/node_modules/electron/dist/Electron.app, analyzer, appId, version })`,
   then drop `ts-analyzer/**` from the staged runtime and its manifest (as `stage-runtime.mjs` now does). Its electron-builder
   config already inherits `afterPack` (installs the service) and `mac.sign` (signs it and writes `adapterSupervisor`).
2. Disk: +286 MiB per installed app (second Electron framework set 292,872 KiB + 36 KiB stub + ~93 KiB supervisor/bridge;
   the 36,216 KiB analyzer moves, net 0): LA8ZS9 545,592 KiB → about 838,700 KiB. DMG/zip deltas not measured. A worker
   JRE copy was not added: no Java worker exists (Java parsing runs in the backend JVM, tree-analyzer is not shipped);
   it would add 53,472 KiB.
3. Runners: `security-analyzer-execution.cjs` runs the packaged analyzer from the service with the repository Electron
   (version asserted equal to the worker's 44.4.5), because the app binary has RunAsNode off and the worker copy traps
   outside the sandbox. `accuracy-packaged-export`, `native-loader-probe`, `run-startup-benchmark`, `run-workload-benchmark`,
   `run-startup-probe` expect `backend, postgres, redis` for such a candidate (`adapter-mode.cjs`).
   `job-race-product.cjs` captures and kills the `ts-analyzer` child and has no xpc-required equivalent yet (it would need
   to kill a bridge mid-analysis); it will fail `OWNERS_NOT_CAPTURED` until rewritten. `security-packaged-probe.cjs`
   already derives the RunAsNode expectation from the flag.
4. Startup: one `codesign --verify --strict` of the service (0.40 s wall, 2.6 s CPU) overlaps the backend JVM start; the
   startup series should be re-measured on the flipped candidate. The first session after signing took 1.7 s to the
   analyzer handshake (smoke run, once); warm Node probe sessions completed in 0.16–0.19 s; warm analyzer readiness was
   not measured.

## SBOM / notice impact (for the coordinator; stage 7 docs not edited)

- New first-party binaries: `AdapterSupervisor`, `adapter-bridge` (C, no third-party code; link only CoreFoundation,
  libxpc/libdispatch, CommonCrypto from the OS).
- Electron 44.4.5 ships twice: app frameworks and `XPCServices/AdapterSupervisor.xpc/Contents/{MacOS/adapter-node,
  Frameworks/{Electron Framework,Mantle,ReactiveObjC,Squirrel}.framework}`. Same version and licence texts already in
  `Resources/legal/electron`; the SBOM must list the second location (and its own fuse wire) — `sbom-candidate.cjs`
  classifies runtime-relative paths only and needs a rule for the service.
- `ts-analyzer` and its npm dependency tree move from `Resources/runtime/ts-analyzer` to
  `XPCServices/AdapterSupervisor.xpc/Contents/Resources/ts-analyzer` (same lock).

## Changed product paths

`desktop/native/adapter-supervisor/{supervisor.c,bridge.c,protocol.h,entitlements/*.plist,test/probe.c,test/node-probe.cjs}`,
`desktop/scripts/adapter-supervisor.cjs`, `desktop/scripts/stage-runtime.mjs`, `desktop/scripts/electron-fuses.cjs`,
`desktop/scripts/sign-macos-runtime.cjs`, `desktop/src/adapter-isolation.cjs`, `desktop/src/adapter-control.cjs`,
`desktop/src/main.cjs` (analyzer spawn/control socket/backend analyzer env only),
`backend/.../analysis/ts/{TsAnalyzerClient,TsAnalyzerProperties,TsAnalyzerControlClient,TsAdapterIsolationException}.java`,
`backend/src/main/resources/application.yml`, `frontend/src/features/import/ProgressStep.tsx`, `frontend/src/lib/translations.ts`.
Runners: `validation/pre-release/{adapter-mode.cjs,adapter-isolation-stage.cjs,security-analyzer-execution.cjs,accuracy-packaged-export.cjs,native-loader-probe.cjs,run-startup-benchmark.cjs,run-workload-benchmark.cjs,run-startup-probe.cjs}`.

## Limits

- Ad-hoc only. The Developer ID branch of the peer requirement (Team ID + identifier) and library validation without
  `disable-library-validation` are untested; no Team ID caller check was observed (C15 BLOCKED).
- The supervisor hashes the worker executable and entry script per launch; the rest of `dist`, `node_modules` and the
  Electron frameworks are covered by the service seal, which main verifies at startup only. The supervisor does not
  re-verify its own Info.plist at runtime (a same-user change after startup is not detected until the next start).
- The control capability and socket path reach the backend in its environment, like the existing analyzer token and
  database password (same-user processes can read process environments on macOS).
- TEST_ONLY was exercised by unit tests only, not by an unpackaged Electron run.
- The staged app reused LA8ZS9 binaries (runtime natives, control jar) with this checkout's JS, backend jar and frontend;
  it is not a candidate. Each native/staged run leaves one `adapter-node` crash report (the deliberate SIGTRAP check) in
  `~/Library/Logs/DiagnosticReports`; the two sandbox containers created by the runs
  (`~/Library/Containers/dev.codeintelligence.{test.adapter,desktop.validation}.adapter-supervisor`, 32 KiB each, per-run
  scratch already empty) and the staged app were removed after the evidence was copied.

## What remains (SEC-H-02 open)

1. Flip on the next candidate with the builder change above, then packaged acceptance of every runner listed.
2. Developer ID signing run (Team ID requirement, library validation on, notarization) and C15 evidence.
3. `job-race-product.cjs` equivalent for bridge/worker loss mid-analysis; SBOM rule for the service.
4. Optional size work: prune locales/GPU libraries from the worker framework copy (it runs only as Node).
5. Independent review.
