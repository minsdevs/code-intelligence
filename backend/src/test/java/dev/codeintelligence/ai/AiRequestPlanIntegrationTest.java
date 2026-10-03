package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.codeintelligence.TestcontainersConfiguration;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.client.EntityExchangeResult;
import org.springframework.test.web.servlet.client.RestTestClient;
import tools.jackson.databind.json.JsonMapper;

/**
 * Real HTTP/session/CSRF and disposable PostgreSQL tests of prepare -> approve -> one send.
 * Source files are real temporary Git objects. Only the AI provider is a local spy; its helpers
 * must never run during approval assembly. The two-user GitHub stand-in binds only to loopback.
 * Expiry, clock changes and new-process invalidation belong to AiRequestPlanStoreTest.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.auth.pat-login-max-attempts=200"
        })
@AutoConfigureRestTestClient
@Import({TestcontainersConfiguration.class, MockAiTestConfig.class})
@Timeout(30)
class AiRequestPlanIntegrationTest {

    private static final TwoUserGithub GITHUB = new TwoUserGithub();
    private static final String SOURCE = "src/App.java";
    private static final String OTHER_SOURCE = "src/Other.java";
    private static final String SOURCE_TEXT = "class App { String name = \"approved-source\"; }\n";
    private static final String SYNTHETIC_KEY = "sk-publicSyntheticRequestPlanKey0123456789";

    @TempDir
    static Path root;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.github.base-url", GITHUB::baseUrl);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
    }

    @AfterAll
    static void closeGithub() {
        GITHUB.close();
    }

    @Autowired
    private RestTestClient http;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private JsonMapper json;

    @MockitoSpyBean
    private MockAIProvider provider;

    @MockitoSpyBean
    private AiMainGatewayClient mainGateway;

    @MockitoSpyBean
    private AiDesktopGateway desktopGateway;

    @Value("${local.server.port}")
    private int port;

    private ResponseCookie session;
    private long userId;

    @BeforeEach
    void resetOnlyThisTestUserAndProvider() {
        reset(provider);
        reset(mainGateway);
        reset(desktopGateway);
        session = login(TwoUserGithub.OWNER_TOKEN);
        userId = jdbc.queryForObject("select id from users where github_id=?", Long.class, TwoUserGithub.OWNER_ID);
        jdbc.update("delete from user_ai_settings where user_id=?", userId);
        jdbc.update("delete from user_ai_preferences where user_id=?", userId);
    }

    @Test
    void repeatedUnavailableQuotesDoNotConsumeApprovalCapacity() throws Exception {
        Fixture fixture = fixture(userId);
        doReturn(true).when(desktopGateway).enabled();
        doThrow(new AiSafetyUnavailableException())
                .when(desktopGateway)
                .quote(
                        anyLong(),
                        anyLong(),
                        anyLong(),
                        anyLong(),
                        anyString(),
                        anyString(),
                        anyString(),
                        anyString(),
                        any(),
                        any());

        for (int attempt = 0; attempt < 40; attempt++) {
            Map<String, Object> failure = post(fixture, "/request-plan", body(), HttpStatus.SERVICE_UNAVAILABLE);
            assertThat(failure).containsEntry("code", "DESKTOP_AI_SAFETY_UNAVAILABLE");
            assertThat(failure).doesNotContainKeys("requestPlanToken", "cost");
        }
        verify(desktopGateway, times(40))
                .quote(
                        anyLong(),
                        anyLong(),
                        anyLong(),
                        anyLong(),
                        anyString(),
                        anyString(),
                        anyString(),
                        anyString(),
                        any(),
                        any());

        doReturn(false).when(desktopGateway).enabled();
        Map<String, Object> recovered = prepare(fixture, body());
        assertThat(recovered.get("requestPlanToken")).asString().matches("[0-9a-f]{64}");
        assertThat(recovered).containsEntry("costStatus", "UNAVAILABLE");
        assertNoProviderCalls();
        verify(mainGateway, never()).exchange(anyString(), any());
        assertNoAiWrites(fixture);
    }

    @Test
    void planIsLocalOnlyAndOneApprovalSendsExactlyTheReviewedPayload() throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> body = body();

        Map<String, Object> plan = prepare(fixture, body);

        assertThat(plan.get("requestPlanToken")).asString().matches("[0-9a-f]{64}");
        assertThat(UUID.fromString((String) plan.get("requestId"))).isNotNull();
        assertThat(Instant.parse((String) plan.get("expiresAt"))).isAfter(Instant.now());
        assertThat(((Number) plan.get("snapshotId")).longValue()).isEqualTo(fixture.snapshotId());
        assertThat(plan)
                .containsEntry("provider", "mock")
                .containsEntry("model", "mock-chat")
                .containsEntry("intent", "EXPLAIN")
                .containsEntry("costStatus", "UNAVAILABLE");
        assertThat(plan.get("payloadSha256")).asString().matches("[0-9a-f]{64}");
        assertThat(plan.get("systemPrompt")).asString().isNotBlank();
        assertThat(plan.get("userPrompt")).asString().contains("SOURCE:", "approved-source");
        assertThat(items(plan)).anyMatch(item -> "SOURCE".equals(item.get("type")));
        assertThat(strings(plan, "fileRefs")).contains("file:" + SOURCE + ":1");
        assertNoProviderCalls();
        assertNoAiWrites(fixture);

        Map<String, Object> answer = post(fixture, "/ask", approved(body, plan), HttpStatus.OK);

        assertThat(answer.get("explanation")).isEqualTo("mock explanation");
        ArgumentCaptor<AIProvider.ChatRequest> sent = ArgumentCaptor.forClass(AIProvider.ChatRequest.class);
        verify(provider, times(1)).chat(sent.capture());
        assertThat(sent.getValue().system()).isEqualTo(plan.get("systemPrompt"));
        assertThat(sent.getValue().user()).isEqualTo(plan.get("userPrompt"));
        assertThat(sent.getValue().jsonMode()).isTrue();
        assertNoHelperCalls();
        assertThat(summaryCount(fixture)).isZero();
        assertThat(usageCount(fixture)).isEqualTo(1);
        assertThat(messageCount(fixture)).isEqualTo(2);

        assertConflict(post(fixture, "/ask", approved(body, plan), HttpStatus.CONFLICT));
        verify(provider, times(1)).chat(any());
        assertThat(usageCount(fixture)).isEqualTo(1);
        assertThat(messageCount(fixture)).isEqualTo(2);
    }

    @Test
    void selectedExclusionsAreReflectedInBothThePlanAndTheOnlyProviderCall() throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> preview = post(fixture, "/preview", body(), HttpStatus.OK);
        Map<String, Object> body = body();
        body.put("excludedContextIds", List.of(itemId(preview, "SOURCE")));
        Map<String, Object> plan = prepare(fixture, body);

        assertThat(items(plan)).noneMatch(item -> "SOURCE".equals(item.get("type")));
        assertThat(plan.get("userPrompt")).asString().doesNotContain("SOURCE:", "approved-source");
        assertThat(strings(plan, "fileRefs")).isEmpty();
        assertNoProviderCalls();
        assertNoAiWrites(fixture);

        post(fixture, "/ask", approved(body, plan), HttpStatus.OK);
        assertThat(provider.lastUser()).isEqualTo(plan.get("userPrompt"));
        verify(provider, times(1)).chat(any());
        assertNoHelperCalls();
    }

    @ParameterizedTest
    @ValueSource(strings = {"changed-note", "added-note", "added-summary", "changed-summary", "missing-source"})
    void changedOrNewIncludedContextRequiresFreshApprovalEvenWithoutAnyExclusions(String change) throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> body = body();
        long note = note(fixture, "Initial focused note", "original focused-note content");
        body.put("focusedNoteId", note);
        if (change.equals("changed-summary")) cache(fixture, "original included summary");
        Map<String, Object> plan = prepare(fixture, body);
        assertThat(items(plan)).anyMatch(item -> "SOURCE".equals(item.get("type")));
        assertThat(body.get("excludedContextIds")).isEqualTo(List.of());

        switch (change) {
            case "changed-note" ->
                jdbc.update("update notes set content_md='changed included note', updated_at=now() where id=?", note);
            case "added-note" -> note(fixture, "New related context", "Read " + SOURCE);
            case "added-summary" -> cache(fixture, "newly available summary");
            case "changed-summary" ->
                jdbc.update(
                        "update summaries set content='changed included summary' where snapshot_id=?",
                        fixture.snapshotId());
            case "missing-source" ->
                Files.move(fixture.clonePath().resolve(".git"), root.resolve("held-git-" + UUID.randomUUID()));
            default -> throw new AssertionError(change);
        }

        long summariesBeforeSend = summaryCount(fixture);
        assertConflict(post(fixture, "/ask", approved(body, plan), HttpStatus.CONFLICT));
        assertNoProviderCalls();
        assertThat(summaryCount(fixture)).isEqualTo(summariesBeforeSend);
        assertThat(usageCount(fixture)).isZero();
        assertThat(messageCount(fixture)).isZero();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "question",
                "masked-question",
                "intent",
                "view",
                "focusedFile",
                "focusedNodeId",
                "focusedCommitSha",
                "focusedFindingId",
                "focusedNoteId",
                "focusedTaskId",
                "selectedAreas",
                "conversationId",
                "excludedContextIds"
            })
    void requestFieldsCannotBeChangedAfterApproval(String field) throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> original = body();
        if (field.equals("masked-question")) original.put("question", "Explain api_key=" + SYNTHETIC_KEY);
        Map<String, Object> plan = prepare(fixture, original);
        Map<String, Object> altered = approved(original, plan);
        switch (field) {
            case "question" -> altered.put("question", "Explain something different");
            // Two raw questions redact to the same displayed prompt; consent still binds the input.
            case "masked-question" ->
                altered.put("question", "Explain api_key=sk-otherPublicSyntheticRequestPlanKey0123456789");
            case "intent" -> altered.put("intent", "WHY");
            case "view" -> altered.put("view", "architecture");
            case "focusedFile" -> altered.put("focusedFile", OTHER_SOURCE);
            case "focusedNodeId", "focusedFindingId", "focusedTaskId" -> altered.put(field, Long.MAX_VALUE);
            case "focusedCommitSha" -> altered.put(field, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
            case "focusedNoteId" -> altered.put(field, note(fixture, "Different focus", "synthetic note"));
            case "selectedAreas" -> altered.put(field, List.of("backend"));
            case "conversationId" -> altered.put(field, conversation(fixture));
            case "excludedContextIds" -> altered.put(field, List.of(itemId(plan, "SOURCE")));
            default -> throw new AssertionError(field);
        }

        assertConflict(post(fixture, "/ask", altered, HttpStatus.CONFLICT));
        assertNoProviderCalls();
        assertNoAiWrites(fixture);
    }

    @Test
    void approvalForAnotherOwnedProjectCannotBeReused() throws Exception {
        Fixture first = fixture(userId);
        Fixture second = fixture(userId);
        Map<String, Object> plan = prepare(first, body());

        assertConflict(post(second, "/ask", approved(body(), plan), HttpStatus.CONFLICT));

        assertNoProviderCalls();
        assertNoAiWrites(first);
        assertNoAiWrites(second);
    }

    @Test
    void advancingCurrentSnapshotInvalidatesTheOldPlan() throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> plan = prepare(fixture, body());
        // Identical source content still belongs to a different analyzed snapshot identity.
        long next = jdbc.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, ?, 'READY', now()) returning id
                """, Long.class, fixture.projectId(), fixture.commitSha());
        jdbc.update("""
                insert into files (snapshot_id,path,language,size,line_count,content_hash)
                select ?,path,language,size,line_count,content_hash from files where snapshot_id=?
                """, next, fixture.snapshotId());
        jdbc.update("update projects set current_snapshot_id=? where id=?", next, fixture.projectId());

        assertConflict(post(fixture, "/ask", approved(body(), plan), HttpStatus.CONFLICT));

        assertNoProviderCalls();
        assertNoAiWrites(fixture);
    }

    @ParameterizedTest
    @ValueSource(strings = {"provider", "model", "settings-revision"})
    void providerModelAndSettingsRevisionAreBoundToThePlan(String change) throws Exception {
        Fixture fixture = fixture(userId);
        jdbc.update("insert into user_ai_preferences (user_id,revision) values (?,7)", userId);
        Map<String, Object> plan = prepare(fixture, body());
        switch (change) {
            case "provider" -> doReturn("different-mock").when(provider).name();
            case "model" -> doReturn("different-mock-chat").when(provider).model();
            case "settings-revision" ->
                jdbc.update("update user_ai_preferences set revision=revision+1 where user_id=?", userId);
            default -> throw new AssertionError(change);
        }

        assertConflict(post(fixture, "/ask", approved(body(), plan), HttpStatus.CONFLICT));

        assertNoProviderCalls();
        assertNoAiWrites(fixture);
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "unknown", "blank", "malformed"})
    void bothAskRoutesRejectUnapprovedRequestsBeforeAnyProviderOrAiWrite(String token) throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> request = body();
        if (!token.equals("missing"))
            request.put(
                    "requestPlanToken",
                    switch (token) {
                        case "unknown" -> "0".repeat(64);
                        case "blank" -> "";
                        default -> "not-a-plan";
                    });

        for (String route : List.of("/ask", "/ask/stream")) {
            assertConflict(post(fixture, route, request, HttpStatus.CONFLICT));
        }

        assertNoProviderCalls();
        assertNoAiWrites(fixture);
    }

    @Test
    void streamConsumesTheSameOneUseApprovalAsOrdinaryAsk() throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> plan = prepare(fixture, body());
        String stream = rawPost(session, fixture.projectId(), "/ask/stream", approved(body(), plan), HttpStatus.OK);

        assertThat(stream).contains("event:token", "event:result", "mock explanation");
        assertConflict(post(fixture, "/ask", approved(body(), plan), HttpStatus.CONFLICT));
        verify(provider, times(1)).chat(any());
        assertNoHelperCalls();
        assertThat(usageCount(fixture)).isEqualTo(1);
        assertThat(messageCount(fixture)).isEqualTo(2);
    }

    @Test
    void twoConcurrentRequestsWithOneTokenDispatchExactlyOnce() throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> plan = prepare(fixture, body());
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch start = new CountDownLatch(1);
        doAnswer(invocation -> {
                    entered.countDown();
                    if (!release.await(10, TimeUnit.SECONDS))
                        throw new AssertionError("Provider fixture was not released");
                    return invocation.callRealMethod();
                })
                .when(provider)
                .chat(any());
        ResponseCookie csrf = csrf();
        HttpRequest request = HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/projects/" + fixture.projectId() + "/ai/ask"))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .header("Cookie", "SESSION=" + session.getValue() + "; XSRF-TOKEN=" + csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(approved(body(), plan))))
                .build();

        try (var client = HttpClient.newHttpClient();
                var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var completed = new ExecutorCompletionService<HttpResponse<String>>(executor);
            for (int index = 0; index < 2; index++)
                completed.submit(() -> {
                    assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
                    return client.send(request, HttpResponse.BodyHandlers.ofString());
                });
            start.countDown();
            try {
                assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
                var rejected = completed.poll(10, TimeUnit.SECONDS);
                assertThat(rejected)
                        .as("The duplicate must be rejected while the first provider call is blocked")
                        .isNotNull();
                HttpResponse<String> duplicate = rejected.get();
                assertThat(duplicate.statusCode()).isEqualTo(409);
                assertConflict(read(duplicate.body()));
            } finally {
                release.countDown();
            }
            var accepted = completed.poll(10, TimeUnit.SECONDS);
            assertThat(accepted).isNotNull();
            assertThat(accepted.get().statusCode()).isEqualTo(200);
        } finally {
            start.countDown();
            release.countDown();
        }

        verify(provider, times(1)).chat(any());
        assertNoHelperCalls();
        assertThat(usageCount(fixture)).isEqualTo(1);
        assertThat(messageCount(fixture)).isEqualTo(2);
    }

    @Test
    void providerFailureConsumesApprovalAndRetryDoesNotCallProviderAgain() throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> plan = prepare(fixture, body());
        doThrow(new AiProviderException(new IllegalStateException("public synthetic provider failure")))
                .when(provider)
                .chat(any());

        post(fixture, "/ask", approved(body(), plan), HttpStatus.BAD_GATEWAY);
        assertConflict(post(fixture, "/ask", approved(body(), plan), HttpStatus.CONFLICT));
        assertConflict(post(fixture, "/ask/stream", approved(body(), plan), HttpStatus.CONFLICT));

        verify(provider, times(1)).chat(any());
        assertNoHelperCalls();
        assertNoAiWrites(fixture);
    }

    @Test
    void otherUserCannotReadThePlanOrConsumeAnOwnersToken() throws Exception {
        Fixture owned = fixture(userId);
        Map<String, Object> plan = prepare(owned, body());
        ResponseCookie other = login(TwoUserGithub.OTHER_TOKEN);
        long otherId =
                jdbc.queryForObject("select id from users where github_id=?", Long.class, TwoUserGithub.OTHER_ID);
        Fixture otherProject = fixture(otherId);

        rawPost(other, owned.projectId(), "/request-plan", body(), HttpStatus.NOT_FOUND);
        rawPost(other, owned.projectId(), "/ask", approved(body(), plan), HttpStatus.NOT_FOUND);
        assertConflict(
                read(rawPost(other, otherProject.projectId(), "/ask", approved(body(), plan), HttpStatus.CONFLICT)));
        assertNoProviderCalls();
        assertNoAiWrites(owned);
        assertNoAiWrites(otherProject);

        // A different user's failed attempt cannot consume the legitimate owner's approval.
        post(owned, "/ask", approved(body(), plan), HttpStatus.OK);
        verify(provider, times(1)).chat(any());
        assertNoHelperCalls();
    }

    @Test
    void invalidOrUnownedConversationCannotCreateAPlanOrReachEitherDispatchPath() throws Exception {
        Fixture owned = fixture(userId);
        Fixture otherProject = fixture(userId);
        long wrongProject = conversation(otherProject);
        login(TwoUserGithub.OTHER_TOKEN);
        long otherUser =
                jdbc.queryForObject("select id from users where github_id=?", Long.class, TwoUserGithub.OTHER_ID);
        // Keep the project identical so this case independently requires the user predicate.
        long wrongOwner = conversation(owned);
        jdbc.update("update ai_conversations set user_id=? where id=?", otherUser, wrongOwner);

        for (long conversationId : List.of(Long.MAX_VALUE, wrongProject, wrongOwner)) {
            Map<String, Object> request = body();
            request.put("conversationId", conversationId);
            Map<String, Object> rejected = post(owned, "/request-plan", request, HttpStatus.NOT_FOUND);
            assertThat(rejected).containsEntry("detail", "Conversation not found.");
            assertThat(rejected).doesNotContainKeys("requestPlanToken", "cost");
        }

        assertNoProviderCalls();
        verify(mainGateway, never()).exchange(anyString(), any());
        assertNoAiWrites(owned);
        assertNoAiWrites(otherProject);
    }

    @Test
    void deletingAnApprovedConversationFailsBeforeProviderOrMainDispatch() throws Exception {
        Fixture fixture = fixture(userId);
        long conversationId = conversation(fixture);
        Map<String, Object> request = body();
        request.put("conversationId", conversationId);
        Map<String, Object> plan = prepare(fixture, request);
        assertNoProviderCalls();

        assertThat(jdbc.update("delete from ai_conversations where id=?", conversationId))
                .isEqualTo(1);
        Map<String, Object> rejected = post(fixture, "/ask", approved(request, plan), HttpStatus.NOT_FOUND);

        assertThat(rejected).containsEntry("detail", "Conversation not found.");
        assertNoProviderCalls();
        verify(mainGateway, never()).exchange(anyString(), any());
        assertNoAiWrites(fixture);
    }

    @Test
    void changingAnApprovedConversationOwnerFailsBeforeProviderOrMainDispatch() throws Exception {
        Fixture fixture = fixture(userId);
        long conversationId = conversation(fixture);
        Map<String, Object> request = body();
        request.put("conversationId", conversationId);
        Map<String, Object> plan = prepare(fixture, request);
        login(TwoUserGithub.OTHER_TOKEN);
        long otherUser =
                jdbc.queryForObject("select id from users where github_id=?", Long.class, TwoUserGithub.OTHER_ID);
        assertThat(jdbc.update("update ai_conversations set user_id=? where id=?", otherUser, conversationId))
                .isEqualTo(1);

        Map<String, Object> rejected = post(fixture, "/ask", approved(request, plan), HttpStatus.NOT_FOUND);

        assertThat(rejected).containsEntry("detail", "Conversation not found.");
        assertNoProviderCalls();
        verify(mainGateway, never()).exchange(anyString(), any());
        assertNoAiWrites(fixture);
    }

    @Test
    void syntheticCredentialAndApprovalTokenAreAbsentFromProviderResponsesAndPersistedMessages() throws Exception {
        Fixture fixture = fixture(userId);
        Map<String, Object> body = body();
        body.put("question", "Explain api_key=" + SYNTHETIC_KEY + " without exposing it");
        Map<String, Object> plan = prepare(fixture, body);
        String token = (String) plan.get("requestPlanToken");
        assertThat(json.writeValueAsString(plan)).doesNotContain(SYNTHETIC_KEY);
        assertThat(plan.get("userPrompt")).asString().contains("[REDACTED]");

        Map<String, Object> answer = post(fixture, "/ask", approved(body, plan), HttpStatus.OK);
        assertThat(json.writeValueAsString(answer)).doesNotContain(SYNTHETIC_KEY, token);
        assertThat(provider.lastUser()).doesNotContain(SYNTHETIC_KEY, token);
        List<String> messages = jdbc.queryForList("""
                select m.content || coalesce(m.context::text,'') || coalesce(m.claims::text,'')
                from ai_messages m join ai_conversations c on c.id=m.conversation_id
                where c.project_id=? order by m.id
                """, String.class, fixture.projectId());
        assertThat(messages)
                .hasSize(2)
                .allSatisfy(message -> assertThat(message).doesNotContain(SYNTHETIC_KEY, token));
        assertThat(messages.getFirst()).contains("[REDACTED]");
    }

    private Map<String, Object> body() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("question", "Explain the approved local source");
        body.put("intent", "EXPLAIN");
        body.put("view", "code");
        body.put("focusedFile", SOURCE);
        body.put("selectedAreas", List.of());
        body.put("excludedContextIds", List.of());
        return body;
    }

    private Map<String, Object> approved(Map<String, Object> body, Map<String, Object> plan) {
        Map<String, Object> result = new LinkedHashMap<>(body);
        result.put("requestPlanToken", plan.get("requestPlanToken"));
        return result;
    }

    private Map<String, Object> prepare(Fixture fixture, Map<String, Object> body) {
        return post(fixture, "/request-plan", body, HttpStatus.OK);
    }

    private Map<String, Object> post(Fixture fixture, String route, Map<String, Object> body, HttpStatus status) {
        return read(rawPost(session, fixture.projectId(), route, body, status));
    }

    private String rawPost(
            ResponseCookie who, long projectId, String route, Map<String, Object> body, HttpStatus status) {
        ResponseCookie csrf = csrf();
        byte[] result = http.post()
                .uri("/api/projects/" + projectId + "/ai" + route)
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("SESSION", who.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(body)
                .exchange()
                .expectStatus()
                .isEqualTo(status)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
        return result == null ? "" : new String(result, StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> read(String value) {
        return json.readValue(value, Map.class);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> items(Map<String, Object> plan) {
        return (List<Map<String, Object>>) plan.get("contextItems");
    }

    @SuppressWarnings("unchecked")
    private List<String> strings(Map<String, Object> plan, String field) {
        return (List<String>) plan.get(field);
    }

    private String itemId(Map<String, Object> plan, String type) {
        return (String) items(plan).stream()
                .filter(item -> type.equals(item.get("type")))
                .findFirst()
                .orElseThrow()
                .get("id");
    }

    private void assertConflict(Map<String, Object> response) {
        assertThat(response).containsEntry("code", "AI_REQUEST_PLAN_REQUIRED");
    }

    private void assertNoProviderCalls() {
        verify(provider, never()).chat(any());
        assertNoHelperCalls();
    }

    private void assertNoHelperCalls() {
        verify(provider, never()).embed(anyString());
        verify(provider, never()).stream(any(), any());
        verify(provider, never()).testConnection();
    }

    private void assertNoAiWrites(Fixture fixture) {
        assertThat(summaryCount(fixture)).isZero();
        assertThat(usageCount(fixture)).isZero();
        assertThat(messageCount(fixture)).isZero();
    }

    private long summaryCount(Fixture fixture) {
        return jdbc.queryForObject(
                "select count(*) from summaries where snapshot_id=?", Long.class, fixture.snapshotId());
    }

    private long usageCount(Fixture fixture) {
        return jdbc.queryForObject(
                "select count(*) from ai_usage_logs where project_id=?", Long.class, fixture.projectId());
    }

    private long messageCount(Fixture fixture) {
        return jdbc.queryForObject("""
                select count(*) from ai_messages m join ai_conversations c on c.id=m.conversation_id
                where c.project_id=?
                """, Long.class, fixture.projectId());
    }

    private long note(Fixture fixture, String title, String content) {
        return jdbc.queryForObject(
                "insert into notes(project_id,title,content_md) values (?,?,?) returning id",
                Long.class,
                fixture.projectId(),
                title,
                content);
    }

    private void cache(Fixture fixture, String content) {
        jdbc.update("""
                insert into summaries(snapshot_id,subject_type,subject_id,level,content,content_hash,model)
                values (?,'FILE',?,'FILE',?,?,'previous-local-cache')
                """, fixture.snapshotId(), fixture.fileId(), content, fixture.oid());
    }

    private long conversation(Fixture fixture) {
        return jdbc.queryForObject(
                "insert into ai_conversations(project_id,snapshot_id,user_id) values (?,?,?) returning id",
                Long.class,
                fixture.projectId(),
                fixture.snapshotId(),
                fixture.userId());
    }

    private Fixture fixture(long owner) throws Exception {
        long projectId = jdbc.queryForObject("""
                insert into projects(user_id,name,repo_owner,repo_name)
                values (?,'request-plan fixture','synthetic',?) returning id
                """, Long.class, owner, "request-plan-" + UUID.randomUUID());
        Path clone = root.resolve("data/repos").resolve(Long.toString(projectId));
        Files.createDirectories(clone.resolve("src"));
        byte[] source = SOURCE_TEXT.getBytes(StandardCharsets.UTF_8);
        byte[] other = "class Other {}\n".getBytes(StandardCharsets.UTF_8);
        Files.write(clone.resolve(SOURCE), source);
        Files.write(clone.resolve(OTHER_SOURCE), other);
        String commit;
        try (Git git = Git.init().setDirectory(clone.toFile()).call()) {
            git.add().addFilepattern(".").call();
            commit = git.commit()
                    .setMessage("public synthetic source")
                    .setAuthor("Fixture", "fixture@example.invalid")
                    .setCommitter("Fixture", "fixture@example.invalid")
                    .call()
                    .name();
        }
        String oid;
        String otherOid;
        try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
            oid = formatter.idFor(Constants.OBJ_BLOB, source).name();
            otherOid = formatter.idFor(Constants.OBJ_BLOB, other).name();
        }
        long snapshotId = jdbc.queryForObject("""
                insert into snapshots(project_id,commit_sha,status,analyzed_at)
                values (?,?,'READY',now()) returning id
                """, Long.class, projectId, commit);
        jdbc.update(
                "update projects set clone_path=?,current_snapshot_id=? where id=?",
                clone.toString(),
                snapshotId,
                projectId);
        long fileId = jdbc.queryForObject("""
                insert into files(snapshot_id,path,language,size,line_count,content_hash)
                values (?,?,'java',?,1,?) returning id
                """, Long.class, snapshotId, SOURCE, source.length, oid);
        jdbc.update("""
                insert into files(snapshot_id,path,language,size,line_count,content_hash)
                values (?,?,'java',?,1,?)
                """, snapshotId, OTHER_SOURCE, other.length, otherOid);
        return new Fixture(owner, projectId, snapshotId, fileId, clone, oid, commit);
    }

    private ResponseCookie csrf() {
        var response = http.get()
                .uri("/api/csrf")
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        ResponseCookie csrf = response.getResponseCookies().getFirst("XSRF-TOKEN");
        assertThat(csrf).isNotNull();
        return csrf;
    }

    private ResponseCookie login(String token) {
        ResponseCookie csrf = csrf();
        EntityExchangeResult<byte[]> response = http.post()
                .uri("/api/auth/pat")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("token", token))
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        ResponseCookie result = response.getResponseCookies().getFirst("SESSION");
        assertThat(result).isNotNull();
        return result;
    }

    private record Fixture(
            long userId, long projectId, long snapshotId, long fileId, Path clonePath, String oid, String commitSha) {}

    /** Two independent real PAT sessions without changing the shared FakeGithubApi helper. */
    private static final class TwoUserGithub implements AutoCloseable {
        private static final String OWNER_TOKEN = "ghp_public_request_plan_owner_fixture";
        private static final String OTHER_TOKEN = "ghp_public_request_plan_other_fixture";
        private static final long OWNER_ID = 98424001L;
        private static final long OTHER_ID = 98424002L;
        private final HttpServer server;

        private TwoUserGithub() {
            try {
                server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                server.createContext("/user", this::user);
                server.start();
            } catch (IOException error) {
                throw new UncheckedIOException(error);
            }
        }

        private String baseUrl() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        private void user(HttpExchange exchange) throws IOException {
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            boolean owner = ("Bearer " + OWNER_TOKEN).equals(authorization);
            boolean other = ("Bearer " + OTHER_TOKEN).equals(authorization);
            int status = owner || other ? 200 : 401;
            String response = owner || other
                    ? "{\"id\":" + (owner ? OWNER_ID : OTHER_ID) + ",\"login\":\"request-plan-"
                            + (owner ? "owner" : "other") + "\",\"name\":\"Public fixture\"}"
                    : "{\"message\":\"Bad credentials\"}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.getResponseHeaders().add("X-OAuth-Scopes", "repo, read:user");
            exchange.sendResponseHeaders(status, bytes.length);
            try (var output = exchange.getResponseBody()) {
                output.write(bytes);
            }
        }

        @Override
        public void close() {
            server.stop(0);
        }
    }
}
