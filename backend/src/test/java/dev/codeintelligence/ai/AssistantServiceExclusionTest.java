package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.Snapshot;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * Unit test proving that excludedContextIds are correctly forwarded to ContextRetrievalService
 * and that the resulting filtered context (without excluded content) is what reaches the AIProvider.
 * <p>
 * This test does NOT require Docker/Testcontainers. It mocks ContextRetrievalService to verify:
 * 1. retrieveWithExclusions() is called with the exact excluded ID set from the request
 * 2. The AIProvider.chat() request contains only the non-excluded content
 * 3. Backward compatibility: no exclusions still calls retrieveWithExclusions with an empty set
 */
class AssistantServiceExclusionTest {

    private ProjectRepository projectRepository;
    private SnapshotRepository snapshotRepository;
    private JdbcClient jdbc;
    private AIProviderResolver providerResolver;
    private AiUsageService usage;
    private ContextRetrievalService retrieval;
    private EvidenceValidator validator;
    private EvidenceService evidenceService;
    private JsonMapper json;
    private TransactionTemplate transactions;
    private AIProvider mockProvider;
    private AssistantService service;

    @BeforeEach
    void setUp() {
        projectRepository = mock(ProjectRepository.class);
        snapshotRepository = mock(SnapshotRepository.class);
        jdbc = mock(JdbcClient.class);
        providerResolver = mock(AIProviderResolver.class);
        usage = mock(AiUsageService.class);
        retrieval = mock(ContextRetrievalService.class);
        validator = mock(EvidenceValidator.class);
        evidenceService = mock(EvidenceService.class);
        json = JsonMapper.builder().build();
        transactions = mock(TransactionTemplate.class);
        mockProvider = mock(AIProvider.class);

        service = new AssistantService(
                projectRepository,
                snapshotRepository,
                jdbc,
                providerResolver,
                usage,
                retrieval,
                validator,
                evidenceService,
                json,
                mock(CodeExplanationService.class),
                mock(WhyAnalysisService.class),
                mock(AlternativeAnalysisService.class),
                mock(ArchitectureAnalysisService.class),
                mock(ProjectAreaAnalysisService.class),
                transactions);
    }

    @Test
    void excludedIdsAreForwardedToContextRetrievalAndProviderReceivesFilteredContent() {
        // Arrange: project + snapshot
        Project project = projectWithSnapshot(1L, 10L, "/tmp/clone");
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        // The excluded ID — simulates a SOURCE block the user chose to exclude
        String excludedSourceId = ContextRetrievalService.deterministicId(
                "SOURCE", "SOURCE:\n1|class Secret { String key = \"sk-123\"; }");

        // ContextRetrievalService returns filtered text (without the excluded SOURCE block)
        String filteredContext = "VIEW: code\nFOCUS_FILE: src/Secret.java";
        when(retrieval.retrieveWithExclusions(
                        eq(1L), eq(1L), eq(10L), eq("/tmp/clone"), any(), anyString(), eq(Set.of(excludedSourceId))))
                .thenReturn(new ContextRetrievalService.Retrieved(filteredContext, List.of("file:src/Secret.java:1")));

        // Provider setup
        when(providerResolver.resolve(1L)).thenReturn(mockProvider);
        when(mockProvider.enabled()).thenReturn(true);
        when(mockProvider.name()).thenReturn("openai");
        when(mockProvider.model()).thenReturn("gpt-4o-mini");

        AIProvider.ChatResponse providerResponse =
                new AIProvider.ChatResponse("{}", List.of(), "explanation", List.of(), 10, 5);
        when(mockProvider.chat(any())).thenReturn(providerResponse);

        // Validator passes through
        when(validator.validate(anyLong(), anyLong(), any())).thenReturn(providerResponse);
        when(validator.collectRefs(any())).thenReturn(Set.of());

        // TransactionTemplate executes inline
        when(transactions.execute(any())).thenAnswer(inv -> {
            var callback = inv.getArgument(0, org.springframework.transaction.support.TransactionCallback.class);
            return callback.doInTransaction(null);
        });

        // Mock JDBC for conversation/message persistence
        mockJdbcForConversation();

        // Act
        var ctx = new ContextRetrievalService.AskContext(
                "code", "src/Secret.java", null, null, null, null, null, List.of());
        var request = new AssistantService.AskRequest(null, "explain this file", null, ctx, List.of(excludedSourceId));
        service.ask(1L, 1L, request);

        // Assert 1: verify retrieval was called with exactly the excluded IDs
        ArgumentCaptor<Set<String>> excludedCaptor = ArgumentCaptor.forClass(Set.class);
        verify(retrieval)
                .retrieveWithExclusions(
                        eq(1L),
                        eq(1L),
                        eq(10L),
                        eq("/tmp/clone"),
                        any(),
                        eq("explain this file"),
                        excludedCaptor.capture());
        assertThat(excludedCaptor.getValue())
                .as("The exact excluded ID set must be forwarded to ContextRetrievalService")
                .containsExactly(excludedSourceId);

        // Assert 2: verify the AIProvider received a prompt that does NOT contain excluded content
        ArgumentCaptor<AIProvider.ChatRequest> chatCaptor = ArgumentCaptor.forClass(AIProvider.ChatRequest.class);
        verify(mockProvider).chat(chatCaptor.capture());
        String userPromptSentToProvider = chatCaptor.getValue().user();
        assertThat(userPromptSentToProvider)
                .as("Provider payload must NOT contain the excluded SOURCE content")
                .doesNotContain("SOURCE:")
                .doesNotContain("class Secret")
                .doesNotContain("sk-123");
        // But it SHOULD contain the non-excluded context
        assertThat(userPromptSentToProvider)
                .as("Provider payload must contain the included VIEW and FILE context")
                .contains("VIEW: code")
                .contains("FOCUS_FILE: src/Secret.java");
    }

    @Test
    void noExclusionsCallsRetrievalWithEmptySet() {
        // Arrange
        Project project = projectWithSnapshot(1L, 10L, "/tmp/clone");
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        String fullContext = "VIEW: code\nFOCUS_FILE: src/App.java\nSOURCE:\n1|class App {}";
        when(retrieval.retrieveWithExclusions(
                        eq(1L), eq(1L), eq(10L), eq("/tmp/clone"), any(), anyString(), eq(Set.of())))
                .thenReturn(new ContextRetrievalService.Retrieved(fullContext, List.of("file:src/App.java:1")));

        when(providerResolver.resolve(1L)).thenReturn(mockProvider);
        when(mockProvider.enabled()).thenReturn(true);
        when(mockProvider.name()).thenReturn("openai");
        when(mockProvider.model()).thenReturn("gpt-4o-mini");

        AIProvider.ChatResponse providerResponse =
                new AIProvider.ChatResponse("{}", List.of(), "explanation", List.of(), 10, 5);
        when(mockProvider.chat(any())).thenReturn(providerResponse);
        when(validator.validate(anyLong(), anyLong(), any())).thenReturn(providerResponse);
        when(validator.collectRefs(any())).thenReturn(Set.of());
        when(transactions.execute(any())).thenAnswer(inv -> {
            var callback = inv.getArgument(0, org.springframework.transaction.support.TransactionCallback.class);
            return callback.doInTransaction(null);
        });
        mockJdbcForConversation();

        // Act — request with NO excludedContextIds
        var ctx =
                new ContextRetrievalService.AskContext("code", "src/App.java", null, null, null, null, null, List.of());
        var request = new AssistantService.AskRequest(null, "explain this", null, ctx, List.of());
        service.ask(1L, 1L, request);

        // Assert: retrieval called with empty excluded set
        ArgumentCaptor<Set<String>> excludedCaptor = ArgumentCaptor.forClass(Set.class);
        verify(retrieval)
                .retrieveWithExclusions(
                        eq(1L), eq(1L), eq(10L), eq("/tmp/clone"), any(), eq("explain this"), excludedCaptor.capture());
        assertThat(excludedCaptor.getValue())
                .as("When no exclusions provided, retrieval receives an empty set (backward compatible)")
                .isEmpty();

        // Assert: provider receives the full context including SOURCE
        ArgumentCaptor<AIProvider.ChatRequest> chatCaptor = ArgumentCaptor.forClass(AIProvider.ChatRequest.class);
        verify(mockProvider).chat(chatCaptor.capture());
        String userPrompt = chatCaptor.getValue().user();
        assertThat(userPrompt)
                .as("With no exclusions, provider payload must contain all context including SOURCE")
                .contains("VIEW: code")
                .contains("FOCUS_FILE: src/App.java")
                .contains("SOURCE:")
                .contains("class App");
    }

    @Test
    void nullExclusionsListTreatedAsEmpty() {
        // Arrange
        Project project = projectWithSnapshot(1L, 10L, "/tmp/clone");
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        String fullContext = "VIEW: -\nFOCUS_FILE: src/Main.java\nSOURCE:\n1|class Main {}";
        when(retrieval.retrieveWithExclusions(
                        eq(1L), eq(1L), eq(10L), eq("/tmp/clone"), any(), anyString(), eq(Set.of())))
                .thenReturn(new ContextRetrievalService.Retrieved(fullContext, List.of()));

        when(providerResolver.resolve(1L)).thenReturn(mockProvider);
        when(mockProvider.enabled()).thenReturn(true);
        when(mockProvider.name()).thenReturn("openai");
        when(mockProvider.model()).thenReturn("gpt-4o-mini");

        AIProvider.ChatResponse providerResponse =
                new AIProvider.ChatResponse("{}", List.of(), "explanation", List.of(), 10, 5);
        when(mockProvider.chat(any())).thenReturn(providerResponse);
        when(validator.validate(anyLong(), anyLong(), any())).thenReturn(providerResponse);
        when(validator.collectRefs(any())).thenReturn(Set.of());
        when(transactions.execute(any())).thenAnswer(inv -> {
            var callback = inv.getArgument(0, org.springframework.transaction.support.TransactionCallback.class);
            return callback.doInTransaction(null);
        });
        mockJdbcForConversation();

        // Act — request with null excludedContextIds (simulating old clients)
        var ctx =
                new ContextRetrievalService.AskContext(null, "src/Main.java", null, null, null, null, null, List.of());
        var request = new AssistantService.AskRequest(null, "explain this", null, ctx, null);
        service.ask(1L, 1L, request);

        // Assert: treated as empty set
        verify(retrieval)
                .retrieveWithExclusions(eq(1L), eq(1L), eq(10L), eq("/tmp/clone"), any(), anyString(), eq(Set.of()));
    }

    @Test
    void multipleExcludedIdsAreAllForwardedAndNoneReachProvider() {
        // Arrange
        Project project = projectWithSnapshot(1L, 10L, "/tmp/clone");
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        String sourceId = ContextRetrievalService.deterministicId("SOURCE", "SOURCE:\n1|class Secret {}");
        String commitId = ContextRetrievalService.deterministicId("COMMIT", "COMMIT abc12345: initial");
        Set<String> excludedIds = Set.of(sourceId, commitId);

        // Filtered context (only VIEW + FILE remain)
        String filteredContext = "VIEW: code\nFOCUS_FILE: src/Secret.java";
        when(retrieval.retrieveWithExclusions(
                        eq(1L), eq(1L), eq(10L), eq("/tmp/clone"), any(), anyString(), eq(excludedIds)))
                .thenReturn(new ContextRetrievalService.Retrieved(filteredContext, List.of()));

        when(providerResolver.resolve(1L)).thenReturn(mockProvider);
        when(mockProvider.enabled()).thenReturn(true);
        when(mockProvider.name()).thenReturn("openai");
        when(mockProvider.model()).thenReturn("gpt-4o-mini");

        AIProvider.ChatResponse providerResponse =
                new AIProvider.ChatResponse("{}", List.of(), "explanation", List.of(), 10, 5);
        when(mockProvider.chat(any())).thenReturn(providerResponse);
        when(validator.validate(anyLong(), anyLong(), any())).thenReturn(providerResponse);
        when(validator.collectRefs(any())).thenReturn(Set.of());
        when(transactions.execute(any())).thenAnswer(inv -> {
            var callback = inv.getArgument(0, org.springframework.transaction.support.TransactionCallback.class);
            return callback.doInTransaction(null);
        });
        mockJdbcForConversation();

        // Act
        var ctx = new ContextRetrievalService.AskContext(
                "code", "src/Secret.java", null, null, null, null, null, List.of());
        var request = new AssistantService.AskRequest(null, "explain this", null, ctx, List.of(sourceId, commitId));
        service.ask(1L, 1L, request);

        // Assert: both excluded IDs forwarded
        ArgumentCaptor<Set<String>> excludedCaptor = ArgumentCaptor.forClass(Set.class);
        verify(retrieval)
                .retrieveWithExclusions(
                        eq(1L), eq(1L), eq(10L), eq("/tmp/clone"), any(), anyString(), excludedCaptor.capture());
        assertThat(excludedCaptor.getValue())
                .as("All excluded IDs must be forwarded")
                .containsExactlyInAnyOrder(sourceId, commitId);

        // Assert: provider receives nothing from excluded blocks
        ArgumentCaptor<AIProvider.ChatRequest> chatCaptor = ArgumentCaptor.forClass(AIProvider.ChatRequest.class);
        verify(mockProvider).chat(chatCaptor.capture());
        String userPrompt = chatCaptor.getValue().user();
        assertThat(userPrompt)
                .doesNotContain("SOURCE:")
                .doesNotContain("class Secret")
                .doesNotContain("COMMIT abc12345")
                .contains("VIEW: code")
                .contains("FOCUS_FILE: src/Secret.java");
    }

    // --- Helpers ---

    private Project projectWithSnapshot(long projectId, long snapshotId, String clonePath) {
        Project project = new Project(projectId, "test-project", "owner", "repo");
        project.assignClonePath(clonePath);
        try {
            var snapshotIdField = Project.class.getDeclaredField("currentSnapshotId");
            snapshotIdField.setAccessible(true);
            snapshotIdField.set(project, snapshotId);
            var idField = Project.class.getDeclaredField("id");
            idField.setAccessible(true);
            idField.set(project, projectId);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        Snapshot snapshot = mock(Snapshot.class);
        when(snapshot.getCommitSha()).thenReturn("abc123");
        when(snapshotRepository.findByIdAndProjectId(snapshotId, projectId)).thenReturn(Optional.of(snapshot));
        return project;
    }

    @SuppressWarnings("unchecked")
    private void mockJdbcForConversation() {
        // Mock the JDBC calls for conversation/message persistence
        var sqlSpec = mock(JdbcClient.StatementSpec.class);
        var mappedSpec = mock(JdbcClient.MappedQuerySpec.class);
        when(jdbc.sql(anyString())).thenReturn(sqlSpec);
        when(sqlSpec.param(anyString(), any())).thenReturn(sqlSpec);
        when(sqlSpec.query(Long.class)).thenReturn(mappedSpec);
        when(mappedSpec.single()).thenReturn(1L);
        when(sqlSpec.update()).thenReturn(1);
    }
}
