package dev.codeintelligence.analysis.config;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.graph.GraphBuildStep;
import dev.codeintelligence.analysis.graph.SourceParsingStep;
import dev.codeintelligence.job.FinalizeStep;
import dev.codeintelligence.testsupport.FixtureRepo;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Files;
import java.nio.file.Path;
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
class ConfigAnalyzersGoldenTest {

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
    private ExtractionStep extractionStep;

    @Autowired
    private FinalizeStep finalizeStep;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void springMiniHasOneTableAndTwoMigrations() throws Exception {
        Run run = analyze("spring-mini");
        try {
            assertThat(keys(run.snapshotId(), "DB_TABLE")).containsExactly("table:todos");
            assertThat(keys(run.snapshotId(), "MIGRATION")).hasSize(2);
            assertThat(countType(run.snapshotId(), "DB_TABLE")).isEqualTo(1);
            assertThat(countType(run.snapshotId(), "MIGRATION")).isEqualTo(2);
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void fullstackMiniHasThreeContainersDeployedInAndOnePipeline() throws Exception {
        Run run = analyze("fullstack-mini");
        try {
            assertThat(keys(run.snapshotId(), "CONTAINER"))
                    .containsExactlyInAnyOrder("container:postgres", "container:backend", "container:frontend");
            assertThat(countType(run.snapshotId(), "CONTAINER")).isEqualTo(3);
            assertThat(countType(run.snapshotId(), "CI_PIPELINE")).isEqualTo(1);
            assertThat(keys(run.snapshotId(), "CI_PIPELINE")).contains("ci:ci.yml:build");
            assertThat(edgePairs(run.snapshotId(), "DEPLOYED_IN")).contains("container:backend->container:postgres");
            assertThat(infraKinds(run.snapshotId()))
                    .containsExactlyInAnyOrder(
                            "CONTAINER:backend", "CONTAINER:frontend", "CONTAINER:postgres", "CI:build");
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void infraMiniHasTwoContainersAndOnePipelineWithDockerfileEvidence() throws Exception {
        Run run = analyze("infra-mini");
        try {
            assertThat(keys(run.snapshotId(), "CONTAINER"))
                    .containsExactlyInAnyOrder("container:app", "container:postgres");
            assertThat(countType(run.snapshotId(), "CONTAINER")).isEqualTo(2);
            assertThat(countType(run.snapshotId(), "CI_PIPELINE")).isEqualTo(1);
            assertThat(keys(run.snapshotId(), "CI_PIPELINE")).contains("ci:deploy.yml:deploy");
            assertThat(edgePairs(run.snapshotId(), "DEPLOYED_IN")).contains("container:app->container:postgres");
            Integer dockerfileEvidence = jdbcTemplate.queryForObject("""
                    select count(*) from evidences e
                    join evidence_links l on l.evidence_id = e.id
                    join graph_nodes n on n.id = l.subject_id
                    where n.snapshot_id = ? and n.natural_key = 'container:app'
                      and l.subject_type = 'GRAPH_NODE' and e.file_path = 'Dockerfile'
                    """, Integer.class, run.snapshotId());
            assertThat(dockerfileEvidence).isEqualTo(1);
            assertThat(infraKinds(run.snapshotId()))
                    .containsExactlyInAnyOrder(
                            "CONTAINER:app", "CONTAINER:postgres", "CI:deploy", "CLOUD:aws_s3_bucket.data");
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void brokenSqlIsDemotedAndSourceParsingSucceeds() throws Exception {
        Run run = analyze("spring-mini");
        try {
            Path broken = run.clonePath().resolve("src/main/resources/db/migration/V99__broken.sql");
            Files.writeString(broken, "this is not sql [[[ unterminated\n");
            jdbcTemplate.update("""
                    insert into files (snapshot_id, path, language, size, line_count, content_hash)
                    values (?, 'src/main/resources/db/migration/V99__broken.sql', 'sql', 24, 1, 'broken')
                    """, run.snapshotId());
            TestJobContext ctx = new TestJobContext(2, run.projectId(), run.snapshotId(), run.clonePath());
            sourceParsingStep.run(ctx);
            assertThat(keys(run.snapshotId(), "DB_TABLE")).contains("table:todos");
            assertThat(keys(run.snapshotId(), "MIGRATION"))
                    .contains("migration:src/main/resources/db/migration/V99__broken.sql");
            Integer failures = jdbcTemplate.queryForObject("""
                    select count(*) from evidences e
                    join evidence_links l on l.evidence_id = e.id
                    join graph_nodes n on n.id = l.subject_id
                    where n.snapshot_id = ?
                      and n.natural_key = 'migration:src/main/resources/db/migration/V99__broken.sql'
                      and e.excerpt like '%SQL parse failed%'
                    """, Integer.class, run.snapshotId());
            assertThat(failures).isGreaterThanOrEqualTo(1);
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void extractionRerunDoesNotDuplicateInfra() throws Exception {
        Run run = analyze("infra-mini");
        try {
            int before = countInfra(run.snapshotId());
            TestJobContext ctx = new TestJobContext(2, run.projectId(), run.snapshotId(), run.clonePath());
            extractionStep.run(ctx);
            assertThat(countInfra(run.snapshotId())).isEqualTo(before);
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
        TestJobContext ctx = TestJobContext.running(jdbcTemplate, projectId, snapshotId, clone);
        fileInventoryStep.run(ctx);
        sourceParsingStep.run(ctx);
        graphBuildStep.run(ctx);
        extractionStep.run(ctx);
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
                .map(row -> String.valueOf(row.get("src")) + "->" + String.valueOf(row.get("tgt")))
                .collect(Collectors.toSet());
    }

    private Set<String> infraKinds(long snapshotId) {
        return jdbcTemplate
                .queryForList("select kind, name from infra_resources where snapshot_id = ?", snapshotId)
                .stream()
                .map(row -> String.valueOf(row.get("kind")) + ":" + String.valueOf(row.get("name")))
                .collect(Collectors.toSet());
    }

    private int countType(long snapshotId, String nodeType) {
        Integer value = jdbcTemplate.queryForObject(
                "select count(*) from graph_nodes where snapshot_id = ? and node_type = ?",
                Integer.class,
                snapshotId,
                nodeType);
        return value == null ? 0 : value;
    }

    private int countInfra(long snapshotId) {
        Integer value = jdbcTemplate.queryForObject(
                "select count(*) from infra_resources where snapshot_id = ?", Integer.class, snapshotId);
        return value == null ? 0 : value;
    }

    private record Run(long projectId, long snapshotId, Path clonePath) {}
}
