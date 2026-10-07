# Supply chain, SBOM and licence obligations on candidate 1lvULq — 2026-10-07

This unit works on stage 7 of `07-delivery-release-gates.md`: an exact dependency
SBOM, licence obligations, provenance of every bundled runtime and advisory
status for the current candidate **1lvULq**
(`.native-product-1lvULq/Code Intelligence Validation.app`, build sequence
`1791292686000`, bundle tree digest `f0087502…d4d7d9`). The bundle was only read:
no file was extracted and run, and the app was not launched. The candidate now has
a **complete CycloneDX 1.5 SBOM: 0 of 5,397 bundle files are unattributed**. It
does **not** meet its redistribution obligations: in particular it ships no
Electron/Chromium licence files and no third-party notices. A packaging fix is
committed but takes effect only from the next candidate. Redis, JRE and FFmpeg
licence items need counsel. Formal release remains **NO_GO**.

Exact commands, digests and the full requirement matrix are in the
[companion ledger](supply-chain-sbom-2026-10-07.json).

## What was added

| File | Purpose |
| --- | --- |
| `validation/pre-release/sbom-candidate.cjs` | Offline generator. Walks the bundle, hashes every file and every first-level member of `app.asar`, the backend JAR and the control JAR, attributes each to a component, re-checks the runtime manifest, and emits CycloneDX 1.5 JSON plus attribution, Mach-O, licence-obligation and licence-text reports into a new private `validation/local/sbom/run-*` directory. |
| `sbom-macho.cjs`, `sbom-zip.cjs`, `sbom-maven.cjs` | Byte readers: Mach-O load commands (loads, rpaths, install name, `LC_BUILD_VERSION`), a bounded in-memory ZIP reader with CRC checks, and POM licence lookup in the read-only Gradle cache. |
| `licence-obligations.cjs`, `licence-policy.json` | SPDX parsing, election of the least-burdensome alternative, obligation checklist and blocking findings. This is an engineering policy, not legal advice. |
| `licence-notices.cjs` | Builds `desktop/build/third-party-notices/` from one SBOM run. Texts come only from the candidate itself, the checkout's frontend module at its exact lock path and version, or a recorded reference copy. Missing texts stay visible as `TEXT_MISSING`. |
| `desktop/package.json` (`build.mac.extraResources`), `desktop/build/third-party-notices/*` | Packaging fix (defect D1). |
| `test/sbom-candidate.test.cjs`, `test/licence-obligations.test.cjs`, `test/licence-packaging.test.cjs` | 24 tests with authored fixtures, plus the packaging regression. |

The format is CycloneDX 1.5 JSON. The official schema is not available offline,
so `validateCycloneDx` checks the structural subset the generator uses: header,
UUID serial, component types, unique `bom-ref`, SHA-256 hashes, the one-expression
licence rule, dependency and composition references. The generator refuses to
write a document that fails this check.

## Results on 1lvULq (run `run-RfY8JR`)

| Area | Result |
| --- | --- |
| Attribution | 5,397 files and 14 symlinks (0 point outside the bundle). 8,372 attributed rows, including archive members. **0 unattributed**, so `completeSbom=true` and the composition is `complete`. Runtime manifest: 5,130 declared files, all present with matching hashes. |
| Components | 350 in total: 6 first-party, Electron plus 9 Electron parts, 1 JRE, 5 native runtimes (PostgreSQL, pgvector, OpenSSL, Redis, IANA tzdata), 8 embedded native libraries, 154 Maven, 127 npm (21 in `app.asar`, 106 in the analyzer tree), 39 frontend-bundle npm. |
| Backend JAR | 153 nested JARs. 152 are identified by file name plus SHA-256 against the Gradle runtime resolution. `spring-boot-jarmode-tools-4.1.0.jar` is identified by SHA-256 against the resource embedded in the cached `spring-boot-loader-tools-4.1.0`. All 100 loader classes match the cached loader JAR byte for byte. |
| Control JAR | All 1,222 members attributed by exact bytes: 6 first-party classes (provenance hashes), 1,206 dependency members, 9 relocated licence files, 1 manifest. The JAR SHA-256 equals the shipped provenance record. |
| Electron | 44.4.5. String witnesses in the framework binary: Chromium 152.0.7977.130, V8 15.2.124.28, Node 24.21.0. The analyzer runs on this embedded Node (`ELECTRON_RUN_AS_NODE`); the bundle has no separate Node binary. |
| JRE | jlink image of Eclipse Temurin 21.0.12+8-LTS (vendor witness "Eclipse Adoptium" in `libjvm.dylib`; `release` has `JAVA_VERSION="21.0.12"`). 18 modules, 78 files under `jre/legal/`. |
| Native | PostgreSQL 16.15 with extensions `plpgsql`, `pg_trgm` and `vector`. pgvector 0.8.7, OpenSSL 3.5.8 (one copy each under `postgres/lib` and `redis/lib`). Redis 8.10.2, with its tri-licence text (RSALv2/SSPLv1/AGPLv3, 1,399 lines) shipped as `postgres/share/code-intelligence-notices/redis-8.10.2-LICENSE.txt`. |
| Grammars and addons | No tree-sitter grammar, `.wasm` or `.node` addon is shipped; the tree analyzer is not part of this bundle. |
| Mach-O | 100 files (all arm64), 0 parse errors. 434 references: 336 system, 93 in-bundle, 5 in-bundle through the executable's rpath. **0 external references, 0 external rpaths, 0 unresolved**. No Swift runtime is referenced. The `otool -l`/`-L` cross-check of all 100 files gave MATCH 100. `LC_BUILD_VERSION` minimum OS: 13.0 for 66 files (Electron 13, PostgreSQL 50, Redis 3) and 11.0 for 34 JRE files. The maximum is 13.0, equal to `LSMinimumSystemVersion` 13.0. |
| Rpaths | Electron uses `@executable_path/../Frameworks`, `@executable_path/../..` (and two deeper variants) and `@loader_path/Libraries`. The JRE uses `@loader_path`, `@loader_path/.`, `@loader_path/..` and `@loader_path/../lib`. PostgreSQL and Redis have no rpaths. |

## Licence obligations

Licence classes over the 344 third-party components: permissive 334, weak
copyleft 7, strong copyleft 3, unknown 0. In the **current candidate** 102
components have blocking findings: 96 lack a licence text, 6 lack a
source-availability statement, 3 carry a strong-copyleft source duty (one of them
network copyleft). 15 components needed an election between licence
alternatives; each election is recorded.

| Component | Class / election | Shipped evidence | Assessment |
| --- | --- | --- | --- |
| Redis 8.10.2 | RSALv2 OR SSPLv1 OR AGPLv3. The policy lists AGPLv3 as the least burdensome, but this needs confirmation. | Licence text shipped. | **Release-blocking, legal.** None of the three is a notice-only licence. AGPLv3 requires a Corresponding Source offer. RSALv2 and SSPL are source-available or restricted. Counsel must choose an option, or the product must change runtime (05 §6 forbids silent substitution). Reachability is local only: loopback, TLS, `requirepass`, protected mode. |
| Temurin JRE 21.0.12+8 | GPL-2.0 WITH Classpath-exception-2.0 | `jre/legal/` (78 files) | **Release-blocking until done.** Binary redistribution needs a GPL §3 source offer or a link to the exact Temurin source tag. |
| FFmpeg (Electron `libffmpeg.dylib`) | LGPL-2.1-or-later | None in the current bundle | **FAIL in the candidate** (no `LICENSES.chromium.html`). Source offer and replaceability of a dylib inside a signed bundle need counsel. The default Electron build includes proprietary codecs (patent licensing). |
| Electron, Chromium, V8, Node, SwiftShader, Crashpad, Squirrel.Mac | MIT / BSD-3-Clause / Apache-2.0 | None in the current bundle | **FAIL in the candidate.** electron-builder copies only `Electron.app`, not the archive's top-level `LICENSE` and `LICENSES.chromium.html`. Fixed in packaging (D1). |
| Mantle, ReactiveObjC | MIT | None | Not credited in `LICENSES.chromium.html`; texts not available offline. Open. |
| PostgreSQL 16.15 / pgvector 0.8.7 / OpenSSL 3.5.8 | PostgreSQL / PostgreSQL / Apache-2.0 | `code-intelligence-notices/` | Met. Embedded Snowball (BSD-3) and Henry Spencer regex texts are not shipped (open). IANA tzdata is public domain. |
| Tree-sitter grammars | — | — | Not shipped in this candidate. |
| logback-core/-classic, aspectjweaver, jakarta.annotation-api, jakarta.transaction-api, elkjs | EPL-2.0 elected | Partly | Source-availability statement missing (6). Open, needs a notice line plus counsel. |
| jmh-core 1.37 | GPL-2.0 WITH Classpath-exception-2.0 | Text in JAR | Should not ship (D2). |
| 42 Maven (incl. the loader), 1 analyzer npm, 38 frontend-bundle components | permissive | No licence text in the bundle (the remaining 15 of the 96 missing-text rows are the Electron and embedded rows above) | No central notice in the current bundle; the generated notices file supplies texts for all but 8 of these 81 (see D1, D5). |

The policy (`licence-policy.json`) records 8 embedded native libraries. They are
reviewed assertions from the upstream source layout, supported by name strings
in the binary where these exist. Redis bundles Lua 5.1, hiredis, hdr_histogram,
fpconv, fast_float and xxHash. PostgreSQL bundles Snowball and Henry Spencer's
regex. Embedded versions and their exact licence files are not verified offline.

## Provenance

| Runtime | Record | Bytes against record |
| --- | --- | --- |
| PostgreSQL, pgvector, OpenSSL, Redis | `desktop/scripts/macos-runtime-supply.json`: URL, SHA-256, checksum source. The shipped `source-lock.json` equals the repository lock. | The version witness in each binary matches the lock (for Redis via the `REDIS_VERSION` constant). Binary-to-source identity is not proven, because the build is not reproducible. The pgvector digest is observed, not signed by the maintainer. |
| Electron 44.4.5 | `electron/checksums.json` from the locked npm package | The archive SHA-256 `a212eee6…` matches the record. Of the bundle files: 237 identical, 13 identical in code apart from the ad-hoc signature, 4 `Info.plist` rewritten by the packager, 0 different, 0 absent upstream. |
| Maven (153) | Gradle runtime resolution `runtime-resolved-1lvULq-20261007.json` | All 153 match by SHA-256. The repository has no Gradle verification metadata, so there is no independent digest record. |
| npm (127) | `desktop/package-lock.json` (checkout), shipped analyzer lock | 127 of 127 versions match. Tarball integrity bytes were not checked again (NOT RUN). |
| Temurin JRE | **None.** The supply lock covers only the four C sources. | No record → FAIL (D4). |
| Frontend bundle (39) | Checkout frontend lock plus licence banners | Declared, not bound to bytes (minified assets). |

## Advisory status

The documented scanner was run again with its existing online step
(`scan-candidate-advisories.cjs --online-public-packages`) at
2026-10-07T04:51Z. It checked 276 coordinates (124 npm and 152 Maven, all
confirmed on the anonymous public registries), queried OSV and returned
**`NO_MATCHES_IN_QUERIED_COORDINATES`, 0 advisories**. One coordinate was omitted
(`spring-boot-jarmode-tools-4.1.0.jar`, which has no hash match in the
resolution). The earlier scan at 2026-10-06T16:09Z gave the same result and is
kept. A no-match result does not prove safety or full coverage. The scan does not
cover the frontend bundle (39), the embedded native libraries, or the runtimes
below.

Manual note, **unverified-offline**: my knowledge does not cover these exact
releases, so I can make no claim about advisories for them. A human must check the
vendor advisories for: Electron 44.4.5 / Chromium 152.0.7977.130 / V8
15.2.124.28 (Electron security advisories, Chrome stable release notes); Node
24.21.0 (Node.js security releases); Temurin 21.0.12+8 (Oracle and OpenJDK
Critical Patch Updates after its release); PostgreSQL 16.15; pgvector 0.8.7;
Redis 8.10.2, including its embedded Lua (Redis security advisories; Lua
scripting has a history of memory-safety CVEs); OpenSSL 3.5.8. Reachability
depends on the service: Redis and PostgreSQL listen only on loopback with
credentials (and TLS for Redis). Chromium renders local first-party content and
is the largest external attack surface.

## Defects

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| D1 | High (blocks public release) | The bundle ships no Electron `LICENSE` or `LICENSES.chromium.html`. These cover Chromium, FFmpeg and other parts and are required by MIT/BSD/Apache/LGPL. There is also no central third-party notice for the npm and Maven components; most Maven and frontend texts are present only inside JARs or not at all. Reproduced: `licence-packaging.test.cjs` failed 2 of 3 before the fix (`validation/local/sbom-tests/licence-packaging-red.log`). | **Fixed in packaging inputs.** `build.mac.extraResources` copies `node_modules/electron/dist/{LICENSE,LICENSES.chromium.html}` to `Contents/Resources/legal/electron/` and `build/third-party-notices` to `Contents/Resources/legal/third-party/`. The generated notices cover 311 components with texts, 13 that have their own legal files elsewhere, 5 that need no notice and 15 without an available text, at 179 distinct texts. The test now passes 3 of 3. A built candidate has not yet verified this. Windows is unchanged. |
| D2 | Medium | `com.github.jsqlparser:jsqlparser:5.3` declares `org.openjdk.jmh:jmh-core:1.37` in compile scope. This puts jmh-core (GPL-2.0 WITH Classpath-exception), jopt-simple and commons-math3 into the production backend JAR, and none of jsqlparser's 527 classes references `org/openjdk/jmh`. | Open. Proposed: `implementation("com.github.jsqlparser:jsqlparser:5.3") { exclude(group = "org.openjdk.jmh") }` in `backend/build.gradle.kts`, followed by the backend suites and a candidate rebuild. Not changed here because it is outside this unit's area and needs a backend build. |
| D3 | Low | `redis-server` contains its build ID, which includes the hostname of the build machine (`uname -n` plus a timestamp, as generated by Redis's `mkreleasehdr.sh`; [INFERENCE] on the mechanism). This discloses build-host information in a shipped binary. | Open. Proposed: give the native provisioning a fixed build ID, for example by overwriting the generated `release.h` before compiling. |
| D4 | Medium | The JRE has no recorded upstream URL or digest. | Open. Proposed: add the Temurin JDK archive (URL, SHA-256, checksum source) to the supply lock, or a separate JDK record that runtime staging checks. |
| D5 | Medium | 15 components have no licence text available offline: Mantle, ReactiveObjC, antlr4-runtime, asm, istack-commons-runtime, jopt-simple, JGit, redis-authx-core, webjars-locator-lite, `@tokenizer/token`, and Lua, hiredis, xxHash, Snowball and Spencer regex. | Open. A human must add the upstream texts as reference inputs (online fetch is outside this unit), then run `licence-notices.cjs` again. |

## Limits

- The SBOM binds the frontend bundle only to lockfile declarations. Members of
  nested JARs inherit their JAR component, and shaded packages inside a JAR are
  listed only as package roots.
- Native binaries are bound to the lock by version strings, not by reproducible
  builds. Embedded native libraries are reviewed assertions.
- The licence classes are an engineering checklist. Every `LEGAL_REVIEW` item
  (Redis, JRE, FFmpeg) and every source-offer item needs counsel.
- The packaging fix was checked only through its inputs and a regression test. No
  candidate was built in this unit. The notices file reflects 1lvULq and must be
  generated again (`licence-notices.cjs`) whenever dependencies change. The SBOM
  of the next candidate reports `thirdPartyNoticesIndex` and moves the matching
  obligations to `BUNDLE_LEGAL`.
- No macOS 13 hardware was used; the minimum-OS result comes from load commands
  only.

## Requirement matrix

PASS 18, FAIL 3, NOT RUN 9, BLOCKED 3. This is a row-level record, not a gate verdict.

| ID | Requirement | Status | Basis |
| --- | --- | --- | --- |
| S7-01 | Standard SBOM (CycloneDX 1.5 JSON) with component hashes from a committed, tested, offline script | PASS | run-RfY8JR/sbom.cdx.json; validateCycloneDx structural check; sbom-candidate.test.cjs 12/12 |
| S7-02 | Every bundle file attributed or listed as unattributed; unattributed count reported | PASS | 5,397 files, 8,372 rows, 0 unattributed; composition complete |
| S7-03 | npm packages in app.asar and analyzer production tree with name, version, declared licence, integrity | PASS | 21 + 106 components; 127/127 lock versions match; lock integrity recorded |
| S7-04 | Maven artefacts in BOOT-INF/lib and control JAR including shaded members (hash-bound) | PASS | 153 nested JARs SHA-256 identified; control JAR 1,222/1,222 members attributed by exact bytes; loader 100/100 |
| S7-05 | Bundled JRE: vendor, exact version, release file, module list, legal directory | PASS | Temurin 21.0.12+8-LTS, vendor witness Eclipse Adoptium, 18 modules, 78 legal files |
| S7-06 | Electron with Chromium/Node versions and licence files | PASS | 44.4.5 / Chromium 152.0.7977.130 / V8 15.2.124.28 / Node 24.21.0; licence-file absence recorded under S7-12/S7-15 |
| S7-07 | PostgreSQL, pgvector and other PostgreSQL extensions | PASS | 16.15; plpgsql, pg_trgm, vector 0.8.7 |
| S7-08 | Redis exact version and its licence text as shipped | PASS | 8.10.2 (REDIS_VERSION witness = lock); redis-8.10.2-LICENSE.txt tri-licence, 1,399 lines |
| S7-09 | Node runtime used for analyzers | PASS | Electron-embedded Node 24.21.0 via ELECTRON_RUN_AS_NODE (desktop/src/main.cjs); no separate node binary |
| S7-10 | Tree-sitter grammars and native .node addons; every other Mach-O | PASS | 0 grammars/.wasm/.node in bundle; all 100 Mach-O attributed |
| S7-11 | otool over every Mach-O: zero external references, rpaths and LC_BUILD_VERSION reported, compared with macOS 13 claim | PASS | 100 files, 0 external, 0 unresolved, otool MATCH 100, max minos 13.0 = LSMinimumSystemVersion 13.0, no Swift runtime |
| S7-12 | Licence obligations satisfied by the current bundle | FAIL | 102 components with blocking findings (96 missing licence text, 6 missing source statement, 3 strong-copyleft source duties) |
| S7-13 | Redis licence treatment | BLOCKED | counsel decision on RSALv2/SSPLv1/AGPLv3 election (or runtime change without silent substitution) |
| S7-14 | JRE licence treatment (GPL-2.0 WITH Classpath-exception source availability) | BLOCKED | counsel-approved source offer or exact Temurin source link to ship |
| S7-15 | Chromium/FFmpeg licence treatment | FAIL | LICENSES.chromium.html absent from 1lvULq; packaging fix committed (S7-25); LGPL source/relink and proprietary codecs need counsel |
| S7-16 | PostgreSQL/pgvector licence treatment | PASS | postgres-16.15-COPYRIGHT, pgvector-0.8.7-LICENSE shipped; embedded Snowball/Spencer texts open under D5 |
| S7-17 | Unknown licences and conflicts listed with blocking reasoning | PASS | 0 unknown; conflicts: Redis (restricted/network copyleft), JRE and jmh-core (GPL-2.0+CPE), FFmpeg (LGPL), 6 EPL-2.0 listed in audit |
| S7-18 | Provenance of PostgreSQL, pgvector, OpenSSL, Redis (record and bytes) | PASS | shipped source-lock equals repository lock; binary version witnesses match |
| S7-19 | Provenance of Electron | PASS | archive SHA-256 equals checksums.json; 237 identical, 13 code-identical modulo ad-hoc signature, 4 packager plists, 0 differing |
| S7-20 | Provenance of Maven artefacts | PASS | 153/153 SHA-256 bound to Gradle resolution |
| S7-21 | Provenance of npm packages at byte level (tarball integrity) | NOT RUN | lock versions match 127/127; tarball integrity not re-verified |
| S7-22 | Provenance of the JRE | FAIL | no URL/digest record in repository (D4) |
| S7-23 | Advisory scan via documented reviewed flow | PASS | rerun 2026-10-07T04:51Z: 276 coordinates, 0 advisories, 1 omission; earlier 2026-10-06T16:09Z identical result kept |
| S7-24 | Manual version-based advisory notes for JRE, Electron/Chromium, Node, PostgreSQL, Redis, pgvector, OpenSSL | NOT RUN | unverified-offline: exact versions listed; offline knowledge does not cover these releases; human must check vendor advisories |
| S7-25 | Packaging change for missing notices implemented with test | PASS | desktop/package.json build.mac.extraResources + desktop/build/third-party-notices; licence-packaging.test.cjs red (1 pass, 2 fail) -> green (3 pass) |
| S7-26 | Packaging change verified in a built candidate | NOT RUN | no candidate built in this unit; coordinator builds next candidate and reruns sbom-candidate.cjs |
| S7-27 | Actual distribution file hashes match support declaration, results and docs | BLOCKED | signed/notarized release artefact (no signing credentials in this phase) |
| S7-28 | Minimum macOS 13 confirmed on real macOS 13 | NOT RUN | no macOS 13 hardware; load-command evidence only (S7-11) |
| S7-29 | Support scope and limits statement | NOT RUN | owner: coordinator |
| S7-30 | Install and recovery guide | NOT RUN | owner: coordinator |
| S7-31 | Privacy and external-transmission statement | NOT RUN | owner: coordinator |
| S7-32 | Version and release notes | NOT RUN | owner: coordinator |
| S7-33 | Development GitHub App public-distribution install scope and operating ownership | NOT RUN | owner: coordinator |

## Remaining conditions for stage 7

Build the next candidate and run `sbom-candidate.cjs` on it, expecting
`legal/electron` and `legal/third-party` with `thirdPartyNoticesIndex: PRESENT`.
Obtain counsel decisions on Redis, the JRE source offer, FFmpeg/LGPL and the
proprietary codecs, and the EPL-2.0 source statements. Fix D2 and D4, supply the
D5 texts, and check vendor advisories for the runtimes above. The coordinator
still owns the support statement, install/recovery guide, privacy/external
transmission statement, version and release notes, ownership of the GitHub App's
public distribution, and the hashes of a signed release artefact.
