package dev.codeintelligence.ai;

import dev.codeintelligence.analysis.core.SafeRelativePath;
import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.evidence.SecretMask;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.ArrayList;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.StringUtils;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Service
public class PlaygroundService {

    static final int PATHS_MAX = 20;
    static final int SNIPPET_MAX = 8000;
    static final int TITLE_MAX = 200;
    static final int QUESTION_MAX = 4000;

    static final String SYSTEM = PromptBuilder.system(AiIntent.EXPLAIN) + """

            PLAYGROUND: selected files and PROPOSED_SNIPPET are hypothetical text for exploration.
            Never treat PROPOSED_SNIPPET as executed code. The clone is never built or run.
            """;

    public record SessionSummary(long id, String title, String updatedAt) {}

    public record SessionView(
            long id,
            String title,
            List<String> selectedPaths,
            String proposedSnippet,
            String lastQuestion,
            String lastExplanation,
            List<AIProvider.Claim> lastClaims,
            String updatedAt) {}

    public record UpsertSession(String title, List<String> selectedPaths, String proposedSnippet) {}

    public record AskBody(String question, List<String> selectedPaths, String proposedSnippet) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;
    private final AIProviderResolver providerResolver;
    private final AiUsageService usage;
    private final ContextRetrievalService retrieval;
    private final EvidenceValidator validator;
    private final JsonMapper json;
    private final TransactionTemplate transactions;

    public PlaygroundService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            JdbcClient jdbc,
            AIProviderResolver providerResolver,
            AiUsageService usage,
            ContextRetrievalService retrieval,
            EvidenceValidator validator,
            JsonMapper json,
            TransactionTemplate transactions) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
        this.providerResolver = providerResolver;
        this.usage = usage;
        this.retrieval = retrieval;
        this.validator = validator;
        this.json = json;
        this.transactions = transactions;
    }

    @Transactional(readOnly = true)
    public List<SessionSummary> list(long projectId, long userId) {
        requireOwned(projectId, userId);
        return jdbc.sql("""
                        select id, title, updated_at::text as updated_at
                        from playground_sessions
                        where project_id = :projectId
                        order by updated_at desc, id desc
                        """)
                .param("projectId", projectId)
                .query((rs, rowNum) ->
                        new SessionSummary(rs.getLong("id"), rs.getString("title"), rs.getString("updated_at")))
                .list();
    }

    @Transactional(readOnly = true)
    public SessionView get(long projectId, long userId, long sessionId) {
        requireOwned(projectId, userId);
        return load(projectId, sessionId);
    }

    @Transactional
    public SessionView create(long projectId, long userId, UpsertSession body) {
        requireOwned(projectId, userId);
        List<String> paths = normalizePaths(body == null ? null : body.selectedPaths());
        String snippet = normalizeSnippet(body == null ? null : body.proposedSnippet());
        String title = normalizeTitle(body == null ? null : body.title(), paths);
        long id = jdbc.sql("""
                        insert into playground_sessions (project_id, title, selected_paths, proposed_snippet)
                        values (:projectId, :title, cast(:paths as jsonb), :snippet)
                        returning id
                        """)
                .param("projectId", projectId)
                .param("title", title)
                .param("paths", json.writeValueAsString(paths))
                .param("snippet", snippet)
                .query(Long.class)
                .single();
        return load(projectId, id);
    }

    @Transactional
    public SessionView update(long projectId, long userId, long sessionId, UpsertSession body) {
        requireOwned(projectId, userId);
        SessionView current = load(projectId, sessionId);
        List<String> paths = body != null && body.selectedPaths() != null
                ? normalizePaths(body.selectedPaths())
                : current.selectedPaths();
        String snippet = body != null && body.proposedSnippet() != null
                ? normalizeSnippet(body.proposedSnippet())
                : current.proposedSnippet();
        String title = body != null && body.title() != null ? normalizeTitle(body.title(), paths) : current.title();
        jdbc.sql("""
                        update playground_sessions
                        set title = :title, selected_paths = cast(:paths as jsonb),
                            proposed_snippet = :snippet, updated_at = now()
                        where id = :id and project_id = :projectId
                        """)
                .param("title", title)
                .param("paths", json.writeValueAsString(paths))
                .param("snippet", snippet)
                .param("id", sessionId)
                .param("projectId", projectId)
                .update();
        return load(projectId, sessionId);
    }

    @Transactional
    public void delete(long projectId, long userId, long sessionId) {
        requireOwned(projectId, userId);
        int rows = jdbc.sql("delete from playground_sessions where id = :id and project_id = :projectId")
                .param("id", sessionId)
                .param("projectId", projectId)
                .update();
        if (rows == 0) {
            throw new PlaygroundSessionNotFoundException();
        }
    }

    public SessionView ask(long projectId, long userId, long sessionId, AskBody body) {
        String question =
                body == null || body.question() == null ? "" : body.question().strip();
        if (!StringUtils.hasText(question) || question.length() > QUESTION_MAX) {
            throw new InvalidAiQuestionException();
        }
        Project project = requireOwned(projectId, userId);
        AIProvider provider = providerResolver.resolve(userId);
        if (!provider.enabled()) {
            throw new AiNotConfiguredException();
        }
        usage.enforceBudget(userId);
        long snapshotId = requireSnapshot(project);
        SessionView current = load(projectId, sessionId);
        List<String> paths = body != null && body.selectedPaths() != null
                ? normalizePaths(body.selectedPaths())
                : current.selectedPaths();
        String snippet = body != null && body.proposedSnippet() != null
                ? normalizeSnippet(body.proposedSnippet())
                : current.proposedSnippet();
        String focused = paths.isEmpty() ? null : paths.getFirst();
        ContextRetrievalService.AskContext ctx =
                new ContextRetrievalService.AskContext("playground", focused, null, null, null, null, null, List.of());
        ContextRetrievalService.Retrieved retrieved =
                retrieval.retrieve(userId, projectId, snapshotId, project.getClonePath(), ctx, question);
        String extra = extraContext(paths, snippet);
        String userPrompt = SecretMask.redact(PromptBuilder.user(question, retrieved.text() + "\n" + extra));
        AIProvider.ChatResponse raw = provider.chat(new AIProvider.ChatRequest(SYSTEM, userPrompt, true));
        AIProvider.ChatResponse validated = validator.validate(projectId, snapshotId, raw);
        return transactions.execute(status -> {
            jdbc.sql("""
                            update playground_sessions
                            set title = :title, selected_paths = cast(:paths as jsonb), proposed_snippet = :snippet,
                                last_question = :question, last_explanation = :explanation,
                                last_claims = cast(:claims as jsonb), updated_at = now()
                            where id = :id and project_id = :projectId
                            """)
                    .param("title", current.title())
                    .param("paths", json.writeValueAsString(paths))
                    .param("snippet", snippet)
                    .param("question", SecretMask.redact(question))
                    .param("explanation", SecretMask.redact(validated.explanation()))
                    .param("claims", json.writeValueAsString(validated.claims()))
                    .param("id", sessionId)
                    .param("projectId", projectId)
                    .update();
            usage.log(userId, projectId, provider, "playground", validated);
            return load(projectId, sessionId);
        });
    }

    private static String extraContext(List<String> paths, String snippet) {
        StringBuilder out = new StringBuilder();
        out.append("SELECTED_FILES: ").append(String.join(", ", paths));
        out.append(
                "\nPROPOSED_SNIPPET is hypothetical text. It was not executed and must not be treated as runtime output.\n");
        out.append("PROPOSED_SNIPPET:\n").append(snippet);
        return out.toString();
    }

    private SessionView load(long projectId, long sessionId) {
        return jdbc.sql("""
                        select id, title, selected_paths::text as selected_paths, proposed_snippet,
                               last_question, last_explanation, last_claims::text as last_claims,
                               updated_at::text as updated_at
                        from playground_sessions
                        where id = :id and project_id = :projectId
                        """)
                .param("id", sessionId)
                .param("projectId", projectId)
                .query((rs, rowNum) -> new SessionView(
                        rs.getLong("id"),
                        rs.getString("title"),
                        readStrings(rs.getString("selected_paths")),
                        rs.getString("proposed_snippet"),
                        rs.getString("last_question"),
                        rs.getString("last_explanation"),
                        readClaims(rs.getString("last_claims")),
                        rs.getString("updated_at")))
                .optional()
                .orElseThrow(PlaygroundSessionNotFoundException::new);
    }

    private List<String> normalizePaths(List<String> raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        if (raw.size() > PATHS_MAX) {
            throw new InvalidPlaygroundException("At most " + PATHS_MAX + " files can be selected.");
        }
        List<String> paths = new ArrayList<>();
        for (String item : raw) {
            if (!StringUtils.hasText(item)) {
                continue;
            }
            paths.add(SafeRelativePath.normalize(item));
        }
        return List.copyOf(paths);
    }

    private static String normalizeSnippet(String raw) {
        String snippet = raw == null ? "" : raw;
        if (snippet.length() > SNIPPET_MAX) {
            throw new InvalidPlaygroundException("Proposed snippet is too long.");
        }
        return SecretMask.redact(snippet);
    }

    private static String normalizeTitle(String raw, List<String> paths) {
        String title = raw == null ? "" : raw.strip();
        if (!StringUtils.hasText(title)) {
            title = paths.isEmpty() ? "Playground" : paths.getFirst();
        }
        if (title.length() > TITLE_MAX) {
            title = title.substring(0, TITLE_MAX);
        }
        return SecretMask.redact(title);
    }

    private List<String> readStrings(String raw) {
        if (!StringUtils.hasText(raw)) {
            return List.of();
        }
        try {
            JsonNode node = json.readTree(raw);
            List<String> values = new ArrayList<>();
            if (node.isArray()) {
                for (JsonNode item : node) {
                    if (item != null && item.isValueNode() && StringUtils.hasText(item.asString())) {
                        values.add(item.asString());
                    }
                }
            }
            return List.copyOf(values);
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    private List<AIProvider.Claim> readClaims(String raw) {
        if (!StringUtils.hasText(raw)) {
            return List.of();
        }
        try {
            JsonNode node = json.readTree(raw);
            if (!node.isArray()) {
                return List.of();
            }
            List<AIProvider.Claim> claims = new ArrayList<>();
            for (JsonNode item : node) {
                List<String> evidence = new ArrayList<>();
                JsonNode ev = item.get("evidence");
                if (ev != null && ev.isArray()) {
                    for (JsonNode ref : ev) {
                        if (ref != null && ref.isValueNode() && StringUtils.hasText(ref.asString())) {
                            evidence.add(ref.asString());
                        }
                    }
                }
                String text = item.get("text") == null || item.get("text").isNull()
                        ? ""
                        : item.get("text").asString();
                String confidence =
                        item.get("confidence") == null || item.get("confidence").isNull()
                                ? "UNKNOWN"
                                : item.get("confidence").asString();
                claims.add(new AIProvider.Claim(text, confidence, List.copyOf(evidence)));
            }
            return List.copyOf(claims);
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private long requireSnapshot(Project project) {
        Long id = project.getCurrentSnapshotId();
        if (id == null) {
            throw new SnapshotNotFoundException();
        }
        snapshotRepository.findByIdAndProjectId(id, project.getId()).orElseThrow(SnapshotNotFoundException::new);
        return id;
    }
}
