# Downloader retry test flake (w12-downloader) — 2026-10-08

Scope: the intermittent `3 !== 2` failure of
`desktop/test/dependency-downloader.test.cjs` › "upstream HTTP failures retain the stable
builder server-error retry behavior". Branch `gate/w12-downloader` from `877abb4`. No packaged
app, candidate, signing or network use. Formal release verdict unchanged: **NO_GO**.

## Verdict

**Test defect, not a product/build defect.** The third request is not made by the builder or
`@code-intelligence/builder-downloader`. It is a foreign `GET /` from another local process
(the user's "Dev Cockpit" desktop app, running since 2026-10-05) that probes listening
loopback ports. The test's synthetic server counted every request on its port, and the
builder's 2 s retry backoff gives that probe a wide window to land between the 503 and the
retry. The real build does not download Electron twice in this path, and no unverified path is
used.

## Evidence

- Reproduction on `877abb4`, isolated target test, 5 runs: 3 failed with `3 !== 2`, 2 passed.
- Instrumented copy (request method/URL/headers logged), 4 runs, 3 failed. In each failure
  the extra request was `GET /` with `Host: localhost:<port>`, `User-Agent: dev-cockpit`,
  `Connection: close`, arriving 0.3–1.8 s after the 503 and before the retry. Both builder
  requests were `GET /artifact.zip` with `Host: 127.0.0.1:<port>`, `User-Agent: node`.
  Passing run: exactly those two builder requests.
- The suggested lead is excluded: `electronGet.js` would log "cached artifact missing from
  disk; retrying with cache write" (warn level, printed alongside the "using cached artifact"
  info line that does appear). No failing run printed it, and the `dest already exists`
  fallback was not taken either.
- The 2026-10-07 regression pass is consistent with probe timing luck; the prober process
  predates it.

## Fix

`serve()` in the test now forwards only requests whose path is one of the fixture paths the
callers are given (`/artifact.zip`, `/tool.bin`, `/tool.zip`, `/same-url`; absolute-form proxy
requests are matched by path) and answers anything else `404` without reaching the handler.
No assertion changed: the target still requires exactly two artifact requests (one retry after
a 5xx) and verified bytes. A builder request to any other path would receive `404` and fail
the download rather than be hidden.

| Check | Before (`877abb4`) | After (`27b056f`) |
|---|---|---|
| Target test, foreign `GET /` injected 500 ms into the backoff (scratch copy) | 3/3 FAIL (`4 !== 2`, `4 !== 2`, `3 !== 2`) | 3/3 PASS |
| Target test alone, 10 runs | (5 runs: 3 FAIL) | 10/10 PASS |
| Whole `dependency-downloader.test.cjs`, 10 runs | — | 10/10 runs, 13/13 tests each |

Changed paths: `desktop/test/dependency-downloader.test.cjs` only. No product path changed.

## Limits

- Other desktop tests that run loopback servers and count requests could see the same probe;
  only this file was audited and run.
- The prober was not stopped or changed; it is user software outside this repository.
