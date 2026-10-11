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

### Changes since the previous candidate (engineering summary, 2026-10-11)

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
  blind real-repository review are pending (G-ACCURACY BLOCKED). The 81-case development baseline has
  two remaining failures: TypeScript inferred call candidates and one SQL table span boundary.
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
`docs/audit/install-update-2026-10-11.md` list every gate with PASS / FAIL / NOT RUN / BLOCKED and the raw
evidence paths. A release is published only when the human gates there are closed and the owner records GO.
