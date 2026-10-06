package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import tools.jackson.databind.JsonNode;

/**
 * C13 cost-egress matrix, non-terminal cases. Each case starts from READY with fresh one-use activation,
 * runs through the real product chain described in {@link CostEgressHarness}, and asserts integer
 * microUSD in PostgreSQL, the main journal and the budget API, plus the fake provider's call count.
 * Case IDs are stable and referenced by docs/audit/cost-egress-matrix-2026-10-07.md.
 */
class AiCostEgressMatrixIntegrationTest extends CostEgressHarness {
    private Fixture fixture;
    private int sendsBefore;
    private Money before;

    @BeforeEach
    void readyThroughTheRealDesktopApis() throws Exception {
        readyForRequests("10000000", "10000000");
        fixture = sourceFixture();
        sendsBefore = runtime.events().size();
        before = money();
        assertThat(before.state()).isEqualTo("READY");
        assertLedgerAgreement();
    }

    @AfterEach
    void releaseAnySyntheticBarrierAndCheckTheWholeLedger() throws Exception {
        runtime.control(Map.of("mode", "success", "release", true));
    }

    @AfterAll
    void everyProviderInvocationUsedTheFixedEndpointWithoutRedirectOrRetry() throws Exception {
        var events = runtime.events();
        assertThat(events).isNotEmpty();
        for (var event : events) {
            assertThat(event)
                    .containsEntry("origin", "https://api.openai.com")
                    .containsEntry("path", "/v1/chat/completions")
                    .containsEntry("method", "POST")
                    .containsEntry("redirects", 0)
                    .containsEntry("retries", 0)
                    .containsEntry("ledgerStatusAtSend", "DISPATCHED")
                    .containsEntry("journalIntentAtSend", true);
        }
        // Zero automatic re-sends: no request UUID reached the provider twice in this context.
        assertThat(events.stream().map(e -> e.get("requestId")).distinct().count())
                .isEqualTo(events.size());
    }

    @Test
    @DisplayName("C13-01 settled request: one send after durable intent, exact 42/22472 microUSD")
    void c13_01_settledRequestIsSentOnceAfterDurableIntentAndSettledExactly() throws Exception {
        Map<String, Object> plan = prepare(fixture);
        assertThat(((Map<?, ?>) plan.get("cost")).get("reservedMicroUsd")).isEqualTo(Long.toString(RESERVATION));
        assertThat(eventsFor(plan)).isEmpty();
        assertThat(requestCount(plan)).isZero();

        Map<String, Object> answer = success(ask(fixture, plan));
        assertThat(answer).containsEntry("explanation", "Synthetic desktop answer");
        Map<String, Object> event = onlyDurablyIntendedEvent(plan);
        byte[] wire = Base64.getDecoder().decode((String) event.get("bodyBase64"));
        assertThat(event.get("wireSha256")).isEqualTo(sha(wire));
        assertThat(requestRow(plan)).containsEntry("wire_body_sha256", sha(wire));
        assertObligation((String) plan.get("requestId"), "SETTLED", RESERVATION, ACTUAL);
        assertThat(evidenceCount(plan)).isEqualTo(1);

        Money after = money();
        assertThat(after.held()).isEqualTo(before.held());
        assertThat(after.dailySettled()).isEqualTo(before.dailySettled() + ACTUAL);
        assertThat(after.monthlySettled()).isEqualTo(before.monthlySettled() + ACTUAL);
        assertLedgerAgreement();

        // Retry of the consumed approval: rejected before any provider call.
        error(ask(fixture, plan), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertThat(legacyUsageCount()).isZero();
    }

    @Test
    @DisplayName("C13-02 concurrent reserve at the budget boundary: exactly one reservation and one send")
    void c13_02_concurrentReservationsCannotBothSpendTheLastBudget() throws Exception {
        Map<String, Object> current = success(request("GET", "/api/ai/budget", null));
        long daily = before.held() + before.dailySettled() + RESERVATION + (RESERVATION - 1);
        Map<String, Object> configured = configure(current.get("policyRevision"), Long.toString(daily), "10000000");
        activate(configured);
        Map<String, Object> first = prepare(fixture), second = prepare(fixture);
        runtime.control(Map.of("mode", "hold", "release", false, "then", "success"));
        CountDownLatch start = new CountDownLatch(1);
        Reply a, b;
        try (var pool = Executors.newFixedThreadPool(2)) {
            var one = pool.submit(() -> {
                start.await();
                return ask(fixture, first);
            });
            var two = pool.submit(() -> {
                start.await();
                return ask(fixture, second);
            });
            start.countDown();
            try {
                runtime.awaitEvents(sendsBefore + 1);
                // The loser fails at the PG row lock while the winner is held at the provider.
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
                while (!(one.isDone() || two.isDone()) && System.nanoTime() < deadline) Thread.sleep(20);
                assertThat(one.isDone() || two.isDone()).isTrue();
                assertThat(runtime.events()).hasSize(sendsBefore + 1);
            } finally {
                runtime.control(Map.of("mode", "success", "release", true));
            }
            a = one.get(35, TimeUnit.SECONDS);
            b = two.get(35, TimeUnit.SECONDS);
        }
        assertThat(List.of(a.status(), b.status())).containsExactlyInAnyOrder(200, 429);
        Map<String, Object> winner = a.status() == 200 ? first : second;
        Map<String, Object> loser = a.status() == 200 ? second : first;
        error(a.status() == 429 ? a : b, 429, "AI_COST_BUDGET_EXCEEDED");
        assertThat(requestCount(loser)).isZero();
        assertThat(eventsFor(loser)).isEmpty();
        onlyDurablyIntendedEvent(winner);
        assertObligation((String) winner.get("requestId"), "SETTLED", RESERVATION, ACTUAL);
        Money after = money();
        assertThat(after.held()).isEqualTo(before.held());
        assertThat(after.dailySettled()).isEqualTo(before.dailySettled() + ACTUAL);
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertLedgerAgreement();
    }

    @ParameterizedTest(name = "{0} {1}: full hold, one provider call, no re-send")
    @CsvSource({
        "C13-03, throw-before-send, false",
        "C13-04, throw-after-send, true",
        "C13-05, status-500, true",
        "C13-06, status-429, true",
        "C13-07, no-usage, true",
        "C13-08, invalid-usage, true",
        "C13-09, reasoning-usage, true",
        "C13-10, total-mismatch, true",
        "C13-11, malformed, true",
        "C13-12, wrong-model, true"
    })
    void c13_03to12_uncertainProviderOutcomeKeepsTheWholeReservation(String caseId, String mode, boolean received)
            throws Exception {
        Map<String, Object> plan = prepare(fixture);
        runtime.control(Map.of("mode", mode, "release", true));
        Reply failed = ask(fixture, plan);
        error(failed, 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        assertThat(failed.body()).doesNotContain("synthetic provider error");
        Map<String, Object> event = onlyDurablyIntendedEvent(plan);
        assertThat(event).containsEntry("received", received);
        assertThat(event.containsKey("bodyBase64")).isEqualTo(received);
        String requestId = (String) plan.get("requestId");
        assertObligation(requestId, "UNKNOWN_HELD", RESERVATION, null);
        assertThat(evidenceCount(plan)).isZero();
        assertThat(messageCount(fixture)).isZero();
        Money after = money();
        assertThat(after.held()).isEqualTo(before.held() + RESERVATION);
        assertThat(after.dailySettled()).isEqualTo(before.dailySettled());
        assertThat(aiOff()).isTrue();
        assertLedgerAgreement();

        // No automatic re-send: the same approval is consumed and reactivation keeps the hold.
        runtime.control(Map.of("mode", "success", "release", true));
        error(ask(fixture, plan), 409, "AI_REQUEST_PLAN_REQUIRED");
        reactivate();
        assertObligation(requestId, "UNKNOWN_HELD", RESERVATION, null);
        assertThat(money().held()).isEqualTo(before.held() + RESERVATION);
        assertThat(eventsFor(plan)).hasSize(1);
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
    }

    @Test
    @DisplayName("C13-13 user retry after an unknown outcome is a new UUID and a new reservation")
    void c13_13_retryAfterUnknownOutcomeNeedsANewApprovalAndReservation() throws Exception {
        Map<String, Object> lost = prepare(fixture);
        runtime.control(Map.of("mode", "throw-after-send", "release", true));
        error(ask(fixture, lost), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        runtime.control(Map.of("mode", "success", "release", true));
        reactivate();
        Map<String, Object> retry = prepare(fixture);
        assertThat(retry.get("requestId")).isNotEqualTo(lost.get("requestId"));
        success(ask(fixture, retry));
        assertObligation((String) lost.get("requestId"), "UNKNOWN_HELD", RESERVATION, null);
        assertObligation((String) retry.get("requestId"), "SETTLED", RESERVATION, ACTUAL);
        assertThat(eventsFor(lost)).hasSize(1);
        onlyDurablyIntendedEvent(retry);
        Money after = money();
        assertThat(after.held()).isEqualTo(before.held() + RESERVATION);
        assertThat(after.dailySettled()).isEqualTo(before.dailySettled() + ACTUAL);
        assertThat(runtime.events()).hasSize(sendsBefore + 2);
        assertLedgerAgreement();
    }

    @Test
    @DisplayName("C13-14 restart-style reconciliation with an outstanding hold mints no budget")
    void c13_14_reconciliationKeepsOutstandingHoldsExactly() throws Exception {
        Map<String, Object> plan = prepare(fixture);
        runtime.control(Map.of("mode", "no-usage", "release", true));
        error(ask(fixture, plan), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        long liability = pgLiability();
        JsonNode position = journal().path("position");
        for (int i = 0; i < 2; i++) {
            reactivate();
            assertThat(pgLiability()).isEqualTo(liability);
            assertThat(money().held()).isEqualTo(before.held() + RESERVATION);
            assertObligation((String) plan.get("requestId"), "UNKNOWN_HELD", RESERVATION, null);
        }
        assertThat(Long.parseLong(journal().path("position").path("sequence").stringValue()))
                .isGreaterThan(Long.parseLong(position.path("sequence").stringValue()));
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertLedgerAgreement();
    }

    @Test
    @DisplayName("C13-15 DB failure before the reservation commit: no row and zero sends")
    void c13_15_databaseFailureBeforeReservationSendsNothing() throws Exception {
        Map<String, Object> plan = prepare(fixture);
        installFailure("ci_c13_reserve", "before insert on ai_request_ledger", "true");
        try {
            // Observed: the reservation's DataAccessException is outside AiDesktopGateway.execute's
            // try block, so it surfaces as a generic 500 (Low, recorded). Nothing internal is echoed.
            Reply failed = ask(fixture, plan);
            assertThat(failed.status()).isEqualTo(500);
            assertThat(failed.body()).doesNotContain("Synthetic C13", "ai_request_ledger", SYNTHETIC_KEY, LAUNCH_TOKEN);
        } finally {
            removeFailure("ci_c13_reserve", "ai_request_ledger");
        }
        assertThat(requestCount(plan)).isZero();
        assertThat(eventsFor(plan)).isEmpty();
        assertThat(money()).isEqualTo(before);
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertLedgerAgreement();
    }

    @Test
    @DisplayName("C13-16 DB failure publishing DISPATCHED after the durable intent: zero sends, full hold")
    void c13_16_databaseFailureAtDispatchPublicationSendsNothing() throws Exception {
        Map<String, Object> plan = prepare(fixture);
        installFailure("ci_c13_dispatch", "before update on ai_request_ledger", "new.status = 'DISPATCHED'");
        try {
            error(ask(fixture, plan), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        } finally {
            removeFailure("ci_c13_dispatch", "ai_request_ledger");
        }
        assertThat(eventsFor(plan)).isEmpty();
        assertThat(requestRow(plan))
                .containsEntry("status", "UNKNOWN_HELD")
                .containsEntry("reserved_micro_usd", RESERVATION);
        assertThat(aiOff()).isTrue();
        reactivate();
        assertObligation((String) plan.get("requestId"), "UNKNOWN_HELD", RESERVATION, null);
        assertThat(money().held()).isEqualTo(before.held() + RESERVATION);
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertLedgerAgreement();
    }

    @Test
    @DisplayName("C13-17 DB failure writing usage evidence after the response: one send, full hold, no answer")
    void c13_17_databaseFailureAtEvidenceKeepsTheHold() throws Exception {
        Map<String, Object> plan = prepare(fixture);
        installFailure("ci_c13_evidence", "before insert on ai_usage_evidence", "true");
        try {
            error(ask(fixture, plan), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        } finally {
            removeFailure("ci_c13_evidence", "ai_usage_evidence");
        }
        onlyDurablyIntendedEvent(plan);
        assertThat(evidenceCount(plan)).isZero();
        assertThat(messageCount(fixture)).isZero();
        assertObligation((String) plan.get("requestId"), "UNKNOWN_HELD", RESERVATION, null);
        reactivate();
        assertObligation((String) plan.get("requestId"), "UNKNOWN_HELD", RESERVATION, null);
        assertThat(money().held()).isEqualTo(before.held() + RESERVATION);
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertLedgerAgreement();
    }

    @Test
    @DisplayName("C13-18 PG clock high-water ahead of the wall clock: no reservation, no send, no new budget")
    void c13_18_clockRegressionAgainstThePgHighWaterRefusesTheReservation() throws Exception {
        Map<String, Object> plan = prepare(fixture);
        long ahead = Instant.now().toEpochMilli() + 6_000;
        jdbc.update("update ai_budget_gate set clock_high_water_ms=? where installation_id=?", ahead, installation);
        error(ask(fixture, plan), 503, "AI_COST_RECONCILIATION_REQUIRED");
        assertThat(requestCount(plan)).isZero();
        assertThat(eventsFor(plan)).isEmpty();
        assertThat(money()).isEqualTo(before);
        // Let the real clock pass the synthetic high-water instead of regressing it (V25 forbids that).
        while (Instant.now().toEpochMilli() <= ahead + 50) Thread.sleep(50);
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertLedgerAgreement();
    }

    @Test
    @DisplayName("C13-19 main wall clock regresses after the PG reservation: zero sends, full hold, latched")
    void c13_19_mainClockRegressionAfterReservationSendsNothing() throws Exception {
        Map<String, Object> plan = prepare(fixture);
        runtime.control(Map.of("mode", "success", "release", true, "wallOffsetMs", -600_000));
        try {
            error(ask(fixture, plan), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
            assertThat(aiOff()).isTrue();
        } finally {
            runtime.control(Map.of("mode", "success", "release", true));
        }
        assertThat(eventsFor(plan)).isEmpty();
        assertThat(requestRow(plan))
                .containsEntry("status", "UNKNOWN_HELD")
                .containsEntry("reserved_micro_usd", RESERVATION);
        reactivate();
        assertObligation((String) plan.get("requestId"), "UNKNOWN_HELD", RESERVATION, null);
        assertThat(money().held()).isEqualTo(before.held() + RESERVATION);
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertLedgerAgreement();
    }

    @Test
    @DisplayName("C13-20 stale price catalog (>30 days): no quote, no reservation, no send")
    void c13_20_staleCatalogGivesNoQuote() throws Exception {
        runtime.control(Map.of("mode", "success", "release", true, "catalog", "stale"));
        Reply plan;
        try {
            plan = request("POST", route(fixture, "/request-plan"), defaultBody());
        } finally {
            runtime.control(Map.of("mode", "success", "release", true));
        }
        error(plan, 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        assertThat(jdbc.queryForObject(
                        "select count(*) from ai_request_ledger where project_id=?", Long.class, fixture.projectId()))
                .isZero();
        assertThat(money()).isEqualTo(before);
        assertThat(runtime.events()).hasSize(sendsBefore);
    }

    @ParameterizedTest(name = "{0} catalog becomes {1} between approval and dispatch: zero sends, conservative hold")
    @CsvSource({"C13-21, stale", "C13-22, changed-price"})
    void c13_21to22_catalogChangeAfterApprovalSendsNothing(String caseId, String catalog) throws Exception {
        Map<String, Object> plan = prepare(fixture);
        runtime.control(Map.of("mode", "success", "release", true, "catalog", catalog));
        try {
            error(ask(fixture, plan), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        } finally {
            runtime.control(Map.of("mode", "success", "release", true));
        }
        assertThat(eventsFor(plan)).isEmpty();
        // The Java reservation committed before main's approval check; without proof of non-send it stays held.
        assertThat(requestRow(plan))
                .containsEntry("status", "UNKNOWN_HELD")
                .containsEntry("reserved_micro_usd", RESERVATION);
        reactivate();
        assertObligation((String) plan.get("requestId"), "UNKNOWN_HELD", RESERVATION, null);
        assertThat(money().held()).isEqualTo(before.held() + RESERVATION);
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertLedgerAgreement();
    }

    @ParameterizedTest(name = "{0} private QUOTE {1} is refused before any reservation or send")
    @CsvSource({
        "C13-23, unknown-model",
        "C13-24, embedding-operation",
        "C13-25, unbounded-billing-body",
        "C13-26, caller-supplied-endpoint",
        "C13-27, missing-output-cap"
    })
    void c13_23to27_unsupportedContractsGetNoQuote(String caseId, String variant) throws Exception {
        long rows = ledgerRows();
        Map<String, Object> body = new LinkedHashMap<>(supportedBody());
        Map<String, Object> input = quoteInput();
        switch (variant) {
            case "unknown-model" -> {
                input.put("model", "gpt-4o-2024-08-06");
                body.put("model", "gpt-4o-2024-08-06");
            }
            case "embedding-operation" -> {
                input.put("model", "text-embedding-3-small");
                input.put("operation", "EMBEDDING");
                body.clear();
                body.putAll(Map.of("model", "text-embedding-3-small", "input", "u"));
            }
            case "unbounded-billing-body" -> body.put("reasoning_effort", "high");
            case "caller-supplied-endpoint" -> input.put("origin", "https://attacker.example.invalid");
            case "missing-output-cap" -> body.remove("max_completion_tokens");
            default -> throw new IllegalArgumentException(variant);
        }
        input.put("bodyBase64", Base64.getEncoder().encodeToString(json.writeValueAsBytes(body)));
        assertThatThrownBy(() -> main.exchange("QUOTE", input)).isInstanceOf(AiSafetyUnavailableException.class);
        assertThat(ledgerRows()).isEqualTo(rows);
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertThat(money()).isEqualTo(before);
    }

    @Test
    @DisplayName("C13-28 no second permit for a settled UUID through the private channel")
    void c13_28_settledUuidCannotObtainASecondPermit() throws Exception {
        Map<String, Object> plan = prepare(fixture);
        success(ask(fixture, plan));
        String requestId = (String) plan.get("requestId");
        Map<String, Object> row = requestRow(plan);
        String payload = (String) row.get("payload_sha256");
        String approval = row.get("approval_id").toString();
        assertThatThrownBy(() -> main.exchange(
                        "APPROVE", Map.of("requestId", requestId, "approvalId", approval, "payloadSha256", payload)))
                .isInstanceOf(AiSafetyUnavailableException.class);
        assertThatThrownBy(() -> main.exchange("EXECUTE", Map.of("requestId", requestId, "payloadSha256", payload)))
                .isInstanceOf(AiSafetyUnavailableException.class);
        Map<String, Object> input = quoteInput();
        input.put("requestId", requestId);
        assertThatThrownBy(() -> main.exchange("QUOTE", input)).isInstanceOf(AiSafetyUnavailableException.class);
        onlyDurablyIntendedEvent(plan);
        assertObligation(requestId, "SETTLED", RESERVATION, ACTUAL);
        assertThat(runtime.events()).hasSize(sendsBefore + 1);
        assertLedgerAgreement();
    }

    @Test
    @DisplayName("C13-29 no permit without one-use approval and a committed PG reservation (send order step 1)")
    void c13_29_permitRequiresApprovalAndACommittedReservation() throws Exception {
        long rows = ledgerRows();
        Map<String, Object> input = quoteInput();
        input.put("bodyBase64", Base64.getEncoder().encodeToString(json.writeValueAsBytes(supportedBody())));
        JsonNode quote = main.exchange("QUOTE", input);
        assertThat(quote.path("reservedMicroUsd").stringValue()).isEqualTo(Long.toString(RESERVATION));
        String requestId = (String) input.get("requestId");
        String payload = quote.path("payloadSha256").stringValue();
        Map<String, Object> execute = Map.of("requestId", requestId, "payloadSha256", payload);
        // 1. Prepared but not approved.
        assertThatThrownBy(() -> main.exchange("EXECUTE", execute)).isInstanceOf(AiSafetyUnavailableException.class);
        assertThat(runtime.events()).hasSize(sendsBefore);
        // 2. Approved, but the backend never committed the PG reservation: main refuses before any intent.
        main.exchange(
                "APPROVE",
                Map.of("requestId", requestId, "approvalId", input.get("approvalId"), "payloadSha256", payload));
        assertThatThrownBy(() -> main.exchange("EXECUTE", execute)).isInstanceOf(AiSafetyUnavailableException.class);
        assertThat(journalRow(requestId)).isNull();
        assertThat(ledgerRows()).isEqualTo(rows);
        assertThat(runtime.events()).hasSize(sendsBefore);
        // 3. A refused UUID can never be reused for a later permit.
        assertThatThrownBy(() -> main.exchange("EXECUTE", execute)).isInstanceOf(AiSafetyUnavailableException.class);
        assertThat(aiOff()).isTrue();
        assertThat(money().held()).isEqualTo(before.held());
        assertThat(runtime.events()).hasSize(sendsBefore);
        assertLedgerAgreement();
    }

    private static Map<String, Object> supportedBody() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", AiDesktopGateway.MODEL);
        body.put("messages", List.of(Map.of("role", "system", "content", "s"), Map.of("role", "user", "content", "u")));
        body.put("max_completion_tokens", 2048);
        body.put("response_format", Map.of("type", "json_object"));
        body.put("stream", false);
        body.put("n", 1);
        body.put("store", false);
        body.put("service_tier", "default");
        return body;
    }

    private Map<String, Object> quoteInput() {
        Map<String, Object> input = new LinkedHashMap<>();
        var gate = jdbc.queryForMap(
                "select policy_revision, policy_sha256 from ai_budget_gate where installation_id=?", installation);
        input.put("requestId", UUID.randomUUID().toString());
        input.put("approvalId", UUID.randomUUID().toString());
        input.put("planSha256", HexFormat.of().formatHex(new byte[32]).replace('0', 'a'));
        input.put("ownerUserId", Long.toString(userId));
        input.put("projectId", Long.toString(fixture.projectId()));
        input.put("snapshotId", Long.toString(fixture.snapshotId()));
        input.put(
                "settingsRevision",
                jdbc.queryForObject("select revision from user_ai_preferences where user_id=?", Long.class, userId)
                        .toString());
        input.put("provider", "openai");
        input.put("model", AiDesktopGateway.MODEL);
        input.put("operation", "CHAT");
        input.put("policyRevision", gate.get("policy_revision").toString());
        input.put("policySha256", gate.get("policy_sha256"));
        input.put("budgetDay", LocalDate.now(ZoneOffset.UTC).toString());
        input.put("expiresAt", Instant.now().plusSeconds(300).toEpochMilli());
        input.put("outputTokenCap", "2048");
        input.put("bodyBase64", Base64.getEncoder().encodeToString("{}".getBytes(StandardCharsets.UTF_8)));
        return input;
    }

    private void installFailure(String name, String timing, String condition) {
        jdbc.execute("""
                create function %1$s() returns trigger language plpgsql as $$
                begin
                  if %2$s then raise exception 'Synthetic C13 database failure'; end if;
                  return new;
                end $$
                """.formatted(name, condition));
        jdbc.execute("create trigger %1$s %2$s for each row execute function %1$s()".formatted(name, timing));
    }

    private void removeFailure(String name, String table) {
        jdbc.execute("drop trigger if exists %s on %s".formatted(name, table));
        jdbc.execute("drop function if exists %s()".formatted(name));
    }
}
