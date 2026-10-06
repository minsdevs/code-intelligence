package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * C13-31 (terminal for its main process): the journal's DISPATCH_INTENT append fails at fsync via the
 * journal's own fault hook. Main must not send; PG keeps the full reservation; the poisoned journal fails
 * closed for every later request in this process.
 */
class AiCostEgressJournalIntentFailureIntegrationTest extends CostEgressHarness {

    @Test
    @DisplayName("C13-31 DISPATCH_INTENT fsync failure: zero sends, full hold, fail-closed afterwards")
    void c13_31_intentFsyncFailureSendsNothing() throws Exception {
        readyForRequests("10000000", "10000000");
        Fixture fixture = sourceFixture();
        Money before = money();
        Map<String, Object> plan = prepare(fixture);
        runtime.control(Map.of("mode", "success", "release", true, "journalFault", "intent-fsync"));
        error(ask(fixture, plan), 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        runtime.expectFailClosedShutdown();
        assertThat(runtime.faults())
                .containsExactly(Map.of("fault", "intent-fsync", "stage", "log.beforeFsync", "phase", "reserve"));
        assertThat(runtime.events()).isEmpty();
        assertThat(requestRow(plan))
                .containsEntry("status", "UNKNOWN_HELD")
                .containsEntry("reserved_micro_usd", RESERVATION)
                .containsEntry("actual_micro_usd", null);
        assertThat(evidenceCount(plan)).isZero();
        assertThat(money().held()).isEqualTo(before.held() + RESERVATION);
        assertThat(aiOff()).isTrue();

        // Fail closed: neither a new plan nor reactivation can reach the provider in this process.
        runtime.control(Map.of("mode", "success", "release", true));
        Reply next = request("POST", route(fixture, "/request-plan"), defaultBody());
        assertThat(next.status()).isGreaterThanOrEqualTo(400);
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
        assertThat(List.of(request("POST", route(fixture, "/request-plan"), defaultBody())
                        .status()))
                .allMatch(code -> code >= 400);
        assertThat(requestRow(plan))
                .containsEntry("status", "UNKNOWN_HELD")
                .containsEntry("reserved_micro_usd", RESERVATION);
        assertThat(runtime.events()).isEmpty();
    }
}
