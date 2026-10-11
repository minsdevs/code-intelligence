# Third-party source availability and runtime exclusions — 2026-10-11 (draft)

This file records **facts** the release packaging needs for the stage-7 items "JRE source offer" and
"jmh-core cleanup" of `07-delivery-release-gates.md`. It is not a legal determination; the licence
election for Redis, the LGPL relink statement for FFmpeg, the EPL-2.0 source statements and the wording
of any written offer remain counsel decisions (see `docs/audit/supply-chain-sbom-2026-10-07.md` §D3–D5).

## Bundled Temurin JRE (GPL-2.0-only WITH Classpath-exception-2.0)

The macOS bundle ships a jlink image of the Eclipse Temurin JDK recorded in
`desktop/scripts/macos-runtime-supply.json` (`jre`). The record binds the exact binary and the exact
corresponding source, which is what a source-availability statement has to name:

| Field | Value |
| --- | --- |
| Vendor / build | Eclipse Adoptium, `Temurin-21.0.12+8` (`21.0.12+8-LTS`) |
| Binary archive | `OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12_8.tar.gz`, 200,069,721 bytes, SHA-256 `021d629349ebc12a409faa517b837ec80ceee8f58a5ac85c788ecad07ca6881c` |
| Binary URL | <https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12_8.tar.gz> |
| Corresponding source (tag) | <https://github.com/adoptium/jdk21u/tree/04806bcb1d50> (`SOURCE=".:git:04806bcb1d50"` in the JDK `release` file) |
| Corresponding source (archive) | <https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jdk-sources_21.0.12_8.tar.gz> |
| Build scripts | <https://github.com/adoptium/temurin-build> at `e6ba7dec3d07654074559310376a3ae89da5f4ac` |
| Licence texts in the bundle | `Contents/Resources/runtime/jre/legal/` (78 files, included in the generated third-party notices) |

Binding of the bundled image to this JDK is recorded in `docs/audit/supply-chain-fixes-2026-10-07.md`
("JRE supply record"): identical files apart from the staging `@rpath` rewrite and the ad-hoc signature;
`sbom-jre-supply.cjs` re-checks the vendor and version witnesses of every candidate.

**Proposed notice text (for counsel review, not adopted):** "This application includes a runtime built
from Eclipse Temurin 21.0.12+8 (OpenJDK, GPL-2.0-only WITH Classpath-exception-2.0). The complete
corresponding source is published by the Eclipse Adoptium project at the tag and archive URLs above;
the publisher of this application will also provide it on request for three years from distribution."
The publisher name, the request channel and whether the archive is mirrored by the publisher are open
decisions (stage 7 row, `USER-INPUT-READINESS`).

## jmh-core, jopt-simple, commons-math3 (D2) — resolved in the build, verified per candidate

`com.github.jsqlparser:jsqlparser:5.3` declared `org.openjdk.jmh:jmh-core` in compile scope; the backend
build excludes `org.openjdk.jmh` (`backend/build.gradle.kts`), and `validation/pre-release/licence-policy.json`
`excludedRuntime` plus `sbom-runtime-exclusions.cjs --jar` refuse a candidate whose backend JAR still nests
`jmh-core`, `jopt-simple` or `commons-math3`. The last SBOM run on a candidate (`wFroXK`, 2026-10-08)
reported `EXCLUDED_RUNTIME_ARTEFACT: 0` and 348 components with zero unattributed files. The next candidate
of this round repeats the check; the result is recorded in `docs/audit/install-update-2026-10-11.md`.

## Still counsel items (unchanged)

Redis licence election and notice placement, FFmpeg (LGPL) relink statement and codec list, EPL-2.0
source statements for six components, and the final wording and channel of the JRE offer above.
