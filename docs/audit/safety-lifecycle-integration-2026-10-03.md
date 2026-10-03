# Main safety lifecycle integration — 2026-10-03

This is an **AI-disabled intermediate integration**, not the completed strict budget gateway,
format3 exporter/restore loader, or a release approval. The existing desktop main process now owns
the purpose keyring and safety journal for its lifetime. Normal OFF permits local analysis; missing
or incompatible safety state prevents normal runtime startup. AI admission is always rejected.

Scope: `desktop/src/safety-lifecycle.cjs`, `desktop/src/main.cjs`, their two Node test files, and this
document. The existing `backup.cjs`, keyring, journal, source module, schema, and frozen roadmap were
not changed by this integration. The parent task owns staging build-sequence validation, the backend
disabled-feature guard, and UI explanations; this report does not substitute for their verification.

## Startup, identity, and enrollment

1. Verify the runtime manifest and require `buildSequence` to be an explicit canonical decimal string
   in `0..9223372036854775807`. Numbers, leading zeros, signs, whitespace, semver, missing values, and
   overflow are rejected. There is no `0`, time, or version fallback. This validation precedes identity,
   enrollment, child-process, or runtime data writes.
2. Load existing `secrets.enc` through Electron safeStorage and validate its historical three-field
   shape. Existing identity/decryption/permission failures do not invoke a fallback. If the file is
   absent, any `safety`, `.safety-enrollment.json`, `postgres`, `data`, `redis`, `recovery`, or
   `authorized-paths.enc` entry—including a dangling symlink—prevents new secrets. Fresh publication
   uses exclusive create, mode 0600, file fsync and parent-directory fsync. Failed publications remain
   evidence; they are not removed for retry.
3. Canonicalize private userData and bind the safety state to its existing `localIdentity`. The final
   directory must be an owned 0700 directory, not a symlink. Existing files must be owned 0600 regular
   files with one link. Parent aliases such as macOS `/var` are resolved before primitive access.
4. Before initializing any purpose keys, exclusively create and fsync
   **`userData/.safety-enrollment.json`**, then fsync userData. This marker is outside both ordinary
   restore area A and the `safety/` directory. Its exact version/identity binding is checked on open.
   Loss of all of `safety/` therefore cannot look like first enrollment. Marker present means **open
   only**; missing files, partial publications and stale locks never cause `initialize*` to run again.
   Existing B without the marker also fails closed; it is not silently adopted.
5. Initialize/open the purpose keyring, then initialize/open the journal using that keyring. The
   journal starts/reopens OFF. Incompatible major, recovery-only state, pending restore, or a persisted
   minimum build above the running build prevents core runtime startup. Acquired handles are closed
   in journal → keyring order on failure; marker and failed B contents are preserved.

An existing installation with readable secrets and legacy A, but no marker and no B, may enroll B
once with the **same identity and AI OFF**. This does not import legacy accounting or authorize AI.
Missing legacy secrets cannot be repaired by inventing a new installation identity.

The primitives receive all current ordinary storage roots: `userData/postgres` (the current actual
PG root, also covering a future nested `data`), `userData/data` (including repo restore staging), and
`userData/recovery`. Selected external backup/restore paths are never admitted because these actions
are disabled. A future loader must add and validate its real staging/swap/destination roots; this
list is not approval for an arbitrary future restore path.

## Production key wrapper and main-only facade

The production adapter is macOS-only and requires `safeStorage.isEncryptionAvailable() === true`.
It does not enable plaintext fallback. Unsupported platforms, including Linux `basic_text`, fail
closed. Electron documents platform-dependent storage protections and the need for consistent macOS
code signing. Actual OS behavior is not demonstrated by these synthetic tests.
[Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).

The adapter does **not** assume OS string encryption authenticates a keyring payload. Each wrap uses
a fresh 32-byte DEK and 12-byte nonce, and Node's built-in `aes-256-gcm` encrypts the purpose-keyring
bytes. Only the canonical base64 DEK, prefixed with `code-intelligence-purpose-dek:v1:`, is passed to
safeStorage. The exact encrypted DEK bytes are authenticated together with the envelope header.

Binary envelope, in order:

| Field | Bound / meaning |
| --- | --- |
| Header | 8 bytes `CIPKR001`, 4-byte big-endian wrapped-DEK length, 4-byte big-endian plaintext length |
| Wrapped DEK | 1–8192 bytes from safeStorage |
| Nonce | 12 random bytes |
| Ciphertext | 1–32768 bytes, equal to the keyring plaintext length |
| GCM tag | 16 bytes |

The GCM AAD is `code-intelligence-purpose-keyring-aead-v1\0` followed by the exact 16-byte header and
wrapped-DEK bytes. Total envelope size is 46–41004 bytes, with exact length checks before OS unwrap.
Malformed DEKs, header changes, nonce/ciphertext/tag corruption and cross-envelope splices fail
before returning plaintext. `decipher.final()` must authenticate before the result is returned.
Owned DEK and temporary plaintext Buffers are zeroed on success and failure. **JavaScript strings,
V8 copies, native crypto copies, OS memory, and files are not claimed to be securely erased.**

The returned lifecycle facade is frozen and contains only:

- `diagnostics()` → `{ aiOff: true, recoveryOnly: boolean }`;
- `latch(reason)` → the same limited diagnostics after the journal write completes;
- `denyAdmission()` → static `DESKTOP_AI_SAFETY_UNAVAILABLE` rejection;
- `close()` → one shared promise, closing journal before keyring.

The internal `verifyCommittedReservation`, `verifySettlement`, and `verifyActivation` callbacks all
return false. No activate/reserve/settlement, key export, journal snapshot, projection map, or keyring
capability is returned by the facade, placed into renderer IPC, or placed into child environments.
Diagnostics are an in-memory OFF/recovery observation, not a live PG seal or tamper-watch proof.

`runtime:status` keeps existing ready/error/service fields and adds only public `aiOff`,
`recoveryOnly`, `backupAvailable: false`, and `restoreAvailable: false` values. `runtime:config`
retains its existing renderer API token and URL only. That token is not safety authority. There is
no temporary HTTP permission server or environment setting capable of enabling this facade.

## Runtime lifetime and maintenance

Startup, user operations, restarts and shutdown use the same main operation queue. Repeated quit
events wait on one shutdown promise, including when there are **zero child processes**. Shutdown
latches OFF before stopping backend/analyzer/Redis/PostgreSQL, then closes journal and keyring.
Journal latching conservatively retains unresolved obligations; this integration does not verify
actual PG reservations, price catalog, provider usage, or an external request drain.

Backend restarts retain the same main safety handles. A failed latch still stops children and blocks
normal restart. If a child does not confirm exit, including a synchronous `kill()` exception, it
remains tracked and main does not release safety ownership. A clean child shutdown with a failed B
close reports a static recovery error; no lock or state is reset. Stale locks require explicit offline
recovery, never a PID heuristic or automatic unlink.

Quit during startup cancels later service/window creation, waits for the active startup operation,
then latches and closes B. Intentional cancellation is not converted into a recovery error that
would skip the latch. An ordinary A/startup error likewise does not prevent healthy B from being
latched during shutdown. Partial lifecycle initialization closes only acquired handles.

`withBackendPaused` now requires a healthy safety facade and a completed latch before stopping the
backend or invoking its action. Its latch is **not** a PG safety seal. Product `data:backup` and
`data:restore` are unconditionally rejected **before dialogs, path reads, pg_dump, repository copy,
pg_restore, pause, or A mutation**. The old main live restore/export bodies were removed, while the
standalone legacy backup primitive and its tests were preserved. Future format3 support must not
reintroduce the legacy primitive as a shortcut around exporter policy, staging, seal, or merge.

Bundled child processes now inherit only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`,
`USER`, and `LOGNAME`, plus values explicitly supplied by main. The same helper is used by managed
children, synchronous bundled commands and `pg_isready`. Host provider/GitHub keys, `NODE_OPTIONS`,
`JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, dynamic-library injection and arbitrary environment values
are not inherited. Existing explicit backend/psql credentials remain narrowly supplied; the public
GitHub native client ID still comes from its existing explicit setting. This is not an OS sandbox.

## Verification and limits

Author final run: **118/118 PASS**, zero failure/cancel/skip/todo, Node v26.5.0. Evidence:

- `/tmp/ci-safety-main-final-2026-10-03.log`
- `/tmp/ci-safety-main-final-2026-10-03.xml`
- `/tmp/ci-safety-main-final-2026-10-03.json` (counts and frozen source hashes)

The lifecycle suite uses the real primitives with private POSIX temporary files and synthetic string
storage. Its VM explicitly models `darwin`, so the tests remain usable on Linux CI without weakening
the production macOS guard or adding a production test switch. Separate VM fixtures verify Linux
and Windows refusal. The main suite evaluates the real main source in a Node VM with synthetic
Electron/child-process/filesystem boundaries; no Electron application is launched.

Covered: strict sequence/no-write failure; fresh/legacy identity; corrupt or unsafe secrets;
durable external enrollment marker ordering and fsync failure; loss of all B; mismatched/missing
markers; corrupt journal; stale/live locks; retained key bytes across reopen; minimum build;
pending/unknown journal state; all verifier denials; AEAD corruption/splice with **plaintext-copy
synthetic OS storage**; Buffer cleanup; startup failure/quit races; zero-child/repeated shutdown;
synchronous kill failure; restart handle reuse; latch-before-action; static backup/restore denial;
public status boundaries; and synthetic host secret/injection environment sentinels.

Independent read-only review supplied 15/15 passing synthetic probes in
`/tmp/ci-safety-main-independent-probe-2026-10-03-third.log`, including reproduced kill-throw and
startup-quit failures before their fixes. Its envelope probes also cover maximum/minimum sizes,
malformed length rejection before OS calls and preserving caller input. These are separate from
the author's 118 cases, not an aggregate full desktop test count.

The initial 68-case lifecycle draft used a prefix-only OS wrapper; it is historical draft evidence,
not the authenticated production candidate. The later 116-case draft predates the final environment
allowlist and strengthened startup-quit assertions. The 117-case candidate precedes the final Redis
installation-evidence guard and its regression. Parent full Node/staging/backend gates must use
the final frozen files and report their own results separately.

Not executed here: real Electron/Keychain, installed userData, GUI, actual PG/Redis/provider calls,
Gradle, Docker, real credentials, signing/notarization, or distribution/update checks. The unsigned
runtime manifest's explicit sequence is not itself proof of a signed release or anti-rollback trust.
Path checks are not native hostile-ancestor confinement, nor protection against an attacker who can
roll back all state as the same OS account. There is no secure-erasure claim.

**Release remains No-Go** until strict reservation/budget/provider admission and reconciliation,
legacy accounting handling, protected format3 export and isolated restore, native/source confinement,
signed build/update trust and installed-app acceptance are implemented and verified. This slice's
verified result is main-owned B lifetime with deliberate AI/backup/restore refusal and local OFF
runtime behavior, not completion of those gates.
