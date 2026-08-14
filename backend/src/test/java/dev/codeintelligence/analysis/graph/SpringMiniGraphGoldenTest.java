package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.job.FinalizeStep;
import dev.codeintelligence.testsupport.FixtureRepo;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.FileSystemUtils;

@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import(TestcontainersConfiguration.class)
class SpringMiniGraphGoldenTest {

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void isolatedDataDir(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    private FileInventoryStep fileInventoryStep;

    @Autowired
    private SourceParsingStep sourceParsingStep;

    @Autowired
    private GraphBuildStep graphBuildStep;

    @Autowired
    private FinalizeStep finalizeStep;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void springMiniGoldenNodeKeysAndStructuralEdges() throws Exception {
        Run run = analyze("spring-mini");
        try {
            Map<String, Integer> counts = jdbcTemplate.queryForList("""
                            select node_type, count(*) as cnt from graph_nodes
                            where snapshot_id = ? group by node_type
                            """, run.snapshotId()).stream()
                    .collect(Collectors.toMap(
                            row -> (String) row.get("node_type"), row -> ((Number) row.get("cnt")).intValue()));
            assertThat(keys(run.snapshotId(), "CLASS")).containsExactlyInAnyOrderElementsOf(expectedClasses());
            assertThat(keys(run.snapshotId(), "INTERFACE")).contains("java:com.example.todo.repository.TodoRepository");
            assertThat(keys(run.snapshotId(), "PACKAGE")).containsExactlyInAnyOrderElementsOf(expectedPackages());
            assertThat(counts.get("FILE")).isEqualTo(13);
            assertThat(counts.get("CLASS")).isEqualTo(7);
            assertThat(counts.get("METHOD")).isEqualTo(24);
            assertThat(counts.get("PACKAGE")).isEqualTo(5);
            assertThat(callPairs(run.snapshotId(), "CONFIRMED")).hasSize(5);
            assertThat(callPairs(run.snapshotId(), "POSSIBLE")).hasSize(3);
            assertThat(keys(run.snapshotId(), "METHOD"))
                    .contains(
                            "java:com.example.todo.api.TodoController#list()",
                            "java:com.example.todo.service.TodoService#findAll()",
                            "java:com.example.todo.repository.TodoRepository#findAll()");

            Set<String> extendsEdges = edgePairs(run.snapshotId(), "EXTENDS");
            assertThat(extendsEdges)
                    .contains("java:com.example.todo.repository.TodoRepository"
                            + "->java:org.springframework.data.jpa.repository.JpaRepository");

            Set<String> confirmed = callPairs(run.snapshotId(), "CONFIRMED");
            Set<String> possible = callPairs(run.snapshotId(), "POSSIBLE");
            assertThat(confirmed)
                    .contains(
                            "java:com.example.todo.api.TodoController#list()"
                                    + "->java:com.example.todo.service.TodoService#findAll()",
                            "java:com.example.todo.api.TodoController#get(java.lang.Long)"
                                    + "->java:com.example.todo.service.TodoService#findById(java.lang.Long)",
                            "java:com.example.todo.api.TodoController#create(com.example.todo.domain.Todo)"
                                    + "->java:com.example.todo.service.TodoService#create(com.example.todo.domain.Todo)",
                            "java:com.example.todo.api.AuthController#login()"
                                    + "->java:com.example.todo.service.AuthService#login()",
                            "java:com.example.todo.api.AuthController#logout()"
                                    + "->java:com.example.todo.service.AuthService#logout()");
            assertThat(possible)
                    .contains(
                            "java:com.example.todo.service.TodoService#findAll()"
                                    + "->java:com.example.todo.repository.TodoRepository#findAll()",
                            "java:com.example.todo.service.TodoService#findById(java.lang.Long)"
                                    + "->java:com.example.todo.repository.TodoRepository#findById(java.lang.Long)",
                            "java:com.example.todo.service.TodoService#create(com.example.todo.domain.Todo)"
                                    + "->java:com.example.todo.repository.TodoRepository#save(com.example.todo.domain.Todo)");

            Integer testingFiles = jdbcTemplate.queryForObject("""
                    select count(*) from graph_nodes
                    where snapshot_id = ? and node_type = 'FILE' and area_type = 'TESTING'
                    """, Integer.class, run.snapshotId());
            assertThat(testingFiles).isGreaterThanOrEqualTo(1);
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void rerunOnSameSnapshotDoesNotDuplicate() throws Exception {
        Run run = analyze("spring-mini");
        try {
            int nodes = count(run.snapshotId(), "graph_nodes");
            int edges = count(run.snapshotId(), "graph_edges");
            TestJobContext ctx = new TestJobContext(2, run.projectId(), run.snapshotId(), run.clonePath());
            sourceParsingStep.run(ctx);
            graphBuildStep.run(ctx);
            assertThat(count(run.snapshotId(), "graph_nodes")).isEqualTo(nodes);
            assertThat(count(run.snapshotId(), "graph_edges")).isEqualTo(edges);
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void syntaxErrorFileIsIsolatedAndStepSucceeds() throws Exception {
        Run run = analyze("spring-mini");
        try {
            Path broken = run.clonePath().resolve("src/main/java/com/example/todo/Broken.java");
            Files.writeString(broken, "package com.example.todo;\npublic class Broken { this is not java\n");
            jdbcTemplate.update("""
                    insert into files (snapshot_id, path, language, size, line_count, content_hash)
                    values (?, 'src/main/java/com/example/todo/Broken.java', 'java', 64, 2, 'broken')
                    """, run.snapshotId());
            TestJobContext ctx = new TestJobContext(2, run.projectId(), run.snapshotId(), run.clonePath());
            sourceParsingStep.run(ctx);
            assertThat(keys(run.snapshotId(), "CLASS")).contains("java:com.example.todo.api.TodoController");
            assertThat(keys(run.snapshotId(), "CLASS")).doesNotContain("java:com.example.todo.Broken");
            Integer failures = jdbcTemplate.queryForObject("""
                    select count(*) from evidences e
                    join evidence_links l on l.evidence_id = e.id
                    where l.subject_type = 'SOURCE_PARSING' and l.subject_id = ?
                      and e.file_path like '%Broken.java%'
                    """, Integer.class, run.snapshotId());
            assertThat(failures).isEqualTo(1);
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    private Run analyze(String fixture) throws Exception {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                fixture + "-" + System.nanoTime());
        long projectId =
                jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, ?, 'acme', ?) returning id
                """, Long.class, userId, fixture, fixture + "-" + System.nanoTime());
        Path clone = FixtureRepo.create(fixture, dataDir.resolve("repos").resolve(String.valueOf(projectId)));
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, projectId);
        TestJobContext ctx = new TestJobContext(1, projectId, snapshotId, clone);
        fileInventoryStep.run(ctx);
        sourceParsingStep.run(ctx);
        graphBuildStep.run(ctx);
        finalizeStep.run(ctx);
        return new Run(projectId, snapshotId, clone);
    }

    private Set<String> keys(long snapshotId, String nodeType) {
        return jdbcTemplate.queryForList("""
                        select natural_key from graph_nodes where snapshot_id = ? and node_type = ?
                        """, snapshotId, nodeType).stream()
                .map(row -> (String) row.get("natural_key"))
                .collect(Collectors.toSet());
    }

    private Set<String> edgePairs(long snapshotId, String edgeType) {
        return jdbcTemplate.queryForList("""
                        select s.natural_key as src, t.natural_key as tgt
                        from graph_edges e
                        join graph_nodes s on s.id = e.source_node_id
                        join graph_nodes t on t.id = e.target_node_id
                        where e.snapshot_id = ? and e.edge_type = ?
                        """, snapshotId, edgeType).stream()
                .map(row -> row.get("src") + "->" + row.get("tgt"))
                .collect(Collectors.toSet());
    }

    private Set<String> callPairs(long snapshotId, String confidence) {
        return jdbcTemplate.queryForList("""
                        select s.natural_key as src, t.natural_key as tgt
                        from graph_edges e
                        join graph_nodes s on s.id = e.source_node_id
                        join graph_nodes t on t.id = e.target_node_id
                        where e.snapshot_id = ? and e.edge_type = 'CALLS' and e.confidence = ?
                        """, snapshotId, confidence).stream()
                .map(row -> row.get("src") + "->" + row.get("tgt"))
                .collect(Collectors.toSet());
    }

    private int count(long snapshotId, String table) {
        Integer value = jdbcTemplate.queryForObject(
                "select count(*) from " + table + " where snapshot_id = ?", Integer.class, snapshotId);
        return value == null ? 0 : value;
    }

    private static Set<String> expectedClasses() {
        return Set.of(
                "java:com.example.todo.TodoApplication",
                "java:com.example.todo.TodoServiceTest",
                "java:com.example.todo.api.AuthController",
                "java:com.example.todo.api.TodoController",
                "java:com.example.todo.domain.Todo",
                "java:com.example.todo.service.AuthService",
                "java:com.example.todo.service.TodoService");
    }

    private static Set<String> expectedPackages() {
        return Set.of(
                "java:com.example.todo",
                "java:com.example.todo.api",
                "java:com.example.todo.domain",
                "java:com.example.todo.repository",
                "java:com.example.todo.service");
    }

    private record Run(long projectId, long snapshotId, Path clonePath) {}
}
