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
class AiAskApiIntegrationTest {

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
    void statusReportsConfiguredMockWithoutKeys() {
        ResponseCookie session = loginWithPat();
        Map<String, Object> status = jsonMapper.readValue(getAs(session, "/api/ai/status", HttpStatus.OK), Map.class);
        assertThat(status.get("configured")).isEqualTo(true);
        assertThat(status.get("provider")).isEqualTo("mock");
        assertThat(status.toString()).doesNotContain("apiKey").doesNotContain("sk-");
    }

    @Test
    void askReturnsValidatedClaimsAndPersistsUsage() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        Map<String, Object> body = jsonMapper.readValue(
                postAsk(
                        session,
                        projectId,
                        Map.of("question", "이 파일 설명해줘", "focusedFile", "src/App.java", "intent", "EXPLAIN")),
                Map.class);
        assertThat(body.get("explanation")).isEqualTo("mock explanation");
        assertThat(body.get("conversationId")).isNotNull();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> claims = (List<Map<String, Object>>) body.get("claims");
        assertThat(claims).isNotEmpty();
        assertThat(claims.getFirst().get("confidence")).isEqualTo("CONFIRMED");
        @SuppressWarnings("unchecked")
        List<String> evidence = (List<String>) claims.getFirst().get("evidence");
        assertThat(evidence).contains("file:src/App.java:1");
        Integer usage = jdbcTemplate.queryForObject("select count(*) from ai_usage_logs", Integer.class);
        assertThat(usage).isGreaterThan(0);
    }

    @Test
    void brokenEvidenceIsDowngradedToUnknown() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        Map<String, Object> body = jsonMapper.readValue(
                postAsk(session, projectId, Map.of("question", "broken-ref please", "focusedFile", "src/App.java")),
                Map.class);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> claims = (List<Map<String, Object>>) body.get("claims");
        assertThat(claims.getFirst().get("confidence")).isEqualTo("UNKNOWN");
        @SuppressWarnings("unchecked")
        List<String> evidence = (List<String>) claims.getFirst().get("evidence");
        assertThat(evidence).isEmpty();
    }

    @Test
    void questionSecretsAreMaskedBeforeTheProvider() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        postAsk(
                session,
                projectId,
                Map.of(
                        "question",
                        "api_key=sk-abcdefghijklmnopqrstuvwxyz012345 explain",
                        "focusedFile",
                        "src/App.java"));
        assertThat(mockAIProvider.lastUser())
                .contains("[REDACTED]")
                .doesNotContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    }

    @Test
    void askIsOwnerScoped() throws Exception {
        ResponseCookie session = loginWithPat();
        long otherUser = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "other-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'x', 'acme', 'x') returning id
                """, Long.class, otherUser);
        postAsk(session, projectId, Map.of("question", "hello"), HttpStatus.NOT_FOUND);
    }

    @Test
    void streamEmitsTokenThenResult() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        ResponseCookie csrf = primeCsrfToken();
        byte[] body = restTestClient
                .post()
                .uri("/api/projects/" + projectId + "/ai/ask/stream")
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("question", "stream please", "focusedFile", "src/App.java"))
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
        String text = new String(body, StandardCharsets.UTF_8);
        assertThat(text).contains("event:token").contains("event:result").contains("mock explanation");
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

    private byte[] postAsk(ResponseCookie session, long projectId, Map<String, Object> body) {
        return postAsk(session, projectId, body, HttpStatus.OK);
    }

    private byte[] postAsk(ResponseCookie session, long projectId, Map<String, Object> body, HttpStatus expected) {
        ResponseCookie csrf = primeCsrfToken();
        return restTestClient
                .post()
                .uri("/api/projects/" + projectId + "/ai/ask")
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
