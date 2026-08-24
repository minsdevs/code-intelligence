package dev.codeintelligence.analysis.finding;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FindingService {

    private static final Set<String> JUDGMENT_STATUSES =
            Set.of("NEEDS_REVIEW", "ACCEPTED", "FALSE_POSITIVE", "RESOLVED");
    private static final String RULE_VERSION = "1";

    public record FindingEvidenceView(String filePath, Integer lineStart, Integer lineEnd, String excerpt) {}

    public record JudgmentView(
            String status, String reason, Long judgedBy, Instant judgedAt, boolean needsReview, boolean hidden) {}

    public record FindingView(
            long id,
            String areaType,
            String category,
            String severity,
            String title,
            String detail,
            String status,
            Long nodeId,
            String stableKey,
            String ruleId,
            String ruleVersion,
            JudgmentView judgment,
            List<FindingEvidenceView> evidences) {}

    private record FindingRow(
            long id,
            String areaType,
            String category,
            String severity,
            String title,
            String detail,
            String status,
            Long nodeId,
            String nodeKey) {}

    private record StoredJudgment(
            String status,
            String reason,
            long userId,
            String ruleVersion,
            String evidenceFingerprint,
            Instant updatedAt) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;

    public FindingService(ProjectRepository projectRepository, SnapshotRepository snapshotRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<FindingView> list(
            long projectId, long userId, Long snapshotId, String severity, boolean includeHidden) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        List<FindingRow> rows = rows(resolved, severity);
        Map<String, StoredJudgment> judgments = judgments(projectId, userId);
        List<FindingView> result = new ArrayList<>();
        for (FindingRow row : rows) {
            List<FindingEvidenceView> evidences = evidences(row.id());
            String stableKey = stableKey(row);
            String fingerprint = evidenceFingerprint(evidences);
            StoredJudgment stored = judgments.get(stableKey);
            boolean stale = stored != null
                    && (!RULE_VERSION.equals(stored.ruleVersion())
                            || !fingerprint.equals(stored.evidenceFingerprint()));
            String judgmentStatus = stored == null || stale ? "NEEDS_REVIEW" : stored.status();
            boolean hidden = "FALSE_POSITIVE".equals(judgmentStatus);
            if (hidden && !includeHidden) continue;
            JudgmentView judgment = new JudgmentView(
                    judgmentStatus,
                    stored == null ? "" : stored.reason(),
                    stored == null ? null : stored.userId(),
                    stored == null ? null : stored.updatedAt(),
                    stored == null || stale || "NEEDS_REVIEW".equals(judgmentStatus),
                    hidden);
            result.add(new FindingView(
                    row.id(),
                    row.areaType(),
                    row.category(),
                    row.severity(),
                    row.title(),
                    row.detail(),
                    row.status(),
                    row.nodeId(),
                    stableKey,
                    row.category(),
                    RULE_VERSION,
                    judgment,
                    evidences));
        }
        return List.copyOf(result);
    }

    @Transactional
    public JudgmentView judge(long projectId, long userId, long findingId, String status, String reason) {
        requireOwned(projectId, userId);
        String normalized = status == null ? "" : status.trim().toUpperCase();
        if (!JUDGMENT_STATUSES.contains(normalized)) {
            throw new InvalidFindingJudgmentException("Unsupported finding judgment status.");
        }
        String normalizedReason = reason == null ? "" : reason.trim();
        if (normalizedReason.length() > 500) {
            throw new InvalidFindingJudgmentException("Finding judgment reason must be 500 characters or fewer.");
        }
        FindingRow row = row(projectId, findingId);
        List<FindingEvidenceView> evidences = evidences(row.id());
        String key = stableKey(row);
        String fingerprint = evidenceFingerprint(evidences);
        jdbc.sql("""
                        insert into finding_judgments
                            (user_id, project_id, stable_key, status, reason, rule_id, rule_version,
                             evidence_fingerprint, created_at, updated_at)
                        values (:userId, :projectId, :stableKey, :status, :reason, :ruleId, :ruleVersion,
                                :fingerprint, now(), now())
                        on conflict (user_id, project_id, stable_key) do update set
                            status = excluded.status,
                            reason = excluded.reason,
                            rule_id = excluded.rule_id,
                            rule_version = excluded.rule_version,
                            evidence_fingerprint = excluded.evidence_fingerprint,
                            updated_at = now()
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("stableKey", key)
                .param("status", normalized)
                .param("reason", normalizedReason)
                .param("ruleId", row.category())
                .param("ruleVersion", RULE_VERSION)
                .param("fingerprint", fingerprint)
                .update();
        return new JudgmentView(
                normalized,
                normalizedReason,
                userId,
                Instant.now(),
                "NEEDS_REVIEW".equals(normalized),
                "FALSE_POSITIVE".equals(normalized));
    }

    private List<FindingRow> rows(long snapshotId, String severity) {
        return jdbc.sql("""
                        select f.id, f.area_type, f.category, f.severity, f.title, f.detail, f.status, f.node_id,
                               n.natural_key as node_key
                        from analysis_findings f
                        left join graph_nodes n on n.id = f.node_id
                        where f.snapshot_id = :snapshotId
                          and (:severity::text is null or f.severity = :severity)
                        order by case f.severity
                            when 'CRITICAL' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end,
                            f.category, f.title, f.id
                        """)
                .param("snapshotId", snapshotId)
                .param("severity", blankToNull(severity))
                .query((rs, rowNum) -> mapRow(rs))
                .list();
    }

    private FindingRow row(long projectId, long findingId) {
        return jdbc.sql("""
                        select f.id, f.area_type, f.category, f.severity, f.title, f.detail, f.status, f.node_id,
                               n.natural_key as node_key
                        from analysis_findings f
                        join snapshots s on s.id = f.snapshot_id
                        left join graph_nodes n on n.id = f.node_id
                        where s.project_id = :projectId and f.id = :findingId
                        """)
                .param("projectId", projectId)
                .param("findingId", findingId)
                .query((rs, rowNum) -> mapRow(rs))
                .optional()
                .orElseThrow(SnapshotNotFoundException::new);
    }

    private static FindingRow mapRow(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new FindingRow(
                rs.getLong("id"),
                rs.getString("area_type"),
                rs.getString("category"),
                rs.getString("severity"),
                rs.getString("title"),
                rs.getString("detail"),
                rs.getString("status"),
                (Long) rs.getObject("node_id"),
                rs.getString("node_key"));
    }

    private Map<String, StoredJudgment> judgments(long projectId, long userId) {
        Map<String, StoredJudgment> result = new LinkedHashMap<>();
        jdbc.sql("""
                        select stable_key, status, reason, user_id, rule_version, evidence_fingerprint, updated_at
                        from finding_judgments
                        where project_id = :projectId and user_id = :userId
                        order by stable_key
                        """)
                .param("projectId", projectId)
                .param("userId", userId)
                .query((rs, rowNum) -> {
                    OffsetDateTime updated = rs.getObject("updated_at", OffsetDateTime.class);
                    result.put(
                            rs.getString("stable_key"),
                            new StoredJudgment(
                                    rs.getString("status"),
                                    rs.getString("reason"),
                                    rs.getLong("user_id"),
                                    rs.getString("rule_version"),
                                    rs.getString("evidence_fingerprint"),
                                    updated == null ? null : updated.toInstant()));
                    return 0;
                })
                .list();
        return result;
    }

    private List<FindingEvidenceView> evidences(long findingId) {
        return jdbc.sql("""
                        select e.file_path, e.line_start, e.line_end, e.excerpt
                        from evidence_links l join evidences e on e.id = l.evidence_id
                        where l.subject_type = 'FINDING' and l.subject_id = :findingId
                        order by e.file_path, e.line_start, e.line_end, e.id
                        """)
                .param("findingId", findingId)
                .query((rs, rowNum) -> new FindingEvidenceView(
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        (Integer) rs.getObject("line_end"),
                        rs.getString("excerpt")))
                .list();
    }

    private static String stableKey(FindingRow row) {
        String target = row.nodeKey() == null || row.nodeKey().isBlank() ? row.title() : row.nodeKey();
        return row.category() + "|" + target;
    }

    private static String evidenceFingerprint(List<FindingEvidenceView> evidences) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (FindingEvidenceView evidence : evidences) {
                String canonical = String.join(
                        "|",
                        nullToEmpty(evidence.filePath()),
                        String.valueOf(evidence.lineStart()),
                        String.valueOf(evidence.lineEnd()),
                        nullToEmpty(evidence.excerpt()));
                digest.update(canonical.getBytes(StandardCharsets.UTF_8));
                digest.update((byte) '\n');
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private long requireSnapshot(Project project, Long snapshotId) {
        Long id = snapshotId != null ? snapshotId : project.getCurrentSnapshotId();
        if (id == null) throw new SnapshotNotFoundException();
        snapshotRepository.findByIdAndProjectId(id, project.getId()).orElseThrow(SnapshotNotFoundException::new);
        return id;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
