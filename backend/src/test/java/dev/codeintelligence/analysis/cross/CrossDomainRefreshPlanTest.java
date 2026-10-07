package dev.codeintelligence.analysis.cross;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * G-PERF finding 5: the 1% refresh of the small workload spent 644–663 s in CROSS_DOMAIN while the
 * first analysis took 36 ms. After the first analysis autovacuum has analyzed the graph tables, so
 * the refresh snapshot's freshly inserted rows are estimated at one row and the route query nests
 * full-snapshot index scans. The graph below mirrors the small workload's shape (about 18k nodes
 * and 31k edges per snapshot, 84 routes, 169 components).
 */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            // Bounds the pre-fix plan (minutes) so the test fails instead of hanging.
            "spring.datasource.hikari.connection-init-sql=set statement_timeout = '30s'"
        })
@Import(TestcontainersConfiguration.class)
class CrossDomainRefreshPlanTest {

    private static final long STEP_BUDGET_MS = 10_000;

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    private CrossDomainStep crossDomainStep;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void refreshSnapshotIsLinkedWithinBudgetAfterStatisticsDescribeOnlyThePreviousSnapshot() {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "refresh-plan-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'refresh-plan', 'acme', ?) returning id
                """, Long.class, userId, "refresh-plan-" + System.nanoTime());

        long first = seedSnapshot(projectId);
        TestJobContext firstJob = TestJobContext.running(jdbcTemplate, projectId, first, dataDir);
        crossDomainStep.run(firstJob);
        jdbcTemplate.update("update analysis_jobs set status = 'DONE' where id = ?", firstJob.jobId());
        // What autovacuum does between the first analysis and the refresh.
        jdbcTemplate.execute("analyze graph_nodes, graph_edges, frontend_routes, api_endpoints");

        long refresh = seedSnapshot(projectId);
        long started = System.nanoTime();
        crossDomainStep.run(TestJobContext.running(jdbcTemplate, projectId, refresh, dataDir));
        long elapsedMs = (System.nanoTime() - started) / 1_000_000;

        assertThat(elapsedMs).isLessThan(STEP_BUDGET_MS);
        assertThat(consumes(refresh)).isEqualTo(consumes(first)).isEqualTo(84 + 42);
    }

    private long seedSnapshot(long projectId) {
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, projectId);
        String s = Long.toString(snapshotId);
        // The seed's own joins would hit the same stale-statistics plan; hash joins keep it fast
        // without refreshing the statistics the step under test must cope with.
        jdbcTemplate.execute("""
                set enable_nestloop = off;
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, metadata)
                select %1$s, 'METHOD', 'm' || i, 'm' || i, jsonb_build_object('pad', repeat('a', 100))
                from generate_series(1, 18000) i;
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, metadata)
                select %1$s, 'COMPONENT', 'c' || i, 'C' || i,
                       case when i %% 2 = 0
                            then jsonb_build_object('apiCalls', jsonb_build_array(
                                    jsonb_build_object('method', 'GET', 'url', '/api/x' || i, 'lineStart', 3)))
                            else '{}'::jsonb end
                from generate_series(1, 169) i;
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, metadata)
                select %1$s, 'FE_ROUTE', 'r' || i, '/r' || i, jsonb_build_object('componentResolution', 'RESOLVED')
                from generate_series(1, 84) i;
                insert into graph_nodes (snapshot_id, node_type, natural_key, name)
                select %1$s, 'API_ENDPOINT', 'endpoint:GET:/api/x' || i, 'GET /api/x' || i
                from generate_series(2, 168, 2) i;
                insert into api_endpoints (snapshot_id, node_id, http_method, path, handler_key)
                select %1$s, id, 'GET', substr(name, 5), 'h' || id
                from graph_nodes where snapshot_id = %1$s and node_type = 'API_ENDPOINT';
                insert into frontend_routes (snapshot_id, node_id, path)
                select %1$s, id, name from graph_nodes where snapshot_id = %1$s and node_type = 'FE_ROUTE';
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence)
                select %1$s, r.id, c.id, 'CONTAINS', 'CONFIRMED'
                from graph_nodes r
                join graph_nodes c on c.snapshot_id = %1$s and c.natural_key = 'c' || substr(r.natural_key, 2)
                where r.snapshot_id = %1$s and r.node_type = 'FE_ROUTE';
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence)
                select %1$s, a.id, b.id, case when a.id %% 4 = 0 then 'CONTAINS' else 'CALLS' end, 'CONFIRMED'
                from graph_nodes a
                join graph_nodes b on b.snapshot_id = %1$s
                     and b.natural_key = 'm' || ((substr(a.natural_key, 2)::int * 7) %% 18000 + 1)
                where a.snapshot_id = %1$s and a.node_type = 'METHOD';
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence)
                select %1$s, a.id, b.id, 'DECLARES', 'CONFIRMED'
                from graph_nodes a
                join graph_nodes b on b.snapshot_id = %1$s
                     and b.natural_key = 'm' || ((substr(a.natural_key, 2)::int * 13) %% 18000 + 1)
                where a.snapshot_id = %1$s and a.node_type = 'METHOD' and substr(a.natural_key, 2)::int <= 13000;
                reset enable_nestloop;
                """.formatted(s));
        return snapshotId;
    }

    private int consumes(long snapshotId) {
        return jdbcTemplate.queryForObject(
                "select count(*) from graph_edges where snapshot_id = ? and edge_type = 'CONSUMES'",
                Integer.class,
                snapshotId);
    }
}
