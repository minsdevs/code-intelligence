package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import dev.codeintelligence.TestcontainersConfiguration;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.ErrorResponseException;

/** Exercises the real preview/retrieval/summary services and database with a mocked provider. */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import({TestcontainersConfiguration.class, AiPreviewLocalRetrievalIntegrationTest.ProviderConfiguration.class})
class AiPreviewLocalRetrievalIntegrationTest {

    @TempDir
    static Path root;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> root.resolve("data").toString());
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class ProviderConfiguration {
        @Bean
        AIProvider previewGuardProvider() {
            return mock(AIProvider.class);
        }

        @Bean
        @Primary
        AIProviderResolver previewGuardResolver(AIProvider previewGuardProvider) {
            return userId -> previewGuardProvider;
        }
    }

    @Autowired
    private AiPreviewService preview;

    @Autowired
    private ContextRetrievalService retrieval;

    @Autowired
    private AIProvider previewGuardProvider;

    @Autowired
    private JdbcTemplate jdbc;

    @BeforeEach
    void providerResponses() {
        reset(previewGuardProvider);
        when(previewGuardProvider.enabled()).thenReturn(true);
        when(previewGuardProvider.name()).thenReturn("mock");
        when(previewGuardProvider.model()).thenReturn("mock-chat");
        when(previewGuardProvider.embeddingModel()).thenReturn("new-embedding");
        when(previewGuardProvider.chat(any()))
                .thenReturn(new AIProvider.ChatResponse(
                        "generated summary", List.of(), "generated summary", List.of(), 12, 8));
        float[] embedding = new float[1536];
        embedding[0] = 1;
        when(previewGuardProvider.embed(anyString())).thenReturn(embedding);
    }

    @Test
    void previewWithMissingSummaryDoesNotGenerateOrEmbedOrWrite() throws Exception {
        Fixture fixture = fixture("class PreviewOnly {}\n");
        var result = preview(fixture, "src/App.java");

        assertThat(result.localOnly()).isTrue();
        assertThat(result.copyablePrompt()).contains("SOURCE:\n1|class PreviewOnly {}");
        assertThat(result.contextItems()).noneMatch(item -> item.type().equals("SUMMARY"));
        assertThat(summaryRows(fixture)).isEmpty();
        assertNoProviderCallsOrUsage(fixture);
        assertThat(Files.readString(fixture.file())).isEqualTo("class PreviewOnly {}\n");
    }

    @Test
    void cachedSummaryWithOldEmbeddingModelIsReadWithoutRefreshOrWrites() throws Exception {
        Fixture fixture = fixture("class Cached {}\n");
        cache(fixture, "cached summary", fixture.hash(), "old-embedding");
        List<String> before = summaryRows(fixture);

        var result = preview(fixture, "src/App.java");

        assertThat(result.copyablePrompt()).contains("FILE_SUMMARY: cached summary");
        assertThat(summaryRows(fixture)).isEqualTo(before);
        assertThat(jdbc.queryForObject(
                        "select embedding_model from summaries where snapshot_id = ?",
                        String.class,
                        fixture.snapshotId()))
                .isEqualTo("old-embedding");
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void previewWithoutFocusedFileDoesNotEmbedQuestionForSemanticSearch() throws Exception {
        Fixture fixture = fixture("class NoFocus {}\n");
        var result = preview(fixture, null);

        assertThat(result.localOnly()).isTrue();
        assertThat(result.contextItems()).noneMatch(item -> item.type().equals("SUMMARY"));
        assertThat(summaryRows(fixture)).isEmpty();
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void foreignOwnerTaskAndGoalsAreExcludedWithoutProviderCallsOrWrites() throws Exception {
        assertForeignTaskExcluded(false);
    }

    @Test
    void sameOwnerOtherProjectTaskAndGoalsAreExcludedWithoutProviderCallsOrWrites() throws Exception {
        assertForeignTaskExcluded(true);
    }

    @Test
    void selectedProjectTaskAndGoalsRemainAvailableWithoutProviderCallsOrWrites() throws Exception {
        Fixture selected = fixture("class SelectedTask {}\n");
        long taskId = task(selected, "selected task title", "selected task detail", "selected task goal");
        List<String> before = contextRows(selected);

        var result = preview.preview(
                selected.projectId(),
                selected.userId(),
                "explain",
                new ContextRetrievalService.AskContext("tasks", null, null, null, null, null, taskId, List.of()));

        assertThat(result.localOnly()).isTrue();
        assertThat(result.copyablePrompt())
                .contains("FOCUS_TASK: OPEN DEVELOPMENT selected task title — selected task detail")
                .contains("TASK_GOAL: selected task goal");
        assertThat(result.contextItems().stream().filter(item -> item.type().equals("TASK")))
                .hasSize(2);
        assertThat(contextRows(selected)).isEqualTo(before);
        assertNoProviderCallsOrUsage(selected);
    }

    @Test
    void foreignNotesFindingsNodesAndCachedSummariesStayOutsideSelectedProjectContext() throws Exception {
        Fixture selected = fixture("class SelectedContext {}\n");
        Fixture foreign = fixture("class ForeignContext {}\n");
        long foreignNote = note(foreign, "foreign note sentinel", "src/App.java foreign note body sentinel");
        long foreignFinding = finding(foreign, "foreign finding sentinel");
        long foreignNode = node(foreign, "foreign node sentinel", foreign.fileId());
        note(selected, "selected related note", "src/App.java");
        cache(selected, "selected cached summary", selected.hash(), "old-embedding");
        cache(foreign, "foreign cache sentinel", foreign.hash(), "old-embedding");
        List<String> selectedBefore = contextRows(selected);
        List<String> foreignBefore = contextRows(foreign);

        var result = preview.preview(
                selected.projectId(),
                selected.userId(),
                "explain",
                new ContextRetrievalService.AskContext(
                        "code", "src/App.java", foreignNode, null, foreignFinding, foreignNote, null, List.of()));

        assertThat(result.copyablePrompt())
                .contains("RELATED_NOTE: selected related note", "FILE_SUMMARY: selected cached summary")
                .doesNotContain(
                        "foreign note sentinel",
                        "foreign note body sentinel",
                        "foreign finding sentinel",
                        "foreign node sentinel",
                        "foreign cache sentinel");
        assertThat(result.contextItems()).noneMatch(item -> item.label().contains("foreign"));
        assertThat(result.contextItems())
                .noneMatch(item -> item.type().equals("NODE") || item.type().equals("FINDING"));
        assertThat(contextRows(selected)).isEqualTo(selectedBefore);
        assertThat(contextRows(foreign)).isEqualTo(foreignBefore);
        assertNoProviderCallsOrUsage(selected);
        assertNoProviderCallsOrUsage(foreign);
    }

    @Test
    void graphNeighborsAndFileReferencesMustMatchSelectedSnapshot() throws Exception {
        Fixture selected = fixture("class SelectedGraph {}\n");
        Fixture foreign = fixture("class ForeignGraph {}\n");
        jdbc.update("update files set path = 'private/foreign-path-sentinel.java' where id = ?", foreign.fileId());
        // The current schema permits these inconsistent FKs; retrieval must still enforce its scope.
        long selectedNode = node(selected, "selected focus node", foreign.fileId());
        long selectedNeighbor = node(selected, "selected neighbor", selected.fileId());
        long foreignNode = node(foreign, "foreign neighbor sentinel", foreign.fileId());
        edge(selected, selectedNode, selectedNeighbor);
        edge(selected, selectedNode, foreignNode);
        List<String> selectedBefore = contextRows(selected);
        List<String> foreignBefore = contextRows(foreign);

        var result = preview.preview(
                selected.projectId(),
                selected.userId(),
                "explain",
                new ContextRetrievalService.AskContext("code", null, selectedNode, null, null, null, null, List.of()));

        assertThat(result.copyablePrompt())
                .contains("FOCUS_NODE: CLASS selected focus node", "NEIGHBOR out CALLS: CLASS selected neighbor")
                .doesNotContain("foreign neighbor sentinel", "private/foreign-path-sentinel.java");
        assertThat(result.contextItems()).noneMatch(item -> item.label().contains("foreign"));
        assertThat(result.fileRefs()).isEmpty();
        assertThat(contextRows(selected)).isEqualTo(selectedBefore);
        assertThat(contextRows(foreign)).isEqualTo(foreignBefore);
        assertNoProviderCallsOrUsage(selected);
        assertNoProviderCallsOrUsage(foreign);
    }

    @Test
    void graphNeighborsAreOmittedWhenFocusNodeIsOutsideSelectedSnapshot() throws Exception {
        Fixture selected = fixture("class NoSelectedFocus {}\n");
        Fixture foreign = fixture("class ForeignFocus {}\n");
        long foreignNode = node(foreign, "foreign focus sentinel", foreign.fileId());
        long selectedNeighbor = node(selected, "selected unrelated neighbor", selected.fileId());
        edge(selected, foreignNode, selectedNeighbor);
        List<String> selectedBefore = contextRows(selected);
        List<String> foreignBefore = contextRows(foreign);

        var result = preview.preview(
                selected.projectId(),
                selected.userId(),
                "explain",
                new ContextRetrievalService.AskContext("code", null, foreignNode, null, null, null, null, List.of()));

        assertThat(result.copyablePrompt()).doesNotContain("foreign focus sentinel", "selected unrelated neighbor");
        assertThat(result.contextItems()).noneMatch(item -> item.type().equals("NODE"));
        assertThat(result.fileRefs()).isEmpty();
        assertThat(contextRows(selected)).isEqualTo(selectedBefore);
        assertThat(contextRows(foreign)).isEqualTo(foreignBefore);
        assertNoProviderCallsOrUsage(selected);
        assertNoProviderCallsOrUsage(foreign);
    }

    @Test
    void cachedSummaryMustMatchSnapshotAndFileHash() throws Exception {
        Fixture selected = fixture("class Current {}\n");
        Fixture another = fixture("class Another {}\n");
        cache(selected, "stale hash sentinel", "wrong-hash", "old-embedding");
        cache(another, "other snapshot sentinel", selected.hash(), "old-embedding");
        List<String> selectedBefore = summaryRows(selected);
        List<String> anotherBefore = summaryRows(another);

        var result = preview(selected, "src/App.java");

        assertThat(result.copyablePrompt()).doesNotContain("stale hash sentinel", "other snapshot sentinel");
        assertThat(summaryRows(selected)).isEqualTo(selectedBefore);
        assertThat(summaryRows(another)).isEqualTo(anotherBefore);
        assertNoProviderCallsOrUsage(selected);
    }

    @Test
    void legacySummaryWithoutHashIsNotPresentedAsMatchingCachedContext() throws Exception {
        Fixture fixture = fixture("class Legacy {}\n");
        cache(fixture, "unverified cache sentinel", null, "old-embedding");
        List<String> before = summaryRows(fixture);

        var result = preview(fixture, "src/App.java");

        assertThat(result.copyablePrompt()).doesNotContain("unverified cache sentinel");
        assertThat(summaryRows(fixture)).isEqualTo(before);
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void previewOmitsSourceOverItsByteLimit() throws Exception {
        Fixture fixture = fixture("x".repeat(1024 * 1024 + 1));

        var result = preview(fixture, "src/App.java");

        assertThat(result.contextItems()).noneMatch(item -> item.type().equals("SOURCE"));
        assertThat(result.fileRefs()).isEmpty();
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void previewOmitsMalformedUtf8AndSourceSymlinks() throws Exception {
        Fixture fixture = fixture(new byte[] {(byte) 0xc3, 0x28});
        assertThat(preview(fixture, "src/App.java").contextItems())
                .noneMatch(item -> item.type().equals("SOURCE"));
        Files.delete(fixture.file());
        Path external = root.resolve("outside-" + UUID.randomUUID());
        Files.writeString(external, "outside source sentinel");
        Files.createSymbolicLink(fixture.file(), external);

        assertThat(preview(fixture, "src/App.java").copyablePrompt()).doesNotContain("outside source sentinel");
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void previewUsesTheSnapshotBlobAfterTheWorkingFileChangesOrBecomesASymlink() throws Exception {
        Fixture fixture = fixture("class ApprovedSnapshot {}\n");
        Files.writeString(fixture.file(), "class LaterUnapprovedSource {}\n");

        assertThat(preview(fixture, "src/App.java").copyablePrompt())
                .contains("1|class ApprovedSnapshot {}")
                .doesNotContain("LaterUnapprovedSource");
        Files.delete(fixture.file());
        Path outside = root.resolve("context-outside-" + UUID.randomUUID());
        Files.writeString(outside, "class ExternalSource {}\n");
        Files.createSymbolicLink(fixture.file(), outside);
        assertThat(preview(fixture, "src/App.java").copyablePrompt())
                .contains("1|class ApprovedSnapshot {}")
                .doesNotContain("ExternalSource");
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void missingSnapshotBlobIsOmittedInsteadOfReadingTheLiveFile() throws Exception {
        Fixture fixture = fixture("class SnapshotBlob {}\n");
        Files.delete(fixture.clonePath()
                .resolve(".git/objects")
                .resolve(fixture.hash().substring(0, 2))
                .resolve(fixture.hash().substring(2)));
        Files.writeString(fixture.file(), "class LiveFallbackMustNotAppear {}\n");

        var result = preview(fixture, "src/App.java");

        assertThat(result.contextItems()).noneMatch(item -> item.type().equals("SOURCE"));
        assertThat(result.copyablePrompt()).doesNotContain("LiveFallbackMustNotAppear");
        assertThat(result.fileRefs()).isEmpty();
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void normalRetrievalUsesTheSameSnapshotSourceAsPreview() throws Exception {
        Fixture fixture = fixture("class NormalSnapshot {}\n");
        Files.writeString(fixture.file(), "class NewLiveFile {}\n");

        var result = retrieval.retrieveStructured(
                fixture.userId(),
                fixture.projectId(),
                fixture.snapshotId(),
                fixture.clonePath().toString(),
                context("src/App.java"),
                "explain");

        assertThat(result.text()).contains("1|class NormalSnapshot {}").doesNotContain("NewLiveFile");
        assertNoProviderCallsOrUsage(fixture);
        assertThat(summaryRows(fixture)).isEmpty();
    }

    @Test
    void normalRetrievalReusesMatchingCacheWithoutAuthorizingSummaryOrEmbeddingCalls() throws Exception {
        Fixture fixture = fixture("class NormalAsk {}\n");
        cache(fixture, "retained normal summary", fixture.hash(), "old-embedding");
        List<String> before = contextRows(fixture);
        var result = retrieval.retrieveStructured(
                fixture.userId(),
                fixture.projectId(),
                fixture.snapshotId(),
                fixture.clonePath().toString(),
                context("src/App.java"),
                "explain");

        assertThat(result.text()).contains("FILE_SUMMARY: retained normal summary");
        assertNoProviderCallsOrUsage(fixture);
        assertThat(summaryRows(fixture)).hasSize(1);
        assertThat(contextRows(fixture)).isEqualTo(before);
    }

    @Test
    void excludedSourceDoesNotReachSummaryOrEmbeddingRequestsOrWriteCaches() throws Exception {
        Fixture fixture = fixture("class ExcludedSourceSentinel {}\n");
        String sourceId = contextId(preview(fixture, "src/App.java"), "SOURCE");
        List<String> before = contextRows(fixture);

        var result = retrieveExcluding(fixture, Set.of(sourceId));

        assertThat(result.text())
                .contains("FOCUS_FILE: src/App.java")
                .doesNotContain("SOURCE:", "ExcludedSourceSentinel", "generated summary");
        assertNoProviderCallsOrUsage(fixture);
        assertThat(summaryRows(fixture)).isEmpty();
        assertThat(contextRows(fixture)).isEqualTo(before);
    }

    @Test
    void excludedCachedSummaryDoesNotRefreshOrEmbedBeforeFiltering() throws Exception {
        Fixture fixture = fixture("class IncludedSource {}\n");
        cache(fixture, "excluded cached summary sentinel", fixture.hash(), "old-embedding");
        String summaryId = contextId(preview(fixture, "src/App.java"), "SUMMARY");
        List<String> before = contextRows(fixture);

        var result = retrieveExcluding(fixture, Set.of(summaryId));

        assertThat(result.text())
                .contains("SOURCE:", "IncludedSource")
                .doesNotContain("FILE_SUMMARY:", "excluded cached summary sentinel");
        assertNoProviderCallsOrUsage(fixture);
        assertThat(contextRows(fixture)).isEqualTo(before);
    }

    @Test
    void staleExclusionRequiresNewPreviewBeforeAnyProviderCallOrWrite() throws Exception {
        Fixture fixture = fixture("class ChangedContext {}\n");
        cache(fixture, "previous cached summary sentinel", fixture.hash(), "old-embedding");
        String summaryId = contextId(preview(fixture, "src/App.java"), "SUMMARY");
        jdbc.update(
                "update summaries set content = 'changed summary sentinel' where snapshot_id = ?",
                fixture.snapshotId());
        List<String> before = contextRows(fixture);

        assertThatThrownBy(() -> retrieveExcluding(fixture, Set.of(summaryId)))
                .isInstanceOfSatisfying(ErrorResponseException.class, error -> {
                    assertThat(error.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getBody().getProperties()).containsEntry("code", "AI_CONTEXT_CHANGED");
                });

        assertNoProviderCallsOrUsage(fixture);
        assertThat(contextRows(fixture)).isEqualTo(before);
    }

    @Test
    void excludingUnrelatedViewPreservesTheFocusedNodeFileReference() throws Exception {
        Fixture fixture = fixture("class SelectedNode {}\n");
        String path = "src/공백 있는:파일.java";
        jdbc.update("update files set path = ? where id = ?", path, fixture.fileId());
        long nodeId = node(fixture, "selected node path=misleading line=99", fixture.fileId());
        jdbc.update("update graph_nodes set line_start = 27 where id = ?", nodeId);
        var context =
                new ContextRetrievalService.AskContext("architecture", null, nodeId, null, null, null, null, List.of());
        var initial = preview.preview(fixture.projectId(), fixture.userId(), "explain", context);
        String viewId = contextId(initial, "VIEW");
        List<String> before = contextRows(fixture);

        var filtered = preview.preview(fixture.projectId(), fixture.userId(), "explain", context, Set.of(viewId));
        var retrieved = retrieval.retrieveWithExclusions(
                fixture.userId(),
                fixture.projectId(),
                fixture.snapshotId(),
                fixture.clonePath().toString(),
                context,
                "explain",
                Set.of(viewId));

        assertThat(initial.fileRefs()).containsExactly("file:" + path + ":27");
        assertThat(filtered.copyablePrompt()).contains("FOCUS_NODE:").doesNotContain("VIEW: architecture");
        assertThat(filtered.fileRefs()).isEqualTo(initial.fileRefs());
        assertThat(retrieved.fileRefs()).isEqualTo(initial.fileRefs());
        assertThat(contextRows(fixture)).isEqualTo(before);
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void excludingNodeRemovesOnlyItsReferenceWhileKeepingIncludedSource() throws Exception {
        Fixture fixture = fixture("class SharedSource {}\n");
        long nodeId = node(fixture, "selected node", fixture.fileId());
        jdbc.update("update graph_nodes set line_start = 27 where id = ?", nodeId);
        var context = new ContextRetrievalService.AskContext(
                "code", "src/App.java", nodeId, null, null, null, null, List.of());
        var initial = preview.preview(fixture.projectId(), fixture.userId(), "explain", context);

        var filtered = preview.preview(
                fixture.projectId(), fixture.userId(), "explain", context, Set.of(contextId(initial, "NODE")));
        var none = preview.preview(
                fixture.projectId(),
                fixture.userId(),
                "explain",
                context,
                Set.of(contextId(initial, "NODE"), contextId(initial, "SOURCE")));

        assertThat(initial.fileRefs()).containsExactly("file:src/App.java:1", "file:src/App.java:27");
        assertThat(filtered.copyablePrompt()).contains("SOURCE:").doesNotContain("FOCUS_NODE:");
        assertThat(filtered.fileRefs()).containsExactly("file:src/App.java:1");
        assertThat(none.fileRefs()).isEmpty();
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void sourceOmittedByContextBudgetDoesNotLeaveAFileReference() throws Exception {
        Fixture fixture = fixture("x".repeat(128 * 1024 + 1));

        var result = preview(fixture, "src/App.java");

        assertThat(result.contextItems()).noneMatch(item -> item.type().equals("SOURCE"));
        assertThat(result.fileRefs()).isEmpty();
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void nodeOmittedByContextBudgetDoesNotLeaveAFileReference() throws Exception {
        Fixture fixture = fixture("class OmittedNode {}\n");
        long nodeId = node(fixture, "x".repeat(128 * 1024 + 1), fixture.fileId());

        var result = preview.preview(
                fixture.projectId(),
                fixture.userId(),
                "explain",
                new ContextRetrievalService.AskContext(
                        "architecture", null, nodeId, null, null, null, null, List.of()));

        assertThat(result.contextItems()).noneMatch(item -> item.type().equals("NODE"));
        assertThat(result.fileRefs()).isEmpty();
        assertNoProviderCallsOrUsage(fixture);
    }

    @Test
    void arbitraryNoteTextDoesNotBecomeStructuredSourceProvenanceWhenFiltering() throws Exception {
        Fixture fixture = fixture("class UnrelatedSource {}\n");
        long noteId = note(fixture, "user note", "quoted example file:not-a-verified-source.java:999");
        var context = new ContextRetrievalService.AskContext("notes", null, null, null, null, noteId, null, List.of());
        var initial = preview.preview(fixture.projectId(), fixture.userId(), "explain", context);

        var filtered = preview.preview(
                fixture.projectId(), fixture.userId(), "explain", context, Set.of(contextId(initial, "VIEW")));

        assertThat(initial.fileRefs()).isEmpty();
        assertThat(filtered.copyablePrompt()).contains("file:not-a-verified-source.java:999");
        assertThat(filtered.fileRefs()).isEmpty();
        assertNoProviderCallsOrUsage(fixture);
    }

    private String contextId(AiPreviewService.AiPreviewResponse result, String type) {
        return result.contextItems().stream()
                .filter(item -> item.type().equals(type))
                .findFirst()
                .orElseThrow()
                .id();
    }

    private ContextRetrievalService.Retrieved retrieveExcluding(Fixture fixture, Set<String> excludedIds) {
        return retrieval.retrieveWithExclusions(
                fixture.userId(),
                fixture.projectId(),
                fixture.snapshotId(),
                fixture.clonePath().toString(),
                context("src/App.java"),
                "explain",
                excludedIds);
    }

    private AiPreviewService.AiPreviewResponse preview(Fixture fixture, String focusedFile) {
        return preview.preview(fixture.projectId(), fixture.userId(), "explain", context(focusedFile));
    }

    private ContextRetrievalService.AskContext context(String focusedFile) {
        return new ContextRetrievalService.AskContext("code", focusedFile, null, null, null, null, null, List.of());
    }

    private void assertForeignTaskExcluded(boolean sameOwner) throws Exception {
        Fixture selected = fixture("class SelectedTaskScope {}\n");
        Fixture foreign = fixture("class ForeignTaskScope {}\n");
        if (sameOwner) {
            jdbc.update("update projects set user_id = ? where id = ?", selected.userId(), foreign.projectId());
        }
        long taskId =
                task(foreign, "foreign task title sentinel", "foreign task detail sentinel", "foreign goal sentinel");
        List<String> selectedBefore = contextRows(selected);
        List<String> foreignBefore = contextRows(foreign);

        var result = preview.preview(
                selected.projectId(),
                selected.userId(),
                "explain",
                new ContextRetrievalService.AskContext("tasks", null, null, null, null, null, taskId, List.of()));

        assertThat(result.localOnly()).isTrue();
        assertThat(result.copyablePrompt())
                .doesNotContain("foreign task title sentinel", "foreign task detail sentinel", "foreign goal sentinel");
        assertThat(result.contextItems()).noneMatch(item -> item.type().equals("TASK"));
        assertThat(contextRows(selected)).isEqualTo(selectedBefore);
        assertThat(contextRows(foreign)).isEqualTo(foreignBefore);
        assertNoProviderCallsOrUsage(selected);
        assertNoProviderCallsOrUsage(foreign);
    }

    private void assertNoProviderCallsOrUsage(Fixture fixture) {
        verify(previewGuardProvider, never()).chat(any());
        verify(previewGuardProvider, never()).embed(anyString());
        verify(previewGuardProvider, never()).stream(any(), any());
        verify(previewGuardProvider, never()).testConnection();
        assertThat(usageCount(fixture)).isZero();
    }

    private long usageCount(Fixture fixture) {
        return jdbc.queryForObject(
                "select count(*) from ai_usage_logs where project_id = ?", Long.class, fixture.projectId());
    }

    private List<String> summaryRows(Fixture fixture) {
        // xmin also detects a cache UPDATE that happens to keep the same visible values.
        return jdbc.queryForList(
                "select row_to_json(s)::text || ':' || xmin::text from summaries s where snapshot_id = ? order by id",
                String.class,
                fixture.snapshotId());
    }

    private List<String> contextRows(Fixture fixture) {
        // Include xmin so a no-op UPDATE cannot masquerade as read-only retrieval.
        return jdbc.queryForList("""
                with scope as (select ?::bigint as project_id, ?::bigint as snapshot_id)
                select 'project:' || row_to_json(p)::text || ':' || p.xmin::text
                from projects p, scope s where p.id = s.project_id
                union all
                select 'snapshot:' || row_to_json(n)::text || ':' || n.xmin::text
                from snapshots n, scope s where n.project_id = s.project_id
                union all
                select 'file:' || row_to_json(f)::text || ':' || f.xmin::text
                from files f, scope s where f.snapshot_id = s.snapshot_id
                union all
                select 'task:' || row_to_json(t)::text || ':' || t.xmin::text
                from tasks t, scope s where t.project_id = s.project_id
                union all
                select 'goal:' || row_to_json(g)::text || ':' || g.xmin::text
                from task_goals g join tasks t on t.id = g.task_id, scope s where t.project_id = s.project_id
                union all
                select 'note:' || row_to_json(n)::text || ':' || n.xmin::text
                from notes n, scope s where n.project_id = s.project_id
                union all
                select 'note_ref:' || row_to_json(r)::text || ':' || r.xmin::text
                from note_references r join notes n on n.id = r.note_id, scope s where n.project_id = s.project_id
                union all
                select 'node:' || row_to_json(n)::text || ':' || n.xmin::text
                from graph_nodes n, scope s where n.snapshot_id = s.snapshot_id
                union all
                select 'edge:' || row_to_json(e)::text || ':' || e.xmin::text
                from graph_edges e, scope s where e.snapshot_id = s.snapshot_id
                union all
                select 'finding:' || row_to_json(f)::text || ':' || f.xmin::text
                from analysis_findings f, scope s where f.snapshot_id = s.snapshot_id
                union all
                select 'summary:' || row_to_json(c)::text || ':' || c.xmin::text
                from summaries c, scope s where c.snapshot_id = s.snapshot_id
                union all
                select 'usage:' || row_to_json(u)::text || ':' || u.xmin::text
                from ai_usage_logs u, scope s where u.project_id = s.project_id
                order by 1
                """, String.class, fixture.projectId(), fixture.snapshotId());
    }

    private long task(Fixture fixture, String title, String description, String goal) {
        long taskId = jdbc.queryForObject(
                "insert into tasks (project_id, type, title, description) values (?, 'DEVELOPMENT', ?, ?) returning id",
                Long.class,
                fixture.projectId(),
                title,
                description);
        jdbc.update("insert into task_goals (task_id, seq, content) values (?, 1, ?)", taskId, goal);
        return taskId;
    }

    private long note(Fixture fixture, String title, String content) {
        return jdbc.queryForObject(
                "insert into notes (project_id, title, content_md) values (?, ?, ?) returning id",
                Long.class,
                fixture.projectId(),
                title,
                content);
    }

    private long finding(Fixture fixture, String title) {
        return jdbc.queryForObject(
                "insert into analysis_findings (snapshot_id, category, severity, title, detail) values (?, 'CODE', 'LOW', ?, ?) returning id",
                Long.class,
                fixture.snapshotId(),
                title,
                title + " detail");
    }

    private long node(Fixture fixture, String name, long fileId) {
        return jdbc.queryForObject(
                "insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id, line_start) values (?, 'CLASS', ?, ?, ?, 1) returning id",
                Long.class,
                fixture.snapshotId(),
                UUID.randomUUID().toString(),
                name,
                fileId);
    }

    private void edge(Fixture fixture, long sourceNode, long targetNode) {
        jdbc.update(
                "insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence) values (?, ?, ?, 'CALLS', 'CONFIRMED')",
                fixture.snapshotId(),
                sourceNode,
                targetNode);
    }

    private void cache(Fixture fixture, String content, String contentHash, String embeddingModel) {
        jdbc.update("""
                insert into summaries (snapshot_id, subject_type, subject_id, level, content, content_hash, embedding_model)
                values (?, 'FILE', ?, 'FILE', ?, ?, ?)
                """, fixture.snapshotId(), fixture.fileId(), content, contentHash, embeddingModel);
    }

    private Fixture fixture(String content) throws Exception {
        return fixture(content.getBytes(StandardCharsets.UTF_8));
    }

    private Fixture fixture(byte[] content) throws Exception {
        long userId = jdbc.queryForObject(
                "insert into users (login, identity_type, local_key) values ('preview-fixture', 'LOCAL', ?) returning id",
                Long.class,
                UUID.randomUUID().toString());
        long projectId = jdbc.queryForObject(
                "insert into projects (user_id, name, repo_owner, repo_name) values (?, 'preview', 'local', ?) returning id",
                Long.class,
                userId,
                UUID.randomUUID().toString());
        Path clone = root.resolve("data/repos").resolve(Long.toString(projectId));
        Path file = clone.resolve("src/App.java");
        Files.createDirectories(file.getParent());
        Files.write(file, content);
        String commit;
        String hash;
        try (var git = Git.init().setDirectory(clone.toFile()).call();
                var formatter = new ObjectInserter.Formatter()) {
            git.add().addFilepattern(".").call();
            commit = git.commit()
                    .setMessage("Synthetic preview snapshot")
                    .setAuthor("Fixture", "fixture@example.invalid")
                    .setCommitter("Fixture", "fixture@example.invalid")
                    .call()
                    .name();
            hash = formatter.idFor(Constants.OBJ_BLOB, content).name();
        }
        jdbc.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbc.queryForObject(
                "insert into snapshots (project_id, commit_sha, status) values (?, ?, 'READY') returning id",
                Long.class,
                projectId,
                commit);
        jdbc.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        long fileId = jdbc.queryForObject(
                "insert into files (snapshot_id, path, language, size, line_count, content_hash) values (?, 'src/App.java', 'java', ?, 1, ?) returning id",
                Long.class,
                snapshotId,
                content.length,
                hash);
        return new Fixture(userId, projectId, snapshotId, fileId, clone, file, hash);
    }

    private record Fixture(
            long userId, long projectId, long snapshotId, long fileId, Path clonePath, Path file, String hash) {}
}
