package dev.codeintelligence.analysis.feature;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.config.ExtractionStep;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.graph.GraphBuildStep;
import dev.codeintelligence.analysis.graph.SourceParsingStep;
import dev.codeintelligence.job.FinalizeStep;
import dev.codeintelligence.testsupport.FixtureRepo;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
import java.util.List;
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
class SpringMiniEndpointsFeaturesGoldenTest {

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
    private FeatureDetectionStep featureDetectionStep;

    @Autowired
    private FinalizeStep finalizeStep;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void springMiniHasFiveEndpointsTwoFeaturesAndTodosLayerLinks() throws Exception {
        Run run = analyze("spring-mini");
        try {
            assertThat(endpoints(run.snapshotId()))
                    .containsExactlyInAnyOrder(
                            "POST /auth/login", "POST /auth/logout", "GET /todos", "GET /todos/{id}", "POST /todos");
            assertThat(layers(run.snapshotId()))
                    .containsEntry("TodoController", "CONTROLLER")
                    .containsEntry("TodoService", "SERVICE")
                    .containsEntry("TodoRepository", "REPOSITORY")
                    .containsEntry("Todo", "ENTITY");
            assertThat(entities(run.snapshotId())).containsExactly("Todo:todos");

            Set<String> featureNames = featureNames(run.snapshotId());
            assertThat(featureNames).containsExactlyInAnyOrder("auth", "todos");

            Set<String> todosLinks = featureLinkNames(run.snapshotId(), "todos");
            assertThat(todosLinks)
                    .anyMatch(name -> name.contains("TodoController"))
                    .anyMatch(name -> name.contains("TodoService"))
                    .anyMatch(name -> name.contains("TodoRepository"))
                    .anyMatch(name -> name.equals("Todo") || name.contains("Todo"));

            List<String> backendLayers = jdbcTemplate.queryForList("""
                    select distinct metadata->>'layer' as layer from graph_nodes
                    where snapshot_id = ? and metadata->>'layer' in ('CONTROLLER','SERVICE','REPOSITORY','ENTITY')
                    """, String.class, run.snapshotId());
            assertThat(backendLayers).containsExactlyInAnyOrder("CONTROLLER", "SERVICE", "REPOSITORY", "ENTITY");
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void fullstackMiniBackendFeaturesMatchSpringMini() throws Exception {
        Run run = analyze("fullstack-mini");
        try {
            assertThat(endpoints(run.snapshotId()))
                    .containsExactlyInAnyOrder(
                            "POST /auth/login", "POST /auth/logout", "GET /todos", "GET /todos/{id}", "POST /todos");
            assertThat(featureNames(run.snapshotId())).containsExactlyInAnyOrder("auth", "todos");
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void extractionAndFeatureRerunAreIdempotent() throws Exception {
        Run run = analyze("spring-mini");
        try {
            int endpoints = count(run.snapshotId(), "api_endpoints");
            int features = count(run.snapshotId(), "features");
            TestJobContext ctx = new TestJobContext(2, run.projectId(), run.snapshotId(), run.clonePath());
            extractionStep.run(ctx);
            featureDetectionStep.run(ctx);
            assertThat(count(run.snapshotId(), "api_endpoints")).isEqualTo(endpoints);
            assertThat(count(run.snapshotId(), "features")).isEqualTo(features);
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
        featureDetectionStep.run(ctx);
        finalizeStep.run(ctx);
        return new Run(projectId, snapshotId, clone);
    }

    private Set<String> endpoints(long snapshotId) {
        return jdbcTemplate
                .queryForList("select http_method, path from api_endpoints where snapshot_id = ?", snapshotId)
                .stream()
                .map(row -> row.get("http_method") + " " + row.get("path"))
                .collect(Collectors.toSet());
    }

    private Set<String> entities(long snapshotId) {
        return jdbcTemplate
                .queryForList("select entity_name, table_name from db_entities where snapshot_id = ?", snapshotId)
                .stream()
                .map(row -> row.get("entity_name") + ":" + row.get("table_name"))
                .collect(Collectors.toSet());
    }

    private Map<String, String> layers(long snapshotId) {
        return jdbcTemplate.queryForList("""
                        select name, metadata->>'layer' as layer from graph_nodes
                        where snapshot_id = ? and metadata->>'layer' is not null
                        """, snapshotId).stream()
                .collect(Collectors.toMap(
                        row -> String.valueOf(row.get("name")), row -> String.valueOf(row.get("layer")), (a, b) -> a));
    }

    private Set<String> featureNames(long snapshotId) {
        return jdbcTemplate.queryForList("select name from features where snapshot_id = ?", snapshotId).stream()
                .map(row -> String.valueOf(row.get("name")))
                .collect(Collectors.toSet());
    }

    private Set<String> featureLinkNames(long snapshotId, String featureName) {
        return jdbcTemplate.queryForList("""
                        select n.name from feature_links fl
                        join features f on f.id = fl.feature_id
                        join graph_nodes n on n.id = fl.node_id
                        where f.snapshot_id = ? and f.name = ?
                        """, snapshotId, featureName).stream()
                .map(row -> String.valueOf(row.get("name")))
                .collect(Collectors.toSet());
    }

    private int count(long snapshotId, String table) {
        Integer value = jdbcTemplate.queryForObject(
                "select count(*) from " + table + " where snapshot_id = ?", Integer.class, snapshotId);
        return value == null ? 0 : value;
    }

    private record Run(long projectId, long snapshotId, Path clonePath) {}
}
