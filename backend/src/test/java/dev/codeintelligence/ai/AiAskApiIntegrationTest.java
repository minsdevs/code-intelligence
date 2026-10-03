package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessException;
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

    @Autowired
    private SummaryService summaryService;

    @Autowired
    private AssistantService assistantService;

    @Autowired
    private AiRequestPlanService plans;

    @Autowired
    private AiUsageService usageService;

    @Autowired
    private org.springframework.transaction.support.TransactionTemplate transactions;

    @Test
    void usageIsCommittedEvenWhenCallingTransactionRollsBack() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        long userId = jdbcTemplate.queryForObject("select user_id from projects where id = ?", Long.class, projectId);
        transactions.executeWithoutResult(status -> {
            usageService.chat(
                    userId, projectId, mockAIProvider, "test", new AIProvider.ChatRequest("system", "question", true));
            status.setRollbackOnly();
        });
        assertThat(jdbcTemplate.queryForObject(
                        "select sum(prompt_tokens + completion_tokens) from ai_usage_logs where project_id = ?",
                        Long.class,
                        projectId))
                .isEqualTo(20L);
    }

    @Test
    void fileSummaryCountsOnceAndCacheHitDoesNotSpendAgain() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        long userId = jdbcTemplate.queryForObject("select user_id from projects where id = ?", Long.class, projectId);
        long snapshotId = jdbcTemplate.queryForObject(
                "select current_snapshot_id from projects where id = ?", Long.class, projectId);
        assertThat(summaryService.ensureFileSummary(userId, snapshotId, "src/App.java", "class App {}"))
                .isPresent();
        assertThat(summaryService.ensureFileSummary(userId, snapshotId, "src/App.java", "class App {}"))
                .isPresent();
        assertThat(jdbcTemplate.queryForObject(
                        "select sum(prompt_tokens + completion_tokens) from ai_usage_logs where project_id = ? and purpose = 'summary'",
                        Long.class,
                        projectId))
                .isEqualTo(20L);
    }

    @Test
    void completedProviderUsageSurvivesEvidenceValidationFailure() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        long userId = jdbcTemplate.queryForObject("select user_id from projects where id = ?", Long.class, projectId);
        // The local mock echoes this numeric reference; validation overflows after the provider returned.
        var request = prepareRequest(
                projectId,
                userId,
                new AssistantService.AskRequest(
                        null, "file:src/App.java:999999999999999999999", "EXPLAIN", null, null));
        assertThatThrownBy(() -> assistantService.ask(projectId, userId, request))
                .isInstanceOf(NumberFormatException.class);
        assertThat(jdbcTemplate.queryForObject(
                        "select sum(prompt_tokens + completion_tokens) from ai_usage_logs where project_id = ?",
                        Long.class,
                        projectId))
                .isEqualTo(20L);
    }

    @Test
    void completedProviderUsageSurvivesAnswerPersistenceFailure() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        long userId = jdbcTemplate.queryForObject("select user_id from projects where id = ?", Long.class, projectId);
        var request = prepareRequest(
                projectId,
                userId,
                new AssistantService.AskRequest(null, "Explain this project", "EXPLAIN", null, null));
        // Invalid conversations now fail before spending. Inject an actual answer-write failure
        // after a valid approval instead, preserving this test's durable-usage contract.
        jdbcTemplate.execute("""
                create function ci_answer_write_failure() returns trigger language plpgsql as $$
                begin
                  if new.role='ASSISTANT' and exists(select 1 from ai_conversations
                      where id=new.conversation_id and project_id=%d) then
                    raise exception 'Synthetic answer write failure';
                  end if;
                  return new;
                end $$
                """.formatted(projectId));
        try {
            jdbcTemplate.execute("create trigger ci_answer_write_failure before insert on ai_messages "
                    + "for each row execute function ci_answer_write_failure()");
            assertThatThrownBy(() -> assistantService.ask(projectId, userId, request))
                    .isInstanceOf(DataAccessException.class);
        } finally {
            jdbcTemplate.execute("drop trigger if exists ci_answer_write_failure on ai_messages");
            jdbcTemplate.execute("drop function if exists ci_answer_write_failure()");
        }
        assertThat(jdbcTemplate.queryForObject(
                        "select sum(prompt_tokens + completion_tokens) from ai_usage_logs where project_id = ?",
                        Long.class,
                        projectId))
                .isEqualTo(20L);
    }

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
    void askAttachesFocusedNoteAndTask() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        long noteId = jdbcTemplate.queryForObject(
                "insert into notes (project_id, title, content_md) values (?, 'Auth notes', 'See src/App.java login flow') returning id",
                Long.class,
                projectId);
        long taskId = jdbcTemplate.queryForObject("""
                insert into tasks (project_id, type, title, description, status, origin)
                values (?, 'LEARNING', 'Read App', 'open src/App.java', 'OPEN', 'USER')
                returning id
                """, Long.class, projectId);
        postAsk(
                session,
                projectId,
                Map.of(
                        "question",
                        "현재 코드 기준으로 설명해줘",
                        "focusedFile",
                        "src/App.java",
                        "focusedNoteId",
                        noteId,
                        "focusedTaskId",
                        taskId));
        assertThat(mockAIProvider.lastUser())
                .contains("FOCUS_NOTE: Auth notes")
                .contains("FOCUS_TASK:")
                .contains("Read App")
                .contains("RELATED_NOTE: Auth notes");
    }

    @Test
    void semanticSearchDoesNotMixEmbeddingModels() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.java", "class App {}\n");
        long userId = jdbcTemplate.queryForObject("select id from users where login = 'octocat'", Long.class);
        long snapshotId = jdbcTemplate.queryForObject(
                "select current_snapshot_id from projects where id = ?", Long.class, projectId);
        String vector = SummaryService.toVectorLiteral(mockAIProvider.embed("query"));
        jdbcTemplate.update("""
                insert into summaries
                    (snapshot_id, subject_type, subject_id, level, content, embedding, model, embedding_model)
                values (?, 'FILE', 1001, 'FILE', 'compatible summary', ?::vector, 'mock-chat', 'mock:mock-embedding'),
                       (?, 'FILE', 1002, 'FILE', 'incompatible summary', ?::vector, 'other-chat', 'other:embedding')
                """, snapshotId, vector, snapshotId, vector);

        List<String> results = summaryService.similar(userId, snapshotId, "query", 5);

        assertThat(results).contains("compatible summary").doesNotContain("incompatible summary");
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
        var request =
                prepareBody(session, projectId, Map.of("question", "stream please", "focusedFile", "src/App.java"));
        ResponseCookie csrf = primeCsrfToken();
        byte[] body = restTestClient
                .post()
                .uri("/api/projects/" + projectId + "/ai/ask/stream")
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(request)
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
        String commit;
        String hash;
        try (var git = Git.init().setDirectory(clone.toFile()).call();
                var formatter = new ObjectInserter.Formatter()) {
            git.add().addFilepattern(".").call();
            commit = git.commit()
                    .setMessage("Synthetic AI request snapshot")
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

    private AssistantService.AskRequest prepareRequest(
            long projectId, long userId, AssistantService.AskRequest request) {
        var prepared = plans.prepare(projectId, userId, request);
        return new AssistantService.AskRequest(
                request.conversationId(),
                request.question(),
                request.intent(),
                request.context(),
                request.excludedContextIds(),
                prepared.requestPlanToken());
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

    private byte[] postAsk(ResponseCookie session, long projectId, Map<String, Object> body) {
        return postAsk(session, projectId, prepareBody(session, projectId, body), HttpStatus.OK);
    }

    private byte[] postAsk(ResponseCookie session, long projectId, Map<String, Object> body, HttpStatus expected) {
        return postJson(session, "/api/projects/" + projectId + "/ai/ask", body, expected);
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
