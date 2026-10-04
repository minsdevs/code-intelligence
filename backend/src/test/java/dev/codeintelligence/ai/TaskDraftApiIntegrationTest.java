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
class TaskDraftApiIntegrationTest {

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

    @Test
    void retiredGeneratorDoesNotCreateTasksAndStoredAnalysisDraftRemainsUsable() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject("src/App.java", "class App {}\n");
        long snapshotId = jdbcTemplate.queryForObject(
                "select current_snapshot_id from projects where id = ?", Long.class, projectId);
        long findingId = jdbcTemplate.queryForObject("""
                insert into analysis_findings (snapshot_id, category, severity, title, detail)
                values (?, 'UNMATCHED_API_CALL', 'HIGH', 'Unmatched GET /api/missing', 'No backend endpoint')
                returning id
                """, Long.class, snapshotId);
        send(
                session,
                "POST",
                "/api/projects/" + projectId + "/findings/" + findingId + "/task-draft",
                Map.of(),
                HttpStatus.NOT_FOUND);
        long storedTaskId = jdbcTemplate.queryForObject("""
                insert into tasks (project_id, type, title, description, status, origin, source_finding_id)
                values (?, 'REVIEW', 'Review unmatched API call', 'Retained analysis draft', 'DRAFT', 'AI', ?) returning id
                """, Long.class, projectId, findingId);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from ai_usage_logs where project_id = ?", Long.class, projectId))
                .isZero();

        List<Map<String, Object>> listed = jsonMapper.readValue(
                send(session, "GET", "/api/projects/" + projectId + "/tasks", null, HttpStatus.OK), List.class);
        assertThat(listed).extracting(row -> row.get("title")).doesNotContain("Review unmatched API call");

        Number taskId = storedTaskId;
        Map<String, Object> approved = jsonMapper.readValue(
                send(
                        session,
                        "POST",
                        "/api/projects/" + projectId + "/tasks/" + taskId.longValue() + "/approve",
                        Map.of(),
                        HttpStatus.OK),
                Map.class);
        assertThat(approved.get("status")).isEqualTo("OPEN");
        List<Map<String, Object>> after = jsonMapper.readValue(
                send(session, "GET", "/api/projects/" + projectId + "/tasks", null, HttpStatus.OK), List.class);
        assertThat(after).extracting(row -> row.get("title")).contains("Review unmatched API call");
    }

    @Test
    void taskDraftIsOwnerScoped() throws Exception {
        ResponseCookie session = loginWithPat();
        long otherUser = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "other-" + System.nanoTime());
        long foreign = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'x', 'acme', 'x') returning id
                """, Long.class, otherUser);
        send(session, "POST", "/api/projects/" + foreign + "/findings/1/task-draft", Map.of(), HttpStatus.NOT_FOUND);
    }

    private long seedOwnedProject(String path, String content) throws Exception {
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

    private byte[] send(ResponseCookie session, String method, String uri, Object body, HttpStatus expected) {
        if ("GET".equals(method) || "HEAD".equals(method)) {
            return restTestClient
                    .method(org.springframework.http.HttpMethod.valueOf(method))
                    .uri(uri)
                    .cookie("SESSION", session.getValue())
                    .exchange()
                    .expectStatus()
                    .isEqualTo(expected)
                    .expectBody()
                    .returnResult()
                    .getResponseBodyContent();
        }
        ResponseCookie csrf = primeCsrfToken();
        var spec = restTestClient
                .method(org.springframework.http.HttpMethod.valueOf(method))
                .uri(uri)
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue());
        var exchanged = body == null ? spec.exchange() : spec.body(body).exchange();
        return exchanged
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
