package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.testsupport.StatementCounter;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** Guards bounded JDBC execution calls and the graph/evidence rows they persist, not wire round trips. */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import({TestcontainersConfiguration.class, StatementCounter.class})
class GraphPersistenceRoundTripTest {

    private static final int NODES = 1200;

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
    void persistingAGraphCostsJdbcCallsPerBatchNotPerRow() {
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

        StatementCounter.EXECUTIONS.set(0);
        persistence.persist(projectId, snapshotId, new AnalysisResult(nodes, edges, evidences));
        int executions = StatementCounter.EXECUTIONS.get();

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

    @Test
    @org.springframework.transaction.annotation.Transactional
    void duplicateKeysPreserveSequentialUpdatesWithNullableColumns() {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "duplicate-graph-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'duplicates', 'acme', ?) returning id
                """, Long.class, userId, "duplicates-" + System.nanoTime());
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'ANALYZING') returning id
                """, Long.class, projectId);
        var nodes = List.of(
                new GraphNodeDraft(
                        "METHOD", "java:a", "initial", null, null, null, null, Map.of("first", 1, "state", "old")),
                new GraphNodeDraft(
                        "METHOD", "java:a", "final", null, null, null, null, Map.of("last", 2, "state", "new")),
                new GraphNodeDraft("METHOD", "java:b", "target", null, null, null, null, Map.of()));
        var edges = List.of(
                new GraphEdgeDraft("java:a", "java:b", "CALLS", "CONFIRMED", Map.of("old", true)),
                new GraphEdgeDraft("java:a", "java:b", "CALLS", "LIKELY", Map.of("latest", true)));

        persistence.persist(projectId, snapshotId, new AnalysisResult(nodes, edges, List.of()));

        assertThat(jdbcTemplate.queryForObject("""
                select count(*) from graph_nodes where snapshot_id = ?
                and file_id is null and line_start is null and line_end is null and area_type is null
                """, Integer.class, snapshotId)).isEqualTo(2);
        assertThat(jdbcTemplate.queryForObject("""
                select name = 'final' and metadata = '{"first":1,"last":2,"state":"new"}'::jsonb
                from graph_nodes where snapshot_id = ? and natural_key = 'java:a'
                """, Boolean.class, snapshotId)).isTrue();
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from graph_edges where snapshot_id = ?", Integer.class, snapshotId))
                .isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject("""
                select s.natural_key = 'java:a' and t.natural_key = 'java:b'
                  and e.confidence = 'LIKELY' and e.metadata = '{"latest":true}'::jsonb
                from graph_edges e
                join graph_nodes s on s.id = e.source_node_id
                join graph_nodes t on t.id = e.target_node_id
                where e.snapshot_id = ?
                """, Boolean.class, snapshotId)).isTrue();
    }
}
