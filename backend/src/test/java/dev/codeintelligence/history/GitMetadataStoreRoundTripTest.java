package dev.codeintelligence.history;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.StatementCounter;
import java.nio.file.Path;
import java.time.Instant;
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

/**
 * G-PERF medium/large GIT_METADATA (4.2 s medium, 47 s large): the desktop analyzes a single-commit
 * repository whose one commit adds every file, and each commit file was its own insert round trip
 * (50,000 for the large workload). Storing a commit must cost round trips per batch, not per file.
 */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import({TestcontainersConfiguration.class, StatementCounter.class})
class GitMetadataStoreRoundTripTest {

    private static final int FILES = 2_000;

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    private GitMetadataStore store;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void storingACommitCostsRoundTripsPerBatchNotPerFile() {
        long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "git-metadata-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'git-metadata', 'acme', ?) returning id
                """, Long.class, userId, "git-metadata-" + System.nanoTime());
        List<ScannedCommitFile> files = new ArrayList<>();
        for (int i = 0; i < FILES; i++) files.add(new ScannedCommitFile("src/F" + i + ".java", "ADD"));
        GitMetadataScan scan = new GitMetadataScan(
                List.of(new ScannedCommit(
                        "a".repeat(40), "workload", "workload", Instant.parse("2026-10-08T00:00:00Z"), 10, 0, files)),
                List.of(new ScannedRef("snapshot", "a".repeat(40))),
                List.of(),
                0);

        StatementCounter.EXECUTIONS.set(0);
        store.replaceCloneMetadata(projectId, scan);
        int executions = StatementCounter.EXECUTIONS.get();
        // Storing it again replaces the commit's files instead of adding to them.
        store.replaceCloneMetadata(projectId, scan);

        assertThat(jdbcTemplate.queryForList("""
                        select cf.path || ':' || cf.change_type from commit_files cf join commits c on c.id = cf.commit_id
                        where c.project_id = ? order by cf.id
                        """, String.class, projectId))
                .hasSize(FILES)
                .startsWith("src/F0.java:ADD", "src/F1.java:ADD")
                .endsWith("src/F" + (FILES - 1) + ".java:ADD");
        // Before batching: one insert per file (2,000) plus the commit, its delete and the refs.
        assertThat(executions).isLessThan(20);
    }
}
