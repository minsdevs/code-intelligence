package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.HttpCookie;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.json.JsonMapper;

/**
 * Actual desktop HTTP authentication/CSRF -> Java approval/ledger -> private UDS -> Node main ->
 * actual disposable PostgreSQL/journal accounting -> answer persistence. The OS wrapping service
 * and final provider transport are synthetic; no real Electron, Keychain or remote provider runs.
 * Uses the production pinned cost catalog (including its real expiry), never a discounted fixture
 * catalog. This is API/process integration evidence, not packaged-app or real-provider validation.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.desktop.api-token=public-synthetic-desktop-launch-token",
            "app.desktop.allowed-origin=http://127.0.0.1:43123",
            "app.desktop.ai-bootstrap-stdin=false",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.ai.openai.base-url=http://127.0.0.1:1",
            "app.ai.gemini.base-url=http://127.0.0.1:1",
            "app.github.base-url=http://127.0.0.1:1",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url="
        })
@Import({TestcontainersConfiguration.class, AiDesktopCostFlowIntegrationTest.RuntimeConfiguration.class})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Timeout(90)
class AiDesktopCostFlowIntegrationTest {
    private static final Path ROOT = privateTemporaryDirectory();
    private static final String INSTALLATION = UUID.randomUUID().toString();
    private static final String LAUNCH_TOKEN = "public-synthetic-desktop-launch-token";
    private static final String SYNTHETIC_KEY = "sk-publicSyntheticDesktopCostKey0123456789";
    private static final String TOKEN_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    private static final String SOURCE = "src/App.java";
    private static final String SOURCE_TEXT = "class App { String value = \"approved-desktop-source\"; }\n";
    private static final long RESERVATION = 22_472; // ceil((128000 * .15 + 2048 * .60) * 1.1) micro-USD.
    private static final long ACTUAL = 42; // 60 uncached + 40 cached input, 50 output, fixed catalog.

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.desktop.local-identity", () -> INSTALLATION);
        registry.add("app.data-dir", () -> ROOT.resolve("data").toString());
    }

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    JsonMapper json;

    @Autowired
    NodeRuntime runtime;

    @Autowired
    AiMainGatewayClient main;

    @Value("${local.server.port}")
    int port;

    private final HttpClient http =
            HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private long userId;
    private Fixture fixture;
    private int sendsBefore;
    private Map<String, Object> readyBudget;

    @BeforeEach
    void useTheRealDesktopSetupApisWithoutAProviderProbe() throws Exception {
        runtime.control("success", true);
        sendsBefore = runtime.events().size();
        Map<String, Object> initial = success(request("GET", "/api/ai/budget", null));
        assertThat(initial).containsEntry("available", true);
        assertThat(initial.get("supportedModels")).isEqualTo(List.of(AiDesktopGateway.MODEL));
        userId = jdbc.queryForObject(
                "select id from users where identity_type='LOCAL' and local_key=?", Long.class, INSTALLATION);
        assertThat(jdbc.queryForObject(
                        "select legacy_liability_unresolved from ai_budget_gate where installation_id=?",
                        Boolean.class,
                        INSTALLATION))
                .isFalse();

        Map<String, Object> settings = success(request(
                "PUT",
                "/api/ai/settings",
                Map.of("provider", "openai", "model", AiDesktopGateway.MODEL, "apiKey", SYNTHETIC_KEY)));
        assertThat(settings).containsEntry("state", "ENABLED").containsEntry("keySet", true);
        assertThat(json.writeValueAsString(settings)).doesNotContain(SYNTHETIC_KEY);
        Map<String, Object> configured = configure(initial.get("policyRevision"), "10000000", "10000000");
        readyBudget = activate(configured);
        assertThat(readyBudget).containsEntry("state", "READY");
        assertThat(runtime.events()).hasSize(sendsBefore);
        fixture = sourceFixture();
    }

    @AfterEach
    void releaseAnySyntheticTransportBarrier() throws IOException {
        runtime.control("success", true);
    }

    @AfterAll
    void stopTheOwnedChildBeforeDeletingOnlyItsTemporaryFiles() throws Exception {
        runtime.close();
        try (var paths = Files.walk(ROOT)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        }
    }

    @Test
    void prepareAndSendUseExactlyTheApprovedPayloadAndSettleBeforeAnyAnswerRow() throws Exception {
        Map<String, Object> plan = prepare();
        Map<String, Object> cost = object(plan.get("cost"));
        assertThat(plan)
                .containsEntry("provider", "openai")
                .containsEntry("model", AiDesktopGateway.MODEL)
                .containsEntry("costStatus", "AVAILABLE")
                .containsEntry("intent", "EXPLAIN");
        assertThat(plan.get("requestPlanToken")).asString().matches("[0-9a-f]{64}");
        assertThat(plan.get("payloadSha256")).asString().matches("[0-9a-f]{64}");
        assertThat(cost)
                .containsEntry("reservedMicroUsd", Long.toString(RESERVATION))
                .containsEntry("inputTokenUpperBound", "128000")
                .containsEntry("outputTokenMax", "2048")
                .containsEntry("priceVersion", "openai-gpt4omini-standard-2026-10-03")
                .containsEntry("policyRevision", readyBudget.get("policyRevision"));
        assertThat(Instant.parse((String) cost.get("validUntil"))).isAfter(Instant.now());
        assertThat(plan.get("userPrompt")).asString().contains("approved-desktop-source", "SOURCE:");
        assertThat(json.writeValueAsString(plan)).doesNotContain(SYNTHETIC_KEY, LAUNCH_TOKEN, TOKEN_KEY);
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertNoAiWrites();

        installPersistenceGuard(plan, false);
        Map<String, Object> answer;
        try {
            answer = success(ask(plan));
        } finally {
            removePersistenceGuard();
        }
        assertThat(answer).containsEntry("explanation", "Synthetic desktop answer");
        Map<String, Object> event = onlyEvent(plan);
        assertThat(event)
                .containsEntry("credentialMatched", true)
                .containsEntry("ledgerStatusAtSend", "DISPATCHED")
                .containsEntry("evidenceCountAtSend", 0)
                .containsEntry("method", "POST")
                .containsEntry("origin", "https://api.openai.com")
                .containsEntry("path", "/v1/chat/completions")
                .containsEntry("redirects", 0)
                .containsEntry("retries", 0);
        byte[] wire = Base64.getDecoder().decode((String) event.get("bodyBase64"));
        Map<String, Object> payload = read(new String(wire, StandardCharsets.UTF_8));
        assertThat(payload)
                .containsOnlyKeys(
                        "model",
                        "messages",
                        "max_completion_tokens",
                        "response_format",
                        "stream",
                        "n",
                        "store",
                        "service_tier");
        assertThat(payload)
                .containsEntry("model", AiDesktopGateway.MODEL)
                .containsEntry("max_completion_tokens", 2048)
                .containsEntry("response_format", Map.of("type", "json_object"))
                .containsEntry("stream", false)
                .containsEntry("n", 1)
                .containsEntry("store", false)
                .containsEntry("service_tier", "default")
                .containsEntry(
                        "messages",
                        List.of(
                                Map.of("role", "system", "content", plan.get("systemPrompt")),
                                Map.of("role", "user", "content", plan.get("userPrompt"))));
        Map<String, Object> row = requestRow(plan);
        assertThat(row)
                .containsEntry("plan_sha256", plan.get("payloadSha256"))
                .containsEntry("wire_body_sha256", sha(wire))
                .containsEntry("reserved_micro_usd", RESERVATION);
        assertThat(event.get("wireSha256")).isEqualTo(sha(wire));
        assertSettled(plan);
        assertThat(messageCount()).isEqualTo(2);
        assertThat(jdbc.queryForObject(
                        "select count(*) from ai_messages m join ai_conversations c on c.id=m.conversation_id "
                                + "where c.project_id=? and m.role='ASSISTANT' and m.prompt_tokens=100 and m.completion_tokens=50",
                        Long.class,
                        fixture.projectId()))
                .isEqualTo(1);
        Map<String, Object> after = success(request("GET", "/api/ai/budget", null));
        assertThat(Long.parseLong((String) after.get("dailySettledMicroUsd")))
                .isEqualTo(Long.parseLong((String) readyBudget.get("dailySettledMicroUsd")) + ACTUAL);
        assertThat(after.get("allDatesHeldMicroUsd")).isEqualTo(readyBudget.get("allDatesHeldMicroUsd"));
        assertThat(summaryCount()).isZero();
        assertThat(legacyUsageCount()).isZero();
        error(ask(plan), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertSettled(plan);
    }

    @Test
    void simultaneousUseOfOneApprovalHasOneTransportAndOneSettlement() throws Exception {
        Map<String, Object> plan = prepare();
        runtime.control("hold", false);
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> {
                start.await();
                return ask(plan);
            });
            var second = pool.submit(() -> {
                start.await();
                return ask(plan);
            });
            start.countDown();
            try {
                runtime.awaitEvents(sendsBefore + 1);
                assertThat(requestRow(plan)).containsEntry("status", "DISPATCHED");
                assertThat(messageCount()).isZero();
            } finally {
                runtime.control("success", true);
            }
            Reply a = first.get(35, TimeUnit.SECONDS), b = second.get(35, TimeUnit.SECONDS);
            assertThat(List.of(a.status(), b.status())).containsExactlyInAnyOrder(200, 409);
            error(a.status() == 409 ? a : b, 409, "AI_REQUEST_PLAN_REQUIRED");
        }
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertSettled(plan);
        assertThat(messageCount()).isEqualTo(2);
    }

    @Test
    void twoInflightReservationsBlockAThirdWithoutSendingOrCreatingItsLedgerRow() throws Exception {
        Map<String, Object> firstPlan = prepare(), secondPlan = prepare(), rejectedPlan = prepare();
        runtime.control("hold", false);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> ask(firstPlan));
            var second = pool.submit(() -> ask(secondPlan));
            try {
                runtime.awaitEvents(sendsBefore + 2);
                assertThat(requestRow(firstPlan)).containsEntry("status", "DISPATCHED");
                assertThat(requestRow(secondPlan)).containsEntry("status", "DISPATCHED");
                Map<String, Object> pending = success(request("GET", "/api/ai/budget", null));
                assertThat(Long.parseLong((String) pending.get("allDatesHeldMicroUsd")))
                        .isEqualTo(Long.parseLong((String) readyBudget.get("allDatesHeldMicroUsd")) + 2 * RESERVATION);
                error(ask(rejectedPlan), 409, "AI_COST_BUSY");
                assertThat(requestCount(rejectedPlan)).isZero();
                assertThat(messageCount()).isZero();
                assertThat(runtime.events()).hasSize(sendsBefore + 2);
            } finally {
                runtime.control("success", true);
            }
            success(first.get(35, TimeUnit.SECONDS));
            success(second.get(35, TimeUnit.SECONDS));
        }
        assertSettled(firstPlan);
        assertSettled(secondPlan);
        error(ask(rejectedPlan), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(runtime.events()).hasSize(sendsBefore + 2);
        assertThat(messageCount()).isEqualTo(4);
    }

    @Test
    void changedBudgetPolicyRequiresNewApprovalWithoutAnyTransport() throws Exception {
        Map<String, Object> plan = prepare();
        Map<String, Object> configured = configure(readyBudget.get("policyRevision"), "11000000", "11000000");
        activate(configured);
        error(ask(plan), 409, "AI_COST_PLAN_CHANGED");
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertNoAiWrites();
        error(ask(plan), 409, "AI_REQUEST_PLAN_REQUIRED");
    }

    @Test
    void dailyBudgetIncludesTheFixedConservativeReservationBeforeSending() throws Exception {
        // A high enough activation limit is required for earlier durable liabilities. Lower the
        // current daily allowance to exactly those liabilities, leaving no room for a new request.
        long existing = Long.parseLong((String) readyBudget.get("allDatesHeldMicroUsd"))
                + Long.parseLong((String) readyBudget.get("dailySettledMicroUsd"));
        long limit = Math.max(1, existing);
        Map<String, Object> configured = configure(readyBudget.get("policyRevision"), Long.toString(limit), "10000000");
        activate(configured);
        Map<String, Object> plan = prepare();
        error(ask(plan), 429, "AI_COST_BUDGET_EXCEEDED");
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertNoAiWrites();
    }

    @Test
    void offDuringOneInflightRequestPreservesItsSettlementAndPreventsTheNextSend() throws Exception {
        Map<String, Object> admitted = prepare(), later = prepare();
        runtime.control("hold", false);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var answer = pool.submit(() -> ask(admitted));
            try {
                runtime.awaitEvents(sendsBefore + 1);
                Map<String, Object> cleared = success(request("DELETE", "/api/ai/settings", null));
                assertThat(cleared).containsEntry("state", "OFF");
                assertThat(main.exchange("STATUS", Map.of()).get("aiOff").asBoolean())
                        .isTrue();
                assertThat(ask(later).status()).isEqualTo(503);
                assertThat(requestCount(later)).isZero();
                assertThat(runtime.events()).hasSize(sendsBefore + 1);
            } finally {
                runtime.control("success", true);
            }
            success(answer.get(35, TimeUnit.SECONDS));
        }
        assertSettled(admitted);
        assertThat(main.exchange("STATUS", Map.of()).get("aiOff").asBoolean()).isTrue();
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertThat(messageCount()).isEqualTo(2);
    }

    @ParameterizedTest
    @ValueSource(strings = {"throw", "invalid-usage"})
    void uncertainProviderOutcomeKeepsTheWholeHoldAndNeverAutomaticallyResends(String mode) throws Exception {
        Map<String, Object> plan = prepare();
        runtime.control(mode, true);
        Reply failed = ask(plan);
        error(failed, 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        assertThat(failed.body()).doesNotContain(SYNTHETIC_KEY, LAUNCH_TOKEN, TOKEN_KEY, "Synthetic provider failure");
        assertThat(requestRow(plan))
                .containsEntry("status", "UNKNOWN_HELD")
                .containsEntry("reserved_micro_usd", RESERVATION)
                .containsEntry("actual_micro_usd", null)
                .containsEntry("proof_sha256", null);
        assertThat(evidenceCount(plan)).isZero();
        assertThat(messageCount()).isZero();
        Map<String, Object> budget = success(request("GET", "/api/ai/budget", null));
        assertThat(Long.parseLong((String) budget.get("allDatesHeldMicroUsd")))
                .isEqualTo(Long.parseLong((String) readyBudget.get("allDatesHeldMicroUsd")) + RESERVATION);
        assertThat(main.exchange("STATUS", Map.of()).get("aiOff").asBoolean()).isTrue();
        runtime.control("success", true);
        error(ask(plan), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertThat(requestRow(plan)).containsEntry("status", "UNKNOWN_HELD");
    }

    @Test
    void answerPersistenceFailureCannotRollBackConfirmedUsageOrResendTheApproval() throws Exception {
        Map<String, Object> plan = prepare();
        installPersistenceGuard(plan, true);
        try {
            assertThat(ask(plan).status()).isEqualTo(500);
        } finally {
            removePersistenceGuard();
        }
        assertSettled(plan);
        assertThat(messageCount()).isZero();
        assertThat(jdbc.queryForObject(
                        "select count(*) from ai_conversations where project_id=?", Long.class, fixture.projectId()))
                .isZero();
        error(ask(plan), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertSettled(plan);
    }

    @Test
    void desktopAuthenticationCsrfAndApprovalRemainRequiredBeforeAnySend() throws Exception {
        assertThat(raw("GET", "/api/ai/budget", null, false, false, null).status())
                .isEqualTo(401);
        assertThat(raw(
                                "PUT",
                                "/api/ai/budget",
                                Map.of(
                                        "expectedRevision",
                                        readyBudget.get("policyRevision"),
                                        "dailyLimitMicroUsd",
                                        "10000000",
                                        "monthlyLimitMicroUsd",
                                        "10000000"),
                                true,
                                false,
                                null)
                        .status())
                .isEqualTo(403);
        assertThat(raw("GET", "/api/ai/budget", null, true, false, "https://untrusted.example.invalid")
                        .status())
                .isEqualTo(403);
        error(request("POST", route("/ask"), body()), 409, "AI_REQUEST_PLAN_REQUIRED");
        Map<String, Object> preview = success(request("POST", route("/preview"), body()));
        assertThat(json.writeValueAsString(preview)).doesNotContain(SYNTHETIC_KEY, LAUNCH_TOKEN, TOKEN_KEY);
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertNoAiWrites();
    }

    @Test
    void budgetActivationRequiresTheLatestOneUseConfirmationAndRejectsReplay() throws Exception {
        Map<String, Object> first = configure(readyBudget.get("policyRevision"), "10000000", "10000000");
        assertThat(first.get("activationToken")).asString().matches("[0-9a-f]{64}");
        error(
                request("POST", "/api/ai/budget/activate", Map.of("expectedRevision", first.get("policyRevision"))),
                409,
                "AI_REQUEST_PLAN_REQUIRED");
        Map<String, Object> latest = success(request("GET", "/api/ai/budget", null));
        assertThat(latest.get("activationToken")).isNotEqualTo(first.get("activationToken"));
        error(request("POST", "/api/ai/budget/activate", activationBody(first)), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(main.exchange("STATUS", Map.of()).get("aiOff").asBoolean()).isTrue();
        assertThat(activate(latest)).containsEntry("state", "READY").containsEntry("activationToken", null);
        error(request("POST", "/api/ai/budget/activate", activationBody(latest)), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(main.exchange("STATUS", Map.of()).get("aiOff").asBoolean()).isFalse();
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertNoAiWrites();
    }

    @Test
    void offThenSavingTheSameCredentialCannotReuseAnOlderBudgetConfirmation() throws Exception {
        Map<String, Object> old = configure(readyBudget.get("policyRevision"), "10000000", "10000000");
        success(request("DELETE", "/api/ai/settings", null));
        success(request(
                "PUT",
                "/api/ai/settings",
                Map.of("provider", "openai", "model", AiDesktopGateway.MODEL, "apiKey", SYNTHETIC_KEY)));
        error(request("POST", "/api/ai/budget/activate", activationBody(old)), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(main.exchange("STATUS", Map.of()).get("aiOff").asBoolean()).isTrue();
        Map<String, Object> fresh = success(request("GET", "/api/ai/budget", null));
        assertThat(activate(fresh)).containsEntry("state", "READY");
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertNoAiWrites();
    }

    private Map<String, Object> configure(Object revision, String daily, String monthly) throws Exception {
        return success(request(
                "PUT",
                "/api/ai/budget",
                Map.of("expectedRevision", revision, "dailyLimitMicroUsd", daily, "monthlyLimitMicroUsd", monthly)));
    }

    private Map<String, Object> activate(Map<String, Object> budget) throws Exception {
        assertThat(budget.get("activationToken")).asString().matches("[0-9a-f]{64}");
        return success(request("POST", "/api/ai/budget/activate", activationBody(budget)));
    }

    private Map<String, Object> activationBody(Map<String, Object> budget) {
        return Map.of(
                "expectedRevision", budget.get("policyRevision"), "activationToken", budget.get("activationToken"));
    }

    private Map<String, Object> body() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("question", "Explain this approved desktop source file.");
        value.put("intent", "EXPLAIN");
        value.put("view", "file");
        value.put("focusedFile", SOURCE);
        value.put("selectedAreas", List.of());
        value.put("excludedContextIds", List.of());
        return value;
    }

    private Map<String, Object> prepare() throws Exception {
        return success(request("POST", route("/request-plan"), body()));
    }

    private Reply ask(Map<String, Object> plan) throws Exception {
        Map<String, Object> value = body();
        value.put("requestPlanToken", plan.get("requestPlanToken"));
        return request("POST", route("/ask"), value);
    }

    private String route(String suffix) {
        return "/api/projects/" + fixture.projectId() + "/ai" + suffix;
    }

    private Reply request(String method, String route, Object body) throws Exception {
        return raw(method, route, body, true, !method.equals("GET"), null);
    }

    private Reply raw(String method, String route, Object body, boolean authenticated, boolean csrf, String origin)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + route))
                .timeout(Duration.ofSeconds(40))
                .header("Accept", "application/json");
        if (authenticated) request.header("X-Code-Intelligence-Token", LAUNCH_TOKEN);
        if (origin != null) request.header("Origin", origin);
        if (csrf) {
            HttpResponse<String> token = http.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/csrf"))
                            .timeout(Duration.ofSeconds(10))
                            .GET()
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            assertThat(token.statusCode()).isEqualTo(204);
            String value = token.headers().allValues("set-cookie").stream()
                    .flatMap(header -> HttpCookie.parse(header).stream())
                    .filter(cookie -> cookie.getName().equals("XSRF-TOKEN"))
                    .findFirst()
                    .orElseThrow()
                    .getValue();
            request.header("Cookie", "XSRF-TOKEN=" + value).header("X-XSRF-TOKEN", value);
        }
        if (body == null) request.method(method, HttpRequest.BodyPublishers.noBody());
        else
            request.header("Content-Type", "application/json")
                    .method(
                            method,
                            HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body), StandardCharsets.UTF_8));
        HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
        return new Reply(response.statusCode(), response.body());
    }

    private Map<String, Object> success(Reply reply) {
        assertThat(reply.status()).as("HTTP response: %s", reply.body()).isEqualTo(200);
        return read(reply.body());
    }

    private void error(Reply reply, int status, String code) {
        assertThat(reply.status()).as("HTTP response: %s", reply.body()).isEqualTo(status);
        assertThat(read(reply.body())).containsEntry("code", code);
        assertThat(reply.body()).doesNotContain(SYNTHETIC_KEY, LAUNCH_TOKEN, TOKEN_KEY);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> read(String text) {
        return json.readValue(text, Map.class);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> object(Object value) {
        return (Map<String, Object>) value;
    }

    private Map<String, Object> onlyEvent(Map<String, Object> plan) throws IOException {
        var events = runtime.events().stream()
                .filter(e -> plan.get("requestId").equals(e.get("requestId")))
                .toList();
        assertThat(events).hasSize(1);
        return events.getFirst();
    }

    private Map<String, Object> requestRow(Map<String, Object> plan) {
        return jdbc.queryForMap("select * from ai_request_ledger where request_id=?::uuid", plan.get("requestId"));
    }

    private long requestCount(Map<String, Object> plan) {
        return jdbc.queryForObject(
                "select count(*) from ai_request_ledger where request_id=?::uuid", Long.class, plan.get("requestId"));
    }

    private long evidenceCount(Map<String, Object> plan) {
        return jdbc.queryForObject(
                "select count(*) from ai_usage_evidence where request_id=?::uuid", Long.class, plan.get("requestId"));
    }

    private void assertSettled(Map<String, Object> plan) throws IOException {
        assertThat(requestRow(plan))
                .containsEntry("status", "SETTLED")
                .containsEntry("actual_micro_usd", ACTUAL)
                .containsEntry("reserved_micro_usd", RESERVATION)
                .containsEntry("conflict", false);
        assertThat(requestRow(plan).get("proof_sha256")).asString().matches("[0-9a-f]{64}");
        assertThat(evidenceCount(plan)).isEqualTo(1);
        assertThat(jdbc.queryForObject(
                        "select actual_micro_usd from ai_usage_evidence where request_id=?::uuid",
                        Long.class,
                        plan.get("requestId")))
                .isEqualTo(ACTUAL);
        assertThat(onlyEvent(plan)).containsEntry("ledgerStatusAtSend", "DISPATCHED");
    }

    private long messageCount() {
        return jdbc.queryForObject(
                "select count(*) from ai_messages m join ai_conversations c on c.id=m.conversation_id "
                        + "where c.project_id=?",
                Long.class,
                fixture.projectId());
    }

    private long summaryCount() {
        return jdbc.queryForObject(
                "select count(*) from summaries where snapshot_id=?", Long.class, fixture.snapshotId());
    }

    private long legacyUsageCount() {
        return jdbc.queryForObject(
                "select count(*) from ai_usage_logs where project_id=?", Long.class, fixture.projectId());
    }

    private void assertNoAiWrites() {
        assertThat(jdbc.queryForObject(
                        "select count(*) from ai_request_ledger where project_id=?", Long.class, fixture.projectId()))
                .isZero();
        assertThat(messageCount()).isZero();
        assertThat(summaryCount()).isZero();
        assertThat(legacyUsageCount()).isZero();
    }

    /** Actual PG observes accounting before either USER or ASSISTANT insertion in this project. */
    private void installPersistenceGuard(Map<String, Object> plan, boolean failAfterSettlement) {
        UUID requestId = UUID.fromString((String) plan.get("requestId"));
        jdbc.execute("""
                create function ci_desktop_persistence_guard() returns trigger language plpgsql as $$
                begin
                  if exists(select 1 from ai_conversations where id=new.conversation_id and project_id=%d) then
                    if not exists(select 1 from ai_request_ledger r join ai_usage_evidence e
                        on e.request_id=r.request_id and e.proof_sha256=r.proof_sha256
                        where r.request_id='%s'::uuid and r.status='SETTLED' and r.actual_micro_usd=42
                          and e.actual_micro_usd=42) then
                      raise exception 'Synthetic answer preceded durable accounting';
                    end if;
                    if %s and new.role='ASSISTANT' then raise exception 'Synthetic answer persistence failure'; end if;
                  end if;
                  return new;
                end $$
                """.formatted(fixture.projectId(), requestId, failAfterSettlement ? "true" : "false"));
        jdbc.execute("create trigger ci_desktop_persistence_guard before insert on ai_messages "
                + "for each row execute function ci_desktop_persistence_guard()");
    }

    private void removePersistenceGuard() {
        jdbc.execute("drop trigger if exists ci_desktop_persistence_guard on ai_messages");
        jdbc.execute("drop function if exists ci_desktop_persistence_guard()");
    }

    private Fixture sourceFixture() throws Exception {
        long projectId = jdbc.queryForObject("""
                insert into projects(user_id,name,repo_owner,repo_name)
                values (?,'desktop cost fixture','synthetic',?) returning id
                """, Long.class, userId, "cost-" + UUID.randomUUID());
        Path clone = ROOT.resolve("data/repos").resolve(Long.toString(projectId));
        Files.createDirectories(clone.resolve("src"));
        byte[] source = SOURCE_TEXT.getBytes(StandardCharsets.UTF_8);
        Files.write(clone.resolve(SOURCE), source);
        String commit;
        try (Git git = Git.init().setDirectory(clone.toFile()).call()) {
            git.add().addFilepattern(".").call();
            commit = git.commit()
                    .setMessage("public synthetic desktop source")
                    .setAuthor("Fixture", "fixture@example.invalid")
                    .setCommitter("Fixture", "fixture@example.invalid")
                    .call()
                    .name();
        }
        String oid;
        try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
            oid = formatter.idFor(Constants.OBJ_BLOB, source).name();
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
        jdbc.update(
                "insert into files(snapshot_id,path,language,size,line_count,content_hash) values (?,?,'java',?,1,?)",
                snapshotId,
                SOURCE,
                source.length,
                oid);
        return new Fixture(projectId, snapshotId);
    }

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static Path privateTemporaryDirectory() {
        try {
            Path directory =
                    Files.createTempDirectory(Path.of("/tmp"), "ci-dc-").toRealPath();
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
            return directory;
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot create the private desktop integration fixture", failure);
        }
    }

    private record Fixture(long projectId, long snapshotId) {}

    private record Reply(int status, String body) {}

    @TestConfiguration(proxyBeanMethods = false)
    static class RuntimeConfiguration {
        @Bean(destroyMethod = "close")
        NodeRuntime desktopCostRuntime(PostgreSQLContainer postgres, JsonMapper json) throws Exception {
            return new NodeRuntime(postgres, json);
        }

        @Bean
        @Primary
        AiMainGatewayClient desktopCostClient(NodeRuntime runtime, JsonMapper json) {
            return new AiMainGatewayClient(runtime.process.getInputStream(), json, Duration.ofSeconds(35));
        }
    }

    /** No inherited environment; config carries only this fresh test container's temporary login. */
    static final class NodeRuntime implements AutoCloseable {
        private final Path directory;
        private final JsonMapper json;
        private final Process process;
        private boolean closed;

        NodeRuntime(PostgreSQLContainer postgres, JsonMapper json) throws Exception {
            this.json = json;
            directory = Files.createDirectory(ROOT.resolve("main"));
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
            assertThat(postgres.isRunning())
                    .as("Only the running disposable Testcontainer may be connected")
                    .isTrue();
            assertThat(postgres.getHost()).isIn("localhost", "127.0.0.1");
            Path psql = executable(List.of("/opt/homebrew/bin/psql", "/usr/local/bin/psql", "/usr/bin/psql"));
            Path node = executable(List.of("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"));
            Path script = Path.of("../desktop/test/fixtures/ai-desktop-cost-runtime.cjs")
                    .toRealPath();
            Path config = directory.resolve("config.json");
            Files.writeString(
                    config,
                    json.writeValueAsString(Map.of(
                            "installationId",
                            INSTALLATION,
                            "psqlPath",
                            psql.toString(),
                            "connection",
                            Map.of(
                                    "host",
                                    "127.0.0.1",
                                    "port",
                                    postgres.getMappedPort(5432),
                                    "user",
                                    postgres.getUsername(),
                                    "database",
                                    postgres.getDatabaseName()),
                            "databasePassword",
                            postgres.getPassword(),
                            "tokenEncryptionKey",
                            TOKEN_KEY)),
                    StandardCharsets.UTF_8);
            Files.setPosixFilePermissions(config, PosixFilePermissions.fromString("rw-------"));
            control("success", true);
            ProcessBuilder builder = new ProcessBuilder(node.toString(), script.toString(), config.toString());
            builder.directory(directory.toFile());
            builder.environment().clear();
            builder.environment()
                    .putAll(Map.of(
                            "PATH",
                            "/usr/bin:/bin:/usr/sbin:/sbin",
                            "HOME",
                            directory.toString(),
                            "TMPDIR",
                            directory.toString(),
                            "LANG",
                            "C",
                            "TZ",
                            "UTC"));
            Path stderr = Files.createFile(directory.resolve("stderr.txt"));
            Files.setPosixFilePermissions(stderr, PosixFilePermissions.fromString("rw-------"));
            builder.redirectError(stderr.toFile());
            process = builder.start();
        }

        private static Path executable(List<String> candidates) throws IOException {
            for (String candidate : candidates) {
                Path path = Path.of(candidate);
                if (Files.isRegularFile(path) && Files.isExecutable(path)) return path.toRealPath();
            }
            throw new IOException("A reviewed local Node/psql executable is required for this integration test");
        }

        synchronized void control(String mode, boolean release) throws IOException {
            Path temporary = Files.createTempFile(directory, "control-", ".json");
            Files.writeString(
                    temporary,
                    json.writeValueAsString(Map.of("mode", mode, "release", release)),
                    StandardCharsets.UTF_8);
            Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"));
            Files.move(
                    temporary,
                    directory.resolve("control.json"),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        }

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> events() throws IOException {
            Path path = directory.resolve("transports.jsonl");
            if (!Files.exists(path)) return List.of();
            String contents = Files.readString(path);
            List<Map<String, Object>> events = new ArrayList<>();
            // Only complete records count; the child may currently be appending its next record.
            int end = contents.lastIndexOf('\n');
            if (end >= 0)
                for (String line : contents.substring(0, end).split("\n")) events.add(json.readValue(line, Map.class));
            return events;
        }

        void awaitEvents(int count) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
            while (events().size() < count && System.nanoTime() < deadline) {
                assertThat(process.isAlive())
                        .as("Synthetic main process must remain alive")
                        .isTrue();
                Thread.sleep(20);
            }
            assertThat(events()).hasSize(count);
        }

        @Override
        public synchronized void close() throws Exception {
            if (closed) return;
            closed = true;
            if (process.isAlive()) {
                control("success", true);
                process.getOutputStream().close();
                if (!process.waitFor(20, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    process.waitFor(3, TimeUnit.SECONDS);
                    throw new AssertionError("Synthetic desktop main did not close after stdin EOF");
                }
            }
            assertThat(process.exitValue())
                    .as("Synthetic main shutdown exit status")
                    .isZero();
            assertThat(Files.readString(directory.resolve("closed.json"))).isEqualTo("{\"closed\":true}");
            assertThat(Files.readString(directory.resolve("stderr.txt"))).isEmpty();
            try (var paths = Files.walk(directory.resolve("t"))) {
                assertThat(paths.filter(path -> !path.equals(directory.resolve("t")))
                                .toList())
                        .isEmpty();
            }
        }
    }
}
