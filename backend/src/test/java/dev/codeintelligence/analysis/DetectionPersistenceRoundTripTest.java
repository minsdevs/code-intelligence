package dev.codeintelligence.analysis;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.feature.FeatureDetectionStep;
import dev.codeintelligence.analysis.flow.FlowDetectionStep;
import dev.codeintelligence.testsupport.StatementCounter;
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
 * G-PERF medium/large FEATURE_DETECTION and FLOW_DETECTION: every feature link, flow step and
 * flow evidence was its own statement round trip (about 30,000 for the medium workload, 21,173
 * flow steps alone), so both steps grew with the graph by one round trip per row. They must cost
 * a bounded number of round trips per batch and store the same rows.
 */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import({TestcontainersConfiguration.class, StatementCounter.class})
class DetectionPersistenceRoundTripTest {

    private static final int MODULES = 300;

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    private FeatureDetectionStep featureDetection;

    @Autowired
    private FlowDetectionStep flowDetection;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void featureLinksAndFlowsCostRoundTripsPerBatchNotPerRow() {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "detection-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'detection', 'acme', ?) returning id
                """, Long.class, userId, "detection-" + System.nanoTime());
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, projectId);
        seed(snapshotId);
        TestJobContext ctx = TestJobContext.running(jdbcTemplate, projectId, snapshotId, dataDir);

        StatementCounter.EXECUTIONS.set(0);
        featureDetection.run(ctx);
        int featureExecutions = StatementCounter.EXECUTIONS.get();
        StatementCounter.EXECUTIONS.set(0);
        flowDetection.run(ctx);
        int flowExecutions = StatementCounter.EXECUTIONS.get();

        // Endpoint, controller, handler and three service methods per module, all in feature "api".
        assertThat(jdbcTemplate.queryForList("""
                        select f.name || ':' || l.role || ':' || count(*)
                        from features f join feature_links l on l.feature_id = f.id
                        where f.snapshot_id = ? group by f.name, l.role order by 1
                        """, String.class, snapshotId))
                .containsExactly("api:API:" + 3 * MODULES, "api:SERVICE:" + 3 * MODULES);
        assertThat(jdbcTemplate.queryForList("""
                        select s.seq || ':' || n.natural_key || ':' || s.description
                        from flows f join flow_steps s on s.flow_id = f.id join graph_nodes n on n.id = s.node_id
                        where f.snapshot_id = ? and f.kind = 'BACKEND' and f.name = 'GET /api/items7'
                        order by s.seq
                        """, String.class, snapshotId))
                .containsExactly(
                        "1:endpoint:GET:/api/items7:GET /api/items7",
                        "2:java:m7.C:C",
                        "3:java:m7.C#get:get",
                        "4:java:m7.S#a:a",
                        "5:java:m7.S#b:b",
                        "6:java:m7.S#c:c");
        assertThat(jdbcTemplate.queryForObject("""
                        select count(*) from flows f join flow_steps s on s.flow_id = f.id where f.snapshot_id = ?
                        """, Integer.class, snapshotId)).isEqualTo(6 * MODULES);
        assertThat(jdbcTemplate.queryForList("""
                        select e.file_path || ':' || e.line_start || ':' || e.excerpt
                        from flows f join evidence_links l on l.subject_type = 'FLOW' and l.subject_id = f.id
                        join evidences e on e.id = l.evidence_id
                        where f.snapshot_id = ? and f.name in ('GET /api/items0', 'GET /api/items299')
                        order by f.name
                        """, String.class, snapshotId))
                .containsExactly(
                        "src/main/java/m0/C.java:1:BACKEND GET /api/items0",
                        "src/main/java/m299/C.java:1:BACKEND GET /api/items299");
        assertThat(jdbcTemplate.queryForObject("""
                        select count(*) from flows f join evidence_links l on l.subject_type = 'FLOW' and l.subject_id = f.id
                        where f.snapshot_id = ?
                        """, Integer.class, snapshotId)).isEqualTo(MODULES);
        // Before batching: one statement per link (1,800) and per flow step (1,800) plus four per flow.
        assertThat(featureExecutions).isLessThan(50);
        assertThat(flowExecutions).isLessThan(50);
    }

    private void seed(long snapshotId) {
        String s = Long.toString(snapshotId);
        jdbcTemplate.execute("""
                insert into files (snapshot_id, path, size, content_hash)
                select %1$s, 'src/main/java/m' || i || '/C.java', 100, md5(i::text)
                from generate_series(0, %2$s - 1) i;
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id, line_start, metadata)
                select %1$s, t.type, t.key, t.name, f.id, 1, t.metadata
                from generate_series(0, %2$s - 1) i
                join files f on f.snapshot_id = %1$s and f.path = 'src/main/java/m' || i || '/C.java'
                cross join lateral (values
                    ('API_ENDPOINT', 'endpoint:GET:/api/items' || i, 'GET /api/items' || i,
                     jsonb_build_object('handlerKey', 'java:m' || i || '.C#get')),
                    ('CLASS', 'java:m' || i || '.C', 'C', '{"layer": "CONTROLLER"}'::jsonb),
                    ('METHOD', 'java:m' || i || '.C#get', 'get', '{"layer": "CONTROLLER"}'::jsonb),
                    ('METHOD', 'java:m' || i || '.S#a', 'a', '{"layer": "SERVICE"}'::jsonb),
                    ('METHOD', 'java:m' || i || '.S#b', 'b', '{"layer": "SERVICE"}'::jsonb),
                    ('METHOD', 'java:m' || i || '.S#c', 'c', '{"layer": "SERVICE"}'::jsonb))
                    t(type, key, name, metadata);
                insert into api_endpoints (snapshot_id, node_id, http_method, path, handler_key)
                select %1$s, id, 'GET', substr(name, 5), metadata->>'handlerKey'
                from graph_nodes where snapshot_id = %1$s and node_type = 'API_ENDPOINT';
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence)
                select %1$s, a.id, b.id, e.type, 'CONFIRMED'
                from generate_series(0, %2$s - 1) i
                cross join lateral (values
                    ('.C', 'endpoint:GET:/api/items', 'EXPOSES'),
                    ('.C', '.C#get', 'DECLARES'),
                    ('.C#get', '.S#a', 'CALLS'),
                    ('.S#a', '.S#b', 'CALLS'),
                    ('.S#b', '.S#c', 'CALLS')) e(source, target, type)
                join graph_nodes a on a.snapshot_id = %1$s and a.natural_key = 'java:m' || i || e.source
                join graph_nodes b on b.snapshot_id = %1$s
                     and b.natural_key = case when e.target like 'endpoint%%' then e.target || i
                                              else 'java:m' || i || e.target end;
                """.formatted(s, MODULES));
    }
}
