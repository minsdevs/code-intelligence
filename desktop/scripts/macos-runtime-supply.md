# macOS 13 runtime source supply

This is a developer provisioning contract, not a validated distributable runtime.
Use the existing `native-acceptance-host.cjs` / `native-acceptance-macos.sh` path.
It builds inside newly owned directories and retains the fixed macOS 13.0 arm64
native gate. Do not substitute an installed Homebrew bottle for the source build.

## Reviewed inputs

`macos-runtime-supply.json` fixes OpenSSL 3.5.8, PostgreSQL 16.15, Redis 8.10.2
and pgvector 0.8.7. The first three archive digests were checked against their
upstream checksum publications. The pgvector digest was measured from the HTTPS
archive at the resolved v0.8.7 commit; it is **not a maintainer-signed checksum**.
The lock records the URLs, hashes and this distinction.

This lock covers those four C source inputs. JDK 21, the Apple SDK/compiler,
Node, Electron and npm dependencies remain separately identified inputs. Fixed
archives alone do not prove reproducible binary bytes or minimum-OS support.

The downloader requires `/usr/bin/curl` 8.4.0 or newer because earlier versions
do not enforce `--max-filesize` when the server omits the size. It checks this
before creating the archive. HTTPS-only requests, redirect/time/size bounds,
exclusive destination creation and post-download digest readback are mandatory.
No source is extracted before verification. A failed archive remains private;
reusing that destination is refused rather than overwritten.

The existing build keeps PG SSL, Redis TLS, portable pgvector `OPTFLAGS=`,
private OpenSSL, `pg_trgm` and dependency relocation. `PGVECTOR_ROOT` is removed
from the macOS acceptance child environment so an old developer extension cannot
silently overwrite the locked version. The original environment is unchanged.
Top-level upstream licenses and the source lock are copied under PostgreSQL's
share directory for staging. This does not settle all redistribution obligations.

## Read-only preflight

From the repository root:

```sh
rtk proxy node desktop/scripts/macos-runtime-supply.cjs --check .
```

This prints a report and uses exit 1 for insufficient space. It neither creates
a run nor downloads, compiles or launches anything. The eight-GiB initial free
space floor is a conservative working-space policy, **not measured app size**,
not a reservation and not a guarantee against another process consuming space.
The host entrypoint checks both source and temporary volumes before allocating a
run; provisioning checks its temporary root again. Each download checks immediate
archive headroom. Keep additional working margin before attempting a full build.

The actual build remains the existing `desktop/scripts/native-acceptance-host.cjs`
entrypoint, with the explicitly verified JDK21 supplied in `JAVA_HOME`. It can
download and build, create isolated credentials, sign validation binaries ad hoc
and launch the validation application. It is **not** a preflight command. Review
its current scope before executing; do not run it while the preflight is blocked.

## Existing-profile and backup boundary

Use a new isolated validation profile first. The app's V26/V27 schema conversion
does not convert PostgreSQL extension versions. `backup-postgres.cjs` includes
`pg_extension.extversion` and PostgreSQL major in the exact catalog hash, and
initializes a new staging catalog using the installed extensions. Different
pgvector versions can therefore produce `BACKUP_PG_SCHEMA` even when both sides
use V27. Current startup only creates missing extensions; it does not update an
existing extension version. Do not apply the new runtime to a user's profile or
relax catalog, ownership, row or source checks to force a restore.

Before an existing-profile update, use dedicated fixtures to verify the reviewed
extension UPDATE path, pre-update and post-update encrypted backup restore, and
rollback/restart recovery. The database locale/provider is another unverified
boundary: current startup uses UTF8 but inherits locale, and the backup catalog
does not fingerprint the database's default locale/provider. A new libc build is
not evidence that an existing ICU database is compatible.

References: [pgvector security release](https://www.postgresql.org/about/news/pgvector-087-released-3392/),
[curl size-limit contract](https://curl.se/docs/manpage.html#--max-filesize),
[PostgreSQL 16 source build](https://www.postgresql.org/docs/16/install-make.html).
