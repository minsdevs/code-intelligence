package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.config.ExtractionStep;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.graph.GraphBuildStep;
import dev.codeintelligence.analysis.graph.SourceParsingStep;
import dev.codeintelligence.job.FinalizeStep;
import dev.codeintelligence.testsupport.FakeTsAnalyzer;
import dev.codeintelligence.testsupport.FixtureRepo;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterAll;
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
class ReactMiniTsParsingGoldenTest {

    private static final FakeTsAnalyzer fakeTs = new FakeTsAnalyzer();

    @AfterAll
    static void closeAnalyzer() {
        fakeTs.close();
    }

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
        registry.add("app.ts-analyzer.base-url", fakeTs::baseUrl);
    }

    @Autowired
    private FileInventoryStep fileInventoryStep;

    @Autowired
    private SourceParsingStep sourceParsingStep;

    @Autowired
    private GraphBuildStep graphBuildStep;

    @Autowired
    private TsParsingStep tsParsingStep;

    @Autowired
    private ExtractionStep extractionStep;

    @Autowired
    private FinalizeStep finalizeStep;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void reactMiniHasTwoRoutesTodoItemAndTodosFetch() throws Exception {
        Run run = analyze("react-mini");
        try {
            assertThat(routes(run.snapshotId())).containsExactlyInAnyOrder("/", "/todos");
            assertThat(components(run.snapshotId()))
                    .contains("TodoItem")
                    .contains("TodosPage")
                    .contains("App");
            Integer apiCalls = jdbcTemplate.queryForObject("""
                    select count(*) from graph_nodes
                    where snapshot_id = ? and node_type = 'COMPONENT'
                      and metadata->'apiCalls' @> '[{"url":"/api/todos","method":"GET"}]'::jsonb
                    """, Integer.class, run.snapshotId());
            assertThat(apiCalls).isGreaterThanOrEqualTo(1);
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void blankSidecarUrlIsNoOp() throws Exception {
        // spring-mini has no TS files; enabled sidecar still finishes.
        Run run = analyze("spring-mini");
        try {
            assertThat(routes(run.snapshotId())).isEmpty();
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
        tsParsingStep.run(ctx);
        extractionStep.run(ctx);
        finalizeStep.run(ctx);
        return new Run(projectId, snapshotId, clone);
    }

    private Set<String> routes(long snapshotId) {
        return jdbcTemplate.queryForList("select path from frontend_routes where snapshot_id = ?", snapshotId).stream()
                .map(row -> String.valueOf(row.get("path")))
                .collect(Collectors.toSet());
    }

    private Set<String> components(long snapshotId) {
        return jdbcTemplate
                .queryForList(
                        "select name from graph_nodes where snapshot_id = ? and node_type = 'COMPONENT'", snapshotId)
                .stream()
                .map(row -> String.valueOf(row.get("name")))
                .collect(Collectors.toSet());
    }

    private record Run(long projectId, long snapshotId, Path clonePath) {}
}
