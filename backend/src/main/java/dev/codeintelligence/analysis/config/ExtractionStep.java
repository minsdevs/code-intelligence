package dev.codeintelligence.analysis.config;

import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Projects CONTAINER/CI_PIPELINE into {@code infra_resources} and API_ENDPOINT/DB_ENTITY into
 * {@code api_endpoints}/{@code db_entities} (P7+P8 EXTRACTION).
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
            projectInfra(snapshotId);
            projectEndpoints(snapshotId);
            projectEntities(snapshotId);
            projectFrontendRoutes(snapshotId);
        });
        ctx.updateProgress(100);
    }

    private void projectInfra(long snapshotId) {
        jdbc.sql("""
                        insert into infra_resources (snapshot_id, node_id, kind, name, source_path)
                        select n.snapshot_id,
                               n.id,
                               case n.node_type
                                   when 'CI_PIPELINE' then 'CI'
                                   when 'CLOUD_RESOURCE' then 'CLOUD'
                                   else n.node_type
                               end,
                               n.name,
                               f.path
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and n.node_type in ('CONTAINER', 'CI_PIPELINE', 'CLOUD_RESOURCE')
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
                                and n.node_type in ('CONTAINER', 'CI_PIPELINE', 'CLOUD_RESOURCE')
                          )
                        """).param("snapshotId", snapshotId).update();
    }

    private void projectEndpoints(long snapshotId) {
        jdbc.sql("""
                        insert into api_endpoints (snapshot_id, node_id, http_method, path, handler_key)
                        select n.snapshot_id,
                               n.id,
                               n.metadata->>'httpMethod',
                               n.metadata->>'path',
                               n.metadata->>'handlerKey'
                        from graph_nodes n
                        where n.snapshot_id = :snapshotId
                          and n.node_type = 'API_ENDPOINT'
                          and n.metadata->>'httpMethod' is not null
                          and n.metadata->>'path' is not null
                          and n.metadata->>'handlerKey' is not null
                        on conflict (node_id) do update set
                            http_method = excluded.http_method,
                            path = excluded.path,
                            handler_key = excluded.handler_key
                        """).param("snapshotId", snapshotId).update();
        jdbc.sql("""
                        delete from api_endpoints e
                        where e.snapshot_id = :snapshotId
                          and not exists (
                              select 1 from graph_nodes n
                              where n.id = e.node_id and n.node_type = 'API_ENDPOINT'
                          )
                        """).param("snapshotId", snapshotId).update();
    }

    private void projectEntities(long snapshotId) {
        jdbc.sql("""
                        insert into db_entities (snapshot_id, node_id, entity_name, table_name, source)
                        select n.snapshot_id,
                               n.id,
                               coalesce(n.metadata->>'entityName', n.name),
                               coalesce(n.metadata->>'tableName', n.name),
                               coalesce(n.metadata->>'source', 'JPA')
                        from graph_nodes n
                        where n.snapshot_id = :snapshotId
                          and n.node_type = 'DB_ENTITY'
                        on conflict (node_id) do update set
                            entity_name = excluded.entity_name,
                            table_name = excluded.table_name,
                            source = excluded.source
                        """).param("snapshotId", snapshotId).update();
        jdbc.sql("""
                        delete from db_entities e
                        where e.snapshot_id = :snapshotId
                          and not exists (
                              select 1 from graph_nodes n
                              where n.id = e.node_id and n.node_type = 'DB_ENTITY'
                          )
                        """).param("snapshotId", snapshotId).update();
    }

    private void projectFrontendRoutes(long snapshotId) {
        jdbc.sql("""
                        insert into frontend_routes (snapshot_id, node_id, path, component_key)
                        select n.snapshot_id,
                               n.id,
                               n.metadata->>'path',
                               n.metadata->>'componentKey'
                        from graph_nodes n
                        where n.snapshot_id = :snapshotId
                          and n.node_type = 'FE_ROUTE'
                          and n.metadata->>'path' is not null
                        on conflict (node_id) do update set
                            path = excluded.path,
                            component_key = excluded.component_key
                        """).param("snapshotId", snapshotId).update();
        jdbc.sql("""
                        delete from frontend_routes r
                        where r.snapshot_id = :snapshotId
                          and not exists (
                              select 1 from graph_nodes n
                              where n.id = r.node_id and n.node_type = 'FE_ROUTE'
                          )
                        """).param("snapshotId", snapshotId).update();
    }
}
