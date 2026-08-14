package dev.codeintelligence.history;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.GitMetadataFixtures;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
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

@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import(TestcontainersConfiguration.class)
class GitMetadataStepTest {

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void isolatedDataDir(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    private GitMetadataStep gitMetadataStep;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void persistsGoldenRepoIdempotently() throws Exception {
        Fixture fixture = seedProject();
        GitMetadataFixtures.GoldenRepo golden = GitMetadataFixtures.createGolden(fixture.clonePath());
        TestJobContext ctx = new TestJobContext(1, fixture.projectId(), fixture.snapshotId(), fixture.clonePath());

        gitMetadataStep.run(ctx);
        gitMetadataStep.run(ctx);

        Integer commitCount = jdbcTemplate.queryForObject(
                "select count(*) from commits where project_id = ?", Integer.class, fixture.projectId());
        assertThat(commitCount).isEqualTo(5);
        List<String> shas = jdbcTemplate.queryForList(
                "select sha from commits where project_id = ? order by committed_at desc, sha",
                String.class,
                fixture.projectId());
        assertThat(shas).containsExactly(golden.c5(), golden.c4(), golden.c3(), golden.c2(), golden.c1());

        List<Map<String, Object>> files = jdbcTemplate.queryForList("""
                select f.path, f.change_type
                from commit_files f join commits c on c.id = f.commit_id
                where c.project_id = ? and c.sha = ?
                """, fixture.projectId(), golden.c5());
        assertThat(files).hasSize(1);
        assertThat(files.getFirst().get("path")).isEqualTo("src/renamed.txt");
        assertThat(files.getFirst().get("change_type")).isEqualTo("RENAME");

        List<String> branches = jdbcTemplate.queryForList(
                "select name from branches where project_id = ? order by name", String.class, fixture.projectId());
        assertThat(branches).containsExactly("main", "topic");
        Integer tags = jdbcTemplate.queryForObject(
                "select count(*) from tags where project_id = ? and name = 'v1.0'", Integer.class, fixture.projectId());
        assertThat(tags).isEqualTo(1);
        Integer evidence = jdbcTemplate.queryForObject("""
                select count(*) from evidence_links
                where subject_type = 'GIT_METADATA' and subject_id = ?
                """, Integer.class, fixture.snapshotId());
        assertThat(evidence).isZero();
    }

    private Fixture seedProject() {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "gitmeta-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'demo', 'octocat', 'hello') returning id
                """, Long.class, userId);
        Path clone = dataDir.resolve("repos").resolve(String.valueOf(projectId));
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, projectId);
        return new Fixture(projectId, snapshotId, clone);
    }

    private record Fixture(long projectId, long snapshotId, Path clonePath) {}
}
