package dev.codeintelligence.ai;

import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.evidence.SecretMask;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.StringUtils;
import tools.jackson.databind.json.JsonMapper;

@Service
public class AssistantService {

    private static final Pattern FILE_REF = Pattern.compile("^file:([^:]+):(\\d+)$");
    private static final int QUESTION_MAX = 4000;

    public record AskRequest(
            Long conversationId,
            String question,
            String intent,
            ContextRetrievalService.AskContext context,
            List<String> excludedContextIds,
            String requestPlanToken) {
        public AskRequest(
                Long conversationId,
                String question,
                String intent,
                ContextRetrievalService.AskContext context,
                List<String> excludedContextIds) {
            this(conversationId, question, intent, context, excludedContextIds, null);
        }
    }

    public record AskResponse(
            long conversationId,
            long messageId,
            String explanation,
            List<AIProvider.Claim> claims,
            List<AIProvider.Alternative> alternatives) {}

    public record AiStatus(boolean configured, String provider, String model, String blockedReason) {}

    private final ProjectRepository projectRepository;
    private final JdbcClient jdbc;
    private final AIProviderResolver providerResolver;
    private final AiUsageService usage;
    private final AiRequestPlanService plans;
    private final EvidenceValidator validator;
    private final EvidenceService evidenceService;
    private final JsonMapper json;
    private final TransactionTemplate transactions;

    public AssistantService(
            ProjectRepository projectRepository,
            JdbcClient jdbc,
            AIProviderResolver providerResolver,
            AiUsageService usage,
            AiRequestPlanService plans,
            EvidenceValidator validator,
            EvidenceService evidenceService,
            JsonMapper json,
            TransactionTemplate transactions) {
        this.projectRepository = projectRepository;
        this.jdbc = jdbc;
        this.providerResolver = providerResolver;
        this.usage = usage;
        this.plans = plans;
        this.validator = validator;
        this.evidenceService = evidenceService;
        this.json = json;
        this.transactions = transactions;
    }

    public AiStatus status(long userId) {
        AIProvider provider = providerResolver.resolve(userId);
        return new AiStatus(
                provider.enabled(),
                provider.enabled() ? provider.name() : null,
                provider.enabled() ? provider.model() : null,
                providerResolver.blockedReason());
    }

    public AskResponse ask(long projectId, long userId, AskRequest request) {
        String question = request.question() == null ? "" : request.question().strip();
        if (!StringUtils.hasText(question) || question.length() > QUESTION_MAX) {
            throw new InvalidAiQuestionException();
        }
        requireOwned(projectId, userId);
        AIProvider provider = providerResolver.resolve(userId);
        if (!provider.enabled()) {
            throw new AiNotConfiguredException();
        }
        if (!plans.desktop()) usage.enforceBudget(userId);
        AiRequestPlanService.Approved approved = plans.consume(projectId, userId, request, provider);
        long snapshotId = approved.snapshotId();
        ContextRetrievalService.AskContext ctx = approved.context();
        AIProvider.ChatResponse raw = plans.desktop()
                ? plans.execute(approved)
                : usage.chat(userId, projectId, provider, approved.intent().name(), approved.payload());
        AIProvider.ChatResponse validated = validator.validate(projectId, snapshotId, raw);
        return transactions.execute(status -> {
            long conversationId = resolveConversation(projectId, snapshotId, userId, request.conversationId());
            persistUserMessage(conversationId, question, ctx);
            long messageId = persistAssistant(conversationId, validated);
            linkEvidence(projectId, messageId, validated);
            return new AskResponse(
                    conversationId, messageId, validated.explanation(), validated.claims(), validated.alternatives());
        });
    }

    public void stream(long projectId, long userId, AskRequest request, AIProvider.TokenConsumer consumer) {
        AskResponse response = ask(projectId, userId, request);
        OpenAIProvider.chunk(response.explanation(), consumer);
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
                .param("content", SecretMask.redact(question))
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

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }
}
