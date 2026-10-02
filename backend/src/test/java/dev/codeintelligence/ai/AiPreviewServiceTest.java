package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.Snapshot;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class AiPreviewServiceTest {

    private ProjectRepository projectRepository;
    private SnapshotRepository snapshotRepository;
    private ContextRetrievalService retrieval;
    private AIProviderResolver providerResolver;
    private AiProperties aiProperties;
    private AiPreviewService service;

    @BeforeEach
    void setUp() {
        projectRepository = mock(ProjectRepository.class);
        snapshotRepository = mock(SnapshotRepository.class);
        retrieval = mock(ContextRetrievalService.class);
        providerResolver = mock(AIProviderResolver.class);
        aiProperties = new AiProperties("openai", 8000, 500000, 40, null, null);
        service =
                new AiPreviewService(projectRepository, snapshotRepository, retrieval, providerResolver, aiProperties);
    }

    @Test
    void previewReturnsCorrectStructure() {
        Project project = new Project(1L, "test", "/tmp/test");
        setProjectSnapshot(project, 10L);
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        var blocks = List.of(
                new ContextRetrievalService.ContextBlock("VIEW:abc123def456", "VIEW", "code", "VIEW: code"),
                new ContextRetrievalService.ContextBlock(
                        "FILE:def789abc012", "FILE", "src/Main.java", "FOCUS_FILE: src/Main.java"),
                new ContextRetrievalService.ContextBlock(
                        "SOURCE:111222333444", "SOURCE", "src/Main.java", "SOURCE:\n1|public class Main {}"));
        String contextText = "VIEW: code\nFOCUS_FILE: src/Main.java\nSOURCE:\n1|public class Main {}";
        when(retrieval.retrieveStructured(eq(1L), eq(1L), eq(10L), any(), any(), anyString()))
                .thenReturn(new ContextRetrievalService.StructuredRetrieved(
                        contextText, List.of("file:src/Main.java:1"), blocks));

        AIProvider mockProvider = mock(AIProvider.class);
        when(mockProvider.enabled()).thenReturn(true);
        when(mockProvider.name()).thenReturn("openai");
        when(mockProvider.model()).thenReturn("gpt-4o-mini");
        when(providerResolver.resolve(1L)).thenReturn(mockProvider);

        var ctx = new ContextRetrievalService.AskContext(
                "code", "src/Main.java", null, null, null, null, null, List.of());
        var result = service.preview(1L, 1L, "explain this", ctx);

        assertThat(result.localOnly()).isTrue();
        assertThat(result.fileRefs()).containsExactly("file:src/Main.java:1");
        assertThat(result.totalChars()).isGreaterThan(0);
        assertThat(result.estimatedInputTokens()).isEqualTo(result.totalChars() / 4);
        assertThat(result.provider()).isEqualTo("openai");
        assertThat(result.model()).isEqualTo("gpt-4o-mini");
        assertThat(result.contextItems()).hasSize(3);
        // Verify context items have deterministic IDs
        assertThat(result.contextItems().get(0).id()).isEqualTo("VIEW:abc123def456");
        assertThat(result.contextItems().get(0).type()).isEqualTo("VIEW");
        assertThat(result.contextItems().get(1).id()).isEqualTo("FILE:def789abc012");
        assertThat(result.contextItems().get(1).type()).isEqualTo("FILE");
        assertThat(result.copyablePrompt()).contains("QUESTION:\nexplain this").contains("---BEGIN CONTEXT---");
    }

    @Test
    void noExternalAiCallIsMade() {
        Project project = new Project(1L, "test", "/tmp/test");
        setProjectSnapshot(project, 10L);
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        var blocks = List.of(new ContextRetrievalService.ContextBlock("VIEW:aaa111222333", "VIEW", "-", "VIEW: code"));
        when(retrieval.retrieveStructured(anyLong(), anyLong(), anyLong(), any(), any(), anyString()))
                .thenReturn(new ContextRetrievalService.StructuredRetrieved("VIEW: code", List.of(), blocks));

        AIProvider mockProvider = mock(AIProvider.class);
        when(mockProvider.enabled()).thenReturn(true);
        when(mockProvider.name()).thenReturn("openai");
        when(mockProvider.model()).thenReturn("gpt-4o-mini");
        when(providerResolver.resolve(1L)).thenReturn(mockProvider);

        var ctx = new ContextRetrievalService.AskContext(null, null, null, null, null, null, null, List.of());
        service.preview(1L, 1L, "test", ctx);

        // Verify the AI provider's chat() method is never called
        verify(mockProvider, never()).chat(any());
    }

    @Test
    void costEstimationMath() {
        // OpenAI: input=$0.15/1M, output=$0.60/1M
        double openaiCost = service.estimateCost("openai", 1000, 300);
        assertThat(openaiCost).isCloseTo(0.000150 + 0.000180, org.assertj.core.api.Assertions.within(0.000001));

        // Gemini: input=$0.075/1M, output=$0.30/1M
        double geminiCost = service.estimateCost("gemini", 1000, 300);
        assertThat(geminiCost).isCloseTo(0.000075 + 0.000090, org.assertj.core.api.Assertions.within(0.000001));
    }

    @Test
    void countsRedactedSecrets() {
        int count = service.countRedacted("password: [REDACTED] and token: [REDACTED]");
        assertThat(count).isEqualTo(2);
    }

    @Test
    void deterministicIdIsStableAcrossCalls() {
        // Same type + content should always produce the same ID
        String id1 = ContextRetrievalService.deterministicId("VIEW", "VIEW: code");
        String id2 = ContextRetrievalService.deterministicId("VIEW", "VIEW: code");
        assertThat(id1).isEqualTo(id2);
        assertThat(id1).startsWith("VIEW:");
        assertThat(id1).hasSize("VIEW:".length() + 12); // type: + 12 hex chars

        // Different content produces a different ID
        String id3 = ContextRetrievalService.deterministicId("VIEW", "VIEW: architecture");
        assertThat(id3).isNotEqualTo(id1);
    }

    @Test
    void previewShowsAllItemsIncludingThoseUserMayLaterExclude() {
        // Preview always returns ALL context items with their IDs so the frontend can present
        // exclusion checkboxes. It does NOT itself filter or prove provider-side exclusion —
        // that proof lives in AssistantServiceExclusionTest which verifies the ask() flow.
        Project project = new Project(1L, "test", "/tmp/test");
        setProjectSnapshot(project, 10L);
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        String sourceId = ContextRetrievalService.deterministicId("SOURCE", "SOURCE:\n1|public class Main {}");
        var blocks = List.of(
                new ContextRetrievalService.ContextBlock(
                        ContextRetrievalService.deterministicId("VIEW", "VIEW: code"), "VIEW", "code", "VIEW: code"),
                new ContextRetrievalService.ContextBlock(
                        ContextRetrievalService.deterministicId("FILE", "FOCUS_FILE: src/Main.java"),
                        "FILE",
                        "src/Main.java",
                        "FOCUS_FILE: src/Main.java"),
                new ContextRetrievalService.ContextBlock(
                        sourceId, "SOURCE", "src/Main.java", "SOURCE:\n1|public class Main {}"));
        String contextText = "VIEW: code\nFOCUS_FILE: src/Main.java\nSOURCE:\n1|public class Main {}";
        when(retrieval.retrieveStructured(anyLong(), anyLong(), anyLong(), any(), any(), anyString()))
                .thenReturn(new ContextRetrievalService.StructuredRetrieved(
                        contextText, List.of("file:src/Main.java:1"), blocks));

        AIProvider mockProvider = mock(AIProvider.class);
        when(mockProvider.enabled()).thenReturn(true);
        when(mockProvider.name()).thenReturn("openai");
        when(mockProvider.model()).thenReturn("gpt-4o-mini");
        when(providerResolver.resolve(1L)).thenReturn(mockProvider);

        // Preview returns ALL items (user can then select which to exclude before asking)
        var ctx = new ContextRetrievalService.AskContext(
                "code", "src/Main.java", null, null, null, null, null, List.of());
        var previewResult = service.preview(1L, 1L, "explain this", ctx);
        assertThat(previewResult.contextItems()).hasSize(3);
        assertThat(previewResult.contextItems().stream()
                        .map(AiPreviewService.ContextItem::id)
                        .toList())
                .contains(sourceId)
                .as("Preview includes SOURCE item ID so frontend can offer exclusion");
    }

    private void setProjectSnapshot(Project project, Long snapshotId) {
        try {
            var field = Project.class.getDeclaredField("currentSnapshotId");
            field.setAccessible(true);
            field.set(project, snapshotId);
            var idField = Project.class.getDeclaredField("id");
            idField.setAccessible(true);
            idField.set(project, 1L);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        Snapshot snapshot = mock(Snapshot.class);
        when(snapshot.getCommitSha()).thenReturn("abc123");
        when(snapshotRepository.findByIdAndProjectId(snapshotId, 1L)).thenReturn(Optional.of(snapshot));
    }
}
