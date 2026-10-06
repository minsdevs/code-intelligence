# Startup phase diagnostics and build capacity — 2026-10-06

The resumed work merged PR99 as `ce0322f`, measured the unchanged tZgvV7 app on a
new synthetic profile, and added backend phase markers at `69337a4`. The marker
change passes 194 existing regression checks. It has **not been packaged or timed
in a new native candidate**: available build space was about 6.11GiB, below the
existing 8GiB policy. Formal release remains **NO_GO**.

The [companion ledger](startup-phase-breakdown-2026-10-06.json) records exact
source identities, raw-result hashes and measurement limits. The previous
[candidate report](startup-resource-follow-up-2026-10-06.md) and its failed
performance acceptance remain intact. tZgvV7 is still the latest native candidate;
it does not contain the new phase markers.

## Previous unit completed

The original checkout had clean, pushed HEAD `8efc829`, with no PR yet. Read-back
verified all 23 referenced raw-result hashes, 14 product-input fingerprints at
that checkpoint and the assessment recomputed from the 20 original measured
rows. The result is
`validation/local/startup-root-cause/resume-readback-uNLsPZ/result.json`.

PR99 was then created and merged with `[skip ci]`. Its candidate retains 198
focused passes, 20 inventory validations within one Electron process, 36 recorded
functional checks with six COMPLETE/code0 exits, and two six-check owner-crash
cases. These existing results were read back, not executed again by the read-back
operation. Its warm-start p95 remains 12,544ms and maximum sampled idle RSS remains
1,745,680KiB; both exceed their original 10s/1.5GiB limits.

## New diagnostic on the same candidate

The existing three-run probe executed against unchanged tZgvV7 and initialized a
fresh synthetic profile. It used mock Keychain, verified AI OFF and all four
runtime services, and confirmed normal cleanup after initialization and each
measured start. Raw evidence is
`validation/local/startup-probe/run-pPI5VC/result.json` and its resource CSV.

| Warm run | Ready | Sampled idle peak | BACKEND → WINDOW | Sum of the two GATEWAY → BACKUP intervals |
| --- | ---: | ---: | ---: | ---: |
| 1 | 11,024ms | 1,711,072KiB | 6,355ms | 546ms |
| 2 | 10,828ms | 1,727,936KiB | 6,377ms | 651ms |
| 3 | 11,384ms | 1,710,608KiB | 6,651ms | 749ms |

Initialization was recorded separately at 11,937ms and 1,721,888KiB. All rows
completed sampling and cleanup; AC was observed at their boundaries, and source
and candidate identities stayed unchanged throughout the probe. This is a
three-run diagnostic, not a replacement for twenty-run acceptance or evidence of
a product improvement. Its shorter fresh-profile history differs from the older
twenty-run series.

Separate post-idle snapshots observed eight JAVA processes totaling
924,768/942,176/923,488KiB. The largest individual JAVA process used
524,096/540,400/521,888KiB; the other seven together used
400,672/401,776/401,600KiB. The raw JAVA label does not identify each worker's duty.
These snapshots occurred after the idle window and are not simultaneous with the
reported idle peaks. They report summed process RSS, not Java heap or continuous
private-memory use. All other observed roles, including ELSE, remain in the total.

## Fixed startup cost and repeated-start growth

The original twenty-run data places the mean BACKEND → WINDOW interval at
6,259ms. Comparing its first and twentieth runs, total ready time grew from
10,981 to 12,901ms, while BACKEND → WINDOW changed only from 6,354 to 6,373ms.
The sum of the two GATEWAY → BACKUP intervals grew from 582 to 2,268ms.
These are observer-arrival intervals, not CPU profiles or method timings.

The source opens a restricted recovery lifecycle when `backup-maintenance`
exists, checks authenticated pending recovery, closes that lifecycle and then
opens the normal lifecycle. That accounts for two gateway intervals in these
warm-start records. Journal replay authenticates each record; each MAC-key access
uses the existing keyring path/file and ownership checks. Reopening also appends
a restart latch. These paths support a hypothesis of history-dependent replay
cost, but record counts and per-operation timings have not been measured. They
do not prove that replay caused the entire observed increase.

The relevant implementation is in `desktop/src/main.cjs`,
`desktop/src/safety-journal.cjs` and `desktop/src/purpose-keyring.cjs`.
Recovery inspection, key access and journal behavior are unchanged in this unit.

## New source instrumentation

`startBackend` now accepts an internal `traceStartup` option, false by default.
`startRuntime` enables it; the direct maintenance-start caller retains false.
The shared parser accepts four additional fixed phase names:

| Marker | Region beginning at this marker |
| --- | --- |
| BACKEND_SOURCES | Prepare the data directory and open production source storage. |
| BACKEND_PROCESS | Prepare bootstrap inputs, create the managed process and await its start acknowledgement. |
| BACKEND_HEALTH | Wait for the backend health response. |
| BACKEND_ROOTS | Check safety state, restore folder authorizations and save the authorization list. |

The coarse BACKEND marker remains. Existing awaits, readiness limits, maintenance
return, service ordering, ownership checks and AI-off rules are preserved. The
new markers use the existing bounded startup diagnostic channel and include no
paths, arguments or credential values.

## Validation and next execution boundary

`validation/local/startup-phase-breakdown/unit-wET6Ea/result.json` records
**194/194 PASS**, zero failures, cancellations or skips, natural test-process
exit0, and unchanged source fingerprints. It ran the existing main-runtime,
runtime-manifest, native-acceptance, startup-probe and startup-benchmark suites.
The synthetic main execution emitted all four new markers. Node syntax checks
for both changed modules and `git diff --check` also passed. A separate narrow
read-only review found no new P1/P2 in the two-file change. This does not establish
native timing, native performance or full release acceptance.

Final ledger read-back is recorded in
`validation/local/startup-phase-breakdown/readback-lPgqD0/result.json`. Its seven
referenced hashes match, and the current source matches both `69337a4` and the
source fingerprint used by the 194-test run.

The existing capacity check returned `MAC_BUILD_DISK_SPACE`: 6,556,340,224 bytes
available versus 8,589,934,592 required. This is an observed free-space floor,
not a reserved quantity or final app-size measurement. No new candidate build
was started and no older candidate, profile or raw evidence was deleted.

The next native execution requires the unchanged 8GiB capacity check to pass,
then a new candidate containing `69337a4` and a fresh phase probe. Its results must
identify that new candidate. Backend subphase timings and gateway replay costs
can then guide a measured optimization; any resulting candidate needs its own
affected functional/recovery checks and unchanged twenty-run acceptance.
The previous two performance failures and the remaining eight-stage release
requirements remain open.
