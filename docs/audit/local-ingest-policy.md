# Bounded local ingest policy (`local-ingest-v1`)

This document records the bounded E3 implementation. It supplements the original
multilanguage plan; it does not replace that plan or mark T01, T02, E2, or production
readiness complete. The independent planning score is a planning review result.

## Selection and stored bytes

`LocalSourcePolicy` supplies both `LocalImportService.fingerprint` and local import.
For an unchanged source, both use the same selected relative paths and raw Git blob
hashes. Selection is ordered by UTF-8 path bytes. A successful import writes only
selected bytes to the staging working tree and inserts those exact bytes into Git.
The resulting HEAD tree and subsequent inventory contain that same selected set.
The importer does not use `git add`, clean filters, attributes, hooks, an external
process, or the source index. Source `.gitattributes` is ordinary selected content;
it cannot transform the bytes during import. The generated repository has explicit
local configuration, one generated branch and commit, and a parentless JGit
`Config`. No source repository configuration or object database is opened.

Reading `.gitignore` is part of selection, including when that file is itself
ignored. Each safely read ignore file is cached once for this inspection; if
selected, its cached bytes and identity are checked before copying. A policy file
that exists but is a symlink, has multiple hard links, is not regular, is too large,
changes identity, contains a known credential signature, or cannot be interpreted
safely fails the inspection. Its rules are never silently discarded.

The source is never intentionally modified. A completed selection is an observation
of bytes read during that inspection, not proof that the source remained unchanged
after inspection or that a previous preview approved those bytes.

## Limits and exclusions

The limits are per inspection, including preview fingerprinting:

| Resource | Ceiling and behavior |
| --- | --- |
| Accepted files | `min(app.analysis.max-files, 50,000)`; further otherwise eligible files are excluded in deterministic order |
| One file | `min(app.analysis.max-file-size, 2 MiB)`; a statically oversized ordinary file is excluded before opening |
| Actual bytes read | 512 MiB across source content, ignore files and advisory HEAD; exceeding it fails the inspection |
| Encountered file entries | 50,000, including excluded file entries; exceeding it fails |
| Visited entries | 200,000, including root and encountered directories; exceeding it fails |
| Relative depth | 64 components; exceeding it fails |
| Time | 30 seconds, checked cooperatively during traversal, reads and matching |
| One `.gitignore` | `min(per-file limit, 64 KiB)` |
| All `.gitignore` bytes | 1 MiB, also charged against the actual byte budget |
| Ignore rules | 4,096 nonempty lines total, including comments; one line at most 4,096 UTF-16 code units |
| Advisory `.git/HEAD` | A single regular, single-link file at most 4 KiB, charged against the byte budget |

Reads request at most one byte beyond a byte limit to detect growth; an over-budget
inspection produces no successful summary or publication. Source contents are held
one bounded file at a time. The byte metric includes content later excluded after
inspection, and does not include content in pruned subtrees or files excluded before
opening. Filesystem metadata operations and generated Git output are not source
byte reads.

Mandatory directory exclusions are `.git`, `node_modules`, `.gradle`, `build`,
`dist`, `target`, `.idea`, `.vscode`, `__pycache__`, `.venv`, `venv`, `vendor`, and
`generated`. `.DS_Store` is also excluded. Credential directories include `.ssh`,
`.aws`, `.gnupg`, `.config`, `.azure`, and `.kube`, at any encountered depth and in
the selected root's canonical and submitted ancestry. Credential filename rules
include `.env*`, private-key and keystore extensions, recognized credential files,
and known token signatures in path components. Negation rules cannot override
mandatory exclusions. Known signatures in advisory HEAD produce an unknown branch.

The importer excludes symlink and multiple-hard-link file entries without opening
their contents. It fails on special files, unsupported path encodings, case or NFC
path collisions, and filesystem-device boundaries. Source path strings must round
trip back to the same `Path`; duplicate display keys also fail. Binary extensions,
NUL bytes anywhere in the bounded content, and invalid UTF-8 are excluded. These
are intentionally conservative admission rules, not a classification of every
possible file format.

The root must pass existing configured-root or desktop-picker authorization. The
selected root cannot be the user's home, a filesystem/volume root, a blocked system
directory, a credential directory or its descendant, or a generated directory.
Source and managed repository storage must not contain one another. Resolving a
picker-authorized root symlink retains the existing authorization behavior; it does
not authorize following symlinks found inside the selected source.

## Local ignore rules

Only `.gitignore` files encountered inside admitted source directories are used.
Global Git ignores, `.git/info/exclude`, Git includes, `core.worktree`, source Git
status, hooks and filters are not consulted. Child rules take precedence over
parent rules; later rules take precedence within a file. Ignored directories are
pruned, so a rule inside such a directory cannot reinclude a hidden child.

`LocalIgnoreRules` supports literals, backslash escapes, comments beginning with
`#`, `!` negation, leading `/` anchors, trailing `/` directory rules, `*`, `?`, and
whole-component `**`, including repeated recursive components. CR, LF and CRLF
split lines identically. Escaped leading `#` and `!` remain literal. Unescaped
trailing spaces are trimmed. A trailing `/**` matches descendants, not the parent
directory itself, so ordinary parent re-inclusion remains possible.

Character classes such as `[abc]`, ranges, POSIX classes, empty path components,
and dangling escapes are unsupported and fail the inspection with fixed safe
text. This is an explicit compatibility limit; unsupported rules are not ignored.
The matcher uses iterative dynamic programming over path components and UTF-8 bytes.
Literal Unicode characters compile to their UTF-8 bytes, and `?` consumes one byte,
matching Git's byte semantics rather than Java UTF-16 character units.
It does not create a regex or call JGit's logging ignore parser. Repeated stars do
not introduce backtracking, and budget checks run inside matching loops. There is
no timed background matcher left running after a timeout.

## Credential detection scope

Bounded content is checked for recognized private-key headers, selected GitHub,
AWS, OpenAI-style and Google API token signatures, and bearer-token signatures.
Quoted credential assignments are checked in all admitted text. Unquoted
assignments are checked in YAML, properties, INI, TOML, text, conf and config files.
Recognized environment/template references and explicit null/boolean/redacted
placeholders are retained. An uppercase configuration literal is not assumed to
be an environment reference. Source types such as `password: string` and source
expressions such as `password: process.env.DB_PASSWORD` are retained.

These detectors can miss arbitrary, encoded, renamed or unsupported-format
credentials and can exclude legitimate literal examples. They do not establish
that a source or the entire managed store is secret-free. In particular, existing
projects, metadata and pre-policy repositories are not retroactively inspected or
purged by this change. No raw excluded filename, source text or credential value is
included in the count-only observation.

## Publication and recovery boundary

Copy, policy checks and Git commit construction finish in a private staging
directory before target replacement starts. On refresh, the existing target is
renamed to a unique `.previous-*` sibling; the new staging directory is then moved
to the target. If the second move reports an ordinary failure, the implementation
attempts to restore the previous directory. A failed staging operation leaves the
target untouched. Successful publication performs best-effort removal of the
previous directory; failed cleanup does not invalidate the successful import.

This two-rename sequence is not crash-safe. A crash between renames can leave the
target absent, and a publication failure followed by a separate restoration failure
can require manual recovery from the preserved `.previous-*` directory. Automatic
startup recovery and fsync durability are not implemented here. A leftover previous
directory can contain pre-policy bytes. This change makes no retroactive purge or
whole-store absence-of-secrets claim.

Filesystem publication and later database snapshot creation are not one atomic
transaction. A database failure after publication can leave a newer managed
repository without an attached snapshot. E1's later-import retry guard prevents
reusing an older completed checkpoint in that situation; E3 does not supply an
immutable per-snapshot source store or roll back database-stage failures.

## Count-only persisted observation

After snapshot creation, `ImportStep` records one CONFIG evidence excerpt linked
with `EvidenceSubjects.LOCAL_IMPORT` and that snapshot ID. `LocalImportStep` is an
unregistered compatibility variant; the active pipeline uses `ImportStep`'s LOCAL
branch. Replacing import diagnostics uses the dedicated subject so subsequent
file-inventory warning replacement cannot erase this record.

The UTF-8 JSON excerpt is at most 2,048 bytes and has exactly these fields:

```json
{
  "schemaVersion": 1,
  "policyVersion": "local-ingest-v1",
  "acceptedFiles": 2,
  "bytesRead": 128,
  "excludedEntriesByReason": {
    "SECRET_PATH": 1,
    "IGNORED": 1
  }
}
```

The closed reason set is `GENERATED_DIRECTORY`, `SECRET_PATH`, `IGNORED`, `BINARY`,
`OVERSIZED`, `FILE_LIMIT`, `SYMLINK`, `HARD_LINK`, and `SECRET_CONTENT`. The writer
emits positive counts only; an empty map is valid. The reader also accepts explicit
zero counts. Accepted files plus excluded entries cannot exceed 200,000. An
excluded subtree counts as one encountered directory entry; its unvisited
descendants remain unmeasured. These values describe ingest admission, not parser
success, analysis coverage, language support, or result completeness. Missing,
malformed, conflicting or unsupported observations are unavailable, not measured
zeroes. The coverage consumer validates project, snapshot and evidence-kind scope.

## Remaining limits and validation

The filesystem defenses are Java `NOFOLLOW_LINKS` on the final open, regular-file,
single-link and device checks, plus pathname identity/size/mtime checks before and
after reads and directory checks after selection. They are not `fstat` on an open
descriptor. The measured Mac JDK 21 provider did not supply
`SecureDirectoryStream`. A malicious process can race ancestors or restore
observable metadata; this implementation does not claim native descriptor-relative
confinement. T01 remains open. Cooperative checks cannot interrupt a blocking
filesystem syscall or prove a hard wall-clock bound on underlying filesystem or
JGit work.

E2 also remains open: an equal current change-count preview does not bind a future
worker to approved bytes. The worker still makes a fresh selection from the live
path. Immutable source/analysis-byte binding, retention, encryption, crash-safe
publication and source-store lifecycle remain T02 work.

Dedicated regression sources are `LocalIngestPolicyTest`, `LocalIgnoreRulesTest`
and `LocalIngestIntegrationTest`, with the existing `LocalImportServiceTest`
adapted for unknown Git dirty status. They cover the reviewed metadata and ignore
bypasses, actual byte growth, exact boundaries, link/special-file cases, deterministic
selection, raw byte equality across fingerprint/working tree/Git/inventory, ordinary
publication rollback, and persisted count/controller-response behavior. The first
successful targeted parent run recorded 223 tests in nine suites with no failures
or skips. After the Unicode-byte correction, the parent ran the full backend
formatter/check/build: **572 tests in 85 suites passed**, with zero failures,
errors or skips. This includes policy67, matcher42, ingest integration4, existing
import15, source status5, and coverage43; these are subsets of572.

The final real backend/temporary database/headless source-and-refresh gate passed
12 cases in one run. The unchanged quality gate also passed (accuracy7, golden23,
TS11, tree7 and both analyzer typechecks/builds). An independent reviewer compared
474 supported matcher cases against actual Git with zero differences. Its final
bounded-E3 verdict was Critical0/High0/Medium0. See the
[review](execution-review-2026-10-02.md) and
[validation record](execution-validation-2026-10-02.json).
These bounded regressions do not complete the remaining limits above.
