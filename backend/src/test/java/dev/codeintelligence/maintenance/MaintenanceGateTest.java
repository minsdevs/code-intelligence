package dev.codeintelligence.maintenance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.web.server.ResponseStatusException;

@Timeout(10)
class MaintenanceGateTest {
    private final MaintenanceGate gate = new MaintenanceGate();
    private final UUID id = UUID.randomUUID();

    @Test
    void startupMaintenanceBlocksAdmissionBeforeHealthCheckAndReleasesOnlyExplicitly() {
        var startup = new MaintenanceGate(id.toString());
        assertThat(startup.active()).isTrue();
        assertUnavailable(startup::admitRequest);
        assertUnavailable(startup::admitWriter);
        assertUnavailable(startup::admitJob);
        var ticket = startup.current(id);
        assertThat(startup.snapshot(ticket, 0).state()).isEqualTo("DRAINED");
        startup.end(ticket, 0);
        assertThat(startup.active()).isFalse();
        startup.admitRequest().close();
    }

    @Test
    void emptyStartupIdKeepsOrdinaryStartupAndMalformedIdsCannotOpenTheGate() {
        assertThat(new MaintenanceGate("").active()).isFalse();
        assertThatThrownBy(() -> new MaintenanceGate("private-invalid-value"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MaintenanceGate("1-1-1-1-1")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void beginsInactiveAndAllLeaseKindsAreCountedUntilTheirOwnClose() {
        assertThat(gate.active()).isFalse();
        var request = gate.admitRequest();
        var writer = gate.admitWriter();
        var job = gate.admitJob();
        gate.begin(id);
        assertCounts("DRAINING", 1, 1, 1, 0);
        request.close();
        assertCounts("DRAINING", 0, 1, 1, 0);
        writer.close();
        assertCounts("DRAINING", 0, 0, 1, 0);
        job.close();
        assertCounts("DRAINED", 0, 0, 0, 0);
    }

    @Test
    void closedBarrierRejectsNewRequestsAndUnrelatedBackgroundWork() {
        gate.begin(id);
        assertUnavailable(gate::admitRequest);
        assertUnavailable(gate::admitWriter);
        assertUnavailable(gate::admitJob);
        assertCounts("DRAINED", 0, 0, 0, 0);
    }

    @Test
    void acceptedHttpRequestCanHandOffChildrenAfterBeginWithoutACountGap() {
        var request = gate.admitRequest();
        gate.begin(id);
        var writer = gate.admitWriter();
        var job = gate.admitJob();
        request.close();
        assertCounts("DRAINING", 0, 1, 1, 0);
        assertUnavailable(gate::admitJob);
        writer.close();
        job.close();
        assertCounts("DRAINED", 0, 0, 0, 0);
    }

    @Test
    void acceptedRequestLineageDoesNotAuthorizeAnUnrelatedThread() throws Exception {
        try (var request = gate.admitRequest();
                var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            gate.begin(id);
            executor.submit(() -> {
                        assertUnavailable(gate::admitWriter);
                        assertUnavailable(gate::admitJob);
                    })
                    .get(3, TimeUnit.SECONDS);
            assertCounts("DRAINING", 1, 0, 0, 0);
        }
        assertCounts("DRAINED", 0, 0, 0, 0);
    }

    @Test
    void childCanCompleteOnAnotherThreadAndAllClosesAreIdempotent() throws Exception {
        var request = gate.admitRequest();
        var writer = gate.admitWriter();
        var job = gate.admitJob();
        gate.begin(id);
        request.close();
        request.close();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            executor.submit(() -> {
                        writer.close();
                        writer.close();
                        job.close();
                        job.close();
                    })
                    .get(3, TimeUnit.SECONDS);
        }
        assertCounts("DRAINED", 0, 0, 0, 0);
    }

    @Test
    void nestedRequestScopesMustCloseInOrderAndCannotLoseTheOuterLease() {
        var outer = gate.admitRequest();
        var inner = gate.admitRequest();
        gate.begin(id);
        assertThatThrownBy(outer::close).isInstanceOf(IllegalStateException.class);
        assertCounts("DRAINING", 2, 0, 0, 0);
        inner.close();
        try (var child = gate.admitJob()) {
            assertCounts("DRAINING", 1, 0, 1, 0);
        }
        outer.close();
        assertCounts("DRAINED", 0, 0, 0, 0);
    }

    @Test
    void duplicateBeginIsIdempotentButAnotherTransactionCannotControlIt() {
        var first = gate.begin(id);
        assertThat(gate.begin(id)).isEqualTo(first);
        UUID other = UUID.randomUUID();
        assertConflict(() -> gate.begin(other));
        assertConflict(() -> gate.current(other));
        assertThat(gate.active()).isTrue();
    }

    @Test
    void endReturnsThePreClearSnapshotAndReopensAdmissionOnlyExplicitly() {
        var writer = gate.admitWriter();
        var ticket = gate.begin(id);
        assertThat(gate.end(ticket, 0).state()).isEqualTo("DRAINING");
        assertThat(gate.active()).isFalse();
        try (var request = gate.admitRequest()) {
            writer.close();
        }
        assertConflict(() -> gate.current(id));
    }

    @Test
    void staleSqlObservationCannotEndOrReportANewerTransactionEvenWithTheSameUuid() {
        var old = gate.begin(id);
        gate.end(old, 0);
        gate.begin(id);
        assertConflict(() -> gate.snapshot(old, 0));
        assertConflict(() -> gate.end(old, 0));
        assertThat(gate.active()).isTrue();
    }

    @Test
    void requestFinishingDuringSqlQueryRequiresFreshObservationEvenWhenCountersReachZero() {
        var request = gate.admitRequest();
        var beforeSql = gate.begin(id);
        // This request can have committed a QUEUED row after SQL observed zero rows and then
        // failed before dispatch. Its completion must not turn that old SQL result into DRAINED.
        request.close();
        var old = gate.snapshot(beforeSql, 0);
        assertThat(old.state()).isEqualTo("DRAINING");
        assertThat(old.activeRequests()).isZero();
        assertCounts("DRAINING", 0, 0, 1, 1);
        assertCounts("DRAINED", 0, 0, 0, 0);
    }

    @Test
    void databaseJobsPreventDrainAfterTheLastLiveWorkerAndAreNotAddedTwice() {
        var job = gate.admitJob();
        gate.begin(id);
        assertCounts("DRAINING", 0, 0, 1, 1);
        assertCounts("DRAINING", 0, 0, 3, 3);
        job.close();
        assertCounts("DRAINING", 0, 0, 1, 1);
    }

    @Test
    void failedObservationDoesNotReopenAdmission() {
        var ticket = gate.begin(id);
        assertThatThrownBy(() -> gate.snapshot(ticket, -1)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> gate.end(ticket, -1)).isInstanceOf(IllegalStateException.class);
        assertThat(gate.active()).isTrue();
        assertUnavailable(gate::admitRequest);
    }

    private void assertCounts(String state, long requests, long writers, long jobs, long databaseJobs) {
        assertThat(gate.snapshot(gate.current(id), databaseJobs))
                .isEqualTo(new MaintenanceGate.View(id.toString(), state, requests, writers, jobs));
    }

    private static void assertUnavailable(Runnable action) {
        assertThatThrownBy(action::run)
                .isInstanceOfSatisfying(
                        ResponseStatusException.class,
                        error -> assertThat(error.getStatusCode().value()).isEqualTo(503));
    }

    private static void assertConflict(Runnable action) {
        assertThatThrownBy(action::run)
                .isInstanceOfSatisfying(
                        ResponseStatusException.class,
                        error -> assertThat(error.getStatusCode().value()).isEqualTo(409));
    }
}
