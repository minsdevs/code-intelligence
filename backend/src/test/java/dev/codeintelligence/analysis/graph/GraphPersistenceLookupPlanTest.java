package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;

/**
 * G-PERF medium/large GRAPH_BUILD: the candidate lookup of {@link GraphPersistenceService#persist}
 * ran 6.5 s per 500-key batch on the large workload. SOURCE_PARSING's own lookups ran while the
 * snapshot was empty, the server-prepared statement switched to a generic plan built for that
 * empty table (bitmap scan of the whole snapshot, every row compared with 500 parameters), and
 * GRAPH_BUILD reused it on the same pooled connection after the snapshot was filled. Captured with
 * auto_explain on this test's connection: {@code Bitmap Index Scan on idx_graph_nodes_snapshot_area
 * (rows=2) Index Cond: (snapshot_id = $1)}, Filter {@code natural_key = ANY (ARRAY[$2 … $501])},
 * 600 ms per execution here.
 */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import(TestcontainersConfiguration.class)
class GraphPersistenceLookupPlanTest {

    private static final int SOURCE_NODES = 60_000;
    private static final int GRAPH_NODES = 20_000;
    private static final long STEP_BUDGET_MS = 8_000;

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
    void graphBuildLookupStaysFastAfterSourceParsingFilledTheSnapshot() {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "lookup-plan-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'lookup-plan', 'acme', ?) returning id
                """, Long.class, userId, "lookup-plan-" + System.nanoTime());
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, projectId);
        jdbcTemplate.update("""
                insert into files (snapshot_id, path, size, content_hash)
                select ?, 'src/p' || (i % 50) || '/F' || i || '.java', 100, md5(i::text)
                from generate_series(0, ?) i
                """, snapshotId, GRAPH_NODES - 1);

        List<GraphNodeDraft> source = new ArrayList<>();
        for (int i = 0; i < SOURCE_NODES; i++) {
            int file = i % GRAPH_NODES;
            source.add(GraphNodeDraft.of(
                    GraphNodeType.METHOD,
                    "java:demo.p" + (file % 50) + ".F" + file + "#m" + i,
                    "m" + i,
                    "src/p" + (file % 50) + "/F" + file + ".java",
                    i + 1,
                    i + 2));
        }
        // SOURCE_PARSING: one result for the whole snapshot, looked up while it is still empty.
        persistence.persist(projectId, snapshotId, new AnalysisResult(source, List.of(), List.of()));

        // GRAPH_BUILD: new keys looked up in the filled snapshot.
        List<GraphNodeDraft> files = new ArrayList<>();
        for (int i = 0; i < GRAPH_NODES; i++) {
            String path = "src/p" + (i % 50) + "/F" + i + ".java";
            files.add(GraphNodeDraft.of(GraphNodeType.FILE, "file:" + path, "F" + i + ".java", path, 1, 10));
        }
        long started = System.nanoTime();
        persistence.persist(projectId, snapshotId, new AnalysisResult(files, List.of(), List.of()));
        long elapsedMs = (System.nanoTime() - started) / 1_000_000;

        // About 25 s with the generic plan (40 lookups of 600 ms), about 1 s with custom plans.
        assertThat(elapsedMs).isLessThan(STEP_BUDGET_MS);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from graph_nodes where snapshot_id = ? and file_id is not null",
                        Integer.class,
                        snapshotId))
                .isEqualTo(SOURCE_NODES + GRAPH_NODES);
    }

    @Autowired
    private GraphBuildStep graphBuild;

    @Test
    @Transactional
    void graphBuildLinksOnlyCanonicalFilesToTypesInTheCurrentSnapshot() {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "contains-plan-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'contains-plan', 'acme', ?) returning id
                """, Long.class, userId, "contains-plan-" + System.nanoTime());
        long previous = seedContainsSnapshot(projectId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true);
        // Same paths in an older snapshot must not supply or receive these links.
        long snapshotId = seedContainsSnapshot(projectId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", false);

        graphBuild.run(new TestJobContext(0, projectId, snapshotId, dataDir));

        assertThat(jdbcTemplate.queryForObject("""
                select count(*) from graph_edges e
                join graph_nodes source on source.id = e.source_node_id
                where e.snapshot_id = ? and e.edge_type = 'CONTAINS' and source.node_type = 'FILE'
                """, Integer.class, snapshotId)).isEqualTo(20);
        assertThat(jdbcTemplate.queryForObject("""
                select count(*) from graph_edges e
                join graph_nodes source on source.id = e.source_node_id
                join graph_nodes target on target.id = e.target_node_id
                join files f on f.id = target.file_id
                where e.snapshot_id = ? and e.edge_type = 'CONTAINS' and source.node_type = 'FILE'
                  and (source.file_id is distinct from target.file_id
                       or source.natural_key is distinct from 'file:' || f.path
                       or target.node_type not in ('CLASS', 'DB_ENTITY')
                       or source.snapshot_id <> ? or target.snapshot_id <> ? or f.snapshot_id <> ?)
                """, Integer.class, snapshotId, snapshotId, snapshotId, snapshotId))
                .isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from graph_edges where snapshot_id = ?", Integer.class, previous))
                .isZero();
    }

    private long seedContainsSnapshot(long projectId, String commit, boolean includeFiles) {
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, ?, 'ANALYZING') returning id
                """, Long.class, projectId, commit);
        jdbcTemplate.update("""
                insert into files (snapshot_id, path, size, content_hash)
                select ?, 'src/p' || (i % 50) || '/F' || i || '.java', 100, md5(i::text)
                from generate_series(0, 9) i
                """, snapshotId);
        jdbcTemplate.update("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id, area_type, metadata)
                select f.snapshot_id, kind.type, kind.prefix || f.path, kind.type, f.id, 'BACKEND', '{}'::jsonb
                from files f cross join (values
                    ('CLASS', 'class:'), ('DB_ENTITY', 'entity:'), ('METHOD', 'method:')) as kind(type, prefix)
                where f.snapshot_id = ?
                """, snapshotId);
        if (includeFiles) jdbcTemplate.update("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id, metadata)
                select snapshot_id, 'FILE', 'file:' || path, path, id, '{}'::jsonb
                from files where snapshot_id = ?
                """, snapshotId);
        // Matching file_id alone must not attach types to a noncanonical FILE alias.
        jdbcTemplate.update("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id, metadata)
                select snapshot_id, 'FILE', 'alias:' || path, path, id, '{}'::jsonb
                from files where snapshot_id = ? and path = 'src/p0/F0.java'
                """, snapshotId);
        return snapshotId;
    }
}
