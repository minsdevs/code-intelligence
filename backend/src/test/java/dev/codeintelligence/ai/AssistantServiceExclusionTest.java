package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
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
 * Exercises real request-plan preparation, exclusion filtering and one-use approval consumption
 * against raw structured retrieval fixtures. The provider must receive the approved filtered payload.
 * No Docker/Testcontainers or external provider is used.
 */
class AssistantServiceExclusionTest {

    private ProjectRepository projectRepository;
    private SnapshotRepository snapshotRepository;
    private JdbcClient jdbc;
    private ContextRetrievalService retrieval;
    private AIProvider mockProvider;
    private AiRequestPlanService plans;
    private AssistantService service;

    @BeforeEach
    void setUp() {
        projectRepository = mock(ProjectRepository.class);
        snapshotRepository = mock(SnapshotRepository.class);
        jdbc = mock(JdbcClient.class);
        var providerResolver = mock(AIProviderResolver.class);
        var usage = mock(AiUsageService.class);
        retrieval = mock(ContextRetrievalService.class);
        var validator = mock(EvidenceValidator.class);
        var evidenceService = mock(EvidenceService.class);
        var json = JsonMapper.builder().build();
        var transactions = mock(TransactionTemplate.class);
        mockProvider = mock(AIProvider.class);
        var preferences = mock(AiPreferenceStore.class);
        when(preferences.find(anyLong())).thenReturn(Optional.empty());
        plans = new AiRequestPlanService(
                projectRepository,
                snapshotRepository,
                retrieval,
                providerResolver,
                preferences,
                new AiRequestPlanStore(),
                json,
                mock(AiDesktopGateway.class),
                jdbc);
        service = new AssistantService(
                projectRepository,
                jdbc,
                providerResolver,
                usage,
                plans,
                validator,
                evidenceService,
                json,
                transactions);

        when(providerResolver.resolve(1L)).thenReturn(mockProvider);
        when(mockProvider.enabled()).thenReturn(true);
        when(mockProvider.name()).thenReturn("openai");
        when(mockProvider.model()).thenReturn("gpt-4o-mini");
        var providerResponse = new AIProvider.ChatResponse("{}", List.of(), "explanation", List.of(), 10, 5);
        when(mockProvider.chat(any())).thenReturn(providerResponse);
        when(usage.chat(anyLong(), anyLong(), any(), anyString(), any())).thenAnswer(invocation -> {
            AIProvider provider = invocation.getArgument(2);
            return provider.chat(invocation.getArgument(4));
        });
        when(validator.validate(anyLong(), anyLong(), any())).thenReturn(providerResponse);
        when(validator.collectRefs(any())).thenReturn(Set.of());
        when(transactions.execute(any())).thenAnswer(inv -> {
            var callback = inv.getArgument(0, org.springframework.transaction.support.TransactionCallback.class);
            return callback.doInTransaction(null);
        });
        mockJdbcForConversation();
        Project project = projectWithSnapshot(1L, 10L, "/tmp/clone");
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));
    }

    @Test
    void excludedIdsAreAppliedToThePlanAndProviderReceivesFilteredContent() {
        var source = block("SOURCE", "SOURCE:\n1|class Secret { String key = \"sk-123\"; }", "file:src/Secret.java:1");
        rawContext(block("VIEW", "VIEW: code"), block("FILE", "FOCUS_FILE: src/Secret.java"), source);
        var ctx = new ContextRetrievalService.AskContext(
                "code", "src/Secret.java", null, null, null, null, null, List.of());
        var request = new AssistantService.AskRequest(null, "explain this file", null, ctx, List.of(source.id()));

        var approved = prepareAndAsk(request);

        assertThat(approved.contextItems())
                .extracting(AiRequestPlanService.ContextItem::id)
                .doesNotContain(source.id());
        assertThat(approved.fileRefs()).isEmpty();
        assertThat(providerPrompt())
                .as("Provider payload must contain the included context without the excluded SOURCE block")
                .doesNotContain("SOURCE:", "class Secret", "sk-123")
                .contains("VIEW: code", "FOCUS_FILE: src/Secret.java");
    }

    @Test
    void noExclusionsKeepsAllContextInThePlanAndProviderPayload() {
        var source = block("SOURCE", "SOURCE:\n1|class App {}", "file:src/App.java:1");
        rawContext(block("VIEW", "VIEW: code"), block("FILE", "FOCUS_FILE: src/App.java"), source);
        var ctx =
                new ContextRetrievalService.AskContext("code", "src/App.java", null, null, null, null, null, List.of());
        var request = new AssistantService.AskRequest(null, "explain this", null, ctx, List.of());

        var approved = prepareAndAsk(request);

        assertThat(approved.contextItems())
                .extracting(AiRequestPlanService.ContextItem::id)
                .contains(source.id());
        assertThat(approved.fileRefs()).containsExactly("file:src/App.java:1");
        assertThat(providerPrompt())
                .as("An approved request with no exclusions must keep the full context")
                .contains("VIEW: code", "FOCUS_FILE: src/App.java", "SOURCE:", "class App");
    }

    @Test
    void nullExclusionsListTreatedAsEmpty() {
        var source = block("SOURCE", "SOURCE:\n1|class Main {}", "file:src/Main.java:1");
        rawContext(block("VIEW", "VIEW: -"), block("FILE", "FOCUS_FILE: src/Main.java"), source);
        var ctx =
                new ContextRetrievalService.AskContext(null, "src/Main.java", null, null, null, null, null, List.of());
        var request = new AssistantService.AskRequest(null, "explain this", null, ctx, null);

        var approved = prepareAndAsk(request);

        assertThat(approved.contextItems())
                .extracting(AiRequestPlanService.ContextItem::id)
                .contains(source.id());
        assertThat(approved.fileRefs()).containsExactly("file:src/Main.java:1");
        assertThat(providerPrompt()).contains("VIEW: -", "FOCUS_FILE: src/Main.java", "SOURCE:", "class Main");
    }

    @Test
    void multipleExcludedIdsAreAllAppliedAndNoneReachProvider() {
        var source = block("SOURCE", "SOURCE:\n1|class Secret {}", "file:src/Secret.java:1");
        var commit = block("COMMIT", "COMMIT abc12345: initial");
        rawContext(block("VIEW", "VIEW: code"), block("FILE", "FOCUS_FILE: src/Secret.java"), source, commit);
        var ctx = new ContextRetrievalService.AskContext(
                "code", "src/Secret.java", null, null, null, null, null, List.of());
        var request =
                new AssistantService.AskRequest(null, "explain this", null, ctx, List.of(source.id(), commit.id()));

        var approved = prepareAndAsk(request);

        assertThat(approved.contextItems())
                .extracting(AiRequestPlanService.ContextItem::id)
                .doesNotContain(source.id(), commit.id());
        assertThat(approved.fileRefs()).isEmpty();
        assertThat(providerPrompt())
                .doesNotContain("SOURCE:", "class Secret", "COMMIT abc12345")
                .contains("VIEW: code", "FOCUS_FILE: src/Secret.java");
    }

    private AiRequestPlanService.View prepareAndAsk(AssistantService.AskRequest request) {
        var approved = plans.prepare(1L, 1L, request);
        verify(mockProvider, never()).chat(any());
        verify(mockProvider, never()).embed(anyString());
        service.ask(
                1L,
                1L,
                new AssistantService.AskRequest(
                        request.conversationId(),
                        request.question(),
                        request.intent(),
                        request.context(),
                        request.excludedContextIds(),
                        approved.requestPlanToken()));
        verify(retrieval, times(2))
                .retrievePreviewStructured(
                        eq(1L), eq(1L), eq(10L), eq("/tmp/clone"), eq(request.context()), eq(request.question()));
        ArgumentCaptor<AIProvider.ChatRequest> chat = ArgumentCaptor.forClass(AIProvider.ChatRequest.class);
        verify(mockProvider).chat(chat.capture());
        assertThat(chat.getValue().system()).isEqualTo(approved.systemPrompt());
        assertThat(chat.getValue().user()).isEqualTo(approved.userPrompt());
        verify(mockProvider, never()).embed(anyString());
        return approved;
    }

    private String providerPrompt() {
        ArgumentCaptor<AIProvider.ChatRequest> chat = ArgumentCaptor.forClass(AIProvider.ChatRequest.class);
        verify(mockProvider).chat(chat.capture());
        return chat.getValue().user();
    }

    private void rawContext(ContextRetrievalService.ContextBlock... rawBlocks) {
        var blocks = List.of(rawBlocks);
        var raw = new ContextRetrievalService.StructuredRetrieved(
                String.join(
                        "\n",
                        blocks.stream()
                                .map(ContextRetrievalService.ContextBlock::content)
                                .toList()),
                blocks.stream()
                        .flatMap(block -> block.fileRefs().stream())
                        .distinct()
                        .toList(),
                blocks);
        when(retrieval.retrievePreviewStructured(eq(1L), eq(1L), eq(10L), eq("/tmp/clone"), any(), anyString()))
                .thenReturn(raw);
    }

    private ContextRetrievalService.ContextBlock block(String type, String content, String... refs) {
        return new ContextRetrievalService.ContextBlock(
                ContextRetrievalService.deterministicId(type, content), type, type, content, List.of(refs));
    }

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
        when(snapshotRepository.findByIdAndProjectId(snapshotId, projectId)).thenReturn(Optional.of(snapshot));
        return project;
    }

    @SuppressWarnings("unchecked")
    private void mockJdbcForConversation() {
        var sqlSpec = mock(JdbcClient.StatementSpec.class);
        var mappedSpec = mock(JdbcClient.MappedQuerySpec.class);
        when(jdbc.sql(anyString())).thenReturn(sqlSpec);
        when(sqlSpec.param(anyString(), any())).thenReturn(sqlSpec);
        when(sqlSpec.query(Long.class)).thenReturn(mappedSpec);
        when(mappedSpec.single()).thenReturn(1L);
        when(sqlSpec.update()).thenReturn(1);
    }
}
