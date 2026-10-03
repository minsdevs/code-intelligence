package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.FakeGithubApi;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
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
 * Verifies the full flow: preview → select exclusions → prepare request plan → approved ask →
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

        // Step 2: Prepare and approve a request with the source excluded
        Map<String, Object> askBodyWithExclusion = Map.of(
                "question", "explain this file",
                "focusedFile", "src/Secret.java",
                "view", "code",
                "excludedContextIds", List.of(sourceId));
        postApprovedAsk(session, projectId, askBodyWithExclusion);

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
        postApprovedAsk(session, projectId, askBody);

        String promptSentToProvider = mockAIProvider.lastUser();
        assertThat(promptSentToProvider)
                .contains("VIEW:")
                .contains("FOCUS_FILE: src/App.java")
                .contains("SOURCE:");
    }

    @Test
    void omittedExclusionsRemainOptionalForApprovedRequests() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/Hello.java", "class Hello {}\n");

        // Exclusions remain optional; the request-plan approval is still required.
        Map<String, Object> askBody = Map.of(
                "question", "what is this",
                "focusedFile", "src/Hello.java");
        byte[] result = postApprovedAsk(session, projectId, askBody);
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

    @ParameterizedTest
    @ValueSource(strings = {"/ai/ask", "/ai/ask/stream", "/ai/preview"})
    void unknownExclusionReturnsConflictBeforeProviderCallsAndWrites(String endpoint) throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/Blocked.java", "class Blocked {}\n");
        String lastUser = mockAIProvider.lastUser();
        Map<String, Object> base = Map.of("question", "explain", "focusedFile", "src/Blocked.java");
        // A real approval lets this exercise stale exclusions rather than missing-token rejection.
        var body = new HashMap<>(endpoint.equals("/ai/preview") ? base : prepareBody(session, projectId, base));
        body.put("excludedContextIds", List.of("SOURCE:obsolete"));
        ResponseCookie csrf = primeCsrfToken();
        byte[] response = restTestClient
                .post()
                .uri("/api/projects/" + projectId + endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .accept(endpoint.endsWith("/stream") ? MediaType.TEXT_EVENT_STREAM : MediaType.APPLICATION_JSON)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(body)
                .exchange()
                .expectStatus()
                .isEqualTo(HttpStatus.CONFLICT)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();

        assertThat(jsonMapper.readValue(response, Map.class)).containsEntry("code", "AI_CONTEXT_CHANGED");
        assertThat(mockAIProvider.lastUser()).isEqualTo(lastUser);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from ai_usage_logs where project_id = ?", Long.class, projectId))
                .isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from ai_conversations where project_id = ?", Long.class, projectId))
                .isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from summaries s join snapshots n on n.id = s.snapshot_id where n.project_id = ?",
                        Long.class,
                        projectId))
                .isZero();
    }

    @Test
    void copyablePreviewHonorsExclusionsWithoutGeneratingSummaryOrUsage() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/Copy.java", "class CopyExcludedSentinel {}\n");
        Map<String, Object> body = Map.of("question", "explain", "focusedFile", "src/Copy.java", "view", "code");
        var first = jsonMapper.readValue(
                postJson(session, "/api/projects/" + projectId + "/ai/preview", body, HttpStatus.OK), Map.class);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) first.get("contextItems");
        String sourceId = (String) items.stream()
                .filter(item -> "SOURCE".equals(item.get("type")))
                .findFirst()
                .orElseThrow()
                .get("id");
        String lastUser = mockAIProvider.lastUser();
        var excludedBody = new java.util.HashMap<>(body);
        excludedBody.put("excludedContextIds", List.of(sourceId));

        var filtered = jsonMapper.readValue(
                postJson(session, "/api/projects/" + projectId + "/ai/preview", excludedBody, HttpStatus.OK),
                Map.class);

        assertThat((String) filtered.get("copyablePrompt"))
                .contains("VIEW: code")
                .doesNotContain("SOURCE:", "CopyExcludedSentinel");
        assertThat((List<?>) filtered.get("fileRefs")).isEmpty();
        assertThat(mockAIProvider.lastUser()).isEqualTo(lastUser);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from ai_usage_logs where project_id = ?", Long.class, projectId))
                .isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from summaries s join snapshots n on n.id = s.snapshot_id where n.project_id = ?",
                        Long.class,
                        projectId))
                .isZero();
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
        String commit;
        String hash;
        try (var git = Git.init().setDirectory(clone.toFile()).call();
                var formatter = new ObjectInserter.Formatter()) {
            git.add().addFilepattern(".").call();
            commit = git.commit()
                    .setMessage("Synthetic exclusion snapshot")
                    .setAuthor("Fixture", "fixture@example.invalid")
                    .setCommitter("Fixture", "fixture@example.invalid")
                    .call()
                    .name();
            hash = formatter
                    .idFor(Constants.OBJ_BLOB, content.getBytes(StandardCharsets.UTF_8))
                    .name();
        }
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, ?, 'READY', now()) returning id
                """, Long.class, projectId, commit);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        jdbcTemplate.update("""
                insert into files (snapshot_id, path, language, size, line_count, content_hash)
                values (?, ?, 'java', ?, 1, ?)
                """, snapshotId, path, content.getBytes(StandardCharsets.UTF_8).length, hash);
        return projectId;
    }

    private byte[] postApprovedAsk(ResponseCookie session, long projectId, Map<String, Object> body) {
        return postJson(
                session,
                "/api/projects/" + projectId + "/ai/ask",
                prepareBody(session, projectId, body),
                HttpStatus.OK);
    }

    private Map<String, Object> prepareBody(ResponseCookie session, long projectId, Map<String, Object> body) {
        byte[] raw = postJson(session, "/api/projects/" + projectId + "/ai/request-plan", body, HttpStatus.OK);
        Map<String, Object> prepared = jsonMapper.readValue(raw, Map.class);
        String token = (String) prepared.get("requestPlanToken");
        assertThat(token).isNotBlank();
        var approved = new HashMap<>(body);
        approved.put("requestPlanToken", token);
        return approved;
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
