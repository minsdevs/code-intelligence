package dev.codeintelligence.history;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.GitMetadataFixtures;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

@SpringBootTest(
        properties = {"app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", "app.analysis.max-commits=2"})
@Import(TestcontainersConfiguration.class)
class GitMetadataTruncationTest {

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
    void writesWarningEvidenceWhenCommitCapExceeded() throws Exception {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "trunc-" + System.nanoTime());
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
        GitMetadataFixtures.createGolden(clone);

        gitMetadataStep.run(new TestJobContext(1, projectId, snapshotId, clone));

        Integer commitCount = jdbcTemplate.queryForObject(
                "select count(*) from commits where project_id = ?", Integer.class, projectId);
        assertThat(commitCount).isEqualTo(2);
        String excerpt = jdbcTemplate.queryForObject("""
                select e.excerpt from evidences e
                join evidence_links l on l.evidence_id = e.id
                where l.subject_type = 'GIT_METADATA' and l.subject_id = ?
                """, String.class, snapshotId);
        assertThat(excerpt).contains("app.analysis.max-commits").contains("omitted 3");
    }
}
