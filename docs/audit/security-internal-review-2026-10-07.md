# G-SEC internal security review — 2026-10-07

**This is an internal check that prepares, and does not replace, the independent review required by
G-SEC.** It does not produce the signed-helper C15 OS-denial evidence either. The gate stays NOT PASS;
this report gives row-level facts and a recommendation.

- Branch `worktree-agent-adc5afddf7b377171`, base `bcd8081`.
- Candidate examined: `.native-product-1lvULq` (build sequence `1791292686000`, app.asar
  `fe08c457…0acc`, runtime manifest `023a8c65…c85d`), unchanged ad-hoc build of `9211e88`.
  `src/main.cjs` and `src/preload.cjs` inside app.asar are byte-identical to this branch.
- Ledger: `security-internal-review-2026-10-07.json` (commands, counts, evidence hashes, full matrix).

## Scope

References: `05-security-performance-operations.md` §1–§2, ADR-01 in `03-architecture-contracts.md`,
G-SEC and B11 in `07-delivery-release-gates.md`, C15 in `06-benchmarks-validation.md`. Rows owned by
other units are cited, not re-tested: local ingest (§1 rows 2–6, 8, quarantine) by `gate-import-evidence`,
AI egress dispatcher (DNS rebinding, IPv4-mapped IPv6, decimal/octal hosts, trailing dot, userinfo,
private destinations) by `gate-cost` (`desktop/test/ai-https-transport.test.cjs`, `ai-egress*.test.cjs`).

## What ran

| Check | Kind | Result |
|---|---|---|
| `SecurityGitImportExecutionTest` against HEAD `GitCloneService` (red) | backend unit, real JGit | 4 tests, 1 failed: `executed-sentinel-evil` created |
| same test with the fix (green) + whole `dev.codeintelligence.github` package | backend unit | 71 tests, 0 failed, 1 skipped (`@Disabled` SEC-M-03) |
| `Security*` backend tests + `DesktopSecurityConfigurationTest` + `github.*` + `auth.*` | backend unit | 279 tests, 272 passed, 0 failed, 7 skipped (6 opt-in `CI_GITHUB_STORE_REAL`, 1 SEC-M-03) |
| `desktop/test/security-renderer-boundary.test.cjs` | real main.cjs/preload.cjs, synthetic Electron | 10 tests: 8 pass, 2 `todo` failing (SEC-M-02, SEC-L-01) |
| existing desktop `main-runtime-gateway`, `service-transport*`, `preload-version`, `native-runtime-policy` | desktop unit | 195 tests: 191 pass, 0 fail, 4 skipped |
| `frontend/src/features/security-rendering.test.tsx` | vitest/jsdom, real router | 3/3 pass |
| `security-analyzer-execution.cjs` on the packaged ts-analyzer (Electron Node mode) | packaged binary | run 1 `analyzer-AuwyRv` FAIL (1 violation, see below); run 2 `analyzer-1Ofv74` PASS |
| `security-packaged-probe.cjs` on the candidate, fresh synthetic profile, mock Keychain | packaged app | `packaged-zeF2B1` COMPLETE, clean shutdown |

Analyzer run 1 recorded one `fs.statSync` of the analyzer's own `typescript.js` with swapped case
(TypeScript's case-sensitivity self-check). The data volume is case-insensitive APFS, so this is the same
install file. The probe now lists such reads under `caseFoldedInstall` instead of `violations`; run 2 lists
exactly that one call there and has 0 violations. Run 1 is kept unchanged. Run 2: hostile tsconfig
`extends`/plugins/`typeRoots`/paths, package scripts, absolute and traversal imports and a remote dynamic
import produced no file read outside the install directory, no process/socket/DNS/HTTP/worker/native-addon
call, no sentinel, no outside secret in the response; all 6 hostile paths were refused. The response had
0 symbols, so this proves non-execution, not full parsing of the hostile project.

The earlier probe record `packaged-xEV5KE` (previous session, stopped while `RUNNING`) is kept; its
signing fields were empty because the probe dropped `codesign` stderr on exit 0. That probe defect was
fixed (`spawnSync`) before `packaged-zeF2B1`, whose `probeSha256` equals the committed probe.

## Packaged facts (`packaged-zeF2B1`)

- Signing as built: all 8 inspected binaries (main, 4 helpers, java, postgres, redis-server) are
  `adhoc,runtime` (hardened runtime on, no Team ID) with entitlements `allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`, `network.client`, `network.server`.
  `default_app.asar` present; `ElectronAsarIntegrity` in Info.plist.
- Fuses: `RunAsNode` ENABLE, `EnableNodeOptionsEnvironmentVariable` ENABLE, `EnableNodeCliInspectArguments`
  ENABLE, `EnableEmbeddedAsarIntegrityValidation` DISABLE, `OnlyLoadAppFromAsar` DISABLE,
  `GrantFileProtocolExtraPrivileges` ENABLE, `EnableCookieEncryption` DISABLE. Demonstrated:
  `ELECTRON_RUN_AS_NODE=1` runs Node 44.4.5 inside the packaged binary and `NODE_OPTIONS=--require` executed
  the marker. Playwright's `--inspect=0 --remote-debugging-port=0` were honored (that is how it attached).
- webPreferences (1 window, 1 webContents): `contextIsolation` true, `sandbox` true, `nodeIntegration*`
  false, `webSecurity` true, `allowRunningInsecureContent` false, `webviewTag` false. No Node globals in
  the renderer; bridge keys `apiBaseUrl, apiToken, appVersion, authorizeDroppedFolder, backup,
  openExternal, pickFolder, platform, restartRuntime, restore, runtimeStatus`.
- CSP: none delivered (no header on `/`, no meta). Injected inline script ran; `eval` allowed; a
  cross-origin `fetch` and an `<img>` reached the probe's loopback listener (no token header, no Origin).
  `file:` fetch blocked; `window.open` returned null; navigation to http/file/data stayed on the app origin;
  `openExternal` rejected `file:`, `vscode:`, `https://evil.example/`, `javascript:`; a synthetic `File`
  grant was rejected. The listener also logged 4 `GET /` without token or Origin whose source was not
  attributed.
- Listening sockets of the owner tree: TCP only on `127.0.0.1` (Electron main ×2, PostgreSQL, analyzer,
  one process classified `OTHER`, backend). The backend JVM additionally held 3 UDP sockets on `*`
  (unconnected, no LISTEN state; source not attributed).
- Local API (HTTPS): without token `/`, `/actuator/health`, `/api/projects`, path grant → 401. With the
  token: cross-site Origin, other loopback port, `null` Origin, `Sec-Fetch-Site: cross-site`, rebinding Host
  with attacker Origin → 403; path grant without path capability → 403; rebinding Host **without** Origin
  → 200. Plain HTTP to the port → 400. Analyzer `/health` and `/analyze` without token → 401.
  PostgreSQL refused `codeintel` and `postgres` without password. Redis TCP authentication was **not
  probed**: the Redis listener was not attributed to the `REDIS` role (2 private Unix sockets observed).
- Child argv: 0 secrets in 24 processes. Child env: backend JVM carries the 6 runtime secrets (its
  documented inputs); analyzer carries its own `TS_ANALYZER_AUTH_TOKEN`; a PostgreSQL server process carries
  `PGPASSWORD` equal to the DB password (`desktop/src/main.cjs` `postgresEnvironment()`).
- Profile modes: 70 directories, 1704 files, 0 not 0700/0600. Plaintext scan of the whole profile plus
  app stdout/stderr for the 6 runtime secrets (58.6 MB): 0 hits.

## Findings

| ID | Sev | Status | Summary |
|---|---|---|---|
| SEC-H-01 | High | **Fixed** (`a8e6101`) | Hostile `.gitattributes` selected a filter driver from the user's Git config; JGit ran its smudge command on clone checkout and fetch reset |
| SEC-H-02 | High | Open | ADR-01 isolation not implemented: production analyzers are ordinary child processes with a loopback HTTPS server |
| SEC-M-01 | Medium | Open | No CSP delivered; inline script, eval and remote fetch/img work in the product renderer |
| SEC-M-02 | Medium | Open | `folder:authorize` grants any absolute path a renderer sends; no native confirmation |
| SEC-M-03 | Medium | Open | Clone credentials are sent to an origin reached through a cross-origin redirect |
| SEC-M-04 | Medium | Open | Fuses allow `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`; asar integrity off |
| SEC-L-01 | Low | Open | `blob:https://github.com/…` passes the origin-only external-open allowlist |
| SEC-L-02 | Low | Open | PostgreSQL server env carries the DB password as `PGPASSWORD` |
| SEC-L-03 | Low | Open | Local API accepts any `Host` when a valid token is sent without Origin |
| SEC-L-04 | Low | Open | Backend JVM holds 3 UDP sockets bound to `*`, unattributed |

**SEC-H-01.** Scenario: user ran `git lfs install` (or defines any filter); a public repo sets
`* filter=lfs` (or another name) and `.lfsconfig`; importing it runs `git-lfs smudge` / the user's filter on
hostile content, including attacker-directed LFS egress. The packaged backend gets the real `HOME`
(`desktop/src/runtime-platform.cjs` env allowlist), so JGit reads `~/.gitconfig`. Reproduction:
`SecurityGitImportExecutionTest.userConfiguredSmudgeDriverSelectedByHostileAttributesNeverRunsOnCloneFetchOrReset`
(red on HEAD `GitCloneService`: `executed-sentinel-evil`; evidence `repro-git-filter-before-fix`,
`redgreen-gitclone-red`). Fix: clone with `setNoCheckout(true)`, write `* -filter` to
`$GIT_DIR/info/attributes` (highest precedence), then hard-reset; the same file is rewritten before every
fetch. Green: `redgreen-gitclone-green`. Severity: command execution from imported content, in the threat
model (repo content is untrusted), explicit policy "no filter execution". Path: `backend/src/main/java/dev/codeintelligence/github/GitCloneService.java`.

**SEC-H-02.** From code: `desktop/src/main.cjs` spawns the TS analyzer with `ELECTRON_RUN_AS_NODE=1` and
`TS_ANALYZER_HOST=127.0.0.1`/TLS/port env; no XPC, App Sandbox or stdio transport exists in `desktop/src` or
`backend/src/main`. ADR-01 forbids the HTTP sidecar as production isolation and requires
`ADAPTER_ISOLATION_UNAVAILABLE` instead of an ordinary child. A parser code-execution bug triggered by an
untrusted repository runs with the user's full file and network rights. Not narrowly fixable (T03
architecture). Rated High because 07's risk table makes ADR-01 failure release-blocking.

**SEC-M-01.** Patch plan: deliver a CSP for app documents (backend response header or
`session.webRequest.onHeadersReceived` in main): `default-src 'self'; script-src 'self'; connect-src 'self';
img-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; object-src 'none';
base-uri 'none'; frame-ancestors 'none'` (verify Monaco needs). Extend the packaged probe to require
`documentCsp` non-null, `injectedInlineScriptRan` false, `crossOriginFetch` blocked. Medium: defence in
depth; no XSS sink was found (`security-rendering.test.tsx`), but any future sink would get the bridge and
the API token with free exfiltration.

**SEC-M-02.** Reproduction: `security-renderer-boundary.test.cjs` todo case; `folder:authorize` with `/`
from a trusted-origin sender reaches the backend grant without a dialog. 05 §1 says only native dialog
results are granted. Patch plan: resolve dropped files in main (record the drop path set from
`webUtils.getPathForFile` events per window with a short expiry) or confirm with a main-side
`dialog.showMessageBox`; reject anything else; flip the todo to a normal test. Medium: needs renderer
compromise first.

**SEC-M-03.** Reproduction: `SecurityGitTransportRedirectTest` (currently `@Disabled`; run without the
annotation it fails: foreign origin received `Basic …` three times; evidence
`repro-clone-redirect-credentials`). Production clone URLs are `https://github.com` only (`RepoRefTest`), so
exploitation needs a GitHub-issued cross-origin redirect. Patch plan: set JGit `http.followRedirects=false`
for clone/fetch, or an origin-bound `CredentialsProvider` that answers only for `https://github.com`;
remove `@Disabled`.

**SEC-M-04.** Scenario: any same-user process runs code as the signed app identity
(`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`) and can then pass Keychain ACLs for the safeStorage
item and the caller-identity check that ADR-01's XPC design relies on. Medium (not High) because 05 §1
excludes same-user malware. Patch plan (release step, needs a new candidate): flip
`EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`, `GrantFileProtocolExtraPrivileges`
off and `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`, `EnableCookieEncryption` on in an
`afterPack` hook with `@electron/fuses`; turning `RunAsNode` off requires moving the analyzer spawn
(`main.cjs`) to `utilityProcess.fork` or a separately signed Node; narrow entitlements per binary
(`disable-library-validation`, `allow-unsigned-executable-memory` only where needed); remove
`default_app.asar`.

**SEC-L-01.** `assertExternalUrl` (`desktop/src/main.cjs`) compares `URL.origin` only; add
`url.protocol === 'https:'`. **SEC-L-02.** Pass `PGPASSWORD` only to `initdb`/`psql`/`pg_isready` calls, not
to the `postgres` server spawn (or use a 0600 passfile). **SEC-L-03.** Add a Host allowlist
(`127.0.0.1:<port>`) in the desktop authentication filter; today the token plus TLS pinning already stop a
rebinding page. **SEC-L-04.** Attribute with `lsof -p` + a thread dump; likely client DNS sockets (not
verified).

## Requirement matrix (summary)

Full rows with code locations and evidence are in the JSON ledger (`matrix`). Counts: **PASS 26,
FAIL 10, NOT RUN 13, BLOCKED 2**.

Non-PASS rows:

| Row | Status | Reason |
|---|---|---|
| SEC-R01b only native dialog results are granted | FAIL | SEC-M-02 |
| SEC-R24 child env minimal | FAIL | SEC-L-02 |
| SEC-R26 GitHub redirect re-check, no cross-origin Authorization | FAIL | SEC-M-03 |
| SEC-R33 no remote content | FAIL | SEC-M-01 (renderer fetch/img reach other origins) |
| SEC-R35 CSP maintained | FAIL | SEC-M-01 |
| SEC-R38 external open https-only | FAIL | SEC-L-01 |
| SEC-R43b Host header validation | FAIL | SEC-L-03 |
| SEC-R50 ADR-01 parser isolation | FAIL | SEC-H-02 |
| SEC-R53 fuses block RunAsNode/NODE_OPTIONS | FAIL | SEC-M-04 |
| SEC-R54 no --inspect/remote debugging honored | FAIL | SEC-M-04 |
| SEC-R02–R06, R08 local-ingest rows | NOT RUN | owned by `gate-import-evidence` |
| SEC-R10 branch pinned to commit OID | NOT RUN | no proving test identified by this unit |
| SEC-R14 no credential helper | NOT RUN | static process rule covers backend code, not JGit internals |
| SEC-R15 quarantine 0700/512 MiB/cleanup | NOT RUN | owned by `gate-import-evidence` |
| SEC-R21 safeStorage wrapping, no plaintext fallback | NOT RUN | `purpose-keyring`/`ai-desktop-gateway` tests not run by this unit (owned by `gate-cost`) |
| SEC-R22b GitHub/BYOK sentinels in diagnostics/crash output | NOT RUN | packaged run had no GitHub token or BYOK key |
| SEC-R27 AI egress dispatcher bypasses | NOT RUN | owned by `gate-cost` (`ai-https-transport.test.cjs`) |
| SEC-R45 Redis loopback-only auth | NOT RUN | probe did not attribute the Redis listener |
| SEC-R51 C15 OS denial with signed helper | BLOCKED | Developer ID signing and an ADR-01 implementation |
| SEC-R52 independent review, High 0 | BLOCKED | an independent reviewer |

## Recommendation

G-SEC stays NOT PASS: one High is open (SEC-H-02), C15 and the independent review are BLOCKED. SEC-H-01 is
fixed on source only; the fix invalidates candidate `1lvULq` for the GitHub import path. SEC-M-01..04 should
be fixed before the release candidate is rebuilt.

## Hand-off for the independent reviewer

- Scope: Electron main/preload (`desktop/src/main.cjs`, `preload.cjs`), local API security chain
  (`backend/.../common/config`, `auth`), GitHub import (`backend/.../github`), analyzers
  (`analyzers/ts-analyzer`, `analyzers/tree-analyzer`), packaging fuses/entitlements.
- Threat model: 05 §1 first paragraph and table; §2 network table and renderer/IPC/local API paragraph;
  ADR-01 in 03.
- Rerun (from the worktree root):
  - backend: `cd backend && ./gradlew --offline test --tests 'dev.codeintelligence.common.SecuritySourceExecutionTest' --tests 'dev.codeintelligence.common.config.SecurityLocalApiBoundaryTest' --tests 'dev.codeintelligence.common.config.DesktopSecurityConfigurationTest' --tests 'dev.codeintelligence.github.*' --tests 'dev.codeintelligence.auth.*' --rerun`
  - desktop: `cd desktop && node --test test/security-renderer-boundary.test.cjs`
  - frontend: `cd frontend && npx vitest run src/features/security-rendering.test.tsx`
  - packaged (wrap with the native lock): `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C node validation/pre-release/security-analyzer-execution.cjs --app "$PWD/.native-product-1lvULq/Code Intelligence Validation.app"` and the same with `security-packaged-probe.cjs`.
- Open questions: severity of SEC-M-04 under a Developer ID build; whether CSP is compatible with Monaco
  workers; source of the 4 unattributed `GET /` and the 3 wildcard UDP sockets; Redis TCP authentication on
  the packaged build; whether any JGit path can still spawn a process (credential helper, hooks on fetch).

## Limits

Synthetic Electron double for IPC tests; jsdom for rendering; one packaged run on a non-quiet machine; no
real GitHub account, no BYOK key, no Developer ID signature; timing not recorded.
