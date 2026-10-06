# Packaged Electron owner crash recovery — 2026-10-06

## Result and eight-stage position

Two real packaged-app restore boundaries passed an intentional Electron-main
`SIGKILL`, same-profile recovery and a further normal restart. Both cases use the
unchanged **j5EJLB** development candidate and a new synthetic automation profile.
This completes the interrupted owner-crash validation unit in **stage1**; it does
not complete the entire recovery matrix or change the eight-stage release verdict
from **NO_GO**.

The work resumed the existing `codex/native-owner-crash-20261006` branch at
PR96 / `0aab119`, preserving its unfinished driver/hooks/tests rather than starting
a duplicate checkout. Implementation commit `e26cbd6` contains the completed
validation changes. No backend, frontend, analyzer, desktop product source,
schema, credential policy or packaged application was changed.

## Actual tested boundaries

Each invocation imports a one-file synthetic source returning91, creates an
encrypted backup, then approves a real reanalysis returning92. A note is created
before backup and changed before restore. Actual API and snapshot-source reads
establish the expected baseline; no successful restore response is substituted.

| Boundary | Operation completed before the pause | Verified recovery |
| --- | --- | --- |
| `AFTER_SOURCE_RENAME` | Database swap and its record, then the real `data/repos` namespace rename; the rename's subsequent durability/transition acknowledgment has not run. | Restore has not committed. The newer pre-restore snapshot2/source92/note survive. Both old and newer snapshot sources remain readable. |
| `BEFORE_COMPLETED_CLEANUP` | Database/source publication, health verification, independent maintenance-journal completion and projection refresh; checkpoint plaintext unlink has not run. | The completed restore remains committed: snapshot1/source91 and the note from backup survive. The newer pre-restore source ciphertext remains preserved in the prior-source image. |

The test-only hook is serialized into the newly owned Electron process, checks
the automation app identity and profile, and intercepts exactly one matching
operation in its recorded transaction. Crash mode holds that operation pending.
The supervisor then signals only the retained Electron `ChildProcess`. Its
ordinary quit path is not invoked before the intentional crash. The existing
injected-EIO mode remains the default when `--owner-crash` is absent.

The supervisor samples a bounded PID/PPID table before the signal, observes the
main's actual SIGKILL exit, and waits for that sampled set to disappear and the
captured child's pipes to close. It never obtains signal authority from numeric
PIDs. This is a before/after process observation, not proof that every unsampled
descendant or hostile daemonized process was tracked.

## State and authority checks

Before the crash, the runner records the encrypted active transaction marker,
append-only encrypted recovery-record prefix, journal prefix, wrapped keyring
files, lock-marker identities, backup/checkpoint hashes and retained-source
ciphertext hashes. It verifies these files across the crash without replacing
keys, resetting locks or deleting recovery state to force startup.

Startup's actual recovery path validates and resumes the same transaction. The
test controls one exact recovery-confirmation dialog, then checks the expected
current snapshot, source text, matching Monaco snapshot URI and note content.
The old snapshot is read through the production file-content API in both cases;
the newer snapshot is additionally read after the rollback case. Preserved newer
ciphertext after a committed restore is not misreported as a currently available
snapshot in the restored database.

Completed recovery appends new history, removes the active marker and registered
plaintext payloads, retains encrypted input/checkpoint/source material and leaves
AI off. The next normal restart must not prompt for recovery again. Both ordinary
shutdowns must report **COMPLETE**, natural code0 and no unexpected native error.
The deliberate SIGKILL is recorded separately and is never labeled clean shutdown.

## Executed evidence

Paths are relative to `validation/local/electron-crash/`.

| Run | Result | Scope |
| --- | --- | --- |
| `native-vgFQTn/result.json` | **PASS,6 recorded checks** | Source rename pause; intentional main SIGKILL; verified previous snapshot2/source92/note; subsequent normal restart. |
| `native-iTZrBY/result.json` | **PASS,6 recorded checks** | Completed-restore cleanup pause; intentional main SIGKILL; verified restored snapshot1/source91/note; subsequent normal restart. |
| `unit-aUP69g/result.json` | **75 PASS,1 FAIL** | Initial test inspected a cross-VM async rename after only one local microtask. This is a test synchronization failure, not a failed native crash run. |
| `unit-m4wXmr/result.json` | **76/76 PASS** | Corrected that synchronization; actual product unchanged. |
| `unit-final-eS6COg/result.json` | **79/79 PASS** | Final hooks, captured-process behavior, strict opt-in arguments, private native-parent guards, isolated-run and shutdown contracts. |

The source-rename case sampled13 processes and observed the sampled set absent
after the crash. Its measured post-exit cleanup observation took161ms. The second
case's own process count and timing are recorded in the companion JSON. These
observations do not measure application cancellation latency or a performance SLO.
The two native runs each have three launches: initial, recovery, normal. Each has
one intentional SIGKILL and two verified ordinary COMPLETE/code0 exits.

The prime visually inspected both recovered screenshots: snapshot2 displays
`return 92`, snapshot1 displays `return 91`, and the UI requires the source folder
to be authorized again. This confirms those captured views, not native-dialog
interaction, broad usability or every screen size.

Final source fingerprints and exact raw report/screenshot hashes are in
[`electron-owner-crash-2026-10-06.json`](electron-owner-crash-2026-10-06.json).
The original failed unit report and both independently created native profiles
remain retained. A temporary CoS disconnection interrupted read requests but
recovered; no successful mutation or native run was replayed to recover tooling.

## Candidate identity

```text
app                  .native-product-j5EJLB/Code Intelligence Validation.app
buildSequence        1791229598313
app.asar SHA-256      31ddec1d3cc5a13fe44c68a5b76e7027e3075e8573213940b01a9bf01bc4f85d
runtime manifest     f138415a5e390c150d2f62fb2788a81d038f03324cc30394c4d70e10bc9fb83f
backend JAR          bd20db8f69443eca950ff7b886454658548bf5ccb6b40ae807148c009858bbee
```

The runtime inventory and existing ad-hoc signature were reverified after both
runs. Production/build input fingerprints still match the previous validated
candidate. The whole `.app` has not been assigned a fabricated single digest.
These tests ran on macOS26.6.2/arm64, using mock Keychain, synthetic data and the
app's actual bundled services. Native popup decisions are automated. No existing
user profile, database, Keychain entry, private key or real account is test input.

## Reproduction

Run one case at a time from the original repository:

```sh
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  node validation/backup-compatibility/native-interruption.cjs \
  --app '<original-repository>/.native-product-j5EJLB/Code Intelligence Validation.app' \
  --point AFTER_SOURCE_RENAME --owner-crash

env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  node validation/backup-compatibility/native-interruption.cjs \
  --app '<original-repository>/.native-product-j5EJLB/Code Intelligence Validation.app' \
  --point BEFORE_COMPLETED_CLEANUP --owner-crash
```

Crash mode creates a fresh private `.nr/desktop-run-*` claim beneath the original
repository to meet Unix-socket path limits. Existing claims are never adopted.
The new hidden parent is ignored by Git; it contains synthetic private material
and is not part of the source PR. Default EIO mode retains its previous output
location and behavior. No existing app is rebuilt or overwritten.

## Remaining acceptance

These are two actual main-process crash boundaries, **not power-loss or full
C16/G-RECOVERY certification**. Remaining recovery coverage includes the other
fsync/receipt/journal/key-rotation boundaries and a single native fixture combining
nonzero cost obligations with retained-source Electron SIGKILL. Prior Node-owner
cost recovery is separate evidence; it is not promoted to that combined result.
Existing user DB/extension/index/locale application and rollback are still pending.

Stages2/3 real-account import, refresh/revoke/SSO; stages4/5 independent corpus,
whole-app repeated performance, security and user tasks; stage6 fresh-machine,
minimum-OS and signed update acceptance; and stage7 complete SBOM/license and
operational decisions remain open. The older intermittent native failures keep
their unconfirmed root causes. No threshold or mandatory gate was relaxed.
The existing no-Actions, no-paid-provider, no-Developer-ID/notarization/public-release
boundary remains in effect. GitHub source publication uses `[skip ci]`.
