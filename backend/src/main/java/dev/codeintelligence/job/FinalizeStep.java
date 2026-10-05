package dev.codeintelligence.job;

import dev.codeintelligence.common.AppProperties;
import java.util.Objects;
import java.util.UUID;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Last pipeline step (§4, §8.3): promotes the snapshot to READY and swaps
 * {@code projects.current_snapshot_id} in one transaction, so a failed run never replaces the
 * previous snapshot. Final publication, the FINALIZE checkpoint and terminal job success commit
 * together; a concurrent cancellation cannot publish a snapshot and then report CANCELLED.
 * Completed legacy snapshots beyond the retention window are pruned (derived data cascades);
 * failed/cancelled attempts keep their diagnostics and jobs. Retained
 * source awaits the separate pin/grace/GC protocol.
 * Uses plain SQL to keep the job package free of project-package dependencies.
 */
@Component
@Order(FinalizeStep.ORDER)
public class FinalizeStep implements JobStep {

    public static final String KEY = "FINALIZE";
    public static final int ORDER = 10_000;

    private final JdbcClient jdbc;
    private final TransactionTemplate transactionTemplate;
    private final AppProperties appProperties;

    public FinalizeStep(JdbcClient jdbc, TransactionTemplate transactionTemplate, AppProperties appProperties) {
        this.jdbc = jdbc;
        this.transactionTemplate = transactionTemplate;
        this.appProperties = appProperties;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        transactionTemplate.executeWithoutResult(tx -> {
            UUID currentGeneration = jdbc.sql("select current_generation_id from projects where id=:project for update")
                    .param("project", ctx.projectId())
                    .query((rs, row) -> new Current(rs.getObject("current_generation_id", UUID.class)))
                    .optional()
                    .orElseThrow(FinalizeStep::invalid)
                    .generation();
            String jobStatus = jdbc.sql("select status from analysis_jobs where id=:job and project_id=:project "
                            + "and snapshot_id=:snapshot for update")
                    .param("job", ctx.jobId())
                    .param("project", ctx.projectId())
                    .param("snapshot", snapshotId)
                    .query(String.class)
                    .optional()
                    .orElseThrow(FinalizeStep::invalid);
            if (!"RUNNING".equals(jobStatus)) throw invalid();
            int sourceVersion = jdbc.sql("select source_contract_version from snapshots where id=:snapshot "
                            + "and project_id=:project for update")
                    .param("snapshot", snapshotId)
                    .param("project", ctx.projectId())
                    .query(Integer.class)
                    .optional()
                    .orElseThrow(FinalizeStep::invalid);
            UUID generationId = null;
            if (sourceVersion == 1) {
                Generation generation = jdbc.sql("select g.id,g.status,g.previous_committed_generation_id "
                                + "from analysis_generations g join source_manifests m "
                                + "on m.id=g.source_manifest_id and m.snapshot_id=g.snapshot_id and m.project_id=g.project_id "
                                + "where g.project_id=:project and g.snapshot_id=:snapshot and g.job_id=:job "
                                + "and m.job_id=:job and m.sealed_at is not null for update of g")
                        .param("project", ctx.projectId())
                        .param("snapshot", snapshotId)
                        .param("job", ctx.jobId())
                        .query((rs, row) -> new Generation(
                                rs.getObject("id", UUID.class),
                                rs.getString("status"),
                                rs.getObject("previous_committed_generation_id", UUID.class)))
                        .optional()
                        .orElseThrow(FinalizeStep::invalid);
                boolean alreadyCurrent = generation.id().equals(currentGeneration);
                if (!"STAGING".equals(generation.status())
                        && !("COMMITTED".equals(generation.status()) && alreadyCurrent)) throw invalid();
                if (!alreadyCurrent && !Objects.equals(generation.previous(), currentGeneration)) throw invalid();
                generationId = generation.id();
                if (!"COMMITTED".equals(generation.status())) {
                    requireOne(jdbc.sql(
                                    "update analysis_generations set status='COMMITTED', committed_at=clock_timestamp() "
                                            + "where id=:id and status='STAGING'")
                            .param("id", generationId)
                            .update());
                }
            }
            requireOne(jdbc.sql(
                            "update snapshots set status = 'READY', analyzed_at = now() where id = :id and project_id=:project")
                    .param("id", snapshotId)
                    .param("project", ctx.projectId())
                    .update());
            requireOne(jdbc.sql("update projects set current_snapshot_id = :snapshotId, updated_at = now(), "
                            + "current_generation_id = :generation where id = :projectId")
                    .param("snapshotId", snapshotId)
                    .param("projectId", ctx.projectId())
                    .param("generation", generationId)
                    .update());
            requireOne(jdbc.sql(
                            "update analysis_job_steps set status='DONE', progress_pct=100, finished_at=clock_timestamp() "
                                    + "where job_id=:job and step_key=:key and status='RUNNING'")
                    .param("job", ctx.jobId())
                    .param("key", KEY)
                    .update());
            requireOne(jdbc.sql(
                            "update analysis_jobs set status='DONE', finished_at=clock_timestamp(), updated_at=clock_timestamp() "
                                    + "where id=:job and project_id=:project and snapshot_id=:snapshot and status='RUNNING'")
                    .param("job", ctx.jobId())
                    .param("project", ctx.projectId())
                    .param("snapshot", snapshotId)
                    .update());
            jdbc.sql("""
                            delete from snapshots
                            where project_id = :projectId
                              and source_contract_version = 0
                              and status = 'READY'
                              and id not in (select id from snapshots where project_id = :projectId
                                             and status = 'READY'
                                             order by id desc limit :keep)
                            """)
                    .param("projectId", ctx.projectId())
                    .param("keep", appProperties.snapshotRetention())
                    .update();
            jdbc.sql("""
                            delete from evidence_links
                            where subject_type = 'PROJECT_AREA'
                              and not exists (select 1 from project_areas a where a.id = subject_id)
                            """).update();
            jdbc.sql("""
                            delete from evidence_links
                            where subject_type in ('SNAPSHOT', 'LOCAL_IMPORT')
                              and not exists (select 1 from snapshots s where s.id = subject_id)
                            """).update();
            jdbc.sql("""
                            delete from evidence_links
                            where subject_type = 'GIT_METADATA'
                              and not exists (select 1 from snapshots s where s.id = subject_id)
                            """).update();
            jdbc.sql("""
                            delete from evidence_links
                            where subject_type = 'SOURCE_PARSING'
                              and not exists (select 1 from snapshots s where s.id = subject_id)
                            """).update();
            jdbc.sql("""
                            delete from evidence_links
                            where subject_type = 'GRAPH_NODE'
                              and not exists (select 1 from graph_nodes n where n.id = subject_id)
                            """).update();
            jdbc.sql("""
                            delete from evidence_links
                            where subject_type = 'FEATURE'
                              and not exists (select 1 from features f where f.id = subject_id)
                            """).update();
            jdbc.sql("""
                            delete from evidences e
                            where e.project_id = :projectId
                              and not exists (select 1 from evidence_links l where l.evidence_id = e.id)
                            """).param("projectId", ctx.projectId()).update();
        });
    }

    private record Current(UUID generation) {}

    private record Generation(UUID id, String status, UUID previous) {}

    private static IllegalStateException invalid() {
        return new IllegalStateException("Analysis publication is no longer valid for this job.");
    }

    private static void requireOne(int count) {
        if (count != 1) throw invalid();
    }
}
