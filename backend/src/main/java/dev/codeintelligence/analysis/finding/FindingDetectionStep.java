package dev.codeintelligence.analysis.finding;

import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.util.List;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
@Order(FindingDetectionStep.ORDER)
public class FindingDetectionStep implements JobStep {

    public static final String KEY = "FINDING_DETECTION";
    public static final int ORDER = 940;

    private final JdbcClient jdbc;
    private final TransactionTemplate transactionTemplate;
    private final EvidenceService evidenceService;

    public FindingDetectionStep(
            JdbcClient jdbc, TransactionTemplate transactionTemplate, EvidenceService evidenceService) {
        this.jdbc = jdbc;
        this.transactionTemplate = transactionTemplate;
        this.evidenceService = evidenceService;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        ctx.updateProgress(20);
        transactionTemplate.executeWithoutResult(tx -> {
            jdbc.sql("""
                            delete from evidences e
                            where e.id in (
                                select el.evidence_id from evidence_links el
                                join analysis_findings f on f.id = el.subject_id
                                where el.subject_type = 'FINDING' and f.snapshot_id = :snapshotId
                            )
                            """).param("snapshotId", snapshotId).update();
            jdbc.sql("delete from analysis_findings where snapshot_id = :snapshotId")
                    .param("snapshotId", snapshotId)
                    .update();
            unmatchedApiCalls(ctx.projectId(), snapshotId);
            unmappedEntities(ctx.projectId(), snapshotId);
            orphanRoutes(ctx.projectId(), snapshotId);
        });
        ctx.updateProgress(100);
    }

    private void unmatchedApiCalls(long projectId, long snapshotId) {
        jdbc.sql("""
                        select n.id, n.name, n.area_type, f.path as file_path, n.line_start
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and n.node_type in ('COMPONENT', 'HOOK')
                          and jsonb_exists(n.metadata, 'apiCalls')
                          and not exists (
                              select 1 from graph_edges e
                              where e.snapshot_id = :snapshotId
                                and e.source_node_id = n.id
                                and e.edge_type = 'CONSUMES'
                          )
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> {
                    insert(
                            projectId,
                            snapshotId,
                            rs.getString("area_type"),
                            "UNMATCHED_API_CALL",
                            "MEDIUM",
                            "API call has no backend endpoint match",
                            rs.getString("name") + " declares fetch/axios calls with no CONSUMES edge",
                            rs.getLong("id"),
                            rs.getString("file_path"),
                            (Integer) rs.getObject("line_start"));
                    return 0;
                })
                .list();
    }

    private void unmappedEntities(long projectId, long snapshotId) {
        jdbc.sql("""
                        select n.id, n.name, n.area_type, f.path as file_path, n.line_start
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and n.node_type = 'DB_ENTITY'
                          and not exists (
                              select 1 from graph_edges e
                              where e.snapshot_id = :snapshotId
                                and e.source_node_id = n.id
                                and e.edge_type = 'MAPS_TO'
                          )
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> {
                    insert(
                            projectId,
                            snapshotId,
                            rs.getString("area_type"),
                            "UNMAPPED_ENTITY",
                            "LOW",
                            "Entity has no MAPS_TO table",
                            rs.getString("name") + " is not linked to a migration table",
                            rs.getLong("id"),
                            rs.getString("file_path"),
                            (Integer) rs.getObject("line_start"));
                    return 0;
                })
                .list();
    }

    private void orphanRoutes(long projectId, long snapshotId) {
        jdbc.sql("""
                        select n.id, n.name, n.area_type, f.path as file_path, n.line_start
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and n.node_type = 'FE_ROUTE'
                          and not exists (
                              select 1 from graph_edges e
                              join graph_nodes component on component.id = e.target_node_id
                              where e.snapshot_id = :snapshotId
                                and e.source_node_id = n.id
                                and e.edge_type = 'CONTAINS'
                                and component.node_type = 'COMPONENT'
                          )
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> {
                    insert(
                            projectId,
                            snapshotId,
                            rs.getString("area_type"),
                            "ORPHAN_ROUTE",
                            "LOW",
                            "Frontend route has no resolved component",
                            "Route " + rs.getString("name") + " has no CONTAINS edge to a component",
                            rs.getLong("id"),
                            rs.getString("file_path"),
                            (Integer) rs.getObject("line_start"));
                    return 0;
                })
                .list();
    }

    private void insert(
            long projectId,
            long snapshotId,
            String areaType,
            String category,
            String severity,
            String title,
            String detail,
            long nodeId,
            String filePath,
            Integer line) {
        long findingId = jdbc.sql("""
                        insert into analysis_findings (
                            snapshot_id, area_type, category, severity, title, detail, status, node_id)
                        values (
                            :snapshotId, :areaType, :category, :severity, :title, :detail, 'OPEN', :nodeId)
                        returning id
                        """)
                .param("snapshotId", snapshotId)
                .param("areaType", areaType)
                .param("category", category)
                .param("severity", severity)
                .param("title", title)
                .param("detail", detail)
                .param("nodeId", nodeId)
                .query(Long.class)
                .single();
        if (filePath != null) {
            evidenceService.replaceLinked(
                    projectId,
                    EvidenceSubjects.FINDING,
                    findingId,
                    List.of(new NewEvidence(EvidenceKind.FILE_LINE, filePath, line, line, title)));
        }
    }
}
