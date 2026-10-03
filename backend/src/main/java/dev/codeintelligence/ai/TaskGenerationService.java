package dev.codeintelligence.ai;

import dev.codeintelligence.evidence.SecretMask;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.StringUtils;
import org.springframework.web.ErrorResponseException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Service
public class TaskGenerationService {

    public record GeneratedTask(
            long id,
            String type,
            String title,
            String description,
            String status,
            String origin,
            Long sourceFindingId,
            List<String> goals) {}

    private final ProjectRepository projectRepository;
    private final JdbcClient jdbc;
    private final AIProviderResolver providerResolver;
    private final AiUsageService usage;
    private final JsonMapper json;
    private final TransactionTemplate transactions;

    public TaskGenerationService(
            ProjectRepository projectRepository,
            JdbcClient jdbc,
            AIProviderResolver providerResolver,
            AiUsageService usage,
            JsonMapper json,
            TransactionTemplate transactions) {
        this.projectRepository = projectRepository;
        this.jdbc = jdbc;
        this.providerResolver = providerResolver;
        this.usage = usage;
        this.json = json;
        this.transactions = transactions;
    }

    public GeneratedTask fromFinding(long projectId, long userId, long findingId) {
        Project project =
                projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
        AIProvider provider = providerResolver.resolve(userId);
        if (!provider.enabled()) {
            throw new AiNotConfiguredException();
        }
        Long snapshotId = project.getCurrentSnapshotId();
        if (snapshotId == null) {
            throw new FindingMissingException();
        }
        FindingRow finding = jdbc.sql("""
                        select id, category, severity, title, detail
                        from analysis_findings
                        where snapshot_id = :snapshotId and id = :id
                        """)
                .param("snapshotId", snapshotId)
                .param("id", findingId)
                .query((rs, rowNum) -> new FindingRow(
                        rs.getLong("id"),
                        rs.getString("category"),
                        rs.getString("severity"),
                        rs.getString("title"),
                        rs.getString("detail")))
                .optional()
                .orElseThrow(FindingMissingException::new);
        String system = """
                Propose a Learning or Refactoring task from the FINDING. Return JSON only:
                {"type":"LEARNING|REFACTORING","title":"...","description":"...","goals":["..."]}
                Do not invent files. Keep the title under 80 characters.
                """;
        String user = SecretMask.redact("FINDING:\n" + finding.severity() + " " + finding.category() + " "
                + finding.title() + "\n" + nullToEmpty(finding.detail()));
        AIProvider.ChatResponse response =
                usage.chat(userId, projectId, provider, "task", new AIProvider.ChatRequest(system, user, true));
        Draft draft = parse(response, finding);
        return transactions.execute(status -> {
            long id = jdbc.sql("""
                            insert into tasks (project_id, type, title, description, status, origin, source_finding_id)
                            values (:projectId, :type, :title, :description, 'DRAFT', 'AI', :findingId)
                            returning id
                            """)
                    .param("projectId", projectId)
                    .param("type", draft.type)
                    .param("title", draft.title)
                    .param("description", draft.description)
                    .param("findingId", findingId)
                    .query(Long.class)
                    .single();
            int seq = 0;
            for (String goal : draft.goals) {
                seq++;
                jdbc.sql("""
                                insert into task_goals (task_id, seq, content, done)
                                values (:taskId, :seq, :content, false)
                                """)
                        .param("taskId", id)
                        .param("seq", seq)
                        .param("content", goal)
                        .update();
            }
            return new GeneratedTask(
                    id, draft.type, draft.title, draft.description, "DRAFT", "AI", findingId, draft.goals);
        });
    }

    private Draft parse(AIProvider.ChatResponse response, FindingRow finding) {
        String raw = StringUtils.hasText(response.explanation()) ? response.explanation() : response.raw();
        try {
            JsonNode root = json.readTree(raw.startsWith("{") ? raw : extractJson(raw));
            String type = text(root, "type").toUpperCase(Locale.ROOT);
            if (!"LEARNING".equals(type) && !"REFACTORING".equals(type)) {
                type = finding.category() != null && finding.category().contains("UNUSED") ? "REFACTORING" : "LEARNING";
            }
            String title = text(root, "title");
            if (!StringUtils.hasText(title)) {
                title = "학습: " + finding.title();
            }
            if (title.length() > 200) {
                title = title.substring(0, 200);
            }
            String description = text(root, "description");
            List<String> goals = new ArrayList<>();
            JsonNode array = root.get("goals");
            if (array != null && array.isArray()) {
                for (JsonNode node : array) {
                    String goal = node.asString();
                    if (StringUtils.hasText(goal)) {
                        goals.add(SecretMask.redact(goal));
                    }
                }
            }
            if (goals.isEmpty()) {
                goals.add("이 finding의 evidence를 코드에서 확인한다");
            }
            return new Draft(type, SecretMask.redact(title), SecretMask.redact(description), List.copyOf(goals));
        } catch (RuntimeException e) {
            return new Draft(
                    "LEARNING",
                    SecretMask.redact("학습: " + finding.title()),
                    SecretMask.redact(nullToEmpty(finding.detail())),
                    List.of("이 finding의 evidence를 코드에서 확인한다"));
        }
    }

    private static String extractJson(String raw) {
        int start = raw.indexOf('{');
        int end = raw.lastIndexOf('}');
        return start >= 0 && end > start ? raw.substring(start, end + 1) : "{}";
    }

    private static String text(JsonNode node, String field) {
        if (node == null) {
            return "";
        }
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? "" : value.asString();
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private record FindingRow(long id, String category, String severity, String title, String detail) {}

    private record Draft(String type, String title, String description, List<String> goals) {}

    public static final class FindingMissingException extends ErrorResponseException {
        public FindingMissingException() {
            super(
                    HttpStatus.NOT_FOUND,
                    ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Finding not found."),
                    null);
        }
    }
}
