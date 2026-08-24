package dev.codeintelligence.analysis.area;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.core.FrameworkDetectionStep;
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
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.FileSystemUtils;

@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import(TestcontainersConfiguration.class)
class FixtureGoldenTest {

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void isolatedDataDir(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    private FileInventoryStep fileInventoryStep;

    @Autowired
    private FrameworkDetectionStep frameworkDetectionStep;

    @Autowired
    private AreaDetectionStep areaDetectionStep;

    @Autowired
    private FinalizeStep finalizeStep;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @ParameterizedTest
    @ValueSource(strings = {"spring-mini", "react-mini", "fullstack-mini", "infra-mini"})
    void inventoryCountsMatchFixtureFiles(String fixture) throws Exception {
        Run run = analyze(fixture);
        try {
            Integer fileCount = jdbcTemplate.queryForObject(
                    "select count(*) from files where snapshot_id = ?", Integer.class, run.snapshotId());
            assertThat(fileCount).isEqualTo(expectedFileCount(fixture));
            Map<String, Integer> languages = jdbcTemplate.queryForList("""
                            select coalesce(language, 'unknown') as language, count(*) as cnt
                            from files where snapshot_id = ? group by 1
                            """, run.snapshotId()).stream()
                    .collect(Collectors.toMap(
                            row -> (String) row.get("language"), row -> ((Number) row.get("cnt")).intValue()));
            assertThat(languages).containsAllEntriesOf(expectedLanguages(fixture));
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void springMiniAutoSelectsBackendAndDatabase() throws Exception {
        assertAutoSelected("spring-mini", Set.of("BACKEND", "DATABASE", "TESTING"));
    }

    @Test
    void reactMiniAutoSelectsFrontend() throws Exception {
        assertAutoSelected("react-mini", Set.of("FRONTEND", "TESTING"));
    }

    @Test
    void fullstackMiniAutoSelectsRequiredAreas() throws Exception {
        assertAutoSelected(
                "fullstack-mini", Set.of("BACKEND", "FRONTEND", "DATABASE", "INFRASTRUCTURE", "DEVOPS", "TESTING"));
    }

    @Test
    void infraMiniAutoSelectsInfrastructureAndDevopsOnly() throws Exception {
        Run run = analyze("infra-mini");
        try {
            Set<String> selected = selectedAreas(run.projectId(), run.snapshotId());
            assertThat(selected).isEqualTo(Set.of("INFRASTRUCTURE", "DEVOPS"));
            List<Map<String, Object>> others = jdbcTemplate.queryForList("""
                    select area_type, confidence from project_areas
                    where snapshot_id = ? and area_type not in ('INFRASTRUCTURE', 'DEVOPS')
                    """, run.snapshotId());
            assertThat(others)
                    .allSatisfy(row -> assertThat(((Number) row.get("confidence")).doubleValue())
                            .isLessThan(0.3));
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    @Test
    void reanalyzePreservesUserSelection() throws Exception {
        Run run = analyze("spring-mini");
        try {
            jdbcTemplate.update("""
                    update project_area_selections set selected = false
                    where project_id = ? and area_type = 'BACKEND'
                    """, run.projectId());
            long snapshot2 = jdbcTemplate.queryForObject("""
                    insert into snapshots (project_id, commit_sha, status)
                    values (?, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'ANALYZING') returning id
                    """, Long.class, run.projectId());
            TestJobContext ctx = new TestJobContext(2, run.projectId(), snapshot2, run.clonePath());
            fileInventoryStep.run(ctx);
            frameworkDetectionStep.run(ctx);
            areaDetectionStep.run(ctx);
            Boolean backendSelected = jdbcTemplate.queryForObject("""
                    select selected from project_area_selections
                    where project_id = ? and area_type = 'BACKEND'
                    """, Boolean.class, run.projectId());
            assertThat(backendSelected).isFalse();
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    private void assertAutoSelected(String fixture, Set<String> expected) throws Exception {
        Run run = analyze(fixture);
        try {
            assertThat(selectedAreas(run.projectId(), run.snapshotId())).isEqualTo(expected);
        } finally {
            FileSystemUtils.deleteRecursively(run.clonePath());
        }
    }

    private Set<String> selectedAreas(long projectId, long snapshotId) {
        return jdbcTemplate.queryForList("""
                        select a.area_type from project_areas a
                        join project_area_selections s
                          on s.project_id = ? and s.area_type = a.area_type and s.selected = true
                        where a.snapshot_id = ? and a.confidence >= 0.5
                        """, projectId, snapshotId).stream()
                .map(row -> (String) row.get("area_type"))
                .collect(Collectors.toSet());
    }

    private Run analyze(String fixture) throws Exception {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                fixture + "-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, ?, 'acme', ?) returning id
                """, Long.class, userId, fixture, fixture);
        Path clone = FixtureRepo.create(fixture, dataDir.resolve("repos").resolve(String.valueOf(projectId)));
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, projectId);
        TestJobContext ctx = new TestJobContext(1, projectId, snapshotId, clone);
        fileInventoryStep.run(ctx);
        frameworkDetectionStep.run(ctx);
        areaDetectionStep.run(ctx);
        finalizeStep.run(ctx);
        return new Run(projectId, snapshotId, clone);
    }

    private static int expectedFileCount(String fixture) {
        return switch (fixture) {
            case "spring-mini" -> 13;
            case "react-mini" -> 10;
            case "fullstack-mini" -> 25;
            case "infra-mini" -> 7;
            default -> throw new IllegalArgumentException(fixture);
        };
    }

    private static Map<String, Integer> expectedLanguages(String fixture) {
        return switch (fixture) {
            case "spring-mini" -> Map.of("java", 8, "gradle", 2, "yaml", 1, "sql", 2);
            case "react-mini" -> Map.of("json", 2, "html", 1, "typescript", 7);
            case "fullstack-mini" ->
                Map.of("java", 8, "gradle", 2, "yaml", 3, "sql", 2, "json", 2, "html", 1, "typescript", 7);
            case "infra-mini" -> Map.of("dockerfile", 1, "yaml", 2, "hcl", 1, "shell", 1, "markdown", 2);
            default -> throw new IllegalArgumentException(fixture);
        };
    }

    private record Run(long projectId, long snapshotId, Path clonePath) {}
}
