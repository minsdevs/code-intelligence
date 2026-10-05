# Pre-release nonzero cost recovery — 2026-10-05

## Execution / stage position

Original checkout `/Users/minseokchae/Dev/code-intelligence`, base `73ef102` (PR91),
branch `codex/pre-release-cost-recovery-20261005`. This completes another bounded
stage1 unit and unblocks continued **implementation** of stages2/3; it does not
approve real-user DB application or the whole eight-stage release gate.

Real components in this unit: current backup coordinator, PostgreSQL database swap,
encrypted records/journal, product/source checks, JAR source worker, v2 private
backend bootstrap, actual source broker/vault, HTTP maintenance barrier, Redis and
Java service guardians/native FileLock leases. Key wrapping and all contents are
synthetic; provider requests are counted and rejected. No real sign-in/Keychain.
The preserved `jXdOYk` app supplies native/Java binaries but is **not launched as
Electron**; current Node modules, including the owner-lock change, are exercised
outside its ASAR. The next unified candidate must include that source change.

## Fixes and unchanged boundaries

The old integration fixture still sent v1 AI-only bootstrap to a backend requiring
v2 AI+source, inserted pre-V26 source-identity columns, and did not own the new
source-broker lifecycle. It now uses actual v2 capabilities, V26/V27 platform
identities, source drain/reopen, and a distinct new socket name for each lifetime.
An interrupted Unix socket is never removed/adopted merely to allow restart.

Managed startup failure keeps `error.managedProcess` before diagnostic callbacks.
Cleanup registers before setup and proves writer termination before source drain,
runtime/B/key release and TLS cleanup. The product native lease helper now catches
synchronous `stdin.write/end/destroy` and `child.kill` failures without leaking a
private error or dropping a still-live reservation; only actual close releases it.
No lock file reset, age/PID adoption or protection bypass was added.

libpq's reviewed connection configuration remains verify-full with a unique CA;
the fixture spawn adapter additionally supplies fresh HOME/optional client key,
certificate/password/service paths. JDBC keeps the product's exact sslmode and
sslrootcert URL allowlist, with JVM user.home/java.io.tmpdir pinned to the fresh
fixture. The temporary extra sslcert/sslkey URL parameters were correctly rejected
by the product guard and removed from the fixture, not accepted by weakening it.

## Actual results

- `validation/local/pre-release-cost/normal-Y6Vhc5`: normal suite **3/3 PASS**
  (parent plus two cases): real backup100, new obligation73, restore liability173;
  then additional29 and post-health failure/rollback liability202. This was before
  the final per-lifetime source socket naming change; preserve as earlier evidence.
- `validation/local/pre-release-cost/crash-IlKwEq`: **2/2 PASS**, no skips, current
  source hashes unchanged. Parent-created Node owner SIGKILL at STAGED resumes
  `VERIFIED_PREVIOUS`; after real B completion resumes `VERIFIED_RESTORED`.
  Both retained newer holds173, exact transaction, append-only B/marker identities,
  credential revocation, AI OFF, providerCalls0 and backend200 only after reopening.
  Parent evidence confirms initial process tree gone and teardownVerified=true.
- Offline owner exception + cleanup barrier contracts: **12/12 PASS**.
- `units/focused.2xh7YY`: **98 PASS, 0 FAIL, 1 SKIP**. The skip is the deliberately
  quarantined native guardian-kill case; it is not counted as passed.
- Final `normal-jIoJSg`: **3/3 PASS** with the final unique-socket fixture and all
  recorded source hashes unchanged. Final offline selection `units/final.EIXsti`:
  **100 PASS, 0 FAIL, 1 SKIP** including two new runner argument/environment contracts.
  `docs/audit/pre-release-cost-validation-2026-10-05.json` binds the exact normal/
  crash reports, source hashes, costs, native bundle and verified cleanup outcomes.

The two actual crash profiles are `.cif-resume-DQSXuc` and `.cif-resume-D2aVty`.
Their `parent-evidence.json` result snapshots show some services running at the
time the successful resume was reported; the separate final `teardownVerified`
proves observed owned processes had then exited. Do not interpret intermediate
`stopped=false` as final cleanup failure, or final process exit as power-loss proof.

## Failed attempts and access boundary

`normal-cJXYrw` failed before backend readiness. Its first synthetic root was outside
the connector's approved read roots; the attempted read was denied, and was not
bypassed with a copy, alternate command or deletion. It remains uninspected.
All subsequent roots are newly created private `.cif-*` children of the original
repository; the change did not adopt the denied root.

`normal-Rwc7Z6` failed because the fixture JDBC URL had unsupported optional client
parameters. `normal-VZ1rUv` completed real backup but failed when obsolete
`root_device/root_inode` columns were inserted; the fixture now uses the current
root_platform/root_identity/root_owner schema. Both accessible failed profiles
record safe cleanup and all owned children stopped; reports remain separate FAILs.

## Remaining release conditions

173 restart and 202 same-process rollback are different evidence; no 202 restart
is claimed. The source fixture is legacy Git/source-contract0, not the complete
retained-vault blob export/import matrix. Guardian death/quarantined test, hostile
daemonization, power loss, all fsync boundaries, user extension/index/locale/ICU
application and old physical DB rollback, minimal supported OS, actual account
OAuth and independent release acceptance remain separate. No public distribution,
formal signing/notarization, Actions or paid provider call was performed.
