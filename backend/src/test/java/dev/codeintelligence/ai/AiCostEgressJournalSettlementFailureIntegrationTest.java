package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * C13-32 (terminal for its main process): the provider answered, but the journal's SETTLED append fails.
 * No answer is returned, the full reservation stays held, and the request is never sent again.
 */
class AiCostEgressJournalSettlementFailureIntegrationTest extends CostEgressHarness {

    @Test
    @DisplayName("C13-32 SETTLED journal append failure after the response: one send, no answer, full hold")
    void c13_32_settlementJournalFailureKeepsTheWholeHold() throws Exception {
        readyForRequests("10000000", "10000000");
        Fixture fixture = sourceFixture();
        Money before = money();
        Map<String, Object> plan = prepare(fixture);
        runtime.control(Map.of("mode", "success", "release", true, "journalFault", "settle-write"));
        Reply reply = ask(fixture, plan);
        error(reply, 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        assertThat(reply.body()).doesNotContain("Synthetic desktop answer");
        runtime.expectFailClosedShutdown();
        assertThat(runtime.faults())
                .containsExactly(Map.of("fault", "settle-write", "stage", "log.beforeWrite", "phase", "settle"));
        onlyDurablyIntendedEvent(plan);
        Map<String, Object> row = requestRow(plan);
        assertThat(row.get("status")).isIn("UNKNOWN_HELD", "DISPATCHED");
        assertThat(row).containsEntry("reserved_micro_usd", RESERVATION).containsEntry("actual_micro_usd", null);
        assertThat(messageCount(fixture)).isZero();
        assertThat(money().held()).isEqualTo(before.held() + RESERVATION);
        assertThat(money().dailySettled()).isEqualTo(before.dailySettled());
        assertThat(aiOff()).isTrue();

        runtime.control(Map.of("mode", "success", "release", true));
        error(ask(fixture, plan), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(request("POST", route(fixture, "/request-plan"), defaultBody())
                        .status())
                .isGreaterThanOrEqualTo(400);
        assertThat(runtime.events()).hasSize(1);
        assertThat(requestRow(plan))
                .containsEntry("reserved_micro_usd", RESERVATION)
                .containsEntry("actual_micro_usd", null);
    }
}
