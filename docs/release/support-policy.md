# Support policy — draft for the first macOS release (2026-10-11)

Status: **draft, not published.** The release itself is NO_GO until the human acceptance gates of
`docs/multilanguage-plan-2026-10-02/07-delivery-release-gates.md` are closed. This document states what the
product can be supported *for* when it ships, what it explicitly does not promise, and how problems are
reported. Nothing here is a warranty or a legal statement.

## Supported platform

| Item | Supported | Not supported in this release |
| --- | --- | --- |
| Operating system | macOS 13.0 or later on Apple Silicon (arm64), as declared by the bundle's `minimumSystemVersion` and architecture record | Intel Macs, macOS 12 and earlier, Windows, Linux (Windows/Linux packaging exists in the repository but is not part of this release) |
| Installation | One signed, notarized application bundle installed by the user into `/Applications` (or any writable folder); nothing is installed outside the bundle and the user's data directory | Unattended or background installation, MDM push, in-place silent updates |
| Runtime | Everything the app needs is inside the bundle (Electron, bundled JRE 21, PostgreSQL, Redis, TypeScript analyzer worker). No Xcode, Homebrew, Java, Node, Docker or database installation is required on the Mac | Running against an external PostgreSQL/Redis, running the backend standalone |
| Accounts | Login-free analysis of local folders; optional GitHub OAuth for importing repositories, with explicit permissions | Other Git hosts, organisation SSO, shared/multi-user installations |
| Analysis languages | Java (Spring), TypeScript/JavaScript (Nest, React), SQL migrations, build/infra config as listed in `02-language-support.md` R1 cells | Languages shown as UNSUPPORTED/UNMEASURED in the per-file outcome; parse success is not an accuracy claim |
| Repository size classes | small (1k files/5 MiB), medium (10k files/50 MiB), large structure exploration (50k files/200 MiB) as defined in `05 §4`; limits are enforced with diagnostics, not silent truncation | Repositories above the hard limits (50k files/512 MiB preview); monorepos needing more than the 10 GiB workspace quota |

## What the product promises and what it marks as uncertain

- Every published fact is bound to retained source bytes (hash + span). Facts the analyzer could not
  resolve are published as abstentions with a reason, not as guesses. A missing relation is not proof that
  no dependency exists.
- Performance targets in `05 §4` are **development goals**; the release notes state which were measured on
  the reference machine and which remain unmeasured.
- AI features are off by default, need a user-saved key and an explicitly activated budget, and never send
  data without a per-request approval. The outbound host and the masked prompt are shown before sending.

## Updates

- Updates are user-initiated ("Check for Updates…" in the application menu). The app downloads a full
  signed artifact, verifies the manifest signature against pinned keys, the artifact hash, the bundle
  identity, Team ID, notarization and staple, then shows the verified installer and quits. The user
  installs it. No silent in-place swap.
- A build that fails its data upgrade leaves the previous database checkpoint in place; the next start is
  recovery-only and offers to restore it (see `install-and-recovery.md`).
- Downgrades are refused except through a signed recovery manifest bound to a retained checkpoint.
- Support window (proposal): the current release and the previous release receive fixes; older releases
  receive the instruction to update. The owner decides the exact window before publication.

## Data and privacy

- All analysis data lives under the user's Application Support directory for the app; the app never
  writes outside its bundle, its data directory and the user-chosen backup destination.
- Imported source is retained in an encrypted vault keyed through the macOS Keychain; the backup archive is
  encrypted and restorable only on the same installation unless the owner documents otherwise.
- The product makes no network connection on its own except: GitHub (only when the user connects an
  account), the AI provider the user configured (only on approved requests) and the update host (only on a
  user-initiated check). The egress probes in `validation/pre-release` verify this per candidate.

## Reporting a problem

- Preferred: a GitHub issue in the public repository with the app version/build sequence (About box),
  macOS version, the diagnostic code shown in the dialog (e.g. `UPDATE_ARTIFACT_HASH`,
  `UPDATE_CHECKPOINT_RECOVERY_REQUIRED`) and the steps. Do not attach the encrypted backup, the Keychain
  item or API keys.
- Diagnostic codes are stable identifiers; dialogs never show paths, tokens or source text.
- Security reports: a private channel the owner publishes with the release (open item in
  `USER-INPUT-READINESS`). Until then, use the repository's private vulnerability reporting if enabled.

## Open items before publication

Publisher identity and contact channel, exact support window, Developer ID/notarization, counsel decisions
on bundled-runtime licences (`third-party-source-availability.md`), and the human acceptance gates
(independent security, accuracy, UX/VoiceOver, real-account, legal) recorded as BLOCKED in 07.
