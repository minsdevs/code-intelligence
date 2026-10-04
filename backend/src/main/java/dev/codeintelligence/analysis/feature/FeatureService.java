package dev.codeintelligence.analysis.feature;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FeatureService {

    public record FeatureChildView(
            long id, String name, String detection, double confidence, List<FeatureChildView> children) {}

    public record FeatureLinkView(String role, long nodeId, String name, String filePath) {}

    public record FeatureEvidenceView(
            String filePath,
            Integer lineStart,
            Integer lineEnd,
            String excerpt,
            long evidenceId,
            long snapshotId,
            String sourceState) {}

    public record FeatureDetailView(
            long id,
            String name,
            String detection,
            double confidence,
            List<FeatureLinkView> links,
            List<FeatureEvidenceView> evidences,
            long resolvedSnapshotId) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;

    public FeatureService(ProjectRepository projectRepository, SnapshotRepository snapshotRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<FeatureChildView> list(long projectId, long userId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        List<FeatureRow> rows = jdbc.sql("""
                        select id, name, detection, confidence, parent_id
                        from features
                        where snapshot_id = :snapshotId
                        order by name
                        """)
                .param("snapshotId", resolved)
                .query((rs, rowNum) -> new FeatureRow(
                        rs.getLong("id"),
                        rs.getString("name"),
                        rs.getString("detection"),
                        rs.getDouble("confidence"),
                        (Long) rs.getObject("parent_id")))
                .list();
        Map<Long, List<FeatureRow>> byParent = new LinkedHashMap<>();
        List<FeatureRow> roots = new ArrayList<>();
        for (FeatureRow row : rows) {
            if (row.parentId() == null) {
                roots.add(row);
            } else {
                byParent.computeIfAbsent(row.parentId(), key -> new ArrayList<>())
                        .add(row);
            }
        }
        return roots.stream().map(row -> toTree(row, byParent)).toList();
    }

    @Transactional(readOnly = true)
    public FeatureDetailView detail(long projectId, long userId, long featureId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        FeatureRow feature = jdbc.sql("""
                        select id, name, detection, confidence, parent_id
                        from features
                        where snapshot_id = :snapshotId and id = :featureId
                        """)
                .param("snapshotId", resolved)
                .param("featureId", featureId)
                .query((rs, rowNum) -> new FeatureRow(
                        rs.getLong("id"),
                        rs.getString("name"),
                        rs.getString("detection"),
                        rs.getDouble("confidence"),
                        (Long) rs.getObject("parent_id")))
                .optional()
                .orElseThrow(FeatureNotFoundException::new);
        List<FeatureLinkView> links = jdbc.sql("""
                        select fl.role, fl.node_id, n.name, f.path as file_path
                        from feature_links fl
                        join graph_nodes n on n.id = fl.node_id and n.snapshot_id = :snapshotId and n.node_type <> 'AMBIGUOUS'
                        left join files f on f.id = n.file_id and f.snapshot_id = :snapshotId
                        where fl.feature_id = :featureId
                        order by fl.role, n.name
                        """)
                .param("featureId", feature.id())
                .param("snapshotId", resolved)
                .query((rs, rowNum) -> new FeatureLinkView(
                        rs.getString("role"), rs.getLong("node_id"), rs.getString("name"), rs.getString("file_path")))
                .list();
        List<FeatureEvidenceView> evidences = jdbc.sql("""
                        select e.id, e.file_path, e.line_start, e.line_end, e.excerpt
                        from evidence_links l
                        join evidences e on e.id = l.evidence_id
                        where l.subject_type = 'FEATURE' and l.subject_id = :featureId and e.project_id = :projectId
                        order by e.file_path, e.line_start
                        """)
                .param("featureId", feature.id())
                .param("projectId", projectId)
                .query((rs, rowNum) -> new FeatureEvidenceView(
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        (Integer) rs.getObject("line_end"),
                        rs.getString("excerpt"),
                        rs.getLong("id"),
                        resolved,
                        "LEGACY_SOURCE_UNVERIFIED"))
                .list();
        return new FeatureDetailView(
                feature.id(), feature.name(), feature.detection(), feature.confidence(), links, evidences, resolved);
    }

    private FeatureChildView toTree(FeatureRow row, Map<Long, List<FeatureRow>> byParent) {
        List<FeatureChildView> children = byParent.getOrDefault(row.id(), List.of()).stream()
                .map(child -> toTree(child, byParent))
                .toList();
        return new FeatureChildView(row.id(), row.name(), row.detection(), row.confidence(), children);
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

    private record FeatureRow(long id, String name, String detection, double confidence, Long parentId) {}
}
