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

/**
 * Integration test proving that excluded context items never reach the AI provider payload.
 * Verifies the full flow: preview → select exclusions → ask with excludedContextIds →
 * provider receives reduced context without the excluded items.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@AutoConfigureRestTestClient
@Import({TestcontainersConfiguration.class, MockAiTestConfig.class})
class AiExclusionIntegrationTest {

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
    void excludedContextItemsNeverReachProvider() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId =
                seedOwnedProject(session, "src/Secret.java", "class Secret { String apiKey = \"sk-test123\"; }\n");

        // Step 1: Preview to get context items with deterministic IDs
        Map<String, Object> previewBody = Map.of(
                "question", "explain this file",
                "focusedFile", "src/Secret.java",
                "view", "code");
        byte[] previewRaw = postJson(session, "/api/projects/" + projectId + "/ai/preview", previewBody, HttpStatus.OK);
        Map<String, Object> previewResult = jsonMapper.readValue(previewRaw, Map.class);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> contextItems = (List<Map<String, Object>>) previewResult.get("contextItems");
        assertThat(contextItems).isNotEmpty();

        // Find the SOURCE item ID to exclude
        String sourceId = null;
        for (Map<String, Object> item : contextItems) {
            if ("SOURCE".equals(item.get("type"))) {
                sourceId = (String) item.get("id");
                break;
            }
        }
        assertThat(sourceId)
                .as("Preview must return a SOURCE context item with an ID")
                .isNotNull();

        // Step 2: Ask WITH the source excluded
        Map<String, Object> askBodyWithExclusion = Map.of(
                "question", "explain this file",
                "focusedFile", "src/Secret.java",
                "view", "code",
                "excludedContextIds", List.of(sourceId));
        postJson(session, "/api/projects/" + projectId + "/ai/ask", askBodyWithExclusion, HttpStatus.OK);

        // Step 3: Verify that the SOURCE content was NOT sent to the provider
        String promptSentToProvider = mockAIProvider.lastUser();
        assertThat(promptSentToProvider)
                .as("Excluded SOURCE block must not appear in AI provider payload")
                .doesNotContain("SOURCE:")
                .doesNotContain("class Secret")
                .doesNotContain("sk-test123");
        // But VIEW and FOCUS_FILE should still be there
        assertThat(promptSentToProvider).contains("VIEW:").contains("FOCUS_FILE: src/Secret.java");
    }

    @Test
    void askWithoutExclusionsIncludesAllContext() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App { void run() {} }\n");

        // Ask WITHOUT exclusions — all context should reach the provider
        Map<String, Object> askBody = Map.of(
                "question", "explain this",
                "focusedFile", "src/App.java",
                "view", "code");
        postJson(session, "/api/projects/" + projectId + "/ai/ask", askBody, HttpStatus.OK);

        String promptSentToProvider = mockAIProvider.lastUser();
        assertThat(promptSentToProvider)
                .contains("VIEW:")
                .contains("FOCUS_FILE: src/App.java")
                .contains("SOURCE:");
    }

    @Test
    void emptyExclusionListPreservesBackwardCompatibility() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/Hello.java", "class Hello {}\n");

        // Old-style body without excludedContextIds field
        Map<String, Object> askBody = Map.of(
                "question", "what is this",
                "focusedFile", "src/Hello.java");
        byte[] result = postJson(session, "/api/projects/" + projectId + "/ai/ask", askBody, HttpStatus.OK);
        Map<String, Object> response = jsonMapper.readValue(result, Map.class);
        assertThat(response.get("explanation")).isNotNull();
    }

    @Test
    void previewContextItemsHaveDeterministicIds() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/Stable.java", "class Stable {}\n");

        Map<String, Object> body = Map.of(
                "question", "explain",
                "focusedFile", "src/Stable.java",
                "view", "code");

        // Call preview twice — IDs must be the same
        byte[] raw1 = postJson(session, "/api/projects/" + projectId + "/ai/preview", body, HttpStatus.OK);
        byte[] raw2 = postJson(session, "/api/projects/" + projectId + "/ai/preview", body, HttpStatus.OK);

        Map<String, Object> result1 = jsonMapper.readValue(raw1, Map.class);
        Map<String, Object> result2 = jsonMapper.readValue(raw2, Map.class);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items1 = (List<Map<String, Object>>) result1.get("contextItems");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items2 = (List<Map<String, Object>>) result2.get("contextItems");

        assertThat(items1).hasSameSizeAs(items2);
        for (int i = 0; i < items1.size(); i++) {
            assertThat(items1.get(i).get("id"))
                    .as("Context item ID must be deterministic across calls (item %d)", i)
                    .isEqualTo(items2.get(i).get("id"));
        }
    }

    private long seedOwnedProject(ResponseCookie session, String path, String content) throws Exception {
        long userId = jdbcTemplate.queryForObject("select id from users where login = 'octocat'", Long.class);
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'excl-test', 'octocat', ?) returning id
                """, Long.class, userId, "excl-" + System.nanoTime());
        Path clone = root.resolve("data").resolve("repos").resolve(String.valueOf(projectId));
        Path file = clone.resolve(path);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'READY', now()) returning id
                """, Long.class, projectId);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        jdbcTemplate.update("""
                insert into files (snapshot_id, path, language, size, line_count, content_hash)
                values (?, ?, 'java', ?, 1, 'hash')
                """, snapshotId, path, content.getBytes(StandardCharsets.UTF_8).length);
        return projectId;
    }

    private byte[] postJson(ResponseCookie session, String uri, Map<String, Object> body, HttpStatus expected) {
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
