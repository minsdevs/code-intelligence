# Local-only AI preview correction

The preview endpoint previously called `ContextRetrievalService.retrieveStructured`. That method could create a missing file summary, refresh a cached summary's embedding after a model change, and embed the question for semantic search. The preview response still returned `localOnly=true`. The existing unit test mocked retrieval, so its provider assertion did not exercise that path.

`AiPreviewService` now calls `retrievePreviewStructured`. This path only reads existing context and cached FILE summaries. A cache entry must match the owned project, selected snapshot/file, and non-null content hash. It never calls summary generation, embedding refresh, or provider-backed semantic search; an old embedding model does not trigger writes. Normal retrieval retains its current behavior.

Preview source input is bounded to 1 MiB, decoded as strict UTF-8, restricted to the managed repository tree, and excludes symlink source paths. The preview context character budget is capped at 128 KiB. Cached summary text is bounded in SQL and redacted before inclusion. These are local preview bounds, not tokenizer or price guarantees.

Independent review found that task metadata was project-scoped but its follow-up goal query used only the caller-supplied task ID. The goal query now joins the owning task and applies the selected project predicate. The adjacent retrieval review also added snapshot equality to graph neighbor/file joins and skips neighbors when the selected snapshot has no matching focus node. Notes, findings, related notes, commits, and cached summaries already have project/snapshot predicates. These shared retrieval scope checks protect preview and normal retrieval.

This change does not implement immutable AI source binding, a preview approval digest, budget reservations, the safety journal, or a complete egress gateway. Preview source still uses the managed local clone. Cached context and normal ask context can differ when normal retrieval generates material later. Exact approved payload binding and source/generation context remain T02/T08 work; no cost or whole-task gate is promoted by this correction.

Production ownership is limited to `AiPreviewService.java` and `ContextRetrievalService.java`. Existing constructors, DTOs, normal retrieval entrypoints, `SummaryService`, and `AiUsageService` are unchanged. `AiPreviewServiceTest` selects the explicit preview path. The 14 tests in `AiPreviewLocalRetrievalIntegrationTest` exercise real preview/retrieval/summary services and PostgreSQL with a mocked provider, covering missing summaries, embedding-model mismatch, no focused file, cache source mismatch, bounded/invalid source, zero chat/embed/stream/test-connection calls, unchanged summary rows, and zero usage writes. Scope regressions cover another owner's task/goals, another project belonging to the same owner, same-project inclusion, foreign notes/findings/nodes/summaries, and inconsistent graph/file snapshot links. The scope tests compare stored rows and PostgreSQL `xmin` before/after to detect updates as well as visible content changes. A separate control checks that normal retrieval still invokes the fake provider.

Root validation passed all14 integration cases,6 preview unit cases and4 exclusion integration cases
in the serialized focused Gradle run (`/tmp/ci-e2-focused-summary.json`, XML in
`/tmp/ci-e2-focused-xml`). Independent scoped review: C0/H0/M0. Providers were test doubles;
no provider network call, GUI, or credential access occurred. This is the preview correction's
acceptance, not the complete T08 strict-budget gate.
