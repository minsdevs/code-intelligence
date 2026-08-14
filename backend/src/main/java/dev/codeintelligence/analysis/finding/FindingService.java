package dev.codeintelligence.analysis.finding;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FindingService {

    public record FindingEvidenceView(String filePath, Integer lineStart, Integer lineEnd, String excerpt) {}

    public record FindingView(
            long id,
            String areaType,
            String category,
            String severity,
            String title,
            String detail,
            String status,
            Long nodeId,
            List<FindingEvidenceView> evidences) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;

    public FindingService(ProjectRepository projectRepository, SnapshotRepository snapshotRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<FindingView> list(long projectId, long userId, Long snapshotId, String severity) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        List<FindingView> findings = jdbc.sql("""
                        select id, area_type, category, severity, title, detail, status, node_id
                        from analysis_findings
                        where snapshot_id = :snapshotId
                          and (:severity::text is null or severity = :severity)
                        order by
                            case severity when 'CRITICAL' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end,
                            id
                        """)
                .param("snapshotId", resolved)
                .param("severity", blankToNull(severity))
                .query((rs, rowNum) -> new FindingView(
                        rs.getLong("id"),
                        rs.getString("area_type"),
                        rs.getString("category"),
                        rs.getString("severity"),
                        rs.getString("title"),
                        rs.getString("detail"),
                        rs.getString("status"),
                        (Long) rs.getObject("node_id"),
                        List.of()))
                .list();
        return findings.stream()
                .map(finding -> new FindingView(
                        finding.id(),
                        finding.areaType(),
                        finding.category(),
                        finding.severity(),
                        finding.title(),
                        finding.detail(),
                        finding.status(),
                        finding.nodeId(),
                        evidences(finding.id())))
                .toList();
    }

    private List<FindingEvidenceView> evidences(long findingId) {
        return jdbc.sql("""
                        select e.file_path, e.line_start, e.line_end, e.excerpt
                        from evidence_links l
                        join evidences e on e.id = l.evidence_id
                        where l.subject_type = 'FINDING' and l.subject_id = :findingId
                        order by e.id
                        """)
                .param("findingId", findingId)
                .query((rs, rowNum) -> new FindingEvidenceView(
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        (Integer) rs.getObject("line_end"),
                        rs.getString("excerpt")))
                .list();
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

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
