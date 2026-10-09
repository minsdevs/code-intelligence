package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.StatementCounter;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import({TestcontainersConfiguration.class, StatementCounter.class})
@Transactional
class FileAnalysisOutcomePersistenceTest {
    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private JdbcTemplate database;

    @Test
    void responseUpdatesHaveBoundedRoundTripsAndPreserveEveryFileOutcome() {
        long snapshot = snapshot();
        int count = 1001;
        database.update("""
                insert into files (snapshot_id, path, size, content_hash, analysis_status, analysis_targeted)
                select ?, 'src/F' || i || '.ts', 100, md5(i::text), 'UNMEASURED', false
                from generate_series(0, ?) i
                """, snapshot, count - 1);
        String unicodePath = "src/한글 file's.ts";
        database.update("update files set path=? where snapshot_id=? and path='src/F777.ts'", unicodePath, snapshot);
        List<String> paths = new ArrayList<>();
        List<FileAnalysisOutcome> outcomes = new ArrayList<>();
        Map<String, Stored> expected = new LinkedHashMap<>();
        List<String> statuses = List.of("SUCCESS", "PARTIAL", "FAILED", "UNSUPPORTED", "UNMEASURED");
        for (int index = 0; index < count; index++) {
            String path = index == 777 ? unicodePath : "src/F" + index + ".ts";
            String status = statuses.get(index % statuses.size());
            String reason = index % 3 == 0 ? null : "PARSER_REPORTED";
            paths.add(path);
            outcomes.add(new FileAnalysisOutcome(path, status, reason));
            expected.put(path, new Stored(status, "PARSER_REPORTED", !"UNMEASURED".equals(status)));
        }
        StatementCounter.EXECUTIONS.set(0);
        FileAnalysisOutcome.recordResponse(jdbc, snapshot, paths, outcomes);
        int executions = StatementCounter.EXECUTIONS.get();
        System.out.println("OUTCOME_DB_ROUND_TRIPS=" + executions);

        assertThat(stored(snapshot)).isEqualTo(expected);
        assertThat(executions)
                .as("database round trips for 1,001 file outcomes")
                .isLessThanOrEqualTo(10);
    }

    @Test
    void invalidResponsesDoNotClaimSuccessOrTouchUnsubmittedFilesOrAnotherSnapshot() {
        List<String> paths =
                List.of("duplicate.ts", "missing.ts", "invalid.ts", "free-text.ts", "good.ts", "external.ts");
        long snapshot = snapshot();
        long otherSnapshot = snapshot();
        seed(snapshot, paths);
        seed(otherSnapshot, paths);
        FileAnalysisOutcome.record(jdbc, snapshot, "duplicate.ts", "TARGETED", "PARSER_STARTED");
        List<FileAnalysisOutcome> response = Arrays.asList(
                new FileAnalysisOutcome("duplicate.ts", "SUCCESS", "TS_PARSED"),
                new FileAnalysisOutcome("duplicate.ts", "SUCCESS", "TS_PARSED"),
                new FileAnalysisOutcome("invalid.ts", "TARGETED", "PARSER_STARTED"),
                new FileAnalysisOutcome("free-text.ts", "PARTIAL", "source text\nmust not be stored"),
                new FileAnalysisOutcome("good.ts", "FAILED", "ANALYZER_REQUEST_FAILED"),
                new FileAnalysisOutcome("external.ts", "SUCCESS", "TS_PARSED"),
                new FileAnalysisOutcome(null, "SUCCESS", "TS_PARSED"),
                null);
        FileAnalysisOutcome.recordResponse(jdbc, snapshot, paths.subList(0, 5), response);

        assertThat(stored(snapshot))
                .isEqualTo(Map.of(
                        "duplicate.ts", new Stored("UNMEASURED", "ANALYZER_OUTCOME_MISSING_OR_INVALID", true),
                        "missing.ts", new Stored("UNMEASURED", "ANALYZER_OUTCOME_MISSING_OR_INVALID", false),
                        "invalid.ts", new Stored("UNMEASURED", "ANALYZER_OUTCOME_MISSING_OR_INVALID", false),
                        "free-text.ts", new Stored("PARTIAL", "PARSER_REPORTED", true),
                        "good.ts", new Stored("FAILED", "ANALYZER_REQUEST_FAILED", true),
                        "external.ts", new Stored("UNMEASURED", null, false)));
        assertThat(stored(otherSnapshot)).isEqualTo(initial(paths));
    }

    @Test
    void ambiguitySurvivesSuccessButFailureOverridesItAndTargetingIsSticky() {
        long snapshot = snapshot();
        List<String> paths = List.of("ambiguous.ts", "failed.ts", "reset.ts");
        seed(snapshot, paths);
        FileAnalysisOutcome.record(jdbc, snapshot, "ambiguous.ts", "PARTIAL", GraphIdentityGuard.REASON);
        FileAnalysisOutcome.record(jdbc, snapshot, "failed.ts", "PARTIAL", GraphIdentityGuard.REASON);
        FileAnalysisOutcome.record(jdbc, snapshot, "reset.ts", "SUCCESS", "TS_PARSED");
        FileAnalysisOutcome.recordResponse(
                jdbc,
                snapshot,
                paths,
                List.of(
                        new FileAnalysisOutcome("ambiguous.ts", "SUCCESS", "TS_PARSED"),
                        new FileAnalysisOutcome("failed.ts", "FAILED", "IO_FAILED"),
                        new FileAnalysisOutcome("reset.ts", "UNMEASURED", null)));

        assertThat(stored(snapshot))
                .isEqualTo(Map.of(
                        "ambiguous.ts", new Stored("PARTIAL", GraphIdentityGuard.REASON, true),
                        "failed.ts", new Stored("FAILED", "IO_FAILED", true),
                        "reset.ts", new Stored("UNMEASURED", "PARSER_REPORTED", true)));
    }

    @Test
    void repeatedPathsKeepSequentialAmbiguityAndFailureTransitions() {
        long snapshot = snapshot();
        seed(snapshot, List.of("repeat.java", "other.java"));
        FileAnalysisOutcome.record(jdbc, snapshot, "repeat.java", "PARTIAL", GraphIdentityGuard.REASON);
        FileAnalysisOutcome.recordFiles(
                jdbc, snapshot, List.of("repeat.java", "other.java", "missing.java", "repeat.java"), "TARGETED", null);
        FileAnalysisOutcome.recordAll(
                jdbc,
                snapshot,
                List.of(
                        new FileAnalysisOutcome("repeat.java", "SUCCESS", "JAVA_PARSED"),
                        new FileAnalysisOutcome("other.java", "UNMEASURED", null),
                        new FileAnalysisOutcome("repeat.java", "FAILED", "JAVA_PARSE_FAILED"),
                        new FileAnalysisOutcome("repeat.java", "SUCCESS", null)));

        assertThat(stored(snapshot))
                .isEqualTo(Map.of(
                        "repeat.java", new Stored("SUCCESS", null, true),
                        "other.java", new Stored("UNMEASURED", null, true)));
    }

    private long snapshot() {
        long user = database.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "outcomes-" + System.nanoTime());
        long project = database.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'outcome-transitions', 'synthetic', ?) returning id
                """, Long.class, user, "outcomes-" + System.nanoTime());
        return database.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, project);
    }

    private void seed(long snapshot, List<String> paths) {
        for (String path : paths) database.update("""
                insert into files (snapshot_id, path, size, content_hash, analysis_status, analysis_targeted)
                values (?, ?, 100, md5(?), 'UNMEASURED', false)
                """, snapshot, path, path);
    }

    private Map<String, Stored> stored(long snapshot) {
        Map<String, Stored> result = new LinkedHashMap<>();
        database.query(
                """
                select path, analysis_status, analysis_reason, analysis_targeted from files where snapshot_id=?
                """,
                rs -> {
                    while (rs.next())
                        result.put(
                                rs.getString("path"),
                                new Stored(
                                        rs.getString("analysis_status"),
                                        rs.getString("analysis_reason"),
                                        rs.getBoolean("analysis_targeted")));
                    return result;
                },
                snapshot);
        return result;
    }

    private static Map<String, Stored> initial(List<String> paths) {
        Map<String, Stored> result = new LinkedHashMap<>();
        for (String path : paths) result.put(path, new Stored("UNMEASURED", null, false));
        return result;
    }

    private record Stored(String status, String reason, boolean targeted) {}
}
