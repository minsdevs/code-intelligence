package dev.codeintelligence.task;

import dev.codeintelligence.evidence.SecretMask;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

@Service
public class TaskService {

    private static final Set<String> TYPES = Set.of("DEVELOPMENT", "REVIEW", "RESEARCH", "REFACTORING");
    private static final Set<String> STATUSES = Set.of("DRAFT", "OPEN", "DONE", "CANCELLED");
    private static final int TITLE_MAX = 200;
    private static final int TEXT_MAX = 20_000;

    public record GoalView(long id, int seq, String content, boolean done) {}

    public record TaskView(
            long id,
            String type,
            String title,
            String description,
            String status,
            String origin,
            Long sourceFindingId,
            String updatedAt,
            List<GoalView> goals) {}

    public record UpsertTask(String type, String title, String description, String status, List<String> goals) {}

    public record GoalPatch(Boolean done, String content) {}

    private final ProjectRepository projectRepository;
    private final JdbcClient jdbc;

    public TaskService(ProjectRepository projectRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<TaskView> list(long projectId, long userId, boolean includeDrafts) {
        requireOwned(projectId, userId);
        return jdbc
                .sql("""
                        select id from tasks
                        where project_id = :projectId and type <> 'LEARNING'
                          and (:includeDrafts or status <> 'DRAFT')
                        order by
                            case status when 'OPEN' then 0 when 'DRAFT' then 1 when 'DONE' then 2 else 3 end,
                            updated_at desc, id desc
                        """)
                .param("projectId", projectId)
                .param("includeDrafts", includeDrafts)
                .query(Long.class)
                .list()
                .stream()
                .map(id -> load(projectId, id))
                .toList();
    }

    @Transactional(readOnly = true)
    public TaskView get(long projectId, long userId, long taskId) {
        requireOwned(projectId, userId);
        return load(projectId, taskId);
    }

    @Transactional
    public TaskView create(long projectId, long userId, UpsertTask body) {
        requireOwned(projectId, userId);
        String type = requireType(body == null ? null : body.type());
        String title = requireTitle(body == null ? null : body.title());
        String description = sanitize(body == null ? null : body.description());
        long id = jdbc.sql("""
                        insert into tasks (project_id, type, title, description, status, origin)
                        values (:projectId, :type, :title, :description, 'OPEN', 'USER')
                        returning id
                        """)
                .param("projectId", projectId)
                .param("type", type)
                .param("title", title)
                .param("description", description)
                .query(Long.class)
                .single();
        replaceGoals(id, body == null ? List.of() : body.goals());
        return load(projectId, id);
    }

    @Transactional
    public TaskView update(long projectId, long userId, long taskId, UpsertTask body) {
        requireOwned(projectId, userId);
        TaskView existing = load(projectId, taskId);
        String type = body != null && body.type() != null ? requireType(body.type()) : existing.type();
        String title = body != null && body.title() != null ? requireTitle(body.title()) : existing.title();
        String description =
                body != null && body.description() != null ? sanitize(body.description()) : existing.description();
        String status = body != null && body.status() != null ? requireStatus(body.status()) : existing.status();
        if ("DRAFT".equals(existing.status()) && !"DRAFT".equals(status) && !"OPEN".equals(status)) {
            throw new InvalidTaskException();
        }
        jdbc.sql("""
                        update tasks
                        set type = :type, title = :title, description = :description, status = :status, updated_at = now()
                        where id = :id and project_id = :projectId and type <> 'LEARNING'
                        """)
                .param("type", type)
                .param("title", title)
                .param("description", description)
                .param("status", status)
                .param("id", taskId)
                .param("projectId", projectId)
                .update();
        if (body != null && body.goals() != null) {
            replaceGoals(taskId, body.goals());
        }
        return load(projectId, taskId);
    }

    @Transactional
    public TaskView approve(long projectId, long userId, long taskId) {
        requireOwned(projectId, userId);
        TaskView existing = load(projectId, taskId);
        if (!"DRAFT".equals(existing.status()) || !"AI".equals(existing.origin())) {
            throw new InvalidTaskException();
        }
        jdbc.sql("""
                        update tasks set status = 'OPEN', updated_at = now()
                        where id = :id and project_id = :projectId and type <> 'LEARNING'
                        """).param("id", taskId).param("projectId", projectId).update();
        return load(projectId, taskId);
    }

    @Transactional
    public GoalView patchGoal(long projectId, long userId, long taskId, long goalId, GoalPatch patch) {
        requireOwned(projectId, userId);
        load(projectId, taskId);
        int n = jdbc.sql("""
                        update task_goals
                        set done = coalesce(:done, done),
                            content = coalesce(:content, content)
                        where id = :goalId and task_id = :taskId
                        """)
                .param("done", patch == null ? null : patch.done())
                .param("content", patch == null || patch.content() == null ? null : sanitize(patch.content()))
                .param("goalId", goalId)
                .param("taskId", taskId)
                .update();
        if (n == 0) {
            throw new TaskNotFoundException();
        }
        return jdbc.sql("select id, seq, content, done from task_goals where id = :id")
                .param("id", goalId)
                .query((rs, rowNum) -> new GoalView(
                        rs.getLong("id"), rs.getInt("seq"), rs.getString("content"), rs.getBoolean("done")))
                .single();
    }

    @Transactional
    public void delete(long projectId, long userId, long taskId) {
        requireOwned(projectId, userId);
        int n = jdbc.sql("delete from tasks where id = :id and project_id = :projectId and type <> 'LEARNING'")
                .param("id", taskId)
                .param("projectId", projectId)
                .update();
        if (n == 0) {
            throw new TaskNotFoundException();
        }
    }

    private TaskView load(long projectId, long taskId) {
        TaskView task = jdbc.sql("""
                        select id, type, title, description, status, origin, source_finding_id, updated_at::text as updated_at
                        from tasks
                        where id = :id and project_id = :projectId and type <> 'LEARNING'
                        """)
                .param("id", taskId)
                .param("projectId", projectId)
                .query((rs, rowNum) -> new TaskView(
                        rs.getLong("id"),
                        rs.getString("type"),
                        rs.getString("title"),
                        rs.getString("description"),
                        rs.getString("status"),
                        rs.getString("origin"),
                        (Long) rs.getObject("source_finding_id"),
                        rs.getString("updated_at"),
                        List.of()))
                .optional()
                .orElseThrow(TaskNotFoundException::new);
        List<GoalView> goals = jdbc.sql("""
                        select id, seq, content, done from task_goals where task_id = :id order by seq, id
                        """)
                .param("id", taskId)
                .query((rs, rowNum) -> new GoalView(
                        rs.getLong("id"), rs.getInt("seq"), rs.getString("content"), rs.getBoolean("done")))
                .list();
        return new TaskView(
                task.id(),
                task.type(),
                task.title(),
                task.description(),
                task.status(),
                task.origin(),
                task.sourceFindingId(),
                task.updatedAt(),
                goals);
    }

    private void replaceGoals(long taskId, List<String> goals) {
        jdbc.sql("delete from task_goals where task_id = :id")
                .param("id", taskId)
                .update();
        if (goals == null) {
            return;
        }
        int seq = 0;
        for (String goal : goals) {
            if (!StringUtils.hasText(goal)) {
                continue;
            }
            seq++;
            jdbc.sql("""
                            insert into task_goals (task_id, seq, content, done)
                            values (:taskId, :seq, :content, false)
                            """)
                    .param("taskId", taskId)
                    .param("seq", seq)
                    .param("content", sanitize(goal))
                    .update();
        }
    }

    private void requireOwned(long projectId, long userId) {
        projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private static String requireType(String type) {
        if (type == null || !TYPES.contains(type.strip().toUpperCase(Locale.ROOT))) {
            throw new InvalidTaskException();
        }
        return type.strip().toUpperCase(Locale.ROOT);
    }

    private static String requireStatus(String status) {
        if (status == null || !STATUSES.contains(status.strip().toUpperCase(Locale.ROOT))) {
            throw new InvalidTaskException();
        }
        return status.strip().toUpperCase(Locale.ROOT);
    }

    private static String requireTitle(String title) {
        if (!StringUtils.hasText(title) || title.strip().length() > TITLE_MAX) {
            throw new InvalidTaskException();
        }
        return title.strip();
    }

    private static String sanitize(String text) {
        String value = text == null ? "" : text;
        if (value.length() > TEXT_MAX) {
            throw new InvalidTaskException();
        }
        return SecretMask.redact(value);
    }
}
