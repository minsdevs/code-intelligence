package dev.codeintelligence.analysis.impact;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.analysis.coverage.CoverageReport;
import dev.codeintelligence.analysis.coverage.CoverageService;
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
    /**
     * Sum of node-type weights over unique dependents (confirmed and candidate), each node counted once however many
     * paths reach it. A size indicator of the reverse-dependency set, not a probability.
     */
    public static final String SCORE_VERSION = "unique-node-weight-v2";

    public static final String CONFIRMED_DEPENDENCY = "CONFIRMED_DEPENDENCY";
    public static final String CANDIDATE_IMPACT = "CANDIDATE_IMPACT";
    private static final int OUTSIDE_AREA_LIMIT = 20;

    /**
     * One row per dependent node. depth and edgeType come from a shortest path; confidence is the strongest verdict
     * over all paths, where a path carries its weakest edge; pathCount counts the simple paths found within depth.
     */
    public record ImpactNodeView(
            int depth,
            String edgeType,
            String nodeType,
            long nodeId,
            String name,
            String filePath,
            Integer line,
            String confidence,
            int pathCount,
            String group) {}

    /** Files whose recorded outcome leaves impact unseen. Counts are null when the snapshot was not measured. */
    public record OutsideAnalysisView(
            String measurementStatus,
            Integer excludedFiles,
            Integer excludedSubmodules,
            Integer unsupportedFiles,
            Integer failedFiles,
            Integer partialFiles,
            Integer pendingFiles,
            Integer unmeasuredFiles,
            List<OutsideAreaView> areas) {}

    public record OutsideAreaView(String status, String language, int files, String samplePath) {}

    public record ImpactView(
            long nodeId,
            int depth,
            int riskScore,
            String riskLevel,
            List<ImpactNodeView> dependents,
            long resolvedSnapshotId,
            String scoreVersion,
            OutsideAnalysisView outsideAnalysis) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final CoverageService coverageService;
    private final JdbcClient jdbc;

    public ImpactService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            CoverageService coverageService,
            JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.coverageService = coverageService;
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
                            select e.source_node_id, e.edge_type,
                                   1 as depth, array[e.target_node_id, e.source_node_id]::bigint[] as seen,
                                   case e.confidence when 'CONFIRMED' then 3 when 'LIKELY' then 2 else 1 end as path_rank
                            from graph_edges e
                            where e.snapshot_id = :snapshotId
                              and e.target_node_id = :nodeId
                            union all
                            select e.source_node_id, e.edge_type,
                                   w.depth + 1, w.seen || e.source_node_id,
                                   least(w.path_rank,
                                         case e.confidence when 'CONFIRMED' then 3 when 'LIKELY' then 2 else 1 end)
                            from graph_edges e
                            join walk w on e.target_node_id = w.source_node_id
                            where e.snapshot_id = :snapshotId
                              and w.depth < :depth
                              and not e.source_node_id = any (w.seen)
                        ),
                        per_node as (
                            select source_node_id, min(depth) as depth, max(path_rank) as path_rank,
                                   count(*) as path_count,
                                   (array_agg(edge_type order by depth, edge_type))[1] as edge_type
                            from walk
                            group by source_node_id
                        )
                        select p.depth, p.edge_type, n.node_type, n.id, n.name, f.path as file_path, n.line_start,
                               case p.path_rank when 3 then 'CONFIRMED' when 2 then 'LIKELY' else 'POSSIBLE' end
                                   as confidence,
                               p.path_count
                        from per_node p
                        join graph_nodes n on n.id = p.source_node_id and n.snapshot_id = :snapshotId
                        left join files f on f.id = n.file_id and f.snapshot_id = :snapshotId
                        order by p.depth, n.natural_key
                        """)
                .param("snapshotId", resolved)
                .param("nodeId", nodeId)
                .param("depth", resolvedDepth)
                .query((rs, rowNum) -> {
                    String confidence = rs.getString("confidence");
                    return new ImpactNodeView(
                            rs.getInt("depth"),
                            rs.getString("edge_type"),
                            rs.getString("node_type"),
                            rs.getLong("id"),
                            rs.getString("name"),
                            rs.getString("file_path"),
                            (Integer) rs.getObject("line_start"),
                            confidence,
                            rs.getInt("path_count"),
                            "CONFIRMED".equals(confidence) ? CONFIRMED_DEPENDENCY : CANDIDATE_IMPACT);
                })
                .list();
        // Rows are unique per node, so a second path to a dependent cannot raise the score.
        int score = 0;
        for (ImpactNodeView dependent : dependents) {
            score += weight(dependent.nodeType());
        }
        String level = score >= 20 ? "HIGH" : score >= 8 ? "MEDIUM" : "LOW";
        return new ImpactView(
                nodeId, resolvedDepth, score, level, dependents, resolved, SCORE_VERSION, outsideAnalysis(resolved));
    }

    private OutsideAnalysisView outsideAnalysis(long snapshotId) {
        CoverageReport.OutcomeSummary outcomes = coverageService.outcomes(snapshotId);
        if (outcomes == null) {
            return new OutsideAnalysisView(
                    CoverageReport.LEGACY_UNMEASURED, null, null, null, null, null, null, null, List.of());
        }
        List<OutsideAreaView> areas = jdbc.sql("""
                        select analysis_status, language, count(*) as files, min(path) as sample_path
                        from files
                        where snapshot_id = :snapshotId
                          and analysis_status in ('UNSUPPORTED', 'FAILED', 'PARTIAL', 'TARGETED', 'UNMEASURED')
                        group by analysis_status, language
                        order by case analysis_status
                                     when 'UNSUPPORTED' then 0 when 'FAILED' then 1 when 'PARTIAL' then 2
                                     when 'TARGETED' then 3 else 4 end,
                                 count(*) desc, language
                        limit :limit
                        """)
                .param("snapshotId", snapshotId)
                .param("limit", OUTSIDE_AREA_LIMIT)
                .query((rs, rowNum) -> new OutsideAreaView(
                        rs.getString("analysis_status"),
                        rs.getString("language"),
                        rs.getInt("files"),
                        rs.getString("sample_path")))
                .list();
        return new OutsideAnalysisView(
                "PER_FILE_RECORDED",
                outcomes.excludedFiles(),
                outcomes.excludedSubmodules(),
                outcomes.unsupportedFiles(),
                outcomes.failedFiles(),
                outcomes.partialFiles(),
                outcomes.pendingFiles(),
                outcomes.unmeasuredFiles(),
                areas);
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
