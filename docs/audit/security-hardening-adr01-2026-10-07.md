# G-SEC renderer/packaging hardening and ADR-01 isolation — 2026-10-07

Unit `w1-isolation`, branch `gate/w1-isolation` from `42d3260`, worktree `/Users/minseokchae/Dev/ciw/isolation`.
Source findings: `security-internal-review-2026-10-07.md` (SEC-M-01, SEC-L-01, SEC-M-03, SEC-M-04, SEC-H-02).
No candidate was built. Packaged acceptance of every fix below happens on the next coordinator candidate.
G-SEC stays NOT PASS: SEC-H-02 is not closed (see "What remains").

## Red/green

| Defect | Failing test first (red, as read) | Fix | Green (as read) |
|---|---|---|---|
| SEC-M-01 CSP | `security-renderer-boundary.test.cjs` › "every app-origin response in the product session carries the reviewed CSP…": 1 fail, `no CSP is delivered for app documents`; `validation/pre-release/test/security-packaged-probe.test.cjs`: 4 fail, `rendererCspFailures is not a function` | `desktop/src/main.cjs` sets `Content-Security-Policy` on every app-origin response of the product session (`session.webRequest.onHeadersReceived`), replacing any served policy; probe records `expectations.rendererCsp` | boundary file 11 tests: 9 pass, 0 fail, 2 todo; `main-runtime-gateway` 86/86; probe test 4/4 |
| SEC-L-01 | boundary test "external open and window.open refuse non-https schemes…" (todo removed): `Missing expected rejection: blob:https://github.com/0000…` | `assertExternalUrl` requires `url.protocol === 'https:'` | boundary file 11 tests: 10 pass, 0 fail, 1 todo (SEC-M-02, other unit) |
| SEC-M-03 | `SecurityGitTransportRedirectTest` without `@Disabled`: foreign origin received `Basic …` 3×; 2 added cases (origin challenges first then redirects; fetch of an existing clone) also red | `GitCloneService` binds JGit's HTTP connection factory to the remote's scheme/host/port for clone and fetch (`OriginBoundConnectionFactory`); no connection to another origin is opened, same-origin redirects still work | `dev.codeintelligence.github.*` 74 tests, 0 failures, 0 errors, 0 skipped (4 in the redirect class) |
| SEC-M-04 | `desktop/test/electron-fuses.test.cjs`: file failed to load, then 2/3 fail (`afterPack` not declared) | `desktop/scripts/electron-fuses.cjs` as `build.afterPack`, flipping through electron-builder's own `@electron/fuses` 1.8.0 (resolved offline from `desktop/node_modules`, already in the lock) before signing; probe records `expectations.fuses` | 3/3; packaging tests `runtime-platform`, `macos-signing`, `signing-readiness` 41/41; probe test 5/5 (fuse case red first: `fuseFailures is not a function`) |
| SEC-H-02 transport | `ts-analyzer/src/stdio-transport.test.ts`, `tree-analyzer/src/stdio-transport.test.ts`: module not found | length-prefixed stdio transport + `stdio` entry in both analyzers; tree request validation moved to `request.ts` (HTTP status unchanged) | ts-analyzer 11/11; tree-analyzer 12/12 (with `extract.test.ts`); both `tsc --noEmit` clean |
| SEC-H-02 refusal | `desktop/test/adapter-isolation.test.cjs`: `Cannot find module '../src/adapter-isolation.cjs'` | `desktop/src/adapter-isolation.cjs` + `spawnAnalyzer` behind the `adapterIsolation` build flag | 10/10 (13 with the fuse file); main/renderer/runtime-policy/preload suites 196: 195 pass, 1 todo |

## SEC-M-01 policy and Monaco check

Policy: `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. `blob:` was dropped from the patch plan's
`worker-src`: the bundle creates Monaco and elk workers from same-origin files (`monacoSetup.ts`, Vite `?worker`).

Electron check (`security-hardening-evidence-2026-10-07/csp-harness*`, native lock held): the LA8ZS9 frontend bundle served on
loopback with a fake API, policy string read from `main.cjs`, code explorer opened on a TypeScript file.

| | with CSP | without CSP |
|---|---|---|
| Monaco rendered, token spans / classes | 41 / 6 | 41 / 6 (identical) |
| worker scripts loaded | `workers`, `ts.worker`, `editor.worker` | same |
| CSP console messages outside the attacks | 0 | 0 |
| eval / injected inline script | blocked / blocked | ran / ran |
| cross-origin fetch / img (listener received) | blocked / blocked (nothing) | sent (`/fetch`, `/img`) |
| blob: worker | blocked | ran |

## SEC-M-04 fuses

Product wire: `EnableCookieEncryption`, `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar` on;
`EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`, `GrantFileProtocolExtraPrivileges` off.
`RunAsNode` stays on while `adapterIsolation` is `legacy-http` (the analyzer is started with `ELECTRON_RUN_AS_NODE=1`)
and is off for any other value. Exception: the exact validation app id keeps `EnableNodeCliInspectArguments` on, because
every packaged runner attaches with Playwright `_electron.launch` (`--inspect=0`, checked in playwright-core 1.63.0).
Real flip on an APFS clone of the Electron app (`fuse-results.txt`): wire as listed, `codesign --verify --strict` ok;
`NODE_OPTIONS=--require` ran on the original and not on the flipped binary. **Finding:** in RunAsNode mode `--inspect` is
still honored with the inspect fuse off, so SEC-R54 closes only when RunAsNode is off.

## ADR-01 technical gate spike (T03 first verification gate)

Verdict: **FEASIBLE** for the mechanism on this machine with an ad-hoc signature; not yet proven for Developer ID.

Toolchain: macOS 26.6.2, Command Line Tools only (`xcode-select -p` = `/Library/Developer/CommandLineTools`, no Xcode),
clang 21 with the CLT SDK and `libxpc` (Swift was not needed), `codesign` ad-hoc. Sources and outputs:
`docs/audit/adr01-spike-2026-10-07/` (`build.sh <candidate.app> plain|inherit`, `run.sh`, `direct.sh`, `src/*`, `result-*.txt`;
`result-plain-xpc.txt` is the run before the analyzer path was fixed, `result-plain-node.txt` the Node/probe part after it).
The app bundle `Spike.app` embeds `Contents/XPCServices/Supervisor.xpc` (entitlement `com.apple.security.app-sandbox`
only, hardened runtime). Workers are APFS clones from LA8ZS9 inside the XPC bundle: the bundled JRE 21.0.12, the Electron
main binary plus `Electron Framework`/`Mantle`/`ReactiveObjC`/`Squirrel`, and `runtime/ts-analyzer`.

| Observation | Result |
|---|---|
| Supervisor started by `xpc_connection_create` from the host binary | `sandboxed:1`, `AppSandbox request successful` |
| Exec of a worker outside the XPC bundle (first layout) | denied: `deny(1) process-exec*` for `Spike.app/Contents/Resources/runtime/jre/bin/java` |
| Java worker (candidate signature unchanged) | runs; home listing `DENIED(FileSystemException)`, TCP `Operation not permitted` |
| Node worker (Electron in RunAsNode mode, JIT) running the unchanged `dist/analyze.service.js` | `fileOutcomes SUCCESS TS_PARSED`, 2 nodes, 2 edges; `listen` `EPERM`; home `EPERM` |
| Probe as supervisor child and as Node grandchild | `sandboxed:1`; read and create outside file, TCP connect, TCP listen, UDP send: `Operation not permitted`; DNS `nodename nor servname provided` |
| Unsandboxed control probe, same arguments | everything `ALLOWED`; listener received `tcp:control`, `udp:control` |
| Listener during sandboxed runs | no probe payload (other loopback scanners appeared, unattributed, without payload) |
| `inherit` variant (workers re-signed `app-sandbox`+`inherit`, + JIT keys for java/node) | same results inside the sandbox |
| `inherit`-signed java / Electron-node run directly, no sandboxed parent | `Trace/BPT trap: 5` (exit 133): they cannot run outside a sandbox |

Precise limits and design consequences:
- Ad-hoc only: no Team ID, so the audit-token caller check (Team ID / bundle id) and Developer ID behaviour are untested
  (C15 stays BLOCKED). Keychain denial was not probed (no Keychain access in this unit).
- Workers must sit inside the supervisor's bundle (exec outside it is denied).
- A worker Node runtime is required that does not need the main app's RunAsNode fuse: either a separate Electron
  runtime copy inside the XPC bundle (+~200 MiB, its own fuse wire) or a standard Node runtime (no macOS supply entry
  exists in `desktop/scripts/macos-runtime-supply.json`). Signed `app-sandbox`+`inherit`, such a copy traps when run
  outside the sandbox, which also answers ADR-01's "inherited child must not run unsandboxed".
- The backend's JRE runs unsandboxed, so worker JRE and backend JRE need separate signatures (two copies or one
  inherit-signed worker copy).
- Electron main has no XPC binding: a small native bridge (signed helper executable spoken to over stdio, or an N-API
  addon) is needed; the spike host shows the helper form.

## Production path landed (behind a build flag)

- Analyzers: `analyzers/ts-analyzer/src/stdio-transport.ts`, `stdio.ts`; `analyzers/tree-analyzer/src/stdio-transport.ts`,
  `stdio.ts`, `request.ts`. Wire: 4-byte big-endian length + one UTF-8 JSON object; request frame ≤ 10 MiB + 4 KiB (03 §6
  bound unchanged), handshake ≤ 1 KiB with protocol, version and a 64-hex run token from the supervisor; length is checked
  before any body byte is buffered; a framing/envelope violation ends the session (exit 3), a refused handshake exits 2;
  engine errors are not echoed. The HTTPS (TS) and HTTP (tree) servers are unchanged and stay as dev/test harness.
- Desktop: `desktop/src/adapter-isolation.cjs` — same framing (response frame ≤ 64 MiB), stdio client with run-token
  handshake and in-order responses, supervisor attestation (fixed path `runtime/adapter-supervisor/AdapterSupervisor.xpc/
  Contents/MacOS/AdapterSupervisor`, hash from the runtime manifest, regular file, `codesign --verify --strict`, app-sandbox
  required, network/files/temporary-exception/Keychain/automation/`cs.*` entitlements rejected), and
  `ADAPTER_ISOLATION_UNAVAILABLE` with a reason for every failure. No code path returns an ordinary child.
- Build flag: `adapterIsolation` in `desktop/package.json` (absent = `legacy-http`, the current product; unknown values fail
  closed to `xpc-required`). With `xpc-required`, `spawnAnalyzer` starts nothing, records `runtime.adapterIsolation`
  and logs `DESKTOP_ADAPTER_ISOLATION ADAPTER_ISOLATION_UNAVAILABLE <reason>`; the afterPack hook then turns RunAsNode off.
  The shipped flag is unchanged, so the Validation build analyzes exactly as before.
- Interop (scratch, not committed): the desktop client against the compiled ts-analyzer `stdio.js` returned
  `fileOutcomes PARTIAL/UNRESOLVED_CALLS`, `apiCalls [GET /api/items]`, a 400 rejection for a malformed body, exit 0;
  a wrong run token gave `ADAPTER_ISOLATION_UNAVAILABLE:PROTOCOL_MISMATCH`, adapter exit 2.

## What remains (SEC-H-02 open)

1. Product supervisor and bridge: native XPC service + main-side bridge, built and signed in staging
   (`stage-runtime.mjs`, `sign-macos-runtime.cjs`, runtime manifest entry), with workers inside the XPC bundle.
2. Worker Node runtime without the main app's RunAsNode (separate Electron copy or a supplied Node), inherit-signed.
3. Backend → main control path (03 ADR-01 Unix socket + run capability) replacing `TS_ANALYZER_BASE_URL`; until then,
   `xpc-required` leaves TS analysis unavailable (the backend's analyzer calls fail) and the refusal is not shown in the UI.
4. TEST_ONLY unsigned dev analysis for synthetic fixtures is not implemented.
5. Packaged runners that use the app binary in Node mode (`security-analyzer-execution.cjs`) must change once the flag flips.
6. Developer ID run of the spike (Team ID caller check, C15) and the independent review.

## Limits

Synthetic Electron doubles for main.cjs; the Electron CSP check served the LA8ZS9 bundle without the backend; the fuse
flip ran on a copy of the npm Electron, not a packaged candidate; the spike is ad-hoc and used candidate binaries as
read-only APFS clones. The native lock was found empty (no holder) from 18:10 to about 18:28 KST and was reported to the
coordinator, not removed. The spike's sandbox container `~/Library/Containers/dev.codeintelligence.spike.adr01.supervisor` (28 KiB) and the
scratch app copies were removed after the evidence was copied.
