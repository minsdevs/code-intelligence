package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigInteger;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * C13-33: settlement is journal-then-PG. The journal fsyncs SETTLED, then the PG projection update fails.
 * PG and the journal now disagree; the more conservative obligation must apply, nothing is re-sent, and
 * no new AI call is admitted before reconciliation. The reconciliation outcome is recorded as observed.
 */
class AiCostEgressSettlementProjectionFailureIntegrationTest extends CostEgressHarness {

    @Test
    @DisplayName("C13-33 PG SETTLED projection failure after journal settlement: conservative, no re-send")
    void c13_33_pgSettlementFailureAfterJournalSettlementStaysConservative() throws Exception {
        readyForRequests("10000000", "10000000");
        Fixture fixture = sourceFixture();
        Money before = money();
        Map<String, Object> plan = prepare(fixture);
        String requestId = (String) plan.get("requestId");
        jdbc.execute("""
                create function ci_c13_settle() returns trigger language plpgsql as $$
                begin
                  if new.status = 'SETTLED' then raise exception 'Synthetic C13 database failure'; end if;
                  return new;
                end $$
                """);
        jdbc.execute("create trigger ci_c13_settle before update on ai_request_ledger "
                + "for each row execute function ci_c13_settle()");
        Reply reply;
        try {
            reply = ask(fixture, plan);
        } finally {
            jdbc.execute("drop trigger if exists ci_c13_settle on ai_request_ledger");
            jdbc.execute("drop function if exists ci_c13_settle()");
        }
        error(reply, 503, "DESKTOP_AI_SAFETY_UNAVAILABLE");
        onlyDurablyIntendedEvent(plan);
        assertThat(messageCount(fixture)).isZero();
        // Journal (higher authority) holds the proven settlement; PG keeps the full reservation.
        var journalRow = journalRow(requestId);
        assertThat(journalRow.path("status").stringValue()).isEqualTo("SETTLED");
        assertThat(journalRow.path("actualMicroUsd").stringValue()).isEqualTo(Long.toString(ACTUAL));
        Map<String, Object> row = requestRow(requestId);
        assertThat(row.get("status")).isIn("UNKNOWN_HELD", "DISPATCHED");
        assertThat(row).containsEntry("reserved_micro_usd", RESERVATION).containsEntry("actual_micro_usd", null);
        assertThat(money().held()).isEqualTo(before.held() + RESERVATION);
        assertThat(aiOff()).isTrue();
        error(ask(fixture, plan), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(request("POST", route(fixture, "/request-plan"), defaultBody())
                        .status())
                .isGreaterThanOrEqualTo(400);

        // Reconciliation: record the outcome. Either the journal's proven settlement is projected to PG,
        // or the disagreement stays conservative and activation is refused. Money is never lost.
        Map<String, Object> budget = success(request("GET", "/api/ai/budget", null));
        Reply activation = budget.get("activationToken") == null
                ? null
                : request(
                        "POST",
                        "/api/ai/budget/activate",
                        Map.of(
                                "expectedRevision",
                                budget.get("policyRevision"),
                                "activationToken",
                                budget.get("activationToken")));
        Map<String, Object> reconciled = requestRow(requestId);
        long pgLiability = "SETTLED".equals(reconciled.get("status")) && !(Boolean) reconciled.get("conflict")
                ? (Long) reconciled.get("actual_micro_usd")
                : Math.max((Long) reconciled.get("reserved_micro_usd"), (Long)
                        reconciled.get("liability_floor_micro_usd"));
        if (activation != null && activation.status() == 200) {
            assertThat(reconciled)
                    .containsEntry("status", "SETTLED")
                    .containsEntry("actual_micro_usd", ACTUAL)
                    .containsEntry("conflict", false);
            assertThat(reconciled.get("proof_sha256"))
                    .isEqualTo(journalRow(requestId).path("proofSha256").stringValue());
        } else {
            assertThat(BigInteger.valueOf(pgLiability)).isGreaterThanOrEqualTo(BigInteger.valueOf(RESERVATION));
            assertThat(aiOff()).isTrue();
        }
        System.out.println("C13-33 observed reconciliation: activationStatus="
                + (activation == null ? "NO_TOKEN" : activation.status()) + " pgStatus=" + reconciled.get("status")
                + " pgLiability=" + pgLiability + " conflict=" + reconciled.get("conflict"));
        assertThat(runtime.events()).hasSize(1);
    }
}
