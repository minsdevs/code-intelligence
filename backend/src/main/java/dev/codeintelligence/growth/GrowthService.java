package dev.codeintelligence.growth;

import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class GrowthService {

    public record TypeCounts(String type, long open, long done, long draft, long cancelled) {}

    public record WeeklyBucket(String weekStart, long learningRecords, long tasksDone) {}

    public record RecentRecord(long taskId, String taskTitle, String note, String createdAt) {}

    public record GrowthView(
            long notesCount,
            long learningRecords,
            long findingsOpen,
            long findingsDismissed,
            List<TypeCounts> tasksByType,
            List<WeeklyBucket> weekly,
            List<RecentRecord> recentRecords) {}

    private final ProjectRepository projectRepository;
    private final JdbcClient jdbc;

    public GrowthService(ProjectRepository projectRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public GrowthView report(long projectId, long userId) {
        Project project = requireOwned(projectId, userId);
        long notes = count("select count(*) from notes where project_id = :projectId", projectId);
        long records = count("""
                select count(*) from learning_records lr
                join tasks t on t.id = lr.task_id
                where t.project_id = :projectId
                """, projectId);
        long findingsOpen = 0;
        long findingsDismissed = 0;
        Long snapshotId = project.getCurrentSnapshotId();
        if (snapshotId != null) {
            findingsOpen = jdbc.sql("""
                            select count(*) from analysis_findings
                            where snapshot_id = :snapshotId and status <> 'DISMISSED'
                            """)
                    .param("snapshotId", snapshotId)
                    .query(Long.class)
                    .single();
            findingsDismissed = jdbc.sql("""
                            select count(*) from analysis_findings
                            where snapshot_id = :snapshotId and status = 'DISMISSED'
                            """)
                    .param("snapshotId", snapshotId)
                    .query(Long.class)
                    .single();
        }
        Map<String, long[]> byType = new LinkedHashMap<>();
        for (String type : List.of("DEVELOPMENT", "LEARNING", "REVIEW", "RESEARCH", "REFACTORING")) {
            byType.put(type, new long[] {0, 0, 0, 0});
        }
        jdbc.sql("""
                        select type, status, count(*) as n
                        from tasks
                        where project_id = :projectId
                        group by type, status
                        """)
                .param("projectId", projectId)
                .query((rs, rowNum) -> {
                    long[] counts = byType.computeIfAbsent(rs.getString("type"), key -> new long[] {0, 0, 0, 0});
                    String status = rs.getString("status");
                    long n = rs.getLong("n");
                    int idx =
                            switch (status) {
                                case "OPEN" -> 0;
                                case "DONE" -> 1;
                                case "DRAFT" -> 2;
                                case "CANCELLED" -> 3;
                                default -> -1;
                            };
                    if (idx >= 0) {
                        counts[idx] = n;
                    }
                    return 0;
                })
                .list();
        List<TypeCounts> tasksByType = new ArrayList<>();
        for (Map.Entry<String, long[]> entry : byType.entrySet()) {
            long[] c = entry.getValue();
            tasksByType.add(new TypeCounts(entry.getKey(), c[0], c[1], c[2], c[3]));
        }
        Map<String, long[]> weeks = new LinkedHashMap<>();
        jdbc.sql("""
                        select date_trunc('week', lr.created_at)::date::text as week_start, count(*) as n
                        from learning_records lr
                        join tasks t on t.id = lr.task_id
                        where t.project_id = :projectId
                        group by 1
                        order by 1 desc
                        limit 12
                        """)
                .param("projectId", projectId)
                .query((rs, rowNum) -> {
                    weeks.computeIfAbsent(rs.getString("week_start"), key -> new long[] {0, 0})[0] = rs.getLong("n");
                    return 0;
                })
                .list();
        jdbc.sql("""
                        select date_trunc('week', updated_at)::date::text as week_start, count(*) as n
                        from tasks
                        where project_id = :projectId and status = 'DONE'
                        group by 1
                        order by 1 desc
                        limit 12
                        """)
                .param("projectId", projectId)
                .query((rs, rowNum) -> {
                    weeks.computeIfAbsent(rs.getString("week_start"), key -> new long[] {0, 0})[1] = rs.getLong("n");
                    return 0;
                })
                .list();
        List<WeeklyBucket> weekly = weeks.entrySet().stream()
                .sorted((a, b) -> b.getKey().compareTo(a.getKey()))
                .limit(12)
                .map(entry -> new WeeklyBucket(entry.getKey(), entry.getValue()[0], entry.getValue()[1]))
                .toList();
        List<RecentRecord> recent = jdbc.sql("""
                        select t.id as task_id, t.title, lr.note, lr.created_at::text as created_at
                        from learning_records lr
                        join tasks t on t.id = lr.task_id
                        where t.project_id = :projectId
                        order by lr.created_at desc, lr.id desc
                        limit 20
                        """)
                .param("projectId", projectId)
                .query((rs, rowNum) -> new RecentRecord(
                        rs.getLong("task_id"), rs.getString("title"), rs.getString("note"), rs.getString("created_at")))
                .list();
        return new GrowthView(notes, records, findingsOpen, findingsDismissed, tasksByType, weekly, recent);
    }

    private long count(String sql, long projectId) {
        Long n = jdbc.sql(sql).param("projectId", projectId).query(Long.class).single();
        return n == null ? 0 : n;
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }
}
