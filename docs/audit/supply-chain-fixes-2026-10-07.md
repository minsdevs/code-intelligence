# Supply-chain fixes without counsel decisions (stage 7) — 2026-10-07

Unit **w3-supply**, branch `gate/w3-supply` from `d7c8952`. This unit fixes the
stage 7 findings of [supply-chain-sbom-2026-10-07.md](supply-chain-sbom-2026-10-07.md)
that need no counsel decision: D2 (jmh-core in the backend JAR), D4 (no JRE supply
record) and the offline part of D5 (missing licence texts). Counsel items (Redis
licence election, FFmpeg relink and codecs, EPL-2.0 source statements, the JRE
source offer itself) are unchanged. Candidate **LA8ZS9** was only read; no
candidate was built. Release stays **NO_GO**.

## Red / green

| Defect | Red (before the fix) | Fix | Green (after the fix) |
| --- | --- | --- | --- |
| D2 jmh-core, jopt-simple, commons-math3 in the production runtime | `sbom-runtime-exclusions.cjs --jar` on LA8ZS9's `runtime/backend/code-intelligence.jar`: `FAIL`, 153 nested JARs checked, excluded `jmh-core-1.37.jar`, `jopt-simple-5.0.4.jar`, `commons-math3-3.6.1.jar` (exit 1). Same on the `d7c8952` runtime resolution: `FAIL`, 169 checked, same 3. | `backend/build.gradle.kts`: `exclude(group = "org.openjdk.jmh")` on jsqlparser 5.3. `dependencyInsight` showed jmh-core as the only path to jopt-simple and commons-math3, so no separate exclusion is needed. | Offline `bootJar`: `PASS`, 150 nested JARs, 0 excluded (exit 0). New resolution: `PASS`, 166 checked; the diff to the old resolution is exactly the 3 removed coordinates, nothing added. jsqlparser 5.3 still packed. Backend tests (`cleanTest`, offline): `SqlMigrationAnalyzerTest` 2, `ConfigSpanLineEndTest` 4, `ConfigAnalyzersGoldenTest` 5 (full Spring context with Testcontainers, includes the broken-SQL demotion) — 11 tests, 0 failures, 0 errors. |
| D2 regression guard | — | `licence-policy.json` `excludedRuntime` (3 rules with class prefixes); `licence-obligations.excludedRuntime`; SBOM generator adds blocking `EXCLUDED_RUNTIME_ARTEFACT`. | SBOM run on LA8ZS9 (`run-qtI2BV`): `EXCLUDED_RUNTIME_ARTEFACT: 3`. The next candidate must show 0. |
| D4 JRE has no supply record | SBOM run on LA8ZS9 before the change (`run-V43GBQ`): `temurin-jre` provenance `NO_REPOSITORY_SUPPLY_RECORD`, `recordedSha256: null`. New `sbom-jre-supply.test.cjs` failed (module absent). | `desktop/scripts/macos-runtime-supply.json` gains a `jre` record beside the four C sources; `sbom-jre-supply.cjs` validates it and compares the image's version and vendor witnesses; the generator emits it as provenance and as CycloneDX `externalReferences` (archive with SHA-256, source revision, source archive). | `run-qtI2BV`: `RECORDED_MATCH`, `mismatches: []`, three external references in `sbom.cdx.json`; structural check passes. Tests: missing record → `FAIL_NO_SUPPLY_RECORD`; 8 malformed fields → `FAIL_SUPPLY_RECORD_INVALID`; 5 witness mismatches → `FAIL_SUPPLY_RECORD_MISMATCH`; broken external reference rejected by `validateCycloneDx`. |
| D5 missing offline texts | `run-V43GBQ`: `MISSING_LICENCE_TEXT: 15`; notices `TEXT_MISSING: 15`. | The generator reads an Eclipse `about.html` at a nested JAR root as licence text when it reproduces licence wording (only JGit in LA8ZS9 has one). Notices regenerated from `run-qtI2BV`. | `run-qtI2BV`: `MISSING_LICENCE_TEXT: 14`; notices `INCLUDED 312, TEXT_MISSING 14, BUNDLED_ELSEWHERE 13, NO_NOTICE_REQUIRED 5`, 180 texts. The only status change against the 1lvULq file is JGit `TEXT_MISSING → INCLUDED`. |

Target tests after all changes: `sbom-candidate`, `licence-obligations`,
`licence-packaging`, `sbom-jre-supply`, `sbom-runtime-exclusions` and
`desktop/test/macos-runtime-supply` — 66 tests, 66 pass, 0 fail. The same
pre-release suites on the merge of this branch with `gate/w2-adr01` (merge-tree,
no conflicts): 29 of 29 pass.

## JRE supply record

| Field | Value | Basis |
| --- | --- | --- |
| Vendor / build | Eclipse Adoptium, `Temurin-21.0.12+8`, `21.0.12+8-LTS` | `release` of the JDK; LA8ZS9 `libjvm.dylib` witnesses `Eclipse Adoptium` and `21.0.12+8-LTS` |
| Archive | `OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12_8.tar.gz`, 200,069,721 bytes, SHA-256 `021d6293…ca6881c` | The archive the Gradle foojay toolchain resolver provisioned for the backend's Java 21 toolchain (`~/.gradle/jdks`), hashed read-only |
| Download URL | `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12_8.tar.gz` | Adoptium release naming, as in `windows-runtime-supply.json` |
| Source (GPL-2.0 WITH Classpath-exception-2.0) | `https://github.com/adoptium/jdk21u/tree/04806bcb1d50`; source archive `…/jdk-21.0.12%2B8/OpenJDK21U-jdk-sources_21.0.12_8.tar.gz` | `SOURCE=".:git:04806bcb1d50"` and `SOURCE_REPO` in the JDK `release`; archive name by Adoptium naming |
| Build scripts | `https://github.com/adoptium/temurin-build` at `e6ba7dec3d07654074559310376a3ae89da5f4ac` | `BUILD_SOURCE` in the JDK `release` |

Binding of LA8ZS9's JRE to this JDK (one-off, read-only comparison with the
extracted JDK; the extracted `libjvm.dylib` and `release` equal the archive members
byte for byte): of 139 image files, 103 are identical and 14 are identical in code
apart from the ad-hoc signature. 20 dylibs differ because staging rewrites
`@rpath/libjvm.dylib` to `@loader_path/server/libjvm.dylib` (`otool -L`: 20 of 20
show exactly that rewrite). `lib/modules` and `release` are generated by jlink.

## Missing licence texts (D5)

Filled offline: **JGit** 7.3.0 — `about.html` inside the shipped JAR (EDL-1.0 text
and the MIT notice of the bundled SHA-1 UbcCheck). **jopt-simple** 5.0.4 stops
shipping with the D2 fix. The other 13 cannot be filled from local files:

| Component | Why not |
| --- | --- |
| Mantle, ReactiveObjC (Electron frameworks) | Not credited in `LICENSES.chromium.html` of Electron 44.4.5; no local copy of either project. |
| antlr4-runtime 4.13.2 | JAR has no licence file; the cached 4.7.2 JAR has none either; no ANTLR npm module locally. |
| asm 9.7.1 | JAR and cached sources JAR have no licence file (only per-file header comments). |
| istack-commons-runtime 4.1.2, redis-authx-core 0.1.1-beta2, webjars-locator-lite 1.1.3 | JARs contain only classes, manifest and POM; POMs name the licence without text. |
| @tokenizer/token 0.3.0 | Package contains `index.d.ts`, `package.json`, `README.md` only. |
| Lua 5.1, hiredis, xxHash (in Redis) | Redis 8.10.2 source tree is not present locally; `redis-server` carries name strings only. |
| Snowball, Henry Spencer regex (in PostgreSQL) | PostgreSQL 16.15 source tree is not present locally; the candidate ships no headers carrying them. |

Searched read-only: Gradle module cache, all four `node_modules` trees, the
candidate bundle, `~/Dev`, `~/.herdr`, `~/Library/Caches`, `/opt/homebrew`,
`/private/tmp`, `~/.cache`.

## Changed paths

- `backend/build.gradle.kts` (dependency exclusion only)
- `desktop/scripts/macos-runtime-supply.json` (`jre` record; `sources` unchanged)
- `desktop/build/third-party-notices/THIRD-PARTY-NOTICES.txt`, `third-party-notices.json` (regenerated from LA8ZS9)
- `validation/pre-release/sbom-candidate.cjs` (JRE provenance and external references, `about.html`, excluded-artefact finding; no change to the ADR-01 attribution rules of `gate/w2-adr01`)
- `validation/pre-release/sbom-jre-supply.cjs`, `sbom-runtime-exclusions.cjs` (new)
- `validation/pre-release/licence-policy.json`, `licence-obligations.cjs`
- `validation/pre-release/test/sbom-jre-supply.test.cjs`, `test/sbom-runtime-exclusions.test.cjs` (new)

## Limits

- The JRE archive digest is an observed digest of the locally provisioned
  archive. It was not compared with the Adoptium-published `.sha256.txt`, and the
  download URL and source archive URL follow the Adoptium naming without an online
  check. The source revision is abbreviated (12 hex digits) as in the JDK `release`.
- The generator binds the JRE by version and vendor witnesses only. Runtime
  staging (`stage-runtime.mjs`) still jlinks from whatever `JAVA_HOME` provides and
  does not check it against the record.
- The notices were generated from LA8ZS9, which still contains the three excluded
  JARs, so their entries remain until the notices are regenerated from the next
  candidate.
- Shipping the source link or a written offer for the JRE (S7-14) is still a
  counsel decision; this unit only records the link.

## What remains

Build the next candidate and run `sbom-candidate.cjs` and
`sbom-runtime-exclusions.cjs --jar` on it, expecting `EXCLUDED_RUNTIME_ARTEFACT`
0, JRE `RECORDED_MATCH`, and `MISSING_LICENCE_TEXT` 13; then regenerate the
notices. Compare the JRE digest with Adoptium's published checksum when online.
Have staging verify its JDK against the `jre` record. Obtain the 13 texts above,
and the counsel decisions listed in the SBOM audit.
