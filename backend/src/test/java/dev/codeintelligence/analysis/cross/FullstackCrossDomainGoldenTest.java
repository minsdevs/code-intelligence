package dev.codeintelligence.analysis.cross;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.config.ExtractionStep;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.feature.FeatureDetectionStep;
import dev.codeintelligence.analysis.finding.FindingDetectionStep;
import dev.codeintelligence.analysis.flow.FlowDetectionStep;
import dev.codeintelligence.analysis.graph.GraphBuildStep;
import dev.codeintelligence.analysis.graph.SourceParsingStep;
import dev.codeintelligence.analysis.ts.TsParsingStep;
import dev.codeintelligence.job.FinalizeStep;
import dev.codeintelligence.testsupport.FakeTsAnalyzer;
import dev.codeintelligence.testsupport.FixtureRepo;
import dev.codeintelligence.testsupport.TestJobContext;
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
class FullstackCrossDomainGoldenTest {

    private static final FakeTsAnalyzer fakeTs = new FakeTsAnalyzer();

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
    private CrossDomainStep crossDomainStep;

    @Autowired
    private FeatureDetectionStep featureDetectionStep;

    @Autowired
    private FlowDetectionStep flowDetectionStep;

    @Autowired
    private FindingDetectionStep findingDetectionStep;

    @Autowired
    private FinalizeStep finalizeStep;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void fullstackLinksConsumesMapsToFlowsAndFindings() throws Exception {
        Run run = analyze("fullstack-mini");
        try {
            assertThat(edgePairs(run.snapshotId(), "CONSUMES")).isNotEmpty();
            assertThat(edgePairs(run.snapshotId(), "MAPS_TO")).anyMatch(pair -> pair.contains("todos"));
            assertThat(edgePairs(run.snapshotId(), "READS_WRITES")).isNotEmpty();
            assertThat(kinds(run.snapshotId())).contains("BACKEND", "FE_BE");
            assertThat(backendFlowSteps(run.snapshotId(), "endpoint:GET:/todos"))
                    .contains("GET /todos", "TodoController", "list", "findAll")
                    .doesNotContain("get", "create", "findById", "save");
            Integer findings = jdbcTemplate.queryForObject(
                    "select count(*) from analysis_findings where snapshot_id = ?", Integer.class, run.snapshotId());
            assertThat(findings).isNotNull();
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
        tsParsingStep.run(ctx);
        extractionStep.run(ctx);
        crossDomainStep.run(ctx);
        featureDetectionStep.run(ctx);
        flowDetectionStep.run(ctx);
        findingDetectionStep.run(ctx);
        finalizeStep.run(ctx);
        return new Run(projectId, snapshotId, clone);
    }

    private Set<String> edgePairs(long snapshotId, String type) {
        return jdbcTemplate.queryForList("""
                        select s.natural_key as src, t.natural_key as tgt
                        from graph_edges e
                        join graph_nodes s on s.id = e.source_node_id
                        join graph_nodes t on t.id = e.target_node_id
                        where e.snapshot_id = ? and e.edge_type = ?
                        """, snapshotId, type).stream()
                .map(row -> row.get("src") + "->" + row.get("tgt"))
                .collect(Collectors.toSet());
    }

    private Set<String> kinds(long snapshotId) {
        return jdbcTemplate.queryForList("select kind from flows where snapshot_id = ?", snapshotId).stream()
                .map(row -> String.valueOf(row.get("kind")))
                .collect(Collectors.toSet());
    }

    private Set<String> backendFlowSteps(long snapshotId, String endpointKey) {
        return jdbcTemplate.queryForList("""
                        select fs.description
                        from flows f
                        join graph_nodes entry on entry.id = f.entry_node_id
                        join flow_steps fs on fs.flow_id = f.id
                        where f.snapshot_id = ? and f.kind = 'BACKEND' and entry.natural_key = ?
                        """, snapshotId, endpointKey).stream()
                .map(row -> String.valueOf(row.get("description")))
                .collect(Collectors.toSet());
    }

    private record Run(long projectId, long snapshotId, Path clonePath) {}
}
