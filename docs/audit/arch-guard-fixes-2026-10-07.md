# Architecture guard fixes (unit w5-arch) — 2026-10-07

Scope: the two backend guard failures that the coordinator's full backend Docker suite
(`docker-integration/backend-AsxfT4`, 1,977 tests, 2 failing) found on integration head `0be7c30`.
Both guards are unchanged; the product code was changed to satisfy them. No packaged app was
launched; packaged acceptance waits for the next candidate.

## 1. `SecuritySourceExecutionTest.onlyTheReviewedProcessHelpersCanStartOperatingSystemProcesses`

Cause: w4-scale's `job.ProcessTreeMemory` started `/bin/ps` from the backend (`new
ProcessBuilder(List)`) for the R10 6 GiB watchdog (`scale-large-2026-10-07.md` §3).

Fix: the backend no longer measures. Desktop main, which owns the tree, samples it with one fixed
`/bin/ps -axo pid=,ppid=,rss=` (`execFile`, no shell, empty env, 2 s timeout, 4 MiB output cap,
same parent/child summing as before) and posts the total to `POST /api/desktop/owner-memory`.
That endpoint needs the local credential plus the main-only capability that `/api/desktop/paths`
already requires (the renderer never holds it), and answers `{watching}`; main samples every 2 s
while a run is watched and every 5 s otherwise, and only while the runtime is ready.
`ReportedOwnerTreeMemory` treats a report older than 15 s as unmeasurable (admits, like the
earlier no-`ps` case). `app.analysis.memory.owner-pid` / `ANALYSIS_MEMORY_OWNER_PID` were removed.

## 2. `ArchitectureTest.packagesMustBeFreeOfCycles`

Cause (ArchUnit members): `analysis.core.FileService -> project` is the established direction;
w3-import added the reverse edges `project.LocalImportScope -> analysis.core.LanguageDetector`
and `project.LocalLanguageCapabilities -> analysis.ts.TsAnalyzerClient`, closing nine cycles.

Fix: `LanguageDetector` (pure, no dependencies) moved to `common`. `LocalLanguageCapabilities`
became a `project` interface holding the depth vocabulary; the table moved unchanged to
`analysis.ts.TsLanguageCapabilities`, which implements it. `project` no longer depends on `analysis`.

## Red → green

| Defect | Test | Red on `0be7c30` | Green on this branch |
| --- | --- | --- | --- |
| Backend starts `ps` | `SecuritySourceExecutionTest` | 4 tests, 1 failure (`ProcessTreeMemory.ownerTreeBytes()` calls `ProcessBuilder(List)`) | 4/0 |
| Package cycles | `ArchitectureTest` | 3 tests, 1 failure (rule violated 9 times) | 3/0 |
| Report endpoint auth/demand | `DesktopRequestSecurityTest` (+1: no capability / renderer token → 403, main → 200 `watching` false/true, negative → 400) | new | 7/0 |
| Freshness, `watching()` | `AnalysisMemoryWatchdogTest` (ps parser cases moved to desktop; +2) | new | 7/0 |
| Desktop sampler/reporter | `desktop/test/owner-memory.test.cjs` (parser, real tree of the test process, failed ps, 2 s/5 s cadence, inactive, stop) | new | 4/0 |
| Main wiring | `main-runtime-gateway.test.cjs` (+1: fixed argv, body, main capability header, cadence, not-ready, stop; owner pid env gone) | new | in 163/0 below |
| Preview depth table | `TsLanguageCapabilitiesTest` | new | 1/0 |

The new tests were written with the fix, not run red separately; the guard failures are the red
evidence.

Other targeted runs (`cleanTest`, offline): `job.*` 161 tests, 0 failures, 4 skipped (opt-in
`JobAnalyzerWorkerRaceIntegrationTest`), including `JobMemoryWatchdogIntegrationTest` 2/0;
`SecurityLocalApiBoundaryTest` 4/0; `MaintenanceFilterTest` 22/0; `LanguageDetectorTest` 26/0;
`JavaAnalyzerTest` 5/0; `FileApiIntegrationTest` 7/0; `LocalPreviewApiIntegrationTest` 8/0;
`LocalSourceApprovalIntegrationTest` 22/0; `spotlessCheck` passed. Desktop: `owner-memory`,
`main-runtime-gateway`, `runtime`, `ai-egress-boundary` 163/0; `adapter-isolation`,
`isolated-build`, `native-acceptance`, `security-renderer-boundary` 65/0.
`SnapshotSourceContractIntegrationTest` (opt-in task) was only compiled.

Full backend Docker suite on this branch (base `d7aea75`, `docker-integration/backend-tdWzKu`,
`sourcesUnchanged: true`): `PASS_EXECUTED_WITH_EXPLICIT_SKIPS`, 1,979 tests, 1,947 pass, 0 fail,
32 skipped (2 more than `backend-AsxfT4`: the endpoint case and `TsLanguageCapabilitiesTest`; the
watchdog class keeps 7, its two ps cases moved to desktop).

## Changed product paths

`backend/src/main/java/dev/codeintelligence/job/{AnalysisMemoryWatchdog,ReportedOwnerTreeMemory,OwnerTreeMemoryController}.java`
(`ProcessTreeMemory.java` deleted), `.../common/{AnalysisMemoryProperties,LanguageDetector}.java`
(`LanguageDetector` moved from `analysis/core`), `.../common/config/SecurityConfig.java` (CSRF
exemption for the main-only report path, like `/api/desktop/paths`),
`.../project/{LocalLanguageCapabilities,LocalImportScope}.java`,
`.../analysis/ts/TsLanguageCapabilities.java`, `.../analysis/core/{DetectionContext,FileInventoryScanner}.java`,
`backend/src/main/resources/application.yml`, `desktop/src/{main.cjs,owner-memory.cjs}`.

## Limits and what remains

- Outside the desktop app (dev server, Docker compose) nothing reports, so the watchdog never
  blocks there; before, it measured the backend's own tree. Windows stays unmeasured as before.
- Detection latency grows by up to one idle report (≤ 5 s) at the start of a run, then 2 s.
  Main's `ps` costs about 20 ms of system time per sample (one local measurement), i.e. every 5 s
  while the app is ready and idle.
- The reported value is trusted as main's; only the main-only capability protects it.
- Not measured in the packaged app (owner-tree RSS, report cadence); pending the next candidate.
