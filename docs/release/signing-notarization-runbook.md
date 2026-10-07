# Signing, notarization and clean-machine runbook — Code Intelligence macOS (arm64)

> **요약 (한국어).** 이 문서는 사용자가 O2 입력(Developer ID Application 인증서, notarytool 키체인 프로필,
> 최소 OS의 두 번째 Mac)을 제공했을 때 G-NATIVE를 한 번에 실행하기 위한 운영 절차다. 자격 증명은 저장소,
> 환경 파일, 명령줄 인자, 대화 기록에 절대 넣지 않는다: 인증서는 사용자가 로그인 키체인에 직접 가져오고,
> notary 자격 증명은 사용자가 `xcrun notarytool store-credentials`의 대화형 프롬프트로 키체인 프로필에
> 저장하며, 빌드에는 **프로필 이름**과 **인증서 표시 이름**만 전달한다. 순서: 사전 점검 → 서명 준비도 검사
> (읽기 전용) → `npm run dist:mac` (내부→외부 서명, hardened runtime, 보안 타임스탬프, 앱 notarize+staple)
> → DMG notarize+staple → `codesign`/`spctl`/`stapler` 검증 → `--expect-team-id` 준비도 재검사 → 해시 기록 →
> 새 Mac 설치·최소 OS·업데이트(C14) 체크리스트. 2026-10-07 기준 이 절차는 **실행되지 않았다**(BLOCKED O2).
> 이 저장소의 에이전트는 서명·notarize·게시를 수행하지 않는다.

Status 2026-10-07: not executed. Every step below needs inputs only the release owner has.
Read-only readiness evidence for the ad-hoc candidate `1lvULq` is in
`docs/audit/native-update-readiness-2026-10-07.md`.

## 1. Inputs the release owner provides (and how)

| Input | How it is supplied | Never |
|---|---|---|
| Developer ID Application certificate + private key (Team ID `XXXXXXXXXX`) | Owner imports the `.p12` into the **login keychain** by double-click / Keychain Access on the build Mac. | In the repo, in `.env`, as `CSC_LINK`/`CSC_KEY_PASSWORD`, in CI, in a transcript. |
| Identity selection | Display name only: `export CSC_NAME="Developer ID Application: <Org> (<TEAMID>)"` in the owner's shell. List candidates with `security find-identity -v -p codesigning` (prints names/hashes, no secrets). | The certificate hash or private key in any file. |
| Notary credentials | Owner runs **interactively**: `xcrun notarytool store-credentials "ci-notary" --apple-id "<id>" --team-id "<TEAMID>"` and types the app-specific password at the prompt (or `--key/--key-id/--issuer` for an API key kept outside the repo). Builds then use `export APPLE_KEYCHAIN_PROFILE=ci-notary`. | `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_API_KEY` exported in a shared shell, passed on a command line, or pasted to an agent. |
| Build sequence | `export CODE_INTELLIGENCE_BUILD_SEQUENCE=<assigned signed64 decimal>` (README "local macOS desktop runtime"). | Reuse of an issued sequence. |
| Clean Mac(s) | A second Apple-silicon Mac (or VM) on macOS 13.x (declared minimum) and one on the current release, with no Xcode CLT, Homebrew, Java, Node, Docker, PostgreSQL or Redis. | The development Mac or its existing `.app` (forbidden substitute). |

`desktop/scripts/sign-macos-runtime.cjs` `validateMacBuild` refuses a DMG/ZIP build unless hardened runtime,
the owned signing hook, `type: distribution`, `notarize: true`, `forceCodeSigning: true`, complete notary
credentials (keychain profile accepted) and a real `Developer ID Application:` identity are present
(`desktop/test/macos-signing.test.cjs`).

## 2. Pre-flight (build Mac)

```bash
df -k "$HOME"                                       # ≥ 15 GiB free for stage + dmg + zip
xcrun notarytool history --keychain-profile ci-notary | head -3   # proves the profile works; prints no secret
security find-identity -v -p codesigning | grep "Developer ID Application"
git status --porcelain                              # clean tree at the release commit
```

## 3. Build, sign (inside-out), notarize and staple the app

```bash
cd desktop
npm ci --install-links
CODE_INTELLIGENCE_BUILD_SEQUENCE=<N> CSC_NAME="Developer ID Application: <Org> (<TEAMID>)" \
  APPLE_KEYCHAIN_PROFILE=ci-notary npm run dist:mac
```

What happens: `stage-runtime.mjs` stages the runtime → electron-builder calls the owned hook, which signs
every Mach-O listed in `runtime/runtime-manifest.json` with `--options runtime --timestamp` and the
inherit entitlements, re-verifies each, refreshes only their manifest hashes, then `@electron/osx-sign`
signs the remaining code deepest-first and the app last, and `codesign --verify --strict --deep` runs →
electron-builder notarizes the app via the keychain profile and staples it → DMG and ZIP are produced
(`dist/Code Intelligence-<version>-arm64-mac.{dmg,zip}`). `gatekeeperAssess` is `false`, so Gatekeeper is
checked manually in §4.

Notarize and staple the DMG itself (the app inside is already stapled):

```bash
xcrun notarytool submit "dist/Code Intelligence-<version>-arm64-mac.dmg" --keychain-profile ci-notary --wait
xcrun stapler staple "dist/Code Intelligence-<version>-arm64-mac.dmg"
```

## 4. Verify (expected output)

```bash
APP="$PWD/dist/mac-arm64/Code Intelligence.app"; DMG="dist/Code Intelligence-<version>-arm64-mac.dmg"
codesign --verify --deep --strict --verbose=2 "$APP"   # "valid on disk" + "satisfies its Designated Requirement"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Authority=Developer ID Application|TeamIdentifier|flags=|Timestamp="
                                                        # flags include runtime; Timestamp= present (not "Signed Time")
spctl --assess --type execute --verbose=4 "$APP"        # "accepted" + "source=Notarized Developer ID"
xcrun stapler validate "$APP"                           # "The validate action worked!"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"   # accepted, Notarized Developer ID
xcrun stapler validate "$DMG"
cd .. && node validation/pre-release/native-signing-readiness.cjs --app "$APP" --expect-team-id <TEAMID>
                                                        # status READY_FOR_NOTARIZATION_SUBMISSION, 0 *_BLOCKER
```

The readiness inspector is read-only; it compares every Mach-O with the signing plan, checks Team ID,
secure timestamp, hardened runtime, entitlements per role, deployment target ≤ 13.0, external library
references, symlinks out of the bundle, Mach-O inside JARs, extended attributes and Electron fuses.

## 5. Failure triage

| Symptom | Likely cause | Action |
|---|---|---|
| `MAC_NOTARY_CREDENTIALS_REQUIRED` / `MAC_DEVELOPER_ID_REQUIRED` before packing | profile/identity not visible to the shell | redo §1 in the same login session; never fall back to ad-hoc |
| `MAC_RUNTIME_SIGN_OPTIONS_UNSUPPORTED` | builder passed per-file options the hook does not reproduce | stop; fix config, do not bypass the hook |
| notarytool `Invalid` | inspect `xcrun notarytool log <submission-id> --keychain-profile ci-notary` | map each path to the readiness report row (unsigned nested code, no timestamp, no hardened runtime, Mach-O in archive) |
| `spctl` "rejected" / "source=Unnotarized Developer ID" | ticket not stapled or notarization not finished | rerun staple; check submission status |
| `codesign --verify` "a sealed resource is missing or invalid" | bundle modified after signing (xattrs, copied files) | rebuild; never re-sign by hand |
| `MAC_MANIFEST_CHANGED_AFTER_SIGNING` | outer signing touched the runtime | stop; this is a packaging defect |

## 6. Recording hashes

After §4 passes record, in the release ledger (`docs/audit/<release>-<date>.json`) and in the signed update
manifest body (`artifact.size`, `artifact.sha256`, see `update-acceptance-plan.md` §2):

```bash
shasum -a 256 "$DMG" "dist/Code Intelligence-<version>-arm64-mac.zip" \
  "$APP/Contents/Resources/runtime/runtime-manifest.json" "$APP/Contents/Resources/app.asar"
stat -f %z "$DMG"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "^(CDHash|TeamIdentifier|Identifier)="
```

plus the notarization submission IDs, the readiness report path and its SHA-256, and the build sequence.

## 7. Clean-machine, minimum-OS and update checklist (C14)

On each clean Mac (13.x minimum and current release), fresh user account:

1. Confirm absence: `xcode-select -p` fails; `/opt/homebrew`, `/usr/local/bin/{node,java,psql,redis-server}`, `/Library/Java`, Docker absent.
2. Download the DMG through a browser (quarantine applied) → open → drag to `/Applications` → first launch shows only the standard Gatekeeper "downloaded from the internet" prompt; no "unidentified developer".
3. App reaches ready with backend, postgres, redis, ts-analyzer running; `ps -o comm=` of all children under `/Applications/Code Intelligence.app`.
4. Import a local project → analysis completes → flow view → source view.
5. Connect GitHub with the production OAuth app → import a repository → flow → source.
6. Quit; relaunch; data intact. Backup and restore once.
7. On the development Mac only (supporting, not acceptance): `node validation/pre-release/native-loader-probe.cjs --app "<repo>/.native-product-<id>/Code Intelligence Validation.app" --packaged-app`.
8. Update cases U1–U10 from `update-acceptance-plan.md` §5 (requires the updater, NU-01..03).

## 8. Results sheet

| Row | Mac / OS | Build seq | Result (PASS/FAIL) | Evidence path / submission ID | Operator, date |
|---|---|---|---|---|---|
| S1 codesign verify (app) | build Mac | | | | |
| S2 spctl execute (app) | build Mac | | | | |
| S3 stapler validate (app, DMG) | build Mac | | | | |
| S4 readiness `--expect-team-id` | build Mac | | | | |
| C1 tools absent | 13.x | | | | |
| C2 Gatekeeper first launch | 13.x | | | | |
| C3 services ready, bundle-only processes | 13.x | | | | |
| C4 local project → flow → source | 13.x | | | | |
| C5 GitHub → flow → source | 13.x | | | | |
| C6 relaunch, backup/restore | 13.x | | | | |
| C1–C6 | current macOS | | | | |
| U1–U10 | 13.x | | | | |
