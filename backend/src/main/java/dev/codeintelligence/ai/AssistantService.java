package dev.codeintelligence.ai;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.evidence.SecretMask;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import tools.jackson.databind.json.JsonMapper;

@Service
public class AssistantService {

    private static final Pattern FILE_REF = Pattern.compile("^file:([^:]+):(\\d+)$");
    private static final int QUESTION_MAX = 4000;

    public record AskRequest(
            Long conversationId, String question, String intent, ContextRetrievalService.AskContext context) {}

    public record AskResponse(
            long conversationId,
            long messageId,
            String explanation,
            List<AIProvider.Claim> claims,
            List<AIProvider.Alternative> alternatives) {}

    public record AiStatus(boolean configured, String provider) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;
    private final AIProvider aiProvider;
    private final AiProperties aiProperties;
    private final ContextRetrievalService retrieval;
    private final EvidenceValidator validator;
    private final EvidenceService evidenceService;
    private final JsonMapper json;
    private final CodeExplanationService codeExplanationService;
    private final WhyAnalysisService whyAnalysisService;
    private final AlternativeAnalysisService alternativeAnalysisService;
    private final ArchitectureAnalysisService architectureAnalysisService;
    private final ProjectAreaAnalysisService projectAreaAnalysisService;

    public AssistantService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            JdbcClient jdbc,
            AIProvider aiProvider,
            AiProperties aiProperties,
            ContextRetrievalService retrieval,
            EvidenceValidator validator,
            EvidenceService evidenceService,
            JsonMapper json,
            CodeExplanationService codeExplanationService,
            WhyAnalysisService whyAnalysisService,
            AlternativeAnalysisService alternativeAnalysisService,
            ArchitectureAnalysisService architectureAnalysisService,
            ProjectAreaAnalysisService projectAreaAnalysisService) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
        this.aiProvider = aiProvider;
        this.aiProperties = aiProperties;
        this.retrieval = retrieval;
        this.validator = validator;
        this.evidenceService = evidenceService;
        this.json = json;
        this.codeExplanationService = codeExplanationService;
        this.whyAnalysisService = whyAnalysisService;
        this.alternativeAnalysisService = alternativeAnalysisService;
        this.architectureAnalysisService = architectureAnalysisService;
        this.projectAreaAnalysisService = projectAreaAnalysisService;
    }

    public AiStatus status() {
        return new AiStatus(aiProvider.enabled(), aiProvider.enabled() ? aiProvider.name() : null);
    }

    @Transactional
    public AskResponse ask(long projectId, long userId, AskRequest request) {
        if (!aiProvider.enabled()) {
            throw new AiNotConfiguredException();
        }
        String question = request.question() == null ? "" : request.question().strip();
        if (!StringUtils.hasText(question) || question.length() > QUESTION_MAX) {
            throw new InvalidAiQuestionException();
        }
        enforceBudget(userId);
        Project project = requireOwned(projectId, userId);
        long snapshotId = requireSnapshot(project, null);
        AiIntent intent = request.intent() == null || request.intent().isBlank()
                ? AiIntent.infer(question)
                : AiIntent.from(request.intent());
        ContextRetrievalService.AskContext ctx = request.context() == null
                ? new ContextRetrievalService.AskContext(null, null, null, null, null, null, null, List.of())
                : request.context();
        ContextRetrievalService.Retrieved retrieved =
                retrieval.retrieve(projectId, snapshotId, project.getClonePath(), ctx, question);
        String userPrompt = SecretMask.redact(PromptBuilder.user(question, retrieved.text()));
        AIProvider.ChatResponse raw =
                aiProvider.chat(new AIProvider.ChatRequest(systemPrompt(intent), userPrompt, true));
        AIProvider.ChatResponse validated = validator.validate(projectId, snapshotId, raw);
        long conversationId = resolveConversation(projectId, snapshotId, userId, request.conversationId());
        persistUserMessage(conversationId, question, ctx);
        long messageId = persistAssistant(conversationId, validated);
        linkEvidence(projectId, messageId, validated);
        logUsage(userId, projectId, intent, validated);
        return new AskResponse(
                conversationId, messageId, validated.explanation(), validated.claims(), validated.alternatives());
    }

    public void stream(long projectId, long userId, AskRequest request, AIProvider.TokenConsumer consumer) {
        AskResponse response = ask(projectId, userId, request);
        OpenAIProvider.chunk(response.explanation(), consumer);
    }

    private String systemPrompt(AiIntent intent) {
        return switch (intent) {
            case WHY -> whyAnalysisService.systemPrompt();
            case ALTERNATIVE -> alternativeAnalysisService.systemPrompt();
            case ARCHITECTURE -> architectureAnalysisService.systemPrompt();
            case PROJECT -> projectAreaAnalysisService.systemPrompt();
            case FINDING, EXPLAIN ->
                codeExplanationService.systemPrompt()
                        + (intent == AiIntent.FINDING ? "\n" + PromptBuilder.system(AiIntent.FINDING) : "");
        };
    }

    private void enforceBudget(long userId) {
        Long used = jdbc.sql("""
                        select coalesce(sum(prompt_tokens + completion_tokens), 0)
                        from ai_usage_logs
                        where user_id = :userId and created_at >= date_trunc('day', now())
                        """).param("userId", userId).query(Long.class).single();
        if (used != null && used >= aiProperties.dailyTokenLimit()) {
            throw new AiBudgetExceededException();
        }
    }

    private long resolveConversation(long projectId, long snapshotId, long userId, Long conversationId) {
        if (conversationId != null) {
            Boolean ok = jdbc.sql("""
                            select exists(
                                select 1 from ai_conversations
                                where id = :id and project_id = :projectId and user_id = :userId
                            )
                            """)
                    .param("id", conversationId)
                    .param("projectId", projectId)
                    .param("userId", userId)
                    .query(Boolean.class)
                    .single();
            if (!Boolean.TRUE.equals(ok)) {
                throw new ConversationNotFoundException();
            }
            return conversationId;
        }
        return jdbc.sql("""
                        insert into ai_conversations (project_id, snapshot_id, user_id)
                        values (:projectId, :snapshotId, :userId)
                        returning id
                        """)
                .param("projectId", projectId)
                .param("snapshotId", snapshotId)
                .param("userId", userId)
                .query(Long.class)
                .single();
    }

    private void persistUserMessage(long conversationId, String question, ContextRetrievalService.AskContext ctx) {
        jdbc.sql("""
                        insert into ai_messages (conversation_id, role, content, context)
                        values (:conversationId, 'USER', :content, :context::jsonb)
                        """)
                .param("conversationId", conversationId)
                .param("content", question)
                .param("context", json.writeValueAsString(ctx))
                .update();
    }

    private long persistAssistant(long conversationId, AIProvider.ChatResponse response) {
        return jdbc.sql("""
                        insert into ai_messages (conversation_id, role, content, claims, prompt_tokens, completion_tokens)
                        values (:conversationId, 'ASSISTANT', :content, :claims::jsonb, :prompt, :completion)
                        returning id
                        """)
                .param("conversationId", conversationId)
                .param("content", response.explanation())
                .param("claims", json.writeValueAsString(response.claims()))
                .param("prompt", response.promptTokens())
                .param("completion", response.completionTokens())
                .query(Long.class)
                .single();
    }

    private void linkEvidence(long projectId, long messageId, AIProvider.ChatResponse response) {
        for (String ref : validator.collectRefs(response)) {
            Matcher file = FILE_REF.matcher(ref);
            if (!file.matches()) {
                continue;
            }
            long evidenceId = evidenceService.insertAi(
                    projectId,
                    new NewEvidence(
                            EvidenceKind.FILE_LINE,
                            file.group(1),
                            Integer.parseInt(file.group(2)),
                            Integer.parseInt(file.group(2)),
                            ref));
            evidenceService.link(evidenceId, EvidenceSubjects.AI_MESSAGE, messageId);
        }
    }

    private void logUsage(long userId, long projectId, AiIntent intent, AIProvider.ChatResponse response) {
        jdbc.sql("""
                        insert into ai_usage_logs (user_id, project_id, provider, model, purpose, prompt_tokens, completion_tokens)
                        values (:userId, :projectId, :provider, :model, :purpose, :prompt, :completion)
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("provider", aiProvider.name())
                .param("model", aiProvider.name())
                .param("purpose", intent.name().toLowerCase(Locale.ROOT))
                .param("prompt", response.promptTokens())
                .param("completion", response.completionTokens())
                .update();
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private long requireSnapshot(Project project, Long snapshotId) {
        Long id = snapshotId != null ? snapshotId : project.getCurrentSnapshotId();
        if (id == null) {
            throw new SnapshotNotFoundException();
        }
        snapshotRepository.findByIdAndProjectId(id, project.getId()).orElseThrow(SnapshotNotFoundException::new);
        return id;
    }
}
