package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
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
 * G-PERF finding 7: deleting an analyzed small project (two snapshots) did not finish within 60 s.
 * Every cascaded graph node delete checked graph_edges, flows, flow steps, findings and feature
 * links through foreign keys without a leading-column index, i.e. one scan per deleted row.
 */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            // Bounds the pre-fix cascade (minutes) so the test fails instead of hanging.
            "spring.datasource.hikari.connection-init-sql=set statement_timeout = '30s'"
        })
@Import(TestcontainersConfiguration.class)
class ProjectDeleteCascadeIndexTest {

    private static final long DELETE_BUDGET_MS = 10_000;

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    private ProjectService projectService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void everyForeignKeyIntoSnapshotDataHasALeadingColumnIndex() {
        assertThat(jdbcTemplate.queryForList("""
                select c.conrelid::regclass::text || '.' || a.attname
                from pg_constraint c
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
                where c.contype = 'f'
                  and c.confrelid in ('snapshots'::regclass, 'files'::regclass,
                                      'graph_nodes'::regclass, 'graph_edges'::regclass)
                  and cardinality(c.conkey) = 1
                  and not exists (select 1 from pg_index i
                                  where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
                order by 1
                """, String.class)).isEmpty();
    }

    @Test
    void deletingAnAnalyzedProjectWithTwoSnapshotsStaysWithinBudget() {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "delete-cascade-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'delete-cascade', 'acme', ?) returning id
                """, Long.class, userId, "delete-cascade-" + System.nanoTime());
        long first = seedSnapshot(projectId);
        long second = seedSnapshot(projectId);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", second, projectId);

        long started = System.nanoTime();
        projectService.delete(projectId, userId);
        long elapsedMs = (System.nanoTime() - started) / 1_000_000;

        assertThat(elapsedMs).isLessThan(DELETE_BUDGET_MS);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from graph_nodes where snapshot_id in (?, ?)", Integer.class, first, second))
                .isZero();
    }

    /** About the small workload's graph per snapshot: 1,000 files, 18k nodes, 31k edges. */
    private long seedSnapshot(long projectId) {
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'READY') returning id
                """, Long.class, projectId);
        jdbcTemplate.execute("""
                set enable_nestloop = off;
                insert into files (snapshot_id, path, size, content_hash)
                select %1$s, 'src/f' || i || '.java', 5000, md5(i::text) from generate_series(1, 1000) i;
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id)
                select %1$s, 'METHOD', 'm' || i, 'm' || i, f.id
                from generate_series(1, 18000) i
                join files f on f.snapshot_id = %1$s and f.path = 'src/f' || (i %% 1000 + 1) || '.java';
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence)
                select %1$s, a.id, b.id, 'CALLS', 'CONFIRMED'
                from graph_nodes a
                join graph_nodes b on b.snapshot_id = %1$s
                     and b.natural_key = 'm' || ((substr(a.natural_key, 2)::int * 7) %% 18000 + 1)
                where a.snapshot_id = %1$s;
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence)
                select %1$s, a.id, b.id, 'DECLARES', 'CONFIRMED'
                from graph_nodes a
                join graph_nodes b on b.snapshot_id = %1$s
                     and b.natural_key = 'm' || ((substr(a.natural_key, 2)::int * 13) %% 18000 + 1)
                where a.snapshot_id = %1$s and substr(a.natural_key, 2)::int <= 13000;
                insert into flows (snapshot_id, name, kind, entry_node_id)
                select %1$s, 'flow' || n.id, 'BACKEND', n.id
                from graph_nodes n where n.snapshot_id = %1$s and n.id %% 50 = 0;
                insert into flow_steps (flow_id, seq, node_id, edge_id)
                select fl.id, 1, fl.entry_node_id, e.id
                from flows fl join graph_edges e on e.source_node_id = fl.entry_node_id and e.edge_type = 'CALLS'
                where fl.snapshot_id = %1$s;
                reset enable_nestloop;
                """.formatted(snapshotId));
        return snapshotId;
    }
}
