package dev.codeintelligence.ai;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.evidence.SecretMask;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

/** Exact local payload approval shared by prepare and send. Does not generate summaries/embeddings. */
@Service
public class AiRequestPlanService {
    public record ContextItem(
            String id, String type, String label, int charCount, boolean masked, List<String> fileRefs) {}

    public record View(
            String requestPlanToken,
            String requestId,
            Instant expiresAt,
            long snapshotId,
            String provider,
            String model,
            String intent,
            List<ContextItem> contextItems,
            List<String> fileRefs,
            String systemPrompt,
            String userPrompt,
            String payloadSha256,
            String costStatus,
            AiDesktopGateway.Cost cost) {
        @Override
        public String toString() {
            return "AiRequestPlanView[redacted]";
        }
    }

    record Approved(
            String requestId,
            long snapshotId,
            String question,
            AiIntent intent,
            ContextRetrievalService.AskContext context,
            AIProvider.ChatRequest payload,
            AiDesktopGateway.Quote quote) {
        @Override
        public String toString() {
            return "ApprovedAiRequest[redacted]";
        }
    }

    private record Binding(
            String schema,
            long userId,
            long projectId,
            long snapshotId,
            Long conversationId,
            String provider,
            String model,
            long preferenceRevision,
            String questionSha256,
            String intent,
            ContextRetrievalService.AskContext context,
            List<String> excludedIds,
            List<ContextItem> items,
            List<String> fileRefs,
            AIProvider.ChatRequest payload) {}

    private record Built(Binding binding, String question, AiIntent intent, String digest) {}

    private final ProjectRepository projects;
    private final SnapshotRepository snapshots;
    private final ContextRetrievalService retrieval;
    private final AIProviderResolver providers;
    private final AiPreferenceStore preferences;
    private final AiRequestPlanStore store;
    private final JsonMapper json;
    private final AiDesktopGateway gateway;
    private final JdbcClient jdbc;

    public AiRequestPlanService(
            ProjectRepository projects,
            SnapshotRepository snapshots,
            ContextRetrievalService retrieval,
            AIProviderResolver providers,
            AiPreferenceStore preferences,
            AiRequestPlanStore store,
            JsonMapper json,
            AiDesktopGateway gateway,
            JdbcClient jdbc) {
        this.projects = projects;
        this.snapshots = snapshots;
        this.retrieval = retrieval;
        this.providers = providers;
        this.preferences = preferences;
        this.store = store;
        this.json = json;
        this.gateway = gateway;
        this.jdbc = jdbc;
    }

    public View prepare(long projectId, long userId, AssistantService.AskRequest request) {
        AIProvider provider = providers.resolve(userId);
        if (!provider.enabled()) throw new AiNotConfiguredException();
        Built built = build(projectId, userId, request, provider);
        var issued = store.issue(userId, built.digest());
        Binding binding = built.binding();
        AiDesktopGateway.Quote quote = null;
        try {
            if (gateway.enabled()) {
                quote = gateway.quote(
                        userId,
                        projectId,
                        binding.snapshotId(),
                        binding.preferenceRevision(),
                        provider.name(),
                        provider.model(),
                        issued.requestId(),
                        built.digest(),
                        issued.expiresAt(),
                        binding.payload());
                store.attachQuote(issued, quote);
            }
        } catch (RuntimeException failure) {
            store.discard(issued);
            throw failure;
        }
        return new View(
                issued.requestPlanToken(),
                issued.requestId(),
                issued.expiresAt(),
                binding.snapshotId(),
                provider.name(),
                provider.model(),
                built.intent().name(),
                binding.items(),
                binding.fileRefs(),
                binding.payload().system(),
                binding.payload().user(),
                built.digest(),
                quote == null ? "UNAVAILABLE" : "AVAILABLE",
                quote == null ? null : quote.cost());
    }

    Approved consume(long projectId, long userId, AssistantService.AskRequest request, AIProvider provider) {
        // No retrieval or helper side effect can precede rejection of an absent approval.
        if (request.requestPlanToken() == null) throw new AiRequestPlanRequiredException();
        Built built = build(projectId, userId, request, provider);
        var consumed = store.consumePlan(userId, request.requestPlanToken(), built.digest());
        if (gateway.enabled() && consumed.quote() == null) throw new AiRequestPlanRequiredException();
        return new Approved(
                consumed.requestId(),
                built.binding().snapshotId(),
                built.question(),
                built.intent(),
                built.binding().context(),
                built.binding().payload(),
                consumed.quote());
    }

    boolean desktop() {
        return gateway.enabled();
    }

    AIProvider.ChatResponse execute(Approved approved) {
        if (approved.quote() == null) throw new AiRequestPlanRequiredException();
        return gateway.execute(approved.quote());
    }

    private Built build(long projectId, long userId, AssistantService.AskRequest request, AIProvider provider) {
        String question = request.question() == null ? "" : request.question().strip();
        if (question.isEmpty() || question.length() > 4000) throw new InvalidAiQuestionException();
        var project = projects.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
        if (request.conversationId() != null) {
            boolean owned = jdbc.sql("""
                    select exists(select 1 from ai_conversations
                    where id=:id and project_id=:project and user_id=:owner)
                    """)
                    .param("id", request.conversationId())
                    .param("project", projectId)
                    .param("owner", userId)
                    .query(Boolean.class)
                    .single();
            if (!owned) throw new ConversationNotFoundException();
        }
        Long snapshotId = project.getCurrentSnapshotId();
        if (snapshotId == null) throw new SnapshotNotFoundException();
        snapshots.findByIdAndProjectId(snapshotId, projectId).orElseThrow(SnapshotNotFoundException::new);
        AiIntent intent = request.intent() == null || request.intent().isBlank()
                ? AiIntent.infer(question)
                : AiIntent.from(request.intent());
        var context = normalize(request.context());
        List<String> excluded = request.excludedContextIds() == null
                ? List.of()
                : request.excludedContextIds().stream().distinct().sorted().toList();
        var structured = retrieval.retrievePreviewStructured(
                userId, projectId, snapshotId, project.getClonePath(), context, question);
        var selected = ContextRetrievalService.filterExclusions(structured, Set.copyOf(excluded));
        List<ContextItem> items = selected.blocks().stream()
                .map(b -> new ContextItem(
                        b.id(),
                        b.type(),
                        SecretMask.redact(b.label()),
                        b.content().length(),
                        b.content().contains("[REDACTED]") || PersonalDataMask.detects(b.content()),
                        b.fileRefs()))
                .toList();
        // The digest below binds these masked bytes, so the approved preview is exactly what is sent.
        var payload = new AIProvider.ChatRequest(
                systemPrompt(intent),
                PersonalDataMask.mask(SecretMask.redact(PromptBuilder.user(question, selected.text()))),
                true);
        long revision = preferences
                .find(userId)
                .map(AiPreferenceStore.Preference::revision)
                .orElse(0L);
        var binding = new Binding(
                "AI_REQUEST_PLAN_1",
                userId,
                projectId,
                snapshotId,
                request.conversationId(),
                provider.name(),
                provider.model(),
                revision,
                AiRequestPlanStore.hash(question),
                intent.name(),
                context,
                excluded,
                items,
                selected.fileRefs(),
                payload);
        return new Built(binding, question, intent, AiRequestPlanStore.hash(json.writeValueAsString(binding)));
    }

    private static ContextRetrievalService.AskContext normalize(ContextRetrievalService.AskContext context) {
        if (context == null)
            return new ContextRetrievalService.AskContext(null, null, null, null, null, null, null, List.of());
        return new ContextRetrievalService.AskContext(
                context.view(),
                context.focusedFile(),
                context.focusedNodeId(),
                context.focusedCommitSha(),
                context.focusedFindingId(),
                context.focusedNoteId(),
                context.focusedTaskId(),
                context.selectedAreas() == null ? List.of() : List.copyOf(context.selectedAreas()));
    }

    private static String systemPrompt(AiIntent intent) {
        return intent == AiIntent.FINDING
                ? PromptBuilder.system(AiIntent.EXPLAIN) + "\n" + PromptBuilder.system(intent)
                : PromptBuilder.system(intent);
    }
}
