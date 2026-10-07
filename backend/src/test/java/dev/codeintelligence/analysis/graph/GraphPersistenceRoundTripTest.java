package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.evidence.EvidenceKind;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * G-PERF finding 3: SOURCE_PARSING, GRAPH_BUILD and TS_PARSING persisted every node, file lookup,
 * evidence and edge with its own statement round trip (tens of thousands per small workload over
 * the desktop's TLS loopback connection). Persisting a graph must cost a bounded number of round
 * trips per batch, not per row, and store exactly the same rows.
 */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import({TestcontainersConfiguration.class, GraphPersistenceRoundTripTest.CountingDataSource.class})
class GraphPersistenceRoundTripTest {

    private static final int NODES = 1200;
    private static final AtomicInteger EXECUTIONS = new AtomicInteger();

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    private GraphPersistenceService persistence;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void persistingAGraphCostsRoundTripsPerBatchNotPerRow() {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "round-trips-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'round-trips', 'acme', ?) returning id
                """, Long.class, userId, "round-trips-" + System.nanoTime());
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, projectId);
        jdbcTemplate.update("""
                insert into files (snapshot_id, path, size, content_hash)
                select ?, 'src/F' || i || '.java', 100, md5(i::text) from generate_series(0, 99) i
                """, snapshotId);

        List<GraphNodeDraft> nodes = new ArrayList<>();
        List<GraphEdgeDraft> edges = new ArrayList<>();
        List<AnalyzerEvidence> evidences = new ArrayList<>();
        for (int i = 0; i < NODES; i++) {
            String key = "java:demo.F" + (i % 100) + "#m" + i;
            nodes.add(new GraphNodeDraft(
                    "METHOD", key, "m" + i, "src/F" + (i % 100) + ".java", i + 1, i + 2, null, Map.of("n", i)));
            evidences.add(new AnalyzerEvidence(
                    key, EvidenceKind.FILE_LINE, "src/F" + (i % 100) + ".java", i + 1, i + 2, "void m" + i + "()"));
        }
        // A duplicate draft merges metadata into the same row, exactly as consecutive upserts do.
        nodes.add(new GraphNodeDraft(
                "METHOD", "java:demo.F0#m0", "m0", "src/F0.java", 1, 2, null, Map.of("second", true)));
        for (int i = 0; i < NODES; i++) {
            edges.add(GraphEdgeDraft.of(
                    nodes.get(i).naturalKey(),
                    nodes.get((i + 1) % NODES).naturalKey(),
                    dev.codeintelligence.analysis.core.GraphEdgeType.CALLS,
                    dev.codeintelligence.analysis.core.EdgeConfidence.CONFIRMED));
            edges.add(GraphEdgeDraft.of(
                    nodes.get(i).naturalKey(),
                    nodes.get((i + 7) % NODES).naturalKey(),
                    dev.codeintelligence.analysis.core.GraphEdgeType.CALLS,
                    dev.codeintelligence.analysis.core.EdgeConfidence.LIKELY));
        }
        // An edge to a node that exists only in the database resolves through a lookup.
        jdbcTemplate.update(
                "insert into graph_nodes (snapshot_id, node_type, natural_key, name) values (?, 'CLASS', 'java:demo.Old', 'Old')",
                snapshotId);
        edges.add(GraphEdgeDraft.of(
                "java:demo.F0#m0",
                "java:demo.Old",
                dev.codeintelligence.analysis.core.GraphEdgeType.CALLS,
                dev.codeintelligence.analysis.core.EdgeConfidence.POSSIBLE));

        EXECUTIONS.set(0);
        persistence.persist(projectId, snapshotId, new AnalysisResult(nodes, edges, evidences));
        int executions = EXECUTIONS.get();

        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from graph_nodes where snapshot_id = ?", Integer.class, snapshotId))
                .isEqualTo(NODES + 1);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from graph_nodes where snapshot_id = ? and file_id is not null",
                        Integer.class,
                        snapshotId))
                .isEqualTo(NODES);
        assertThat(jdbcTemplate.queryForObject(
                        "select metadata::text from graph_nodes where snapshot_id = ? and natural_key = 'java:demo.F0#m0'",
                        String.class,
                        snapshotId))
                .contains("\"n\": 0", "\"second\": true");
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from graph_edges where snapshot_id = ?", Integer.class, snapshotId))
                .isEqualTo(2 * NODES + 1);
        assertThat(jdbcTemplate.queryForList("""
                        select e.excerpt from evidence_links l
                        join evidences e on e.id = l.evidence_id
                        join graph_nodes n on n.id = l.subject_id
                        where l.subject_type = 'GRAPH_NODE' and n.snapshot_id = ? and n.natural_key = 'java:demo.F5#m5'
                        """, String.class, snapshotId)).containsExactly("void m5()");
        assertThat(jdbcTemplate.queryForObject("""
                        select count(*) from evidence_links l join graph_nodes n on n.id = l.subject_id
                        where l.subject_type = 'GRAPH_NODE' and n.snapshot_id = ?
                        """, Integer.class, snapshotId)).isEqualTo(NODES);
        // Before batching this was about 6,000 executions (five per node plus one per edge).
        assertThat(executions).isLessThan(100);

        // Re-persisting replaces the node evidence instead of accumulating it.
        persistence.persist(projectId, snapshotId, new AnalysisResult(nodes, edges, evidences));
        assertThat(jdbcTemplate.queryForObject("""
                        select count(*) from evidence_links l join graph_nodes n on n.id = l.subject_id
                        where l.subject_type = 'GRAPH_NODE' and n.snapshot_id = ?
                        """, Integer.class, snapshotId)).isEqualTo(NODES);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from graph_edges where snapshot_id = ?", Integer.class, snapshotId))
                .isEqualTo(2 * NODES + 1);
    }

    /** Counts statement executions (one database round trip each, a batch counts once). */
    @TestConfiguration(proxyBeanMethods = false)
    static class CountingDataSource {

        private static final Set<String> EXECUTE = Set.of(
                "execute", "executeQuery", "executeUpdate", "executeLargeUpdate", "executeBatch", "executeLargeBatch");

        @Bean
        static BeanPostProcessor countingDataSourcePostProcessor() {
            return new BeanPostProcessor() {
                @Override
                public Object postProcessAfterInitialization(Object bean, String beanName) {
                    if (!(bean instanceof DataSource dataSource) || bean instanceof DelegatingDataSource) {
                        return bean;
                    }
                    return new DelegatingDataSource(dataSource) {
                        @Override
                        public Connection getConnection() throws SQLException {
                            return counting(super.getConnection());
                        }

                        @Override
                        public Connection getConnection(String username, String password) throws SQLException {
                            return counting(super.getConnection(username, password));
                        }
                    };
                }
            };
        }

        private static Connection counting(Connection connection) {
            return (Connection) Proxy.newProxyInstance(
                    Connection.class.getClassLoader(), new Class<?>[] {Connection.class}, (proxy, method, args) -> {
                        Object result = invoke(connection, method, args);
                        if (result instanceof Statement statement) {
                            Class<?> type = statement instanceof java.sql.CallableStatement
                                    ? java.sql.CallableStatement.class
                                    : statement instanceof java.sql.PreparedStatement
                                            ? java.sql.PreparedStatement.class
                                            : Statement.class;
                            return Proxy.newProxyInstance(
                                    Connection.class.getClassLoader(), new Class<?>[] {type}, (p, m, a) -> {
                                        if (EXECUTE.contains(m.getName())) EXECUTIONS.incrementAndGet();
                                        return invoke(statement, m, a);
                                    });
                        }
                        return result;
                    });
        }

        private static Object invoke(Object target, java.lang.reflect.Method method, Object[] args) throws Throwable {
            try {
                return method.invoke(target, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
        }
    }
}
