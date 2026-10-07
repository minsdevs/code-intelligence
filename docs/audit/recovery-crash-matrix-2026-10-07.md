# G-RECOVERY C16 restore crash matrix — 2026-10-07

## Result

The unchanged **1lvULq** candidate (`9211e88`, buildSequence 1791292686000; HEAD differs from
`9211e88` only outside product paths) passed every implemented C16 restore boundary that a real
Electron main-process SIGKILL can reach: **26/26 boundaries**, each with crash, same-profile
recovery and one further normal restart, all carrying a nonzero cost ledger (settled 210 µUSD +
held 22,472 µUSD) and retained source snapshots. One boundary (`SOURCES_PUBLISHED_AFTER`) failed
on its first attempt and passed on the single rerun; both records are kept. Five crafted journal
faults and two old-archive selections were refused fail-closed in the same packaged app. Power
loss, the user's real database and an actual older binary are **not** covered. This is a
row-level evidence report, not a gate verdict; the release verdict remains **NO_GO**.

## Scope and method

- New driver `validation/backup-compatibility/native-recovery-matrix.cjs` with serialized hooks
  in `recovery-boundaries.cjs`. One fresh automation claim per invocation under a short private
  `/private/tmp/cirm-*` parent (the worktree path exceeds the macOS Unix-socket budget), mock
  Keychain, the unmodified bundle (ASAR/manifest/driver/boundary hashes re-checked at the end),
  real bundled PostgreSQL/Redis/JRE/backend and real encrypted backups made through the UI.
- `--points` holds the real restore at one durable edge (journal frame before write/after fsync,
  recovery-record file before creation/after its fsync+readback, latch-file rename, source rename,
  checkpoint/active-marker unlink), then SIGKILLs only the captured Electron child. Records are
  labelled by order and cross-checked at creation time against observed journal types, renames
  and unlinks; any deviation is reported as a mismatch instead of pausing (none occurred).
- Setup per chain: import source91 (snapshot1), note+task "backup91", backup **B1**; reanalyze to
  source92 (snapshot2), note+task "backup92", backup **B2**. Each point restores whichever backup
  differs from the current state, so PREVIOUS and RESTORED outcomes are distinguishable.
- `--cost`: through the real UI/backend/main gateway, journal and PG ledger, saves a synthetic
  BYOK key (sentinel), sets a budget, activates AI and sends request R1 (settled 210 µUSD) before
  B1, then R2 after B1, which is held in flight and the owner is SIGKILLed while DISPATCHED
  (latest-DISPATCHED crash). Only `tls.connect` for `api.openai.com` is replaced by a loopback
  HTTP stand-in; no DNS lookup or network egress occurs. B2 is taken after that restart, so every
  restore of B1 is "latest DISPATCHED → older DB".
- Checked after each recovery and each normal restart: current snapshot, file-content API for
  every snapshot present, Monaco snapshot URI/text, vault ciphertext hash per snapshot, note and
  task/goal content, health/AI-off status, append-only journal prefix, append-only recovery-record
  history, unchanged wrapped purpose/source keyrings and owner-lock files, active marker removed,
  registered plaintext removed, budget view (held/settled), per-UUID RESERVED/DISPATCH_INTENT = 1,
  provider attempts = 2 in total, minimumVersion/budgetDay high-water monotonic, a request-plan
  probe refused while latched with no transport attempt, and a sentinel scan of the plaintext
  payloads present at the crash (raw/base64/hex).
- `--faults` (separate profile): with the app stopped, damage the synthetic B area, launch, expect
  a fixed startup refusal without repair, then restore the exact original bytes/inode (test-only)
  and require an ordinary start with unchanged data. Two further steps select old-format archives
  through the controlled picker and the real `data:restore` IPC.

## What ran

All native runs used `.native-product-1lvULq/Code Intelligence Validation.app` from this
worktree, a clean environment (`env -i … LANG=C LC_ALL=C node …`) and the machine-wide native
lock. Timings are not acceptance results (shared machine, load about 5).

| Run (`validation/local/recovery-matrix/…`) | Invocation | Status | Launches | SIGKILLs | Clean exits | Refusal exits | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `native-AGwHPH` | `--points SEAL_AFTER,COMPLETE_AFTER --cost`, **pre-commit development driver** (`323892b0…`) | FAIL at `hold-COMPLETE_AFTER`, cause not retained | 4 | 2 | 1 | 0 | 7 |
| `native-Lvlebw` | chain A, 9 points `--cost` | **PASS** | 20 | 10 | 10 | 0 | 23 |
| `native-jDsa8w` | chain B, 9 points `--cost` | FAIL at `launch-restricted-recovery` of `SOURCES_PUBLISHED_AFTER`; 6 points PASS before it, `HEALTH_*` not reached | 15 | 8 | 6 | 0 | 17 |
| `native-jMjVtS` | rerun: `SOURCES_PUBLISHED_AFTER,HEALTH_BEFORE,HEALTH_AFTER --cost` | **PASS** | 8 | 4 | 4 | 0 | 11 |
| `native-XLeNLT` | chain C, 8 points `--cost` | **PASS** | 18 | 9 | 9 | 0 | 21 |
| `native-vMnYut` | `--faults torn-tail,corrupt-mac,incompatible-major,latch-major,missing,format2-archive,container-v2` | **PASS** | 11 | 0 | 6 | 5 | 13 |

Every intentional SIGKILL exit had `signal=SIGKILL` and its sampled PID/PPID set (13–26 processes)
gone afterwards. No launch in these 76 failed at the MANIFEST startup stage.

**`native-jDsa8w` failure.** After the `SOURCES_PUBLISHED_AFTER` crash the recovery launch
accepted the recovery prompt (`RECOVERY_ACCEPTED`), then the driver failed inside `launch()`
with an `Error` whose message failed the driver's fixed-character filter and was not retained; no
`failure.png` was written, and the last observed startup phase was `BACKUP`/`RUNNING`. The
synthetic profile (kept at `/private/tmp/cirm-pJzEaC`, outside the repository) shows the
recovery itself completing: recovery records 140–145 and receipt 144 were written between 16 s
and 49 s after launch, the active marker is gone, and the ordinary shutdown ended with code 0
and a COMPLETE shutdown trace about 60 s after the backend became ready, which matches the
driver's 60 s wait for the home link. The first attempt ran with five units sharing the machine.
**[INFERENCE]** a harness wait expired during a slow recovery; this is not established. The
single rerun `native-jMjVtS` passed the same point (recovery launch to backend ready about 14 s)
plus `HEALTH_BEFORE/AFTER`. The failing record is kept unchanged.

**`native-AGwHPH`** was produced by an uncommitted earlier driver revision before commit
`b7dc8ee`; its failure (`captureUnavailable`) is kept but not used for any row. `COMPLETE_AFTER`
passed later with the committed driver in `native-XLeNLT`.

Targeted module tests: `node --test test/backup-runtime.test.cjs test/backup-recovery-matrix.test.cjs`
in `desktop/` → **145 tests, 145 pass, 0 fail** (`unit-resume-20261007/tests.log`). The earlier
full desktop run during development (`unit-WMgFDV/tests.log`) read 1,879 tests, 1,859 pass,
0 fail, 20 skipped.

## Requirement matrix

Levels: **U** unit/module with real modules and synthetic ports; **PG** real PostgreSQL; **N**
current Node modules against packaged binaries; **E** real Electron main process of the packaged
app. ADR-02 arrows map to implementation edges as shown; the implementation merges B before
staging (SAFETY_MERGED precedes DATA_STAGED), which is the more conservative order. Ledger
column: held/monthly-settled µUSD/provider attempts after recovery; held/settled after the
further normal restart.

### C16 crash boundaries (all E, `--cost`)

| # | Point | ADR-02 arrow (side) | Prompt | Restore (from→target): expected outcome | Ledger | High-water monotonic | Status | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | LATCH_BEFORE | NORMAL→LATCHED (before) | no | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-Lvlebw` | orphan plaintext `incoming` (F1) |
| 2 | LATCH_AFTER | NORMAL→LATCHED (after) | no | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-Lvlebw` | orphan plaintext `incoming` (F1) |
| 3 | PREPARED_BEFORE | LATCHED→SAFETY_SEALED (before) | no | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-Lvlebw` | orphan plaintext `checkpoint`+`incoming` (F1) |
| 4 | PREPARED_AFTER | LATCHED→SAFETY_SEALED (within) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-Lvlebw` | |
| 5 | MERGED_BEFORE | LATCHED→SAFETY_SEALED (within) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-Lvlebw` | |
| 6 | MERGED_AFTER | LATCHED→SAFETY_SEALED (within) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-Lvlebw` | |
| 7 | SEAL_BEFORE | LATCHED→SAFETY_SEALED (within) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-Lvlebw` | |
| 8 | SEAL_AFTER | LATCHED→SAFETY_SEALED (within) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-Lvlebw` | |
| 9 | SEALED_AFTER | LATCHED→SAFETY_SEALED (after) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-Lvlebw` | |
| 10 | STAGED_BEFORE | SAFETY_SEALED→DATA_STAGED (before) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-jDsa8w` | unrecorded stage DB (F3) |
| 11 | STAGED_AFTER | SAFETY_SEALED→DATA_STAGED (after) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-jDsa8w` | |
| 12 | DATABASE_SWAPPED_BEFORE | DATA_STAGED→DATA_RESTORED (within) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-jDsa8w` | |
| 13 | DATABASE_SWAPPED_AFTER | DATA_STAGED→DATA_RESTORED (within) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-jDsa8w` | |
| 14 | SOURCE_RENAME_AFTER | DATA_STAGED→DATA_RESTORED (within) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-jDsa8w` | |
| 15 | SOURCES_PUBLISHED_BEFORE | DATA_STAGED→DATA_RESTORED (within) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-jDsa8w` | |
| 16 | SOURCES_PUBLISHED_AFTER | DATA_STAGED→DATA_RESTORED (after) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** (rerun) | `native-jDsa8w` FAIL, `native-jMjVtS` PASS | first attempt failed in the recovery launch; see above |
| 17 | HEALTH_BEFORE | SAFETY_MERGED→HEALTH_VERIFIED (before) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-jMjVtS` | |
| 18 | HEALTH_AFTER | SAFETY_MERGED→HEALTH_VERIFIED (after) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-jMjVtS` | |
| 19 | COMPLETE_BEFORE | HEALTH_VERIFIED→NORMAL (before) | yes | B2→B1: PREVIOUS | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-XLeNLT` | |
| 20 | COMPLETE_AFTER | HEALTH_VERIFIED→NORMAL (within) | yes | B2→B1: RESTORED | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-XLeNLT` | |
| 21 | CLEANUP_BEFORE | HEALTH_VERIFIED→NORMAL (within) | yes | B1→B2: RESTORED | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-XLeNLT` | |
| 22 | RETENTION_AFTER | HEALTH_VERIFIED→NORMAL (within) | yes | B2→B1: RESTORED | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-XLeNLT` | |
| 23 | COMPLETED_BEFORE | HEALTH_VERIFIED→NORMAL (within) | yes | B1→B2: RESTORED | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-XLeNLT` | |
| 24 | COMPLETED_AFTER | HEALTH_VERIFIED→NORMAL (within) | yes | B2→B1: RESTORED | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-XLeNLT` | |
| 25 | ACTIVE_CLEAR_BEFORE | HEALTH_VERIFIED→NORMAL (within) | yes | B1→B2: RESTORED | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-XLeNLT` | |
| 26 | ACTIVE_CLEAR_AFTER | HEALTH_VERIFIED→NORMAL (after) | no | B2→B1: RESTORED | 22472/210/2 ; 22472/210 | yes | **PASS** | `native-XLeNLT` | |

Plaintext sentinel matches at every crash: 0. Every boundary hook hit exactly once with no
sequence mismatch.

### Other gate rows

| # | Requirement | Level | Status | Evidence / blocking input |
| --- | --- | --- | --- | --- |
| 27 | Nonzero ledger built through the real AI path (R1 settled 210 µUSD through the loopback stand-in) | E | **PASS** | check `real-ai-path-settled-nonzero-cost-through-loopback-provider-stand-in` in `Lvlebw`, `jDsa8w`, `jMjVtS`, `XLeNLT` |
| 28 | Latest-DISPATCHED owner crash keeps the full hold; latched AI refuses new dispatch | E | **PASS** | check `in-flight-dispatch-crash-retains-full-hold-and-latched-ai-refuses-new-dispatch` in the same four runs |
| 29 | Journal torn tail refused at startup without repair; original restored → normal start, data unchanged | E | **PASS** | `native-vMnYut`: GATEWAY/FAILED/`SAFETY_RECOVERY_REQUIRED`, exit 0, journal bytes unchanged |
| 30 | Corrupted journal MAC refused without repair | E | **PASS** | `native-vMnYut`, same refusal code |
| 31 | Newer-major journal frame refused (crafted; stands in for an older reader of newer data) | E | **PASS** | `native-vMnYut`, same refusal code |
| 32 | Newer-major AI-off latch refused and not replaced | E | **PASS** | `native-vMnYut`, same refusal code |
| 33 | Missing journal refused, latch kept, journal not recreated | E | **PASS** | `native-vMnYut`, same refusal code |
| 34 | Format 2 archive selected through the real picker/IPC is refused before maintenance (no latch frame, record, scratch or data change) | E + U | **PASS** | `native-vMnYut` `format2-archive`; U test "old-archive policy: format 1/2 …" |
| 35 | Container `CIBAK002` refused before maintenance | E + U | **PASS** | `native-vMnYut` `container-v2`; same U test |
| 36 | V25-and-older / unknown future schema in format 3 refused; V26 converted; V27 catalog drift INCOMPATIBLE | U (+PG earlier) | **PASS** at U | U test "old-archive policy: V25-and-older …"; PG `backup-compatibility-VjdhHc` (earlier unit) |
| 37 | Foreign installation / payload identity / newer build / foreign owner never reach maintenance | U | **PASS** at U | U test "old-archive policy: foreign installation …" |
| 38 | Backup key rotation: retired-key archive restores, new evidence uses current key, unknown key refused | U | **PASS** at U | U test "backup key rotation …"; no product entrypoint for rotation exists |
| 39 | Boundary hooks pause exactly once, refuse foreign profiles/claims, report out-of-order sequences | U | **PASS** | `backup-recovery-matrix.test.cjs` (7 tests) |
| 40 | Uninterrupted format-3 backup/restore in the packaged app | E | **PASS** (earlier unit, same candidate) | `pre-release-final/product-9epbSW` full sequence on 1lvULq, omitted `[]` (review-follow-up-1lvulq-2026-10-06) |
| 41 | Format 2 archive **normal** restore in the packaged app (gate wording "format2/3 정상") | — | **BLOCKED** | Product implements refusal, not conversion (`backup.cjs` is not wired into `main.cjs`). Needs a product decision that documented refusal satisfies the row, or a conversion feature |
| 42 | Power loss (un-synced writes lost, torn single writes, abrupt PostgreSQL death) | — | **NOT RUN** | Needs dedicated hardware or a VM that drops un-synced writes |
| 43 | Application to the user's real profile/DB/locale with agreed rollback | — | **BLOCKED** | Needs the user's explicit approval and their profile |
| 44 | Actual older binary reading newer B-area/journal | — | **BLOCKED** | Isolated-run claim binds one runtime; `tZgvV7` has the same journal major. Needs a signed recovery manifest / older reader |
| 45 | Independent review of this evidence | — | **NOT RUN** | Needs an independent reviewer |

**Counts: 40 PASS, 0 FAIL, 2 NOT RUN, 3 BLOCKED** (rows 36–38 are module-level only; row 16
passed on its rerun after a retained first-attempt failure).

## Old-archive policy as implemented

| Input | Behaviour today | Code | Evidence |
| --- | --- | --- | --- |
| Format 1/2 directory backup (`backup.cjs`) | Not readable by the protocol-3 runtime; `backup.cjs` is not wired into `main.cjs`. A directory cannot be chosen in the `.cibackup` file picker; a renamed manifest/dump file is refused | `BACKUP_RUNTIME_INPUT`, `recoveryRequired=false`, no maintenance | U (new runtime test), E (`format2-archive`) |
| Container magic/version ≠ `CIBAK003` | Refused before maintenance | `BACKUP_RUNTIME_INPUT` | U, E (`container-v2`) |
| Foreign installation (container identity or payload identity) | Refused before maintenance | `BACKUP_RUNTIME_INPUT` | U |
| Archive whose header `minimumVersion` exceeds the running build | Refused before maintenance (no downgrade restore) | `BACKUP_RUNTIME_INPUT` | U |
| V25 and older schema inside format 3 (producible by builds 93cb2d2…4d8946c) | Refused before maintenance, **not converted** | `BACKUP_RUNTIME_INPUT` | U |
| Unknown future schema (V28+) | Refused before maintenance | `BACKUP_RUNTIME_INPUT` | U |
| V26 (pinned 4d8946c producer) | **Accepted and converted** to V27 (`LEGACY_UNMEASURED` outcomes) | restored | U (new crafted control + existing), PG (`backup-compatibility-VjdhHc`, earlier unit) |
| V27 with catalog/extension drift, or another owner | Refused by the preflight probe | `BACKUP_RUNTIME_INCOMPATIBLE`, IPC `BACKUP_INCOMPATIBLE` | U, PG (`VjdhHc`), E (earlier `native-VCIheO`, older candidate) |

Each refusal leaves B, A, records, recovery scratch and the selected bytes unchanged; positive
controls through the same crafting path restore successfully.

## Findings

| ID | Severity | Finding | Reproduction | Status / proposal |
| --- | --- | --- | --- | --- |
| F1 | Low | A crash before the PREPARED record (LATCH_BEFORE/AFTER, PREPARED_BEFORE) leaves the decrypted incoming payload (and, after export, the checkpoint payload) as plaintext under `userData/recovery/<tx>/`. No record references it, so no later recovery or retention removes it. | Rows 1–3 (`orphanPlaintext` in `native-Lvlebw`). | Open. Inside the private 0700 profile, same content as the user's chosen archive/live DB, data correct. Proposal: record the scratch root (or a pre-maintenance intent record) before decryption, or let startup remove an unrecorded `recovery/<uuid>` whose payload identities match no record. |
| F2 | Low | V25-and-older and unknown-schema format-3 archives are refused as `INPUT` ("Choose an intact encrypted backup from this installation."), not `INCOMPATIBLE`, so an intact old archive is described as damaged. No maintenance or data change occurs. | U test "old-archive policy: V25-and-older…". | Open. Proposal: map `BackupPayloadError` SUMMARY/SCHEMA from a successfully authenticated payload to `BACKUP_RUNTIME_INCOMPATIBLE`. |
| F3 | Low | Interrupted restores leave extra PostgreSQL databases in the profile: a crash before STAGED leaves an unrecorded `ci_backup_stage_*` database that is deliberately neither adopted nor dropped (code reading, `backup-runtime.cjs`). Observed live database directories at the end of each chain: 4 (chain A, faults: baseline) vs 8 (chain B), 6 (rerun), 7 (chain C); their names were not resolved because the runner holds no DB credentials. | Row 10; `postgres/base` directory counts of the retained synthetic profiles. | Documented design for stage DBs; disk-only. Proposal: a later authenticated GC rule for stage/previous/failed DBs of completed transactions, with a retention bound. |
| — | Note | `native-jDsa8w`: first `SOURCES_PUBLISHED_AFTER` attempt failed in the recovery launch; cause not established (see "What ran"). | Single rerun passed. | Not classified as a product defect. Proposal: let the driver retain a sanitized first line of Playwright errors and capture a screenshot before close so a recurrence is attributable. |

No Critical/High defect was reproduced; no product file changed, so 1lvULq stays the candidate.

## Limits

- **SIGKILL is not power loss.** Killing the main process leaves every completed `write` in the
  page cache, so a later read sees data that a power cut could have lost before `fsync`; it also
  cannot tear a single write. Bundled children exited through their own guardians (13–26 sampled
  processes observed gone per kill), so PostgreSQL was not hard-killed mid-checkpoint by these
  runs. A whole-process-tree SIGKILL would add abrupt PostgreSQL/Redis death but still keep the
  page cache; it was not run because PID tables are deliberately never signal authority in this
  harness. Only real power removal (or a VM with dropped un-synced writes) closes that gap.
- The provider transport is a loopback stand-in; real provider behaviour/billing is not tested.
- Mock Keychain; no real account; native dialogs are controlled.
- The DB comparison is the product's own per-table SHA-256 verification inside `recover()` plus
  the runner's API/UI/ciphertext checks; the runner holds no DB credentials.
- An actual older binary cannot share a profile: the isolated-run claim binds one runtime, and
  `tZgvV7` uses the same journal major. Incompatible-major is therefore a crafted newer-major
  frame/latch read by the current binary.
- Key rotation has no product entrypoint; rotation rows are module-level only.
- Each boundary was exercised once (row 16 twice); repetition rates are not measured.

## Remaining for this gate

1. Power-loss testing on dedicated hardware/VM (NOT RUN).
2. Application to the user's real profile/DB/locale with an agreed rollback (BLOCKED: needs the
   user's explicit approval and their profile).
3. Decision on the format-2 "normal" row (BLOCKED: refusal is implemented, conversion is not).
4. Root cause of historical MANIFEST start failures (open; none of the 76 launches here failed at
   MANIFEST, which does not establish a cause or a fix).
5. F1–F3 decisions; an older-binary test once a signed recovery manifest/older reader exists.
6. Independent review of this evidence and the release decision.

Exact commands, run directories and SHA-256 values: [`recovery-crash-matrix-2026-10-07.json`](recovery-crash-matrix-2026-10-07.json).
