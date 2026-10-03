package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

class AiRequestPlanStoreTest {
    private static final String BINDING = "a".repeat(64);
    private MutableClock clock;
    private AtomicLong nanos;
    private AiRequestPlanStore store;

    @BeforeEach
    void setup() {
        clock = new MutableClock();
        nanos = new AtomicLong();
        store = new AiRequestPlanStore(clock, nanos::get);
    }

    @Test
    void approvalIsOpaqueUniqueAndConsumedExactlyOnce() {
        var first = store.issue(1, BINDING);
        var second = store.issue(1, BINDING);
        assertThat(first.requestPlanToken()).matches("[0-9a-f]{64}").isNotEqualTo(second.requestPlanToken());
        assertThat(first.requestId()).isNotEqualTo(second.requestId());
        assertThat(first.toString()).doesNotContain(first.requestPlanToken());
        assertThat(store.consume(1, first.requestPlanToken(), BINDING)).isEqualTo(first.requestId());
        assertThatThrownBy(() -> store.consume(1, first.requestPlanToken(), BINDING))
                .isInstanceOf(AiRequestPlanRequiredException.class);
    }

    @Test
    void anotherUserCannotUseOrInvalidateAnApproval() {
        var plan = store.issue(1, BINDING);
        assertThatThrownBy(() -> store.consume(2, plan.requestPlanToken(), BINDING))
                .isInstanceOf(AiRequestPlanRequiredException.class);
        assertThat(store.consume(1, plan.requestPlanToken(), BINDING)).isEqualTo(plan.requestId());
    }

    @Test
    void changedBackPayloadCannotReviveRejectedApproval() {
        var plan = store.issue(1, BINDING);
        assertThatThrownBy(() -> store.consume(1, plan.requestPlanToken(), "b".repeat(64)))
                .isInstanceOf(AiRequestPlanRequiredException.class);
        assertThatThrownBy(() -> store.consume(1, plan.requestPlanToken(), BINDING))
                .isInstanceOf(AiRequestPlanRequiredException.class);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(
            strings = {
                "invalid",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            })
    void absentMalformedAndUnknownCapabilitiesFail(String token) {
        assertThatThrownBy(() -> store.consume(1, token, BINDING)).isInstanceOf(AiRequestPlanRequiredException.class);
    }

    @Test
    void exactExpirationBoundaryRejectsAndCleansCapacity() {
        var plan = store.issue(1, BINDING);
        clock.now = plan.expiresAt();
        assertThatThrownBy(() -> store.consume(1, plan.requestPlanToken(), BINDING))
                .isInstanceOf(AiRequestPlanRequiredException.class);
        assertThat(store.issue(1, BINDING)).isNotNull();
    }

    @Test
    void clockRollbackDoesNotExtendMonotonicLifetime() {
        var plan = store.issue(1, BINDING);
        clock.now = clock.now.minusSeconds(3600);
        nanos.set(AiRequestPlanStore.LIFETIME.toNanos());
        assertThatThrownBy(() -> store.consume(1, plan.requestPlanToken(), BINDING))
                .isInstanceOf(AiRequestPlanRequiredException.class);
    }

    @Test
    void anotherProcessHasNoApprovalsEvenWithSameRestoredDatabaseAndClock() {
        var plan = store.issue(1, BINDING);
        var restarted = new AiRequestPlanStore(clock, nanos::get);
        assertThatThrownBy(() -> restarted.consume(1, plan.requestPlanToken(), BINDING))
                .isInstanceOf(AiRequestPlanRequiredException.class);
    }

    @Test
    void consumedApprovalDoesNotReturnAfterSimulatedDispatchFailure() {
        var plan = store.issue(1, BINDING);
        store.consume(1, plan.requestPlanToken(), BINDING);
        // A network or answer-storage failure does not call any rollback/reissue API.
        assertThatThrownBy(() -> store.consume(1, plan.requestPlanToken(), BINDING))
                .isInstanceOf(AiRequestPlanRequiredException.class);
    }

    @Test
    void perUserLimitKeepsOtherUsersAvailable() {
        for (int i = 0; i < 32; i++) store.issue(1, BINDING);
        assertThatThrownBy(() -> store.issue(1, BINDING)).isInstanceOf(AiBusyException.class);
        assertThat(store.issue(2, BINDING)).isNotNull();
        nanos.set(AiRequestPlanStore.LIFETIME.toNanos());
        assertThat(store.issue(1, BINDING)).isNotNull();
    }

    @Test
    void globalLimitIsBoundedAcrossManyOwners() {
        for (int i = 1; i <= 1024; i++) store.issue(i, BINDING);
        assertThatThrownBy(() -> store.issue(1025, BINDING)).isInstanceOf(AiBusyException.class);
        nanos.set(AiRequestPlanStore.LIFETIME.toNanos());
        assertThat(store.issue(1025, BINDING)).isNotNull();
    }

    @Test
    void concurrentConfirmationsAdmitOnlyOne() throws Exception {
        var plan = store.issue(1, BINDING);
        var start = new CountDownLatch(1);
        var admitted = new AtomicInteger();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> consumeAfter(start, plan.requestPlanToken(), admitted));
            var second = executor.submit(() -> consumeAfter(start, plan.requestPlanToken(), admitted));
            start.countDown();
            first.get();
            second.get();
        }
        assertThat(admitted.get()).isEqualTo(1);
    }

    private void consumeAfter(CountDownLatch start, String token, AtomicInteger admitted) {
        try {
            start.await();
            store.consume(1, token, BINDING);
            admitted.incrementAndGet();
        } catch (AiRequestPlanRequiredException expected) {
            // The losing confirmation must be rejected before any dispatch.
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
    }

    private static final class MutableClock extends Clock {
        Instant now = Instant.parse("2026-10-03T00:00:00Z");

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
