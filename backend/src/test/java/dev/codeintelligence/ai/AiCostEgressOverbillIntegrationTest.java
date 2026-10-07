package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * C13-30 (terminal for its installation): the provider reports usage above the enforced output cap.
 * The whole observed charge is recorded (never clamped), main latches, and no further AI call or
 * activation is possible until manual reconciliation.
 */
class AiCostEgressOverbillIntegrationTest extends CostEgressHarness {
    /** ceil(128000 * 0.15 + 16384 * 0.60) microUSD, above the 22472 reservation. */
    static final long OVERBILLED = 29_031;

    @Test
    @DisplayName("C13-30 over-billing is recorded in full, latched and blocks further calls")
    void c13_30_overBillingIsRecordedInFullAndBlocksFurtherCalls() throws Exception {
        readyForRequests("10000000", "10000000");
        Fixture fixture = sourceFixture();
        Money before = money();
        long liabilityBefore = pgLiability();
        Map<String, Object> plan = prepare(fixture);
        runtime.control(Map.of("mode", "overbill", "release", true));
        Reply reply = ask(fixture, plan);
        assertThat(reply.body()).doesNotContain(SYNTHETIC_KEY, LAUNCH_TOKEN, TOKEN_KEY);
        onlyDurablyIntendedEvent(plan);
        String requestId = (String) plan.get("requestId");
        Map<String, Object> row = requestRow(requestId);
        assertThat(row)
                .containsEntry("status", "SETTLED")
                .containsEntry("reserved_micro_usd", RESERVATION)
                .containsEntry("actual_micro_usd", OVERBILLED);
        var journalRow = journalRow(requestId);
        assertThat(journalRow.path("status").stringValue()).isEqualTo("SETTLED");
        assertThat(journalRow.path("actualMicroUsd").stringValue()).isEqualTo(Long.toString(OVERBILLED));
        assertThat(pgLiability()).isEqualTo(liabilityBefore + OVERBILLED);
        assertThat(jdbc.queryForObject(
                        "select reconciliation_required from ai_budget_gate where installation_id=?",
                        Boolean.class,
                        installation))
                .isTrue();
        assertThat(aiOff()).isTrue();
        Money after = money();
        assertThat(after.state()).isEqualTo("RECOVERY_REQUIRED");
        assertThat(after.dailySettled() + after.held()).isEqualTo(before.dailySettled() + before.held() + OVERBILLED);

        // Further calls are blocked, including after a fresh one-use activation attempt.
        error(request("POST", route(fixture, "/request-plan"), defaultBody()), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        Map<String, Object> budget = success(request("GET", "/api/ai/budget", null));
        if (budget.get("activationToken") != null) {
            Reply activation = request(
                    "POST",
                    "/api/ai/budget/activate",
                    Map.of(
                            "expectedRevision",
                            budget.get("policyRevision"),
                            "activationToken",
                            budget.get("activationToken")));
            assertThat(activation.status()).isNotEqualTo(200);
        }
        assertThat(aiOff()).isTrue();
        error(request("POST", route(fixture, "/request-plan"), defaultBody()), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        assertThat(requestRow(requestId)).containsEntry("actual_micro_usd", OVERBILLED);
        assertThat(runtime.events()).hasSize(1);
    }
}
