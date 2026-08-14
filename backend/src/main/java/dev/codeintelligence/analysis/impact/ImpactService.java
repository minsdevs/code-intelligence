package dev.codeintelligence.analysis.impact;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.analysis.graph.GraphNodeNotFoundException;
import dev.codeintelligence.analysis.graph.InvalidGraphQueryException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.List;
import java.util.Locale;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ImpactService {

    public static final int DEFAULT_DEPTH = 5;
    public static final int MAX_DEPTH = 8;

    public record ImpactNodeView(
            int depth, String edgeType, String nodeType, long nodeId, String name, String filePath, Integer line) {}

    public record ImpactView(
            long nodeId, int depth, int riskScore, String riskLevel, List<ImpactNodeView> dependents) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;

    public ImpactService(ProjectRepository projectRepository, SnapshotRepository snapshotRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public ImpactView impact(long projectId, long userId, long nodeId, Long snapshotId, Integer depth) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        requireNode(resolved, nodeId);
        int resolvedDepth = depth == null ? DEFAULT_DEPTH : depth;
        if (resolvedDepth < 1 || resolvedDepth > MAX_DEPTH) {
            throw new InvalidGraphQueryException("depth must be between 1 and " + MAX_DEPTH + ".");
        }
        List<ImpactNodeView> dependents = jdbc.sql("""
                        with recursive walk as (
                            select e.source_node_id, e.target_node_id, e.edge_type,
                                   1 as depth, array[e.target_node_id, e.source_node_id]::bigint[] as seen
                            from graph_edges e
                            where e.snapshot_id = :snapshotId
                              and e.target_node_id = :nodeId
                            union all
                            select e.source_node_id, e.target_node_id, e.edge_type,
                                   w.depth + 1, w.seen || e.source_node_id
                            from graph_edges e
                            join walk w on e.target_node_id = w.source_node_id
                            where e.snapshot_id = :snapshotId
                              and w.depth < :depth
                              and not e.source_node_id = any (w.seen)
                        )
                        select w.depth, w.edge_type, n.node_type, n.id, n.name, f.path as file_path, n.line_start
                        from walk w
                        join graph_nodes n on n.id = w.source_node_id
                        left join files f on f.id = n.file_id
                        order by w.depth, n.natural_key
                        """)
                .param("snapshotId", resolved)
                .param("nodeId", nodeId)
                .param("depth", resolvedDepth)
                .query((rs, rowNum) -> new ImpactNodeView(
                        rs.getInt("depth"),
                        rs.getString("edge_type"),
                        rs.getString("node_type"),
                        rs.getLong("id"),
                        rs.getString("name"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start")))
                .list();
        int score = 0;
        for (ImpactNodeView dependent : dependents) {
            score += weight(dependent.nodeType());
        }
        String level = score >= 20 ? "HIGH" : score >= 8 ? "MEDIUM" : "LOW";
        return new ImpactView(nodeId, resolvedDepth, score, level, dependents);
    }

    private static int weight(String nodeType) {
        if (nodeType == null) {
            return 1;
        }
        return switch (nodeType.toUpperCase(Locale.ROOT)) {
            case "API_ENDPOINT", "FE_ROUTE" -> 4;
            case "COMPONENT", "CLASS" -> 2;
            default -> 1;
        };
    }

    private void requireNode(long snapshotId, long nodeId) {
        Boolean exists = jdbc.sql("""
                        select exists(select 1 from graph_nodes where snapshot_id = :snapshotId and id = :nodeId)
                        """)
                .param("snapshotId", snapshotId)
                .param("nodeId", nodeId)
                .query(Boolean.class)
                .single();
        if (!Boolean.TRUE.equals(exists)) {
            throw new GraphNodeNotFoundException();
        }
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
