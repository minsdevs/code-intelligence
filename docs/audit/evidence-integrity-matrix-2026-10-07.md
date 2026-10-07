# G-EVIDENCE requirement matrix and C06 sequences — 2026-10-07

Scope: release gate **G-EVIDENCE** (07 §3: "immutable source/edge span/coverage
partition/GC/legacy migration100%"; forbidden substitute: inventory count), the
06 thresholds "소스 근거 … 100%" and "coverage … manifest partition 100%", T02
acceptance, audit item B8 and the V27 coverage model. Branch
`worktree-agent-ac4a347c91fe92645` from `bcd8081`; packaged checks on retained
candidate **1lvULq**. No product code was changed and the gate is not declared PASS
here. Hashes and commands: [companion ledger](evidence-integrity-matrix-2026-10-07.json).

## What ran

| Run | Components | Result |
| --- | --- | --- |
| `EvidenceHistoryIntegrationTest` (C06, 15 sequences) | Approved local imports through the real `JobWorker` and the complete Spring pipeline (15 steps), PostgreSQL, production Node vault/broker, the real TypeScript analyzer sidecar (`accuracy-server.cjs`, compiled from source), in-process Java parsing | 15 tests: 14 PASS, 1 explicit skip (C06-15 R2), in run `backend-bsZZx6` and again in the targeted rerun `targeted-sJi3wp` (identical report SHA-256) |
| `PublishedFactAudit` after every sequence, for every retained snapshot | Node, edge, node-evidence and projection rows vs. the bytes `FileService` serves for that snapshot | 13 audit rounds, 4,313 fact checks, 0 failures; final round over 7 snapshots: 692 facts (185 node spans, 119 call-edge spans, 248 edge endpoint pairs, 105 node evidences, 35 projections) plus 66 file hash identities; 21 ambiguous rows withheld, 126 location-free nodes (directories, packages without file). Node types covered: FILE, DIRECTORY, PACKAGE, CLASS, METHOD, FIELD, ANNOTATION, COMPONENT, API_ENDPOINT, AMBIGUOUS — **no CONFIG or MIGRATION node** (corpus gap, see F-3) |
| `LegacyMigrationWalkTest` | Flyway V1→V27 one step at a time on a fresh pgvector/pg16 container, 14 sentinel rows | 1/1 PASS in both runs: 27 single-step migrations, 14 sentinels |
| `import-evidence-native.cjs` on 1lvULq | Packaged app: import, UI-approved re-analysis, published facts fetched through the app API (all `/graph/nodes` pages, node detail evidences, served file content) | `native-n9Svxt`: FAIL at the first fact round; `native-bJn2bY`: FAIL — per snapshot exactly one failure, `span bounds config:package.json 1-2 of 1`; all other facts verified (snapshot 1: 27 nodes, 18 node spans, 9 evidences, 8 files; snapshot 1 after re-analysis identical; snapshot 2: 28 nodes, 19 node spans, 10 evidences, 8 files) |

The audit checks, per fact: the file row belongs to the same snapshot; served bytes
equal the bytes approved for that snapshot (captured at import time), their Git
OID equals `files.content_hash` and the manifest `git_oid`, and their SHA-256
equals the manifest `blob_sha256`; the line span lies inside the retained bytes
(LF, CRLF and CR split like the analyzers); the declared name occurs inside its
span (file facts span the whole file; endpoints contain their path literal);
path-keyed natural keys equal the file path and Java keys match the file's
`package` declaration; ambiguous identities publish no span; every edge endpoint
and projection (endpoints, routes, flows, flow steps, findings) belongs to the
same snapshot; call edges contain the target name on their callsite line.

## Requirement matrix

| ID | Requirement (source) | Evidence | Level | Status |
| --- | --- | --- | --- | --- |
| E-01 | Old snapshot bytes immutable vs working tree (C06) | C06-02 live edit without re-analysis; C06-03 after re-analysis both generations verify | real DB + vault + analyzers | PASS |
| E-02 | Hash/span/namespace of every published fact 100% (06 소스 근거) | C06: final audit round 692 facts over 7 snapshots, 0 failures (4,313 checks over all rounds), line spans only (N-1), but no CONFIG/MIGRATION nodes in the corpus. Packaged: `config:package.json` published with lines 1-2 for a 1-line LF-terminated file (F-3); the same `lineCount` is used for every build-file, YAML-config and SQL-migration node | real DB + vault + analyzers; packaged | **FAIL** (F-3) |
| E-03 | Edge span (07 gate) | Call edges with callsite metadata verified inside retained bytes with target name on the line; other edges verified for same-snapshot endpoints | as above | PASS |
| E-04 | Same-line calls (C06) | C06-04: `a()` and `b()` on one line are two edges with line 2; repeated `a(); a();` is one edge on line 3, never merged with another target | real analyzer | PASS |
| E-05 | CRLF / Unicode / BOM (C06) | C06-05 CRLF kept, `crlfTwo` on line 5; C06-06 Korean/emoji before a declaration, line 3; C06-07 BOM bytes kept, line 1 | real analyzer + vault | PASS |
| E-06 | Rename / delete (C06) | C06-08 old snapshot serves the old path, new snapshot has no fact on it; C06-09 deleted file readable in history, no fact in the new snapshot | real pipeline | PASS |
| E-07 | Re-analysis reproducibility | C06-10 unchanged re-analysis: identical normalized facts, previous snapshot unchanged | real pipeline | PASS |
| E-08 | Duplicate namespace (T02) | C06-11: the same FQCN in two modules is published only as AMBIGUOUS rows without span; no merged declaration | real Java parsing | PASS |
| E-09 | Pin: note-referenced source survives later analyses (T02, 07 §4) | C06-12: note written on snapshot 1 keeps its `files` row and served bytes after four more analyses | real DB + vault | PASS |
| E-10 | GC never removes pinned or note-referenced source (07 gate) | Retained snapshots: no destructive GC exists (fail-at-quota design); all seven snapshots and 1:1 blob rows kept (C06-13). Legacy-contract (v0, e.g. GitHub) snapshots: `FinalizeStep` retention (2) pruned a note-pinned snapshot and its file row (C06-13 legacy case) | real DB | **FAIL** (F-1) |
| E-11 | Coverage: file counts equal the manifest partition (06 coverage, B8) | C06-14 for every snapshot: files rows = manifest `file_count` = approved set = import `acceptedFiles`; outcome statuses sum to rows; discovered = rows + excluded + submodules; targeted matches; no pending | real DB | PASS |
| E-12 | Coverage: capability counts equal the manifest partition (06 coverage, B8) | No per-capability outcome is persisted (V27 stores per-file outcome and reason only) | code/schema | **FAIL** (F-2) |
| E-13 | V27 per-file outcome/reason; older results `LEGACY_UNMEASURED` (11, T02) | Migration walk: legacy file `LEGACY_UNMEASURED`, not targeted, no reason, no measurement row; legacy snapshot coverage `LEGACY_UNMEASURED`, outcomes null (C06-13) | real DB | PASS |
| E-14 | Legacy migration: every Flyway step, sentinels kept (07 gate, T02 V19–V21) | V1→V27, 27 single-step migrations; users, projects, snapshot, job, file, evidence, graph node, finding, note, note reference, task, task goal, AI setting and finding judgment contained in their rows after every later step | real PostgreSQL | PASS |
| E-15 | Packaged app: published facts via the app API verified 100% against retained source | `native-bJn2bY`: every node from `/graph/nodes` (all pages), its node evidence and the served file bytes (Git OID, equality with approved bytes) for snapshot 1, snapshot 1 after re-analysis and snapshot 2: 1 failure per snapshot (`config:package.json` 1-2 of 1); all other spans, namespaces, evidences and file identities verified | packaged | **FAIL** (F-3) |
| E-16 | SFC offset (C06, R2) | Outside this release (06 corpus table: R2); explicit skip | — | NOT RUN (R2) |
| E-17 | AI nonexistent evidence 0 (06 소스 근거) | Not in this unit (AI evidence validation belongs to the AI/cost unit) | — | NOT RUN |

Summary: 17 rows — PASS 11, FAIL 4 (E-02, E-10, E-12, E-15), NOT RUN 2 (E-16 R2,
E-17 other unit), BLOCKED 0. Recommendation: G-EVIDENCE stays open until F-1 and
F-3 are fixed on a rebuilt candidate with C06 extended by CONFIG/MIGRATION nodes and
the packaged run passing, and F-2 is decided by product review.

## Findings

- **F-1 (Medium, open).** `FinalizeStep` prunes READY snapshots with
  `source_contract_version = 0` beyond `app.snapshot-retention` (default 2) without
  checking note/task references. GitHub imports still create v0 snapshots, so a
  note that pins a file or node of an older GitHub snapshot loses its target after
  two newer analyses (the note text survives, the reference dangles). This
  conflicts with 07 §4 "notes pin 자동삭제 금지". Proposed fix: exclude snapshots
  whose `files`/`graph_nodes` ids are referenced by `note_references` (FILE/NODE)
  from the prune, with a regression test; retained (v1) snapshots are not pruned.
- **F-2 (Medium, open; product gap).** The coverage model persists per-file
  outcomes only; per-capability counts required by the 06 coverage threshold and
  B8 do not exist, so they cannot be compared with a manifest partition.
- **F-3 (Medium, open; found by the packaged run).** `BuildFileAnalyzer`,
  `YamlConfigAnalyzer` and `SqlMigrationAnalyzer` set a CONFIG/MIGRATION node's
  `lineEnd` with a private `lineCount` that returns 1 + the number of `\n`, so every
  LF-terminated file gets a span ending one line past its last line (reproduced:
  `native-bJn2bY`, `span bounds config:package.json 1-2 of 1` on a one-line
  `package.json` in every snapshot; also `native-n9Svxt`). Lone-CR files are
  under-counted by the same helper [INFERENCE from the code, not run]. Severity: the
  span points at a non-existent line, so the 06 "source evidence 100%" threshold
  fails for these node types; no other file's bytes are attributed, nothing is lost
  or disclosed, hence Medium, not High; not fixed here because a product change
  invalidates the candidate. The C06 audit missed it because its corpus produces no
  CONFIG/MIGRATION node. Proposed fix: count lines the way the analyzers and audit
  split them (LF, CRLF, lone CR terminate a line; a final terminator does not open a
  new line; empty file = 0/1 by the FILE-node convention), share one helper among the
  three analyzers, add unit tests for `x`, `x\n`, `x\r\n`, `x\r` and a C06 sequence
  with `package.json`, `application.yml` and a Flyway SQL file.
- **N-1.** Facts persist **line** spans; no byte offsets are stored. The audit
  derives byte ranges from line boundaries of the retained bytes, so "byte span"
  is verified at line granularity only.
- **N-2.** Retained-source GC (mark/grace/recheck) is not implemented; the store
  fails at quota instead of evicting. E-10 for retained sources is therefore met
  only because nothing is evicted.
- **N-3.** Coverage `excludedFiles` for retained snapshots is 0 because the
  worker only sees approved bytes; import-time exclusions are in the separate
  `localImport` observation.

## Remaining conditions

Resolve F-1 and F-3 (product changes + candidate rebuild + rerun of C06 and
`import-evidence-native.cjs`) and decide F-2 (implement capability outcomes or
narrow the published threshold through product review). Representative
real-repository fact verification, independent review and the R2 SFC cell are
outside this unit.
