# Installation, update and recovery guide — draft (2026-10-11)

Status: **draft for the first signed macOS release; not yet published.** Steps marked *(signed release)*
need the Developer ID / notarization inputs of `signing-notarization-runbook.md` and have not been exercised on
a signed artifact. The update and recovery behaviour below was exercised on an ad-hoc signed Validation
candidate with a loopback feed (`docs/audit/install-update-2026-10-11.md`); that is engineering evidence, not
a clean-machine acceptance.

## 1. Requirements

- Apple Silicon Mac (arm64), macOS 13.0 or later.
- About 1.5 GB for the application and, per analysed repository, roughly the repository size ×6 plus
  1 GB free (the import pre-check tells you the exact number and refuses when space is short).
- No developer tools, Java, Node, Docker or database installation. Everything runs inside the bundle.

## 2. Install *(signed release)*

1. Download the DMG or ZIP from the publisher's release page and compare its SHA-256 with the value in the
   release notes.
2. Open the DMG (or unzip) and drag **Code Intelligence** to `/Applications`.
3. First launch: macOS verifies the notarized signature (Gatekeeper). If the system reports the app as
   damaged or unverified, stop and report it; do not bypass Gatekeeper.
4. The app creates its data directory under `~/Library/Application Support/Code Intelligence` and starts its
   bundled services. Startup shows per-runtime status; a failing service shows a diagnostic code instead of
   an endless spinner.
5. Choose an entry point: **Analyze a local folder** (no account; you select the folder in the macOS dialog
   and confirm the exact exclusions shown in the preview) or **Connect GitHub** (OAuth with the permissions
   listed on screen).

## 3. Update

1. Open the **Code Intelligence ▸ Check for Updates…** menu. The app contacts only the pinned update host.
2. If a newer build is available you see "Update available". Choose **Download and verify**.
3. The app downloads the full artifact into its private `updates/` folder and verifies, in this order:
   manifest signature (pinned Ed25519 key), serial (no replay), platform/arch, minimum OS, build sequence
   (no downgrade), artifact size and SHA-256, then the downloaded app's code signature, Team ID, bundle ID,
   notarization and staple, and that its build sequence matches the manifest.
4. "Ready to install" → **Show installer and quit**. The verified installer is revealed in Finder and the
   app quits. Replace the app in `/Applications` and start it again.
5. The first start of the new build takes a **pre-upgrade checkpoint** (a copy of the database) before it
   migrates, and only after a healthy start records the new build as the minimum allowed version.

If the dialog says "No verified update", nothing was downloaded or installed; the reason code (for example
`UPDATE_SIGNATURE_INVALID`, `UPDATE_ARTIFACT_HASH`, `UPDATE_APP_NOT_NOTARIZED`) is what to report.

## 4. Recovery

### 4.1 An upgrade did not complete

Symptom at start: "Data upgrade did not complete. Normal startup is blocked."

- **Restore previous data**: the database is returned to the pre-upgrade checkpoint; your newest source
  vault and safety records are kept; the failed database copy is retained for inspection. The dialog then
  names the build to reinstall (with its runtime-manifest hash). Reinstall that build and start it.
- **Try the upgrade again**: offered when the same build is starting; it reuses the kept checkpoint.
- **Quit**: nothing changes.

### 4.2 Going back to an older build

An older build refuses to start on data that a newer build has already opened ("could not start",
`UPDATE_REJECTED`). This protects the data. The only sanctioned way back is a **signed recovery version**
offered through "Check for Updates…" that is bound to your retained checkpoint: it restores the checkpoint,
records the rollback once, reveals the older installer and quits. After that, the older build starts normally.

### 4.3 Backup and restore

Settings ▸ Backup exports an encrypted archive to a destination you choose; Restore imports one on the same
installation. Restore never lowers the minimum allowed build or re-allows a consumed update serial. A restore
that is interrupted is resumed or rolled back on the next start; see the recovery guidance shown in the app.

### 4.4 Recovery-only mode

When the safety journal or the database cannot be opened consistently, the app starts in recovery-only mode
(no parsing, no AI, no remote fetch) and shows the step to take. Follow the dialog; do not delete the data
directory unless support asks for it.

## 5. Uninstall

Quit the app, move it to the Trash, then remove `~/Library/Application Support/Code Intelligence` if you do
not want to keep the data, and the Keychain item named for the app. Backups you exported stay where you
saved them.

## 6. Diagnostics to include in a report

App version and build sequence (About), macOS version, the dialog's reason code, the time, and whether the
machine was on battery. Never include API keys, the Keychain item, the encrypted backup or source files.
