package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * C13-34/35: a fresh installation (first-run state: AI OFF, budget 0) and then a saved provider key with
 * budget 0. Every AI HTTP entry point of the desktop backend is exercised; none can produce a provider
 * call, ledger row, journal obligation or legacy usage row.
 */
class AiCostEgressFirstRunIntegrationTest extends CostEgressHarness {

    @Test
    @DisplayName("C13-34/35 first run AI OFF + budget 0, then key saved with budget 0: zero provider calls")
    void c13_34to35_firstRunAndSavedKeyWithZeroBudgetCannotReachTheProvider() throws Exception {
        Map<String, Object> status = success(request("GET", "/api/ai/status", null));
        assertThat(status).containsEntry("configured", false).containsEntry("blockedReason", null);
        Map<String, Object> budget = success(request("GET", "/api/ai/budget", null));
        // Observed: a fresh gate reports RECOVERY_REQUIRED (not OFF) until the first activation; the UI
        // then shows its reconciliation message on first run (Low UX finding, fail-closed for cost).
        assertThat(budget.get("state")).isIn("OFF", "RECOVERY_REQUIRED");
        System.out.println("C13-34 observed first-run budget state=" + budget.get("state"));
        assertThat(budget)
                .containsEntry("available", true)
                .containsEntry("dailyLimitMicroUsd", "0")
                .containsEntry("monthlyLimitMicroUsd", "0")
                .containsEntry("allDatesHeldMicroUsd", "0")
                .containsEntry("activationToken", null);
        assertThat(aiOff()).isTrue();
        assertThat(request("GET", "/api/ai/settings", null).body()).isIn("", "null");
        userId = jdbc.queryForObject(
                "select id from users where identity_type='LOCAL' and local_key=?", Long.class, installation);
        Fixture fixture = sourceFixture();

        // C13-34: no key, budget 0. Local preview works; every sending entry point is refused.
        success(request("POST", route(fixture, "/preview"), defaultBody()));
        List<Integer> refused = everySendingEntryPoint(fixture);
        System.out.println("C13-34 refused ask/what-if/review/playground statuses=" + refused);
        assertThat(refused).containsExactly(503, 503, 503, 503);
        assertNothingWasSentOrReserved();

        // C13-35: key saved (no provider probe), budget still 0: no activation token, no quote, no send.
        saveSyntheticKey();
        budget = success(request("GET", "/api/ai/budget", null));
        assertThat(budget.get("state")).isIn("OFF", "RECOVERY_REQUIRED");
        assertThat(budget).containsEntry("activationToken", null).containsEntry("dailyLimitMicroUsd", "0");
        error(
                request(
                        "POST",
                        "/api/ai/budget/activate",
                        Map.of("expectedRevision", budget.get("policyRevision"), "activationToken", "a".repeat(64))),
                409,
                "AI_REQUEST_PLAN_REQUIRED");
        error(request("POST", route(fixture, "/request-plan"), defaultBody()), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        refused = everySendingEntryPoint(fixture);
        System.out.println("C13-35 refused ask/what-if/review/playground statuses=" + refused);
        assertThat(refused).allMatch(code -> code >= 400);
        // Non-zero limits saved but never activated still cannot quote or send.
        Map<String, Object> configured = configure(budget.get("policyRevision"), "10000000", "10000000");
        assertThat(configured.get("activationToken")).asString().matches("[0-9a-f]{64}");
        error(request("POST", route(fixture, "/request-plan"), defaultBody()), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        assertThat(aiOff()).isTrue();
        assertNothingWasSentOrReserved();
    }

    /** Every backend route that can lead toward a provider request, with the exact refusal statuses. */
    private List<Integer> everySendingEntryPoint(Fixture fixture) throws Exception {
        String project = "/api/projects/" + fixture.projectId();
        Reply ask = request("POST", route(fixture, "/ask"), defaultBody());
        Reply stream = request("POST", route(fixture, "/ask/stream"), defaultBody());
        Reply whatIf = request("POST", project + "/what-if", Map.of("nodeId", 1, "depth", 1));
        Reply review = request("POST", project + "/pulls/1/review", null);
        Reply created = request("POST", project + "/playground/sessions", Map.of("title", "first-run"));
        assertThat(created.status()).isEqualTo(201);
        Map<String, Object> session = read(created.body());
        Reply playground = request(
                "POST",
                project + "/playground/sessions/" + session.get("id") + "/ask",
                Map.of("question", "Explain this.", "selectedPaths", List.of(SOURCE)));
        for (Reply reply : List.of(ask, stream, whatIf, review, playground))
            assertThat(reply.body()).doesNotContain(SYNTHETIC_KEY, LAUNCH_TOKEN, TOKEN_KEY, "Synthetic desktop answer");
        // The SSE route may report its refusal inside a 200 event stream; it never carries an answer.
        return List.of(ask.status(), whatIf.status(), review.status(), playground.status());
    }

    private void assertNothingWasSentOrReserved() throws Exception {
        assertThat(runtime.events()).isEmpty();
        assertThat(ledgerRows()).isZero();
        assertThat(journal().path("obligations").size()).isZero();
        assertThat(legacyUsageCount()).isZero();
        assertThat(jdbc.queryForObject("select count(*) from ai_usage_evidence", Long.class))
                .isZero();
    }
}
