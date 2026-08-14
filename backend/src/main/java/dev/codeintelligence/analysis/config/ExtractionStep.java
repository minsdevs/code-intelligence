package dev.codeintelligence.analysis.config;

import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Projects CONTAINER and CI_PIPELINE graph nodes into {@code infra_resources} (P7 EXTRACTION).
 * Endpoint/entity projection is added in P8.
 */
@Component
@Order(ExtractionStep.ORDER)
public class ExtractionStep implements JobStep {

    public static final String KEY = "EXTRACTION";
    public static final int ORDER = 800;

    private final JdbcClient jdbc;
    private final TransactionTemplate transactionTemplate;

    public ExtractionStep(JdbcClient jdbc, TransactionTemplate transactionTemplate) {
        this.jdbc = jdbc;
        this.transactionTemplate = transactionTemplate;
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
                            insert into infra_resources (snapshot_id, node_id, kind, name, source_path)
                            select n.snapshot_id,
                                   n.id,
                                   case n.node_type when 'CI_PIPELINE' then 'CI' else n.node_type end,
                                   n.name,
                                   f.path
                            from graph_nodes n
                            left join files f on f.id = n.file_id
                            where n.snapshot_id = :snapshotId
                              and n.node_type in ('CONTAINER', 'CI_PIPELINE')
                            on conflict (node_id) do update set
                                kind = excluded.kind,
                                name = excluded.name,
                                source_path = excluded.source_path
                            """).param("snapshotId", snapshotId).update();
            jdbc.sql("""
                            delete from infra_resources ir
                            where ir.snapshot_id = :snapshotId
                              and not exists (
                                  select 1 from graph_nodes n
                                  where n.id = ir.node_id
                                    and n.node_type in ('CONTAINER', 'CI_PIPELINE')
                              )
                            """).param("snapshotId", snapshotId).update();
        });
        ctx.updateProgress(100);
    }
}
