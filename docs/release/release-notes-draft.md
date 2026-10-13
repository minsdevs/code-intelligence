# Release notes — draft (not a release; verdict NO_GO as of 2026-10-11)

These are engineering notes for a retained Validation candidate, not an announcement of a signed release.
The signed artifact, publisher Team ID and notarization record are **NOT_AVAILABLE**; they require the
owner inputs and acceptance recorded in the gate table. No download is offered by this document.

## Retained Validation candidate mQ5nbO (Apple Silicon)

Product source: `da580ad362a770316fd959e0886ecad7cc968be5`; build sequence `1791660490966`.
app.asar SHA-256: `948b9c152b4d807b513fc7f07694580abdfd7ea57235544f7a00f035efca9321`.
Runtime manifest SHA-256: `e5e8ffe3a1f10b35e26894ea16a76fa8365eb3432cddd9c9cb353f36fca29af8`.
The bundle is ad-hoc signed for local validation only; it is not a distributable release artifact.

### What it does

- Understand an unfamiliar repository: import a local folder (no account) or a GitHub repository (OAuth),
  get a snapshot-backed overview, search the structured results, and trace a feature through source and
  relationship evidence with links into the analysed snapshot.
- Facts are separated into observed source facts, README declarations, static-analysis candidates, AI
  inference and unmeasured behaviour. Unresolved calls are published as abstentions with a reason.
- Supported analysis cells (R1): Java/Spring, TypeScript/JavaScript (Nest, React), SQL migrations, build and
  infra configuration. Per-file outcomes show SUCCESS, PARTIAL (with reason), FAILED (with reason) or
  UNMEASURED.
- Incremental refresh of an imported snapshot with conservative recomputation; results equal a full analysis.
- Encrypted source vault, encrypted backup/restore, pre-upgrade database checkpoint and recovery-only mode.
- AI assistance is off by default, bound to a user-saved key, an activated budget and per-request approval.

### Changes since the previous candidate (engineering summary, 2026-10-12)

- Coverage: every analysis capability (parse, symbols, calls, framework, cross-domain) now records a per-file
  outcome (schema V30); the coverage report partitions each capability over the inventory instead of reporting
  symbol/call/framework/cross-domain coverage as not recorded.
- TypeScript: a call through a receiver declared as a project interface or type alias publishes the
  implementations found in the calling and declaring modules as inferred candidates (never as a confirmed call).
- Backup/restore: encrypted backups taken on an older build restore on a newer build without lowering the
  started-build floor; after a signed recovery rollback the older build can read the maintenance records the
  newer build wrote. Archives of the previous reviewed schema (V29) still restore.
- Memory: the backend JVM keeps less free heap committed between analysis steps; the medium incremental
  diagnostic stayed below 4 GiB on both runs of the two latest candidates and the large incremental diagnostic
  below 6 GiB (loaded host, one large run with an incomplete sample series; not acceptance).
- Incremental correctness: on the final candidate the large incremental result equalled a fresh full analysis of
  the same changed tree in all 21 compared categories (diagnostic run on battery, recorded as such; no timing accepted).

### Changes in the 2026-10-11 candidate (engineering summary)

- Updater: the product updater, pre-migration checkpoint and started-build floor were exercised end to end
  on a Validation candidate (install → verified update → refusals → interrupted upgrade → restore → signed
  recovery rollback). Developer ID, notarization and a real update host remain to be exercised.
- Memory: the backend requests heap release between pipeline steps/jobs with a JVM heap-shrink policy;
  the incremental phase now carries the class RSS ceiling. Large diagnostic runs stayed below 6 GiB,
  but the second medium run exceeded 4 GiB. This is not performance or memory acceptance.
- Accuracy evidence: Java abstentions carry call-site lines, inheritance edges carry clause spans, inherited
  method stubs no longer claim a file, SQL migrations publish per-file parse verdicts and statement/column
  lines, a TypeScript file with syntax errors no longer rejects the whole project (it is reported FAILED and
  excluded; the rest is analysed without a SUCCESS claim), and each fact's area is published as its namespace.

### Measured on the reference machine

The final 20-run series was **NOT_RUN**. Performance targets in 05 §4 remain development goals.
Loaded-host smoke diagnostics, including phase RSS, belong to the engineering audit and are not SLO acceptance.

### Known limitations

- Intel Macs, Windows and Linux are not part of this release.
- Accuracy cells are measured on development material only; independent evaluation annotations and the
  blind real-repository review are pending (G-ACCURACY BLOCKED). The 81-case development baseline has no
  remaining failures (development material only).
- Large repositories: structure exploration up to 50k files / 200 MiB with per-capability limits and a
  15-minute hard timeout; above the hard limits the import is refused with a diagnostic.
- Updates are user-initiated; there is no background check and no in-place swap.

### Licences and notices

Third-party notices are inside the bundle (`Contents/Resources/THIRD-PARTY-NOTICES.txt`) and in the SBOM
published with the release. The bundled Eclipse Temurin JRE is GPL-2.0 with Classpath exception; the
corresponding source is identified in `docs/release/third-party-source-availability.md`. Final licence
statements (Redis, FFmpeg, EPL-2.0 components, the JRE offer wording) await counsel decisions.

### Verification record

The gate table in `docs/multilanguage-plan-2026-10-02/07-delivery-release-gates.md` §3 and the audit
`docs/audit/release-blockers-2026-10-12.md` (and the earlier `docs/audit/install-update-2026-10-11.md`) list
every gate with PASS / FAIL / NOT RUN / BLOCKED and the raw evidence paths. The large-class memory diagnostic
and the large incremental-vs-full comparison ran on the final candidate on 2026-10-13 (audit §3.6); the 20-run
series was not run. A release is published only when the human gates there are closed and the owner records GO.
