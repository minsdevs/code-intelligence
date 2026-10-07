# G-IMPORT requirement matrix and C05 corpus — 2026-10-07

Scope: release gate **G-IMPORT** (07 §3: "C05 및 실제 picker→preview→snapshot,
secret/size/race0"; forbidden substitute: a small fixture copy succeeding),
policy table 05 §1, audit items B6/B7/F11 and T01 acceptance. Work is on branch
`worktree-agent-ac4a347c91fe92645` from `bcd8081`; the packaged checks use the
retained candidate **1lvULq** (built from `9211e88`; HEAD differs only by docs and
the new tests/runners). No product code was changed. This report does not declare
the gate PASS. Hashes and commands are in the
[companion ledger](import-safety-matrix-2026-10-07.json).

## What ran

| Run | Components | Result |
| --- | --- | --- |
| `ImportSecretsCorpusIntegrationTest` (C05, 71 generated cases + 1 sweep) | Real APFS filesystem, real PostgreSQL (Testcontainers), production Node vault/broker, real `JobWorker` with IMPORT/INVENTORY/FINALIZE, picker grants via `DesktopPathAuthorizationService` only (no allowed root) | 72/72 tests PASS in both runs below; case level 70 PASS, C05-18 asserts an observed deviation recorded as `FAIL_SPEC_DEVIATION`, sweep PASS |
| `import-evidence-backend.cjs` (project, evidence, migration, history packages + coverage/comparison) | Same isolated Docker/Gradle environment as `run-docker-integration.cjs` | run `backend-bsZZx6`: 519 tests, 517 PASS, 1 explicit skip (C06-15 R2), 1 FAIL: existing `LocalIngestPolicyTest.specialFilesAreRejectedAndTheOldRepositorySurvives` — "Unix domain path too long" under this worktree's long temporary path; rerun alone with the default temporary directory 67/67 PASS (environment, not product). The FAIL record is kept. |
| Targeted rerun (C05 + C06 + migration walk classes, same isolated environment, `--offline --tests`) | As above | run `targeted-sJi3wp`: 88 tests, 87 PASS, 0 FAIL, 1 explicit skip (C06-15 R2); Gradle exit 0 |
| `desktop/test/source-vault.test.cjs`, `source-broker.test.cjs` | Node vault/broker, quotas and identity | 74/74 PASS |
| `import-evidence-native.cjs` on 1lvULq | Packaged app, fresh isolated profile, mock Keychain, controlled single-use folder dialog result | run `native-n9Svxt` (driver of `8a0b9b9`): FAIL at the published-fact step (`config:package.json` span 1-2 of a 1-line file, see the G-EVIDENCE report); the fail-fast driver did not reach the later checks. Run `native-bJn2bY` (driver of `b6fbbd2`, fact failures judged last): all 11 import checks PASS, run FAIL only on the same published-fact span. An earlier attempt (`native-run-1.log`) was terminated right after acquiring the lock and created no evidence directory. |

The C05 corpus generates every fixture at test time under a private temporary
directory: real symlinks, hard links, FIFO and Unix socket, sparse files, an NFD
name, a 16 MiB APFS image mounted below a root (mount traversal), the root of a
mounted volume, and a case-sensitive APFS image holding `A.ts` and `a.ts`. Each case
asserts the exact preview result (accepted count, actual bytes read where fixed,
exclusion counts by reason, changed-path list) **and** the exact copy result:
either the approved import through the real worker into the encrypted store, or —
for 512 MiB, 50,000-entry and 20,000-file boundaries — the same production copy
(`importApproved`, selection, staging verifier, synthetic Git) without the vault.
Rejected inputs are refused with the same fixed reason by preview and by copy. The
original folder's lstat/content state is compared before and after every case.

The final sweep checks every row of all 54 application tables (text and bytea hex),
every vault blob address against the SHA-256 of every forbidden plaintext, all
ciphertext files, the managed repository root, JSON/Markdown export, AI preview
bodies and all captured log events: no sentinel was found.

The packaged run (`native-bJn2bY`, candidate 1lvULq, build sequence `1791292686000`,
manifest and `app.asar` hashes unchanged before/after) builds a synthetic attack tree
(`.env`, `.env.local`, nested `.ssh` key, PEM, token-shaped content, credential
properties, `node_modules`, `.git/config` with a credential URL, a `.gitignore`d file,
a hard-link pair, a 1 MiB + 1 file, invalid UTF-8, a symlink to a file outside the
root, and `package.json` with pre/postinstall scripts that would create a marker).
Only the folder dialog's return value is controlled (single use, title and
`openDirectory` property checked); the `folder:pick` IPC, the main-held path grant,
the UI preview and approval buttons, the backend, PostgreSQL, the vault and the
analyzers are the shipped ones. Observed: renderer grant without the main path
token 403, forged token 403, ungranted preview 400, sibling of the granted root 400;
preview accepted exactly the 8 approved files (1,006 bytes) with exclusions
`SECRET_PATH 4, SECRET_CONTENT 2, HARD_LINK 2, GENERATED_DIRECTORY 2, SYMLINK 1,
IGNORED 1, BINARY 1, OVERSIZED 1`; the snapshot path set equals the approved set;
file content, JSON/Markdown export and four AI preview bodies (focus `.env`,
`src/leak.ts`, `src/main.ts`, `app.properties`, all 200) carry no sentinel; after a
UI-approved re-analysis a raw-byte scan of every regular file under the isolated run
root (1,728 files, 59,508,685 bytes) found 0 sentinel hits, and no directory name
equals the SHA-256 of a forbidden plaintext; the script marker was never created; the
original folder's lstat/content state is unchanged by import and analysis (apart from
the runner's own edit before re-analysis); the app shut down cleanly (phase
`COMPLETE`). The raw scan cannot see values PostgreSQL stores compressed; row-level
SQL sweeps are the C05 backend sweep.

## Requirement matrix

| ID | Requirement (source) | Evidence | Level | Status |
| --- | --- | --- | --- | --- |
| I-01 | Path grant only from main after the native dialog; renderer/general bearer alone refused (05 §1) | `DesktopPathAuthorizationController` requires main's path token; packaged: renderer POST `/api/desktop/paths` 403, forged token 403, ungranted preview 400, sibling of granted root 400 (`native-n9Svxt`, `native-bJn2bY`); C05-53/54 | unit, real DB, packaged | PASS |
| I-02 | Capability = canonical root + identity + expiry + nonce; reuse/different root refused (05 §1) | Grant is a per-process set of canonical paths (persisted by main, covers descendants, no expiry/nonce/identity). Root identity is bound later in the preview binding and rechecked at confirmation and copy (C05-66 → 409) | code review, real DB | **FAIL** (F-1) |
| I-03 | Home, volume root, system root refused; smaller project required (05 §1) | C05-47 home, C05-48 `/`, C05-49 mounted-volume root, C05-50 `/usr/share`, C05-51 below `.aws`, C05-52 `node_modules` root, C05-71 picker symlink into `.ssh` | real FS + DB | PASS |
| I-04 | Nested `.ssh/.aws/.gnupg/.config`, credential files excluded (05 §1) | C05-04…08 | real FS + DB + vault | PASS |
| I-05a | Links/races excluded or refused (05 §1, behaviour) | C05-19…22 excluded, C05-58/62/63 race → conflict | real FS + DB | PASS |
| I-05b | Race mechanism lstat + no-follow open + descriptor `fstat` identity (05 §1) | Mechanism is pathname NOFOLLOW + identity/size/mtime re-checks, not descriptor `fstat` (documented in `local-ingest-policy.md`) | code review | **FAIL** (F-3) |
| I-06a | symlink/socket/FIFO/nlink>1 excluded (05 §1) | Symlink, hard link excluded; FIFO (C05-23) and socket (C05-24) fail the inspection with a fixed reason (stricter); packaged: `SYMLINK 1`, `HARD_LINK 2` | real FS; packaged | PASS |
| I-06b | Device node excluded (05 §1) | Creating a device node needs root; no privileged harness in this unit | — | **BLOCKED** (privileged harness) |
| I-07 | No traversal across mounts (05 §1) | C05-25 mount below root → "crosses a filesystem boundary" in preview and copy | real APFS image | PASS |
| I-08 | Digest over ordered (path,type,size,contentHash,exclusionPolicy); 10-minute server token (05 §1, B7) | `LocalSourceManifest` (path, REGULAR_FILE, size, SHA-256, policy version, limits hash); every C05 preview asserts a 9–10 min expiry; one-use/expiry/concurrency in `LocalSourceApprovalIntegrationTest` | real DB | PASS |
| I-09 | Any change after preview → 409 even with equal counts (05 §1, B7) | C05-56 same size/count, C05-57 same size and restored mtime, C05-58 symlink swap, C05-59 rename, C05-60/61 growth, C05-62 hard link, C05-63 FIFO, C05-64 delete+add, C05-65 ignore rule: job FAILED `LOCAL_PREVIEW_REQUIRED` from `LOCAL_SOURCE_CHANGED` (409 problem type), no snapshot, old pointer and old bytes kept. C05-66 root replaced → HTTP 409 at confirmation | real FS + DB + worker | PASS (note N-1) |
| I-10 | 50,000 files / 512 MiB / 2 MiB per file on actual streamed bytes, preview and copy (05 §1, B6) | Shipped limits: 1 MiB per file (C05-37/38/39 at −1/0/+1), 2 MiB ceiling with a 4 MiB configuration (C05-68/69/70), 512 MiB aggregate actual bytes −1/0/+1 (C05-40/41/42, sparse), 50,000/50,001 encountered entries (C05-43/44), 20,000/20,001 accepted files (C05-45/46), 1 GiB sparse not read (C05-35), in-limit sparse read and counted (C05-36); growth during read: `LocalIngestPolicyTest` | real FS (+DB for preview) | PASS |
| I-11 | No archive expansion (05 §1) | C05-34 stored ZIP with sentinel entry | real FS + DB | PASS |
| I-12a | One exclusion policy for preview/copy/inventory/cache/export/AI (05 §1) | Same `LocalSourcePolicy` in preview and copy (every C05 case); sweep of DB, vault, managed storage, export, AI preview, logs; packaged profile/API sweep | real DB + vault; packaged | PASS |
| I-12b | Same policy for the backup archive (05 §1) | Backup payload sources (rows, vault blobs) swept; an encrypted archive was not produced and decrypted (N-2) | — | NOT RUN |
| I-13 | `.env*`, PEM/key/token patterns, content secret scan (05 §1) | C05-01/02/03 (`.env.example` also excluded, stricter), C05-07, C05-09 token-shaped name, C05-10/11/12 content, C05-13 secret in `.gitignore` fails | real FS + DB | PASS |
| I-14a | No execution of package scripts / Gradle / Maven / setup.py / make (05 §1), file marker | C05-55 marker absent after import; packaged run with the real analyzers and `pre`/`postinstall` scripts: marker absent after import and re-analysis | real FS; packaged | PASS |
| I-14b | Same, network-egress sentinel | Needs an OS-isolation/egress harness (G-SEC/C15) | — | NOT RUN |
| I-15a | Case-fold collisions and unsafe names fail explicitly (05 §1) | C05-26 `A.ts`/`a.ts` on a case-sensitive APFS image → "colliding paths"; C05-28/29/30 control character, backslash, depth | real APFS image | PASS |
| I-15b | Unicode-normalisation (NFC/NFD) twin fails explicitly (05 §1) | A twin cannot be created on APFS/exFAT on macOS (N-3); C05-27 shows the NFD name retained byte-for-byte | real APFS | **BLOCKED** (no supported filesystem holds both names) |
| I-16 | Default exclusions vendor/node_modules/venv/.git/build/dist/generated (05 §1) | C05-14/15/16 | real FS + DB | PASS |
| I-17 | Submodule excluded by default; F11 gitlink excluded, no auto fetch | C05-18: only the gitlink file is excluded; the submodule working tree is copied | real FS + DB | **FAIL** (F-2) |
| I-18 | User's project folder never modified (05 §1, T01) | Before/after lstat+content state in all C05 cases and in the packaged run | real FS; packaged | PASS |
| I-19 | Old pointer kept on failure (T01) | Every race case asserts current snapshot and its served bytes unchanged | real DB + vault | PASS |
| I-20 | Secret sentinel 0 (T01, 06 thresholds) | C05 sweep (54 tables, vault, managed storage, export, AI preview, logs: 0); packaged API/export/AI preview and raw profile scan (1,728 files): 0 hits (`native-bJn2bY`) | real DB + vault; packaged | PASS |
| I-21a | Source-store quota/entry budget (B6) | Vault quota/entry tests 74/74 (Node, synthetic) | unit | PASS |
| I-21b | Installation free-space budget (B6) | Integration with disk free-space admission not exercised | — | NOT RUN |
| I-22a | Picker → preview → snapshot in the packaged app (07 gate) | `native-bJn2bY`: controlled dialog return value → shipped `folder:pick` IPC and main-issued grant → UI "Choose folder" → UI preview with the exact exclusion counts → UI approval → worker → snapshot equal to the approved set; UI-approved re-analysis | packaged | PASS |
| I-22b | Same with a person clicking the real macOS folder dialog | Not automatable here (`nativePickerInteraction: false`) | — | NOT RUN (human) |
| I-23 | C05 ≥40 attack cases incl. nested keys/PEM, equal-count change, symlink race/hard link/FIFO, invalid UTF-8/NFC, bytes ±1, sparse/binary (06) | 71 cases + sweep in `targeted-sJi3wp` and `backend-bsZZx6`: 70 cases PASS, sweep PASS, C05-18 `FAIL_SPEC_DEVIATION` | real FS + DB + vault | **FAIL** (C05-18, F-2) |

Summary: 30 rows — PASS 20, FAIL 4 (I-02, I-05b, I-17, I-23), NOT RUN 4 (I-12b,
I-14b, I-21b, I-22b), BLOCKED 2 (I-06b, I-15b). Recommendation: G-IMPORT stays open
until F-1 and F-2 are fixed (or explicitly accepted by product/security review) and
C05 plus the packaged run pass on a rebuilt candidate; the corpus and runners are
ready to rerun unchanged.

## Findings

- **F-1 (Medium, open).** The desktop path grant has no expiry, nonce or root
  identity. `DesktopPathAuthorizationService` keeps canonical paths for the process
  (main also persists them for later sessions) and authorises any descendant. A
  compromised renderer can therefore preview any folder below a previously chosen
  root without a new dialog. Mitigations observed: the grant itself needs main's
  path token (403 otherwise), previews are owner-bound one-use 10-minute tokens,
  and the preview binding pins the root identity (a replaced root is refused).
  Proposed fix: issue a main-held grant record (canonical root, `dev:ino`, expiry,
  random nonce) per dialog result, require it for initial preview, and limit
  descendant use to explicit relink/refresh of an existing project.
- **F-2 (Medium, open).** Local import does not exclude submodule working trees
  (05 §1 lists "submodule" as a default exclusion). Only a `.git` gitlink file is
  excluded; secret and size rules still apply to the copied content. Proposed fix:
  treat a non-root directory containing a `.git` entry as a nested repository and
  prune it with a fixed reason (counted, visible in preview), with a new C05 case.
- **F-3 (Low, known limit).** Race defences are pathname-based; descriptor-relative
  `fstat` confinement is not implemented (already documented; native confinement
  belongs to T03/G-SEC).
- **N-1.** For content changes after confirmation the conflict surfaces as a failed
  job with `LOCAL_PREVIEW_REQUIRED` (the copy runs in the worker); only a replaced
  root returns HTTP 409 on the confirmation request itself.
- **N-2.** Backup payload = PostgreSQL rows + vault blobs; both were swept, but an
  encrypted archive was not produced and decrypted in this unit.
- **N-3.** APFS (both variants) and exFAT on macOS treat NFC/NFD names as the same
  file, so a normalisation twin cannot be created on the supported platform; C05-27
  shows the refusal and that the NFD name is retained byte-for-byte.

## Remaining conditions

Fix or accept F-1 and F-2 (each needs a product change, a new candidate and a rerun
of C05 and the packaged check). The packaged runner's overall status is FAIL until
the G-EVIDENCE span defect (`config:package.json` line end past the file end) is
fixed; its import checks pass. Device-node and network-egress sentinels need a
privileged or OS-isolation harness (G-SEC/C15); an encrypted backup archive should be
produced and decrypted with the C05 sentinels (backup unit). A real OS dialog click
by a person is still not part of any run. Independent security review of the import
boundary is outstanding.
