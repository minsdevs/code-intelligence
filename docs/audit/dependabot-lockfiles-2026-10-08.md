# Dependabot lockfile fixes (w9-deps) — 2026-10-08

Unit **w9-deps** closes the open Dependabot alerts #49–#52 by updating lockfiles only,
per the user decision of 2026-10-08 (no `package.json` range changes). Branch
`gate/w9-deps` from `dba2557`. Candidate 9lVRha was read, not launched. Formal
release verdict stays **NO_GO**; this unit records facts and does not pass a gate.

## Scope and result

| Alert | Severity | Package | Lockfile | Before | After | Path | Scope |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #49 | critical | `proxy-addr` ([GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), `<2.0.8`) | `analyzers/tree-analyzer/package-lock.json` | 2.0.7 | 2.0.8 | express 5.2.1 | runtime |
| #50–#52 | high | `source-map-js` ([GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), `<1.2.2`) | `analyzers/tree-analyzer`, `analyzers/ts-analyzer`, `frontend` `package-lock.json` | 1.2.1 | 1.2.2 | vitest → vite → postcss (frontend also `@tailwindcss/node`, `css-tree`) | dev |

The lockfile diff (`git diff dba2557 -- '*package-lock.json'`, 3 files, +16/−12) is
limited to `version`, `resolved` and `integrity` of these two packages, plus the
`funding` block that `proxy-addr@2.0.8` itself declares. Integrity values equal
`npm view <pkg>@<version> dist.integrity`. `desktop/package-lock.json` contains
neither package. `ts-analyzer` already pinned `proxy-addr` 2.0.8 through `overrides`.

Method: `npm update proxy-addr source-map-js --package-lock-only` (tree analyzer) and
`npm update source-map-js --package-lock-only` (TS analyzer). In `frontend` the same
command also added six unrelated `inBundle` entries for the optional
`@tailwindcss/oxide-wasm32-wasi` package (npm 11.17 re-describing bundled
dependencies), so that file was restored and only the three `source-map-js` fields
were edited; `npm ci` (online and offline) and `npm ls` accept the result.

## Red/green evidence (counts read from output)

| Check | Before (red) | After (green) |
| --- | --- | --- |
| tree-analyzer `npm ls proxy-addr source-map-js` | proxy-addr 2.0.7, source-map-js 1.2.1 | 2.0.8, 1.2.2, rc 0 |
| ts-analyzer `npm ls` | proxy-addr 2.0.8 (overridden), source-map-js 1.2.1 | 2.0.8, 1.2.2, rc 0 |
| frontend `npm ls source-map-js` | 1.2.1 (3 paths, deduped) | 1.2.2 (3 paths, deduped), rc 0 |
| tree-analyzer `npm audit --omit=dev` / `npm audit` | 1 critical / 1 critical + 1 high (total 2) | 0 / 0 |
| ts-analyzer `npm audit --omit=dev` / `npm audit` | 0 / 1 high | 0 / 0 |
| frontend `npm audit --omit=dev` / `npm audit` | 0 / 1 high | 0 / 0 |
| `validation/pre-release/test/proxy-addr-security.test.cjs` (extended to the tree analyzer) | against tree-analyzer proxy-addr 2.0.7: 6 tests, 5 pass, 1 fail — `tree-analyzer: IPv4-mapped IPv6 /8 does not trust an unrelated IPv4 address` (`true !== false`) | 6 tests, 6 pass |

## Tests run after the update (target files only)

- tree-analyzer `vitest run`: 2 files, 12 tests passed.
- ts-analyzer `vitest run`: 11 files, 292 tests passed.
- frontend `vitest run`: 49 files, 480 tests passed; `tsc -b --noEmit`: exit 0.
- `node --test` on `validation/pre-release/test/{proxy-addr-security,sbom-candidate,
  sbom-runtime-exclusions,sbom-jre-supply,build-candidate,inventory-candidate,
  licence-obligations,licence-packaging}.test.cjs` and
  `desktop/test/runtime-stage-containment.test.cjs`: 103 tests, 103 pass, 0 fail,
  0 skipped. No test pins `source-map-js` or the tree analyzer lockfile; the
  `build-candidate` fixtures use a synthetic `proxy-addr` 2.0.8 lock.

## Offline candidate cache

`validation/pre-release/build-candidate.cjs` uses
`validation/local/pre-release-cache/npm` (relative to the building checkout) for one
step only: when the TS analyzer `package.json`/`package-lock.json` differ from the
staged ones, it runs `npm ci --omit=dev --ignore-scripts --bin-links=false --offline
--no-audit --no-fund` with empty user/global npm configs. This change alters the
TS analyzer lockfile, so the next candidate takes that path. Frontend, desktop and
TS analyzer `node_modules` are otherwise copied from the building checkout
(`copyPrivateTree`); the tree analyzer is not built or staged.

`source-map-js@1.2.2` (and `proxy-addr@2.0.8`, already present) were added with
`npm cache add source-map-js@1.2.2 proxy-addr@2.0.8 --cache <dir>` (public registry,
empty npm configs, logs outside the cache). Additive only: file listings before and
after show 0 removed files (+8 files each in the two shared caches).

| Cache | Files before → after |
| --- | --- |
| `/Users/minseokchae/Dev/ciw/deps/validation/local/pre-release-cache/npm` (unit clone) | 320 → 328 |
| `/Users/minseokchae/Dev/code-intelligence/validation/local/pre-release-cache/npm` | 326 → 334 |
| `/Users/minseokchae/.herdr/worktrees/code-intelligence/worktree-calm-meadow-7229/validation/local/pre-release-cache/npm` | 327 → 335 |

Offline proof with the builder's flags, from copies of the new `package.json` and
`package-lock.json` in temporary directories under the unit worktree (deleted after):

- TS analyzer, unit clone before the add: `--omit=dev` passed (106 packages);
  full install failed `ENOTCACHED source-map-js-1.2.2.tgz` (red).
- TS analyzer after the add, each of the three caches: `--omit=dev` 106 packages
  (proxy-addr 2.0.8), full install 160 packages (source-map-js 1.2.2), rc 0; the
  installs changed 0 files in the two shared caches.
- Tree analyzer and frontend cannot install from the pre-release cache before or
  after this change: it never held their trees (`ENOTCACHED tree-sitter-python-0.25.0`,
  `ENOTCACHED zustand-5.0.15`). Their lockfiles were instead checked by an online
  `npm ci --ignore-scripts` into a temporary directory with a scratch cache, then an
  offline `npm ci` from that scratch cache: tree analyzer 130 packages (73 with
  `--omit=dev`), frontend 288 packages (41 with `--omit=dev`), rc 0. The scratch cache
  was deleted.

## Is the tree analyzer shipped? Is `trust proxy` used?

- Candidate 9lVRha (read-only): `Contents/Resources/runtime/runtime-manifest.json`
  lists 951 files under `backend/`, `jre/`, `postgres/`, `redis/` only; no
  `tree-analyzer`, `express` or `proxy-addr` entry. The `app.asar` header has no
  `tree-analyzer` or `proxy-addr` path. The only shipped `proxy-addr` is the TS
  analyzer's inside `XPCServices/AdapterSupervisor.xpc/Contents/Resources/ts-analyzer`,
  version 2.0.8. No `source-map-js` directory exists in the bundle.
- `build-candidate.cjs` `SOURCE_COPY_INPUTS` and `desktop/scripts/stage-runtime.mjs`
  do not stage the tree analyzer. It runs from `docker-compose.yml` (port 3041) and is
  reached by the backend only when `TREE_ANALYZER_BASE_URL` is set (empty by default,
  `TreeAnalyzerProperties.enabled()`), or through its stdio entry `src/stdio.ts`.
- Neither analyzer sets `trust proxy` (no `trust proxy`/`trustProxy`/`req.ip` use in
  `analyzers/*/src`). With Express's default (`trust proxy` false) the vulnerable
  IPv4-mapped CIDR path of `proxy-addr` is not reached, so #49 was a latent,
  non-shipped exposure. It is fixed regardless.

## Limits and what remains

- Lockfile-only change; `package.json` ranges unchanged, so a future `npm install`
  may still resolve the same versions only as long as the lockfiles are kept.
- The building checkout must refresh its `node_modules` before the next candidate,
  because the builder copies them: `frontend` and `analyzers/ts-analyzer` (one
  package each, `npm install --ignore-scripts` from the merged lockfile). The
  pre-release cache cannot do this for `frontend`. In this unit an `npm update
  --package-lock-only` also rewrote the hidden `node_modules/.package-lock.json`,
  after which `npm install` reported "up to date" with 1.2.1 still on disk; removing
  that hidden file made `npm install` replace the packages (verified by reading each
  installed `package.json`).
- Dependabot alert state on GitHub was not read or changed; it should close once the
  lockfiles reach the default branch.
- No packaged app was launched; packaged acceptance belongs to the next candidate.
