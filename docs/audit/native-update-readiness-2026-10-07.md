# Native and update gate readiness (G-NATIVE / G-UPDATE) — 2026-10-07

Unit `gate-native-update`, branch `worktree-agent-a288b6b80aae4da1f` from `bcd8081`. Candidate:
`.native-product-1lvULq/Code Intelligence Validation.app` (ad-hoc Validation build from `9211e88`;
runtime manifest SHA-256 `023a8c65…c85d`, `app.asar` `fe08c457…0acc`). No signing, notarization, Keychain,
real profile, paid provider, GitHub account, update host or publication was used. All keys are throw-away
Ed25519 pairs generated in memory by the tests. **This report does not declare either gate PASS.**

## Scope

Requirements from `07-delivery-release-gates.md` §3 (G-NATIVE, G-UPDATE, B9, B10), stage 6,
`05-security-performance-operations.md` §6/§7 (ADR-02), `01-prd.md` D02/D11/D12/O2, C14
`packaged-recovery`. Forbidden substitutes respected: the development Mac's existing `.app` is never
presented as G-NATIVE evidence, and electron-builder options are never presented as G-UPDATE evidence.

## Added

| File | Kind | Purpose |
|---|---|---|
| `validation/pre-release/native-signing-readiness.cjs` | read-only inspector | Every Mach-O in a bundle (and inside JAR/ZIP, nested) vs. the exact signing plan (owned runtime hook selection mirrored + `@electron/osx-sign` walk), inside-out order, signature/ad-hoc/Team ID/secure timestamp/hardened runtime, entitlements per role, `minos`/SDK, external load paths and rpaths, symlinks out of the bundle, xattrs, Electron fuses, `codesign --verify --deep --strict`. `--expect-team-id` turns pending items into release blockers. |
| `validation/pre-release/native-loader-probe.cjs` | native probe | Bundled service binaries run with a stripped environment and again under a `sandbox-exec` profile denying developer roots; with `--packaged-app` the app is launched on a fresh synthetic profile + mock Keychain and every program-text mapping of every app process is classified. |
| `validation/pre-release/update-manifest-reference.cjs` | reference contract (not shipped) | Executable G-UPDATE manifest contract for rehearsal until the updater exists. |
| `desktop/test/signing-readiness.test.cjs` (9), `signing-loader-probe.test.cjs` (7), `update-manifest-reference.test.cjs` (12), `update-anti-rollback.test.cjs` (3, one `todo`) | tests | see results |
| `docs/release/signing-notarization-runbook.md`, `docs/release/update-acceptance-plan.md` | operator docs | credentials handling, command sequence, triage, hash recording, C14 checklist and results sheet; update contract and spec of the missing updater |

`desktop/scripts/sign-macos-runtime.cjs`: an uncommitted refactor left by the interrupted session exported
the runtime signing-target selection. It fixed no reproduced defect, so HEAD's version was restored
byte-for-byte; the inspector mirrors the selection and `signing-readiness.test.cjs` "runtime signing plan is
exactly the set signRuntime signs" pins the mirror to the files the real `signRuntime` re-signs (ad-hoc,
synthetic runtime). **No product or packaging file changed in this unit.**

## What ran

| Run | Command (cwd = worktree root unless noted) | Result |
|---|---|---|
| Targeted suites | `cd desktop && node --test test/signing-readiness.test.cjs test/signing-loader-probe.test.cjs test/update-anti-rollback.test.cjs test/update-manifest-reference.test.cjs test/macos-signing.test.cjs test/runtime-stage.test.cjs test/runtime-stage-containment.test.cjs test/native-runtime-staging.test.cjs` | 119 tests: 118 pass, 0 fail, 1 todo (NU-03) |
| Signing readiness | `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C node validation/pre-release/native-signing-readiness.cjs --app "$PWD/.native-product-1lvULq/Code Intelligence Validation.app"` | `signing-nPG4nt`: READY_FOR_DEVELOPER_ID_SIGNING_PASS; 0 NOTARY/DEPLOYMENT/RELEASE blockers, 200 SIGNING_PENDING, 35 REVIEW, 1 INFO |
| Negative control | same with `--expect-team-id ABCDE12345` (fictitious) | `signing-U3TqZf`: BLOCKED, 300 RELEASE_BLOCKER (100 ad-hoc, 100 no secure timestamp, 100 Team ID mismatch) — the strict mode fires on the ad-hoc candidate as intended |
| Loader probe | `SCRATCH/with-native-lock.sh gate-native-update env -i … node validation/pre-release/native-loader-probe.cjs --app "$PWD/.native-product-1lvULq/Code Intelligence Validation.app" --packaged-app` | 1st `loader-dFf5Gm` FAIL `ISOLATED_RUN_INVALID` (probe defect P-1); 2nd `loader-IZZgkK` FAIL (probe defect P-2); 3rd `loader-MU54XX` **PASS** |

Retained earlier records of the interrupted session (kept, superseded, inspector/probe hashes differ):
`signing-me2v26`, `signing-7mD7Kl`, `signing-FerzMd`, `loader-Oc8ejx` (services only, PASS),
`signing-nMyq3Z` (empty, aborted), `focused-suites.log` (a full `desktop` run of that session: 781 tests,
779 pass, 1 cancelled `backup-recovery-records.test.cjs` "Promise resolution is still pending…", 1 todo;
not rerun here — the cancelled file is gate-recovery's area).

### Signing readiness facts (`signing-nPG4nt`)

- 5,397 files, 14 symlinks (all framework-internal, none escaping or dangling), **100 Mach-O**; signing
  plan = 87 runtime files signed by the owned hook + 719 `osx-sign` targets; **coverage 100/100**,
  inside-out order holds; 156 JAR/ZIP archives with 55,921 entries contain **0 Mach-O**.
- All 100 Mach-O signed, ad-hoc, hardened runtime flag set, no secure timestamp (expected before a
  Developer ID pass: the hook uses `--timestamp` for a real identity); 0 external load paths, 0 external
  rpaths; `codesign --verify --deep --strict` passes.
- Deployment targets: 66 × 13.0 (Electron, PostgreSQL, Redis), 34 × 11.0 (JRE); highest 13.0 = declared
  `LSMinimumSystemVersion` 13.0. SDKs 26.5 (66) and 14.2 (34), all ≥ 10.9.
- Entitlements: one plist for app and inherit (`allow-jit`, `allow-unsigned-executable-memory`,
  `disable-library-validation`, `network.client`, `network.server`); embedded entitlements equal the plan
  on all 21 executables. REVIEW: 20 `ENTITLEMENT_BROADER_THAN_ROLE`, `SANDBOX_ONLY_ENTITLEMENTS_WITHOUT_SANDBOX`.
- Other REVIEW: Electron fuses `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`,
  `EnableNodeCliInspectArguments` enabled and `EnableEmbeddedAsarIntegrityValidation` disabled;
  `default_app.asar` shipped; unused `Squirrel/Mantle/ReactiveObjC` frameworks; 3 PostgreSQL `pgxs` test
  executables, 2 executable shell scripts and 9 static archives shipped; 10 files not world-readable
  (helper `_CodeSignature` and similar); `com.apple.provenance` on 6,138 files (local copy). INFO: DYLD_*
  set by `main.cjs` is ignored under hardened runtime — harmless because all references are relative.

### Loader probe facts (`loader-MU54XX`)

Stripped environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, keys HOME/LANG/LC_ALL/PATH, 0 DYLD_*).
Services step: 10/10 bundled binaries (postgres, initdb, psql, pg_dump, pg_restore, pg_isready,
createdb, redis-server, java, keytool) give identical output with and without the sandbox denying
`/opt/homebrew`, `/usr/local`, `/opt/local`, `/Library/Developer`, Xcode, `/Library/Java`,
`/Library/PostgreSQL`, Docker/Postgres.app and `~/.nvm`… roots; control `ls /opt/homebrew/bin` denied.
Packaged step: ready with backend/postgres/redis/ts-analyzer, not recovery-only; 24 processes, 292
program-text/mapped entries (165 bundle, 86 OS, 24 profile, 17 other data), **0 code mapped from outside
bundle/OS, 0 developer-root mappings, 0 process executables outside the bundle**; PostgreSQL, Redis, JVM,
both libssl copies and `vector.dylib` mapped from the bundle; clean shutdown COMPLETE, profile removed,
bundle manifest/asar hashes unchanged. Non-code "other" entries: 3 user fonts in `~/Library/Fonts`,
LaunchServices/Metal caches in the per-user `/var/folders` area, 8 JVM `hsperfdata_<user>` files in the
shared per-user temp directory (outside the isolated profile; data, not code — recorded for G-SEC).

What this does **not** prove: the development Mac still has `/opt/homebrew`, `/usr/local`,
`/Library/Developer`, `/Library/Java`, Docker; absence of tools, Gatekeeper first launch of a quarantined
download, behaviour on macOS 13.x, and Developer-ID library validation can only be shown on a clean
second Mac or VM.

## Requirement matrix

| ID | Requirement | Product implementation | Evidence (level) | Status |
|---|---|---|---|---|
| N-01 | Developer ID signing (O2) | `sign-macos-runtime.cjs`, `package.json` `mac` | `macos-signing.test.cjs` (fail-closed config, unit + real ad-hoc codesign) | BLOCKED — Developer ID Application identity in the owner's login keychain (`CSC_NAME`) |
| N-02 | Notarization | electron-builder notarize via keychain profile | — | BLOCKED — `xcrun notarytool store-credentials` profile name (`APPLE_KEYCHAIN_PROFILE`) |
| N-03 | Staple + Gatekeeper | electron-builder staple; `gatekeeperAssess:false` → manual `spctl` | — | BLOCKED — N-02 |
| N-04 | Clean macOS matrix (13.x minimum + current) | — | — | BLOCKED — second Apple-silicon Mac/VM on 13.x and current macOS without CLT/Homebrew/Java/Node/Docker/PostgreSQL/Redis |
| N-05 | install → local + GitHub → flow → source on clean Mac | app | — | BLOCKED — N-04 + N-01..03 + production GitHub OAuth app/account |
| N-06 | Exact-digest staging | `runtime-stage.cjs`, `runtime-manifest.cjs` | `runtime-stage*.test.cjs` 81/81 (unit, synthetic); candidate manifest validated by loader probe (packaged, read-only) | PASS |
| N-07 | `otool -L` free of external paths, `@rpath/@loader_path` relocation | `stage-runtime.mjs`, `native-runtime-policy.cjs` | `native-runtime-staging.test.cjs` 2/2; readiness 0 external refs/rpaths on 100 Mach-O; loader probe 0 non-bundle code mappings at runtime (packaged, one Mac) | PASS |
| N-08 | Inside-out signing covers every Mach-O | owned hook + osx-sign | readiness coverage 100/100, order inside-out (candidate, read-only); mirror = real `signRuntime` (unit, ad-hoc) | PASS (plan); real Developer ID pass under N-01 |
| N-09 | Hardened runtime on all code | hook `--options runtime`; `hardenedRuntime:true` | 100/100 runtime flag (candidate) | PASS |
| N-10 | Entitlements justified per role | single plist for all | readiness 20 `ENTITLEMENT_BROADER_THAN_ROLE` + inert sandbox-only keys | FAIL — NS-01 (open) |
| N-11 | Nothing predicts a notary rejection (unsigned/ad-hoc nested code, non-Mach-O executables, escaping symlinks, xattrs, old SDK, Mach-O in archives) | — | readiness 0 NOTARY_BLOCKER (candidate, read-only) | PASS (predictor); actual result under N-02 |
| N-12 | Secure timestamp configured | hook `--timestamp` for non-ad-hoc (`sign-macos-runtime.cjs` `signRuntime`); `@electron/osx-sign` 1.3.3 adds `--timestamp` by default (`dist/cjs/sign.js` 229–234) | code reading; ad-hoc candidate has none by design | NOT RUN — needs N-01 |
| N-13 | Minimum OS of every binary ≤ declared 13.0 (D02 build target) | `minimumSystemVersion: 13.0` | readiness: 66×13.0, 34×11.0 (candidate) | PASS |
| N-14 | D02 minimum OS determined by measurement | — | — | BLOCKED — Mac on macOS 13.x |
| N-15 | New Mac without developer tools (B9) — single-Mac approximation | — | loader probe `loader-MU54XX` (packaged, stripped env + deny-sandbox, one Mac) | PASS (approximation only) |
| N-16 | New Mac without developer tools (B9) — real | — | — | BLOCKED — N-04 |
| N-17 | Stage swap without deletion window (B10) | `runtime-stage.cjs` (build host) | `runtime-stage*.test.cjs` (unit, synthetic crash points) | PASS for build-host staging; installed-app swap → U-01 |
| U-01 | First update = user-confirmed full signed DMG/ZIP | none | — | FAIL — NU-01 (no updater) |
| U-02 | Manifest verified with pinned key, carrying version/platform/arch/SHA-256/schema/minimum version | none | reference rehearsal 12/12 (fixture keys, not product) | FAIL — NU-01 |
| U-03 | Forged signature refused | none | rehearsal PASS | FAIL — NU-01 |
| U-04 | Tampered artifact refused | none | rehearsal PASS | FAIL — NU-01 |
| U-05 | Wrong platform/arch refused | none | rehearsal PASS | FAIL — NU-01 |
| U-06 | Downgrade via update refused | none | rehearsal PASS | FAIL — NU-01 |
| U-07 | Replayed older manifest refused | none | rehearsal PASS | FAIL — NU-01 |
| U-08 | Minimum-version violation refused | area-B `minimumVersion` start gate only | `update-anti-rollback.test.cjs` (real modules, synthetic profile); manifest part rehearsal only | FAIL — NU-01 (manifest); start gate PASS |
| U-09 | TeamID/bundle ID/notarization check of downloaded app | none | rehearsal PASS on observed inputs | FAIL — NU-01 |
| U-10 | Older build refused once a newer build has run (anti-rollback high-water) | floor raised only by backup/restore | `update-anti-rollback.test.cjs` recorded-floor PASS; first-start `todo` fails | FAIL — NU-03 |
| U-11 | minVersion/high-water never lowered by backup restore | `safety-journal.cjs` `mergeRestore` | `update-anti-rollback.test.cjs` + existing `safety-journal.test.cjs` (real modules) | PASS |
| U-12 | Corrupted state fails closed to recovery-only | `safety-lifecycle.cjs` | `update-anti-rollback.test.cjs` (real modules) | PASS |
| U-13 | Downgrade only via signed recovery manifest + compatible checkpoint | none | rehearsal PASS | FAIL — NU-01 |
| U-14 | Migration failure/crash restores bundle + DB + source, newest vault/journal kept | none for updates | — | FAIL — NU-02 |
| U-15 | Recovery-only mode | `safety-lifecycle.cjs`, `main.cjs` | `safety-lifecycle.test.cjs`, U-12 | PASS |
| U-16 | Real update channel end-to-end (C14 U1–U10) | — | — | BLOCKED — NU-01..03 implemented + update host/TLS + offline Ed25519 release key + N-01..04 |

Counts: **PASS 11, FAIL 13, NOT RUN 1, BLOCKED 8** (33 rows: G-NATIVE 8/1/1/7, G-UPDATE 3/12/0/1).

## Defects and findings

| ID | Severity | Status | Finding |
|---|---|---|---|
| NU-01 | High (release blocker) | open | No updater: no check, signed manifest, pinned key, artifact hash, downloaded-app identity check, recovery manifest. Spec and size in `docs/release/update-acceptance-plan.md` §4 (≈1.5–2.5k lines incl. tests). Not started here (new feature). |
| NU-02 | High | open | No pre-update/pre-migration checkpoint coupling previous bundle + DB + source; a failed Flyway migration on a new build has no automated restore path (ADR-02). |
| NU-03 | High (G-UPDATE contract) | open | Area-B floor is raised only by backup/restore maintenance; after a newer build merely starts, a reinstalled older build still opens the profile. Reproduced by the `todo` test. Not fixed alone: raising the floor without the signed recovery path would remove every sanctioned rollback; must land with NU-01. |
| NS-01 | Medium | open | Entitlements broader than role: PostgreSQL/Redis/pgxs/ShipIt receive `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`; JRE and helpers receive more than `allow-jit`; `network.*` keys are inert without App Sandbox. Narrowing needs per-role plists and a Developer ID runtime check (library validation with Team ID). G-SEC decision. |
| NS-02 | Medium | open | Electron fuses permit code injection into the signed process (`RunAsNode`, `NODE_OPTIONS`, inspect args) and asar integrity is off. `RunAsNode` is used by the TS analyzer launch and the Playwright runners rely on the inspector; G-SEC decision. |
| NS-03 | Low | open | Unneeded shipped content: `default_app.asar`, Squirrel/Mantle/ReactiveObjC, PostgreSQL `pgxs` test executables, scripts and static archives. |
| NS-04 | Low | open | JVM writes `hsperfdata_<user>` into the shared per-user temp directory, outside the isolated profile (`-XX:-UsePerfData` or `TMPDIR` per profile would contain it). |
| P-1 | Low (validation tool) | fixed `3a719e4` | Loader probe used `<repo>/.nr` as profile parent; from a deep worktree the profile socket path exceeded the isolated-run budget (`ISOLATED_RUN_INVALID`, `loader-dFf5Gm`). Now a fresh `/private/tmp/cilp-*` parent (as `run-integrity-diagnostic.cjs`), removed after a confirmed shutdown. |
| P-2 | Low (validation tool) | fixed `156d68c` | Loader probe judged executables by `ps comm`; PostgreSQL children retitle themselves, giving a false FAIL (`loader-IZZgkK`). Now the first lsof program-text mapping per pid; red/green test "process executables come from the first program-text mapping…". |

## Limits

One development Mac with developer tools installed; ad-hoc Validation bundle ID
`dev.codeintelligence.desktop.validation`; no Developer ID, notary, Gatekeeper, quarantine or clean
machine; timing and memory are not acceptance values. The update rehearsal exercises a reference
contract, not product code.

## Remaining conditions

1. Owner provides O2 (Developer ID identity, notary keychain profile) and runs the runbook §2–§6.
2. Clean Macs (13.x and current) for C1–C6 in the runbook results sheet.
3. Implement NU-01..03 (updater, pre-migration checkpoint, first-start high-water with recovery manifest), then C14 U1–U10 with an update host and an offline release key.
4. G-SEC decisions on NS-01, NS-02; NS-03/NS-04 cleanups.
