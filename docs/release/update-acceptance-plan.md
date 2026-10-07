# G-UPDATE acceptance plan — Code Intelligence macOS

> **요약 (한국어).** 현재 제품에는 업데이트 기능이 없다. 업데이트 확인, 서명된 매니페스트 검증(고정 공개키),
> 아티팩트 해시 검증, 다운로드된 앱의 TeamID·bundle ID·notarization 확인, 업데이트 전 체크포인트와
> 마이그레이션 실패 복원이 모두 구현되어 있지 않다(NU-01, NU-02). 존재하는 부분은 영역 B(safety journal)의
> `minimumVersion` 하한과 recovery-only 모드뿐이며, 이 하한은 백업/복원 maintenance에서만 올라가고 새 빌드의
> 첫 시작에서는 기록되지 않는다(NU-03, `todo` 테스트로 고정). 이 문서는 업데이트 계약을 정의하고, 임시
> 생성 키(fixture key)로 수행한 계약 리허설 결과와, 업데이트 구현 후 O2 입력(Developer ID, 업데이트 호스트,
> 릴리스 서명 키)으로 실행할 수락 절차를 기록한다. 리허설 PASS는 G-UPDATE PASS가 아니다.

Gate (07 §3): **G-UPDATE — signed manifest/artifact, forged-signature and downgrade refusal,
schema crash → restore.** Forbidden substitute evidence: *an electron-builder option existing*.
Contract sources: `05-security-performance-operations.md` §6 and §7 (ADR-02), `01-prd.md` D11/D12/O2,
corpus C14 `packaged-recovery` in `06-benchmarks-validation.md`.

## 1. What exists in the product today

| Piece | Exists? | Where / evidence |
|---|---|---|
| In-app update check, manifest fetch, download, install hand-off | **No** (NU-01) | No `publish` block in `desktop/package.json` `build`, no `electron-updater` dependency, no `autoUpdater` use in `desktop/src`. Electron's `Squirrel.framework`, `Mantle.framework`, `ReactiveObjC.framework` ship in the bundle unused (readiness finding `UNUSED_UPDATER_FRAMEWORKS_SIGNED`). |
| Manifest signature verification with a pinned public key | **No** (NU-01) | Contract rehearsed only in the non-shipped reference `validation/pre-release/update-manifest-reference.cjs`. |
| Artifact size/SHA-256 check | **No** (NU-01) | Reference `verifyArtifactBytes`. |
| TeamID / bundle ID / notarization check of the downloaded app | **No** (NU-01) | Reference `verifyInstalledIdentity` (inputs observed from `codesign`/`spctl`/`stapler`). |
| Anti-rollback high-water in area B | **Partial** | `desktop/src/safety-lifecycle.cjs` refuses normal start when `minimumVersion > runningBuild` (`SAFETY_RECOVERY_REQUIRED`, recovery-only). `desktop/src/safety-journal.cjs` `mergeRestore` never lowers it. **Gap NU-03:** the floor is only raised by backup/restore maintenance, never by a normal first start of a newer build. |
| Pre-update / pre-migration checkpoint coupling bundle + DB + source | **No** (NU-02) | Backup/restore (`desktop/src/backup-*.cjs`) and its recovery checkpoint exist for user-initiated restore only; nothing captures the previous app bundle or triggers a checkpoint before Flyway migrates on a new build. |
| Recovery-only mode | **Yes** | `SafetyLifecycleError.recoveryOnly`, `main.cjs` `runtimeStatus().recoveryOnly`; covered by `safety-lifecycle.test.cjs` and `update-anti-rollback.test.cjs`. |
| Build-time runtime stage swap without a deletion window (B10) | **Yes (build host only)** | `desktop/scripts/runtime-stage.cjs`; `runtime-stage*.test.cjs`. This is the staging tree on the build machine, not an installed-app update swap. |

## 2. Manifest contract (reference)

Envelope `{ keyId, body, signature }`. `signature` = Ed25519 over
`"CI-UPDATE-MANIFEST-1\0" + canonical(body)` (sorted keys, safe integers only, no floats/undefined/dates).
Body fields are exact (no extras): `format, kind ('update'|'recovery'), product, bundleId, teamId, channel,
serial, issuedAt, expiresAt, version, buildSequence, platform, arch, minimumSystemVersion,
compatibleFromBuild, schema{flyway, safetyJournalMajor, backupFormat}, artifact{kind, url, size, sha256},
recovery{checkpointId, checkpointSchemaFlyway, reason}|null`.

Verification order (fail closed, first failure wins): pinned key ID known → signature → body schema →
product/bundle/team identity → platform → arch → validity window (5 min skew) → serial strictly above the
last accepted serial (replay) → `update`: target build strictly above running build and not below the
area-B high-water; `recovery`: bound to a retained checkpoint with equal schema and creator build ≤ target →
host OS ≥ `minimumSystemVersion` → running build ≥ `compatibleFromBuild` → schema not older than running →
artifact URL is HTTPS on an allow-listed host without credentials, port or fragment. After download:
size and SHA-256 (constant-time compare). After unpacking, before first launch: `codesign --verify --deep
--strict`, Team ID and bundle ID from the code signature (not the manifest), Gatekeeper + stapled ticket,
build sequence equals the manifest. Install raises high-water and last serial; a restore merge only raises.

## 3. Fixture-key rehearsal (run 2026-10-07)

Keys: two Ed25519 pairs generated in memory per test process (`release`, `attacker`), never written to
disk, never real. Synthetic artifact bytes. Host `updates.example.invalid`, Team ID `ABCDE12345` (fictitious).

| Case (prompt deliverable 2) | Test | Result |
|---|---|---|
| Valid signed, current, compatible manifest + matching artifact accepted | `update-manifest-reference.test.cjs` "a correctly signed…" | PASS |
| Forged signature (attacker key under the pinned key ID), unknown key ID | "forged signature…" | PASS |
| Tampered manifest field or artifact byte/size | "tampered manifest or artifact…" | PASS |
| Wrong platform / arch / bundle ID / Team ID | "wrong platform, architecture or product identity…" | PASS |
| Downgrade (older, equal, below high-water) | "downgrade…" | PASS |
| Replayed older manifest (superseded serial) | "replayed older manifest…" | PASS |
| Minimum-version violation (host OS, direct-upgrade floor, schema) | "minimum-version violations…" | PASS |
| Artifact URL host/scheme/credential/port | "artifact location must be an allowlisted HTTPS host…" | PASS |
| Exceptional downgrade only with signed recovery manifest + compatible checkpoint | "exceptional downgrade only through a signed recovery manifest…" | PASS |
| TeamID/bundle/notarization of installed app from code signature | "installed app identity comes from its code signature…" | PASS |
| Restore never lowers high-water (reference state) | "high-water state is monotonic…" | PASS |
| Canonical encoding ambiguity | "canonical encoding rejects values…" | PASS |
| **Product** area-B floor: older build refused after a recorded floor, B not reset, older restore keeps the floor | `update-anti-rollback.test.cjs` "downgrade after a recorded high-water…" (real `safety-lifecycle`/`purpose-keyring`/`safety-journal` on a synthetic profile) | PASS |
| **Product** corrupted journal fails closed to recovery-only | "a corrupted safety journal fails closed…" | PASS |
| **Product** older build refused after a newer build merely *started* | "after a newer build has started…" | `todo` — fails today (NU-03) |
| Schema-migration failure/crash → restore bundle + DB + source, newest vault/journal kept | — | NOT RUN: no update path or pre-update checkpoint exists (NU-02). User-initiated restore crash recovery is owned by gate-recovery (`backup-*`, `restore-interruption` audits). |

Command (cwd `desktop/`): `node --test test/update-manifest-reference.test.cjs test/update-anti-rollback.test.cjs`.

## 4. Specification of the missing updater (NU-01/02/03)

Estimated size: about 1,500–2,500 lines including tests, 1–2 engineer-weeks [estimate].

- `desktop/src/update-manifest.cjs` — promote `validation/pre-release/update-manifest-reference.cjs`
  unchanged in behaviour (`verifyUpdateManifest`, `verifyArtifactBytes`, `verifyInstalledIdentity`,
  `raiseHighWater`, `mergeAfterRestore`); delete the reference afterwards. Public keys only, pinned in
  `desktop/build/update-keys.json` and packed into the asar; key rotation = new key ID in a signed build.
- `desktop/src/update-service.cjs` — `check()` (user-initiated or daily, HTTPS GET via `net` with a
  size cap), `download(manifest)` into a private directory under `userData/updates/<serial>/`,
  `verifyDownloaded()` (hash, then mount/unpack read-only, then `codesign --verify --deep --strict`,
  `spctl --assess --type execute`, `stapler validate`, Team ID/bundle ID from `codesign -dv`),
  `handOff()` — first update is a user-confirmed full signed DMG/ZIP: reveal the verified artifact and
  quit; no silent in-place swap (05 §6).
- Area B (`safety-journal.cjs`): a `recordStartedBuild(runningBuild)` maintenance record written after a
  successful normal start that raises `minimumVersion`, plus `lastManifestSerial`. It must land together
  with the signed recovery-manifest path; adding the floor alone would leave no sanctioned rollback.
- Pre-migration checkpoint: on first start of a build whose Flyway target exceeds the recorded schema,
  take the existing backup-subsystem checkpoint (DB + source vault references + journal pointer) and
  record the previous bundle path/hash before the backend migrates; on migration failure enter
  recovery-only and offer restore of bundle + DB + source while keeping the newest vault/journal (ADR-02).
- UI: update available / verified / ready-to-install states; recovery-only explanation.
- Tests: move `update-manifest-reference.test.cjs` onto the product module; add service tests with a
  local HTTPS fixture server and fixture keys; make the NU-03 `todo` a normal test; a native C14 run
  (below).

## 5. Acceptance on real inputs (after NU-01..03 are implemented)

Required user inputs (O2): Developer ID Application identity and notarytool keychain profile (see
`signing-notarization-runbook.md`); an update host name and TLS endpoint; an Ed25519 release-manifest
signing key held outside the repository (only its public key enters the repo); a second Mac on the
minimum OS (13.x) without developer tools.

C14 `packaged-recovery` checklist, each on the clean Mac with the notarized build N installed and a
profile holding a local and a GitHub project:

1. Serve a manifest for N+1 signed by the release key → update offered, artifact verified, user-confirmed install, N+1 starts, high-water = N+1.
2. Same manifest with one body byte changed / signed by a fresh key → refused, nothing downloaded or installed.
3. Artifact with one byte changed → refused after download, previous app untouched.
4. Manifest with `arch: x86_64` / `platform: win32` → refused.
5. Replay the N+1 manifest after installing N+1 → refused (serial).
6. Manifest for N-1 (`kind: update`) → refused; manually reinstall build N after N+1 started → recovery-only, data intact.
7. Signed recovery manifest for N bound to the retained checkpoint → allowed, data restored to the checkpoint.
8. Restore an older backup on N+1 → high-water stays N+1.
9. Build N+1 with a deliberately failing migration; kill during migration → next start recovery-only; restore returns bundle N + DB + source; newest vault/journal kept.
10. N+1 re-signed with another Team ID or ad-hoc → refused before launch.

Results sheet: `docs/release/signing-notarization-runbook.md` §8 (rows U1–U10).
