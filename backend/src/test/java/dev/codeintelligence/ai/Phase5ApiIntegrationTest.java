package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.FakeGithubApi;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.EntityExchangeResult;
import org.springframework.test.web.servlet.client.RestTestClient;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@AutoConfigureRestTestClient
@Import({TestcontainersConfiguration.class, MockAiTestConfig.class})
class Phase5ApiIntegrationTest {

    private static final FakeGithubApi fakeGithub = new FakeGithubApi();

    @TempDir
    static Path root;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry) {
        registry.add("app.github.base-url", fakeGithub::baseUrl);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
    }

    @AfterAll
    static void stopFakeGithub() {
        fakeGithub.close();
    }

    @Autowired
    private RestTestClient restTestClient;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private JsonMapper jsonMapper;

    @Autowired
    private MockAIProvider mockAIProvider;

    @Test
    void reviewGeneratesFromChangedFilesAndIsOwnerScoped() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        seedPull(projectId, 12, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "src/App.java");

        Map<String, Object> created = jsonMapper.readValue(
                postAs(session, "/api/projects/" + projectId + "/pulls/12/review", Map.of(), HttpStatus.CREATED),
                Map.class);
        assertThat(created.get("summary")).isEqualTo("mock review");
        assertThat(created.get("origin")).isEqualTo("AI");
        assertThat(created.get("pullNumber")).isEqualTo(12);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> comments = (List<Map<String, Object>>) created.get("comments");
        assertThat(comments).isNotEmpty();
        assertThat(comments.getFirst().get("filePath")).isEqualTo("src/App.java");
        assertThat(comments.getFirst().get("confidence")).isEqualTo("CONFIRMED");
        assertThat(mockAIProvider.lastUser())
                .contains("CHANGED_FILE: src/App.java")
                .contains("pr:12")
                .contains("Review pull request #12");

        Map<String, Object> latest = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/pulls/12/review", HttpStatus.OK), Map.class);
        assertThat(latest.get("id")).isEqualTo(created.get("id"));

        getAs(session, "/api/projects/" + projectId + "/pulls/99/review", HttpStatus.NOT_FOUND);

        long foreign = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "other-" + System.nanoTime());
        long otherProject = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'x', 'acme', 'x') returning id
                """, Long.class, foreign);
        postAs(session, "/api/projects/" + otherProject + "/pulls/12/review", Map.of(), HttpStatus.NOT_FOUND);
    }

    @Test
    void reviewMasksSecretsBeforeTheProvider() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        long pullId = jdbcTemplate.queryForObject(
                """
                insert into pull_requests (project_id, number, title, body, state, author, head_sha, base_sha)
                values (?, 7, 'secret pr', 'api_key=sk-abcdefghijklmnopqrstuvwxyz012345', 'open', 'octocat', ?, ?)
                returning id
                """,
                Long.class,
                projectId,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        assertThat(pullId).isPositive();
        postAs(session, "/api/projects/" + projectId + "/pulls/7/review", Map.of(), HttpStatus.CREATED);
        assertThat(mockAIProvider.lastUser())
                .contains("[REDACTED]")
                .doesNotContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    }

    @Test
    void playgroundAskIsIsolatedAndNeverExecutesSnippet() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        Map<String, Object> created = jsonMapper.readValue(
                postAs(
                        session,
                        "/api/projects/" + projectId + "/playground/sessions",
                        Map.of(
                                "title",
                                "Explore App",
                                "selectedPaths",
                                List.of("src/App.java"),
                                "proposedSnippet",
                                "class App {}"),
                        HttpStatus.CREATED),
                Map.class);
        Number sessionId = (Number) created.get("id");
        Map<String, Object> asked = jsonMapper.readValue(
                postAs(
                        session,
                        "/api/projects/" + projectId + "/playground/sessions/" + sessionId + "/ask",
                        Map.of(
                                "question",
                                "api_key=sk-abcdefghijklmnopqrstuvwxyz012345 what does this do?",
                                "proposedSnippet",
                                "print(1)"),
                        HttpStatus.OK),
                Map.class);
        assertThat(asked.get("lastExplanation")).isEqualTo("mock explanation");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> claims = (List<Map<String, Object>>) asked.get("lastClaims");
        assertThat(claims).isNotEmpty();
        assertThat(mockAIProvider.lastUser())
                .contains("[REDACTED]")
                .doesNotContain("sk-abcdefghijklmnopqrstuvwxyz012345")
                .contains("PROPOSED_SNIPPET")
                .contains("was not executed")
                .contains("print(1)");
        assertThat(asked.get("proposedSnippet")).isEqualTo("print(1)");

        postAs(
                session,
                "/api/projects/" + projectId + "/playground/sessions",
                Map.of("selectedPaths", List.of("../etc/passwd")),
                HttpStatus.BAD_REQUEST);

        long foreign = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "pg-" + System.nanoTime());
        long otherProject = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'x', 'acme', 'x') returning id
                """, Long.class, foreign);
        getAs(session, "/api/projects/" + otherProject + "/playground/sessions", HttpStatus.NOT_FOUND);
    }

    @Test
    void growthAggregatesLearningWithoutAi() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        jdbcTemplate.update("insert into notes (project_id, title, content_md) values (?, 'n1', 'hello')", projectId);
        long taskId = jdbcTemplate.queryForObject("""
                insert into tasks (project_id, type, title, description, status, origin)
                values (?, 'LEARNING', 'Read App', '', 'DONE', 'USER')
                returning id
                """, Long.class, projectId);
        jdbcTemplate.update(
                "insert into learning_records (task_id, note) values (?, 'understood constructors')", taskId);
        Long snapshotId = jdbcTemplate.queryForObject(
                "select current_snapshot_id from projects where id = ?", Long.class, projectId);
        jdbcTemplate.update("""
                insert into analysis_findings (snapshot_id, category, severity, title, status)
                values (?, 'UNUSED', 'LOW', 'unused', 'OPEN')
                """, snapshotId);
        jdbcTemplate.update("""
                insert into analysis_findings (snapshot_id, category, severity, title, status)
                values (?, 'UNUSED', 'LOW', 'gone', 'DISMISSED')
                """, snapshotId);

        Map<String, Object> body = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/growth", HttpStatus.OK), Map.class);
        assertThat(body.get("notesCount")).isEqualTo(1);
        assertThat(body.get("learningRecords")).isEqualTo(1);
        assertThat(body.get("findingsOpen")).isEqualTo(1);
        assertThat(body.get("findingsDismissed")).isEqualTo(1);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> types = (List<Map<String, Object>>) body.get("tasksByType");
        Map<String, Object> learning = types.stream()
                .filter(row -> "LEARNING".equals(row.get("type")))
                .findFirst()
                .orElseThrow();
        assertThat(learning.get("done")).isEqualTo(1);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> recent = (List<Map<String, Object>>) body.get("recentRecords");
        assertThat(recent.getFirst().get("note")).isEqualTo("understood constructors");

        long foreign = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "g-" + System.nanoTime());
        long otherProject = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'x', 'acme', 'x') returning id
                """, Long.class, foreign);
        getAs(session, "/api/projects/" + otherProject + "/growth", HttpStatus.NOT_FOUND);
    }

    @Test
    void whatIfUsesImpactAndDoesNotExecuteCode() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        Long snapshotId = jdbcTemplate.queryForObject(
                "select current_snapshot_id from projects where id = ?", Long.class, projectId);
        Long fileId = jdbcTemplate.queryForObject(
                "select id from files where snapshot_id = ? and path = 'src/App.java'", Long.class, snapshotId);
        long leaf = jdbcTemplate.queryForObject("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id, line_start, metadata)
                values (?, 'METHOD', 'java:demo.C#c()', 'C', ?, 1, '{}'::jsonb) returning id
                """, Long.class, snapshotId, fileId);
        long caller = jdbcTemplate.queryForObject("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, metadata)
                values (?, 'METHOD', 'java:demo.B#b()', 'B', '{}'::jsonb) returning id
                """, Long.class, snapshotId);
        jdbcTemplate.update("""
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence, metadata)
                values (?, ?, ?, 'CALLS', 'CONFIRMED', '{}'::jsonb)
                """, snapshotId, caller, leaf);

        Map<String, Object> body = jsonMapper.readValue(
                postAs(
                        session,
                        "/api/projects/" + projectId + "/what-if",
                        Map.of("nodeId", leaf, "depth", 3),
                        HttpStatus.OK),
                Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> impact = (Map<String, Object>) body.get("impact");
        assertThat(((Number) impact.get("nodeId")).longValue()).isEqualTo(leaf);
        assertThat(body.get("explanation")).isEqualTo("mock explanation");
        assertThat(mockAIProvider.lastUser()).contains("WHAT_IF_NODE").contains("DEPENDENT");
        postAs(session, "/api/projects/" + projectId + "/what-if", Map.of(), HttpStatus.BAD_REQUEST);
        postAs(session, "/api/projects/" + projectId + "/what-if", Map.of("nodeId", 999999), HttpStatus.NOT_FOUND);
    }

    private void seedPull(long projectId, int number, String sha, String path) {
        jdbcTemplate.update("""
                insert into pull_requests (project_id, number, title, body, state, author, head_sha, base_sha)
                values (?, ?, 'Add login', 'changes App', 'open', 'octocat', ?, ?)
                """, projectId, number, sha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        Long commitId = jdbcTemplate.queryForObject("""
                insert into commits (project_id, sha, author, message, committed_at)
                values (?, ?, 'octocat', 'head', now()) returning id
                """, Long.class, projectId, sha);
        jdbcTemplate.update(
                "insert into commit_files (commit_id, path, change_type) values (?, ?, 'MODIFY')", commitId, path);
    }

    private long seedOwnedProject(ResponseCookie session, String path, String content) throws Exception {
        long userId = jdbcTemplate.queryForObject("select id from users where login = 'octocat'", Long.class);
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'demo', 'octocat', ?) returning id
                """, Long.class, userId, "demo-" + System.nanoTime());
        Path clone = root.resolve("data").resolve("repos").resolve(String.valueOf(projectId));
        Path file = clone.resolve(path);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'READY', now()) returning id
                """, Long.class, projectId);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        jdbcTemplate.update("""
                insert into files (snapshot_id, path, language, size, line_count, content_hash)
                values (?, ?, 'java', ?, 1, 'hash')
                """, snapshotId, path, content.getBytes(StandardCharsets.UTF_8).length);
        return projectId;
    }

    private byte[] postAs(ResponseCookie session, String uri, Map<String, Object> body, HttpStatus expected) {
        ResponseCookie csrf = primeCsrfToken();
        return restTestClient
                .post()
                .uri(uri)
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(body)
                .exchange()
                .expectStatus()
                .isEqualTo(expected)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
    }

    private byte[] getAs(ResponseCookie session, String uri, HttpStatus expected) {
        return restTestClient
                .get()
                .uri(uri)
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isEqualTo(expected)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
    }

    private ResponseCookie primeCsrfToken() {
        EntityExchangeResult<byte[]> result = restTestClient
                .get()
                .uri("/api/csrf")
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        ResponseCookie csrf = result.getResponseCookies().getFirst("XSRF-TOKEN");
        assertThat(csrf).isNotNull();
        return csrf;
    }

    private ResponseCookie loginWithPat() {
        ResponseCookie csrf = primeCsrfToken();
        EntityExchangeResult<byte[]> result = restTestClient
                .post()
                .uri("/api/auth/pat")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("token", FakeGithubApi.VALID_TOKEN))
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        ResponseCookie session = result.getResponseCookies().getFirst("SESSION");
        assertThat(session).isNotNull();
        return session;
    }
}
