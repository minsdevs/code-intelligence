package dev.codeintelligence.job;

import dev.codeintelligence.common.AppProperties;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Last pipeline step (§4, §8.3): promotes the snapshot to READY and swaps
 * {@code projects.current_snapshot_id} in one transaction, so a failed run never replaces the
 * previous snapshot. Snapshots beyond the retention window are pruned (derived data cascades).
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
            jdbc.sql("update snapshots set status = 'READY', analyzed_at = now() where id = :id")
                    .param("id", snapshotId)
                    .update();
            jdbc.sql("update projects set current_snapshot_id = :snapshotId, updated_at = now() "
                            + "where id = :projectId")
                    .param("snapshotId", snapshotId)
                    .param("projectId", ctx.projectId())
                    .update();
            jdbc.sql("""
                            delete from snapshots
                            where project_id = :projectId
                              and id not in (select id from snapshots where project_id = :projectId
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
                            where subject_type = 'SNAPSHOT'
                              and not exists (select 1 from snapshots s where s.id = subject_id)
                            """).update();
            jdbc.sql("""
                            delete from evidences e
                            where e.project_id = :projectId
                              and not exists (select 1 from evidence_links l where l.evidence_id = e.id)
                            """).param("projectId", ctx.projectId()).update();
        });
    }
}
