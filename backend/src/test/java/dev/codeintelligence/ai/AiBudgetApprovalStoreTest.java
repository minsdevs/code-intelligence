package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
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

class AiBudgetApprovalStoreTest {
    private static final String BINDING = "a".repeat(64);
    private static final String CHANGED_BINDING = "b".repeat(64);
    private MutableClock clock;
    private AtomicLong nanos;
    private AiBudgetApprovalStore store;

    @BeforeEach
    void setup() {
        clock = new MutableClock();
        nanos = new AtomicLong();
        store = new AiBudgetApprovalStore(clock, nanos::get);
    }

    @Test
    void opaqueApprovalCanBeConsumedOnlyOnce() {
        String token = store.issue(1, BINDING);
        assertThat(token).matches("[0-9a-f]{64}").isNotEqualTo(BINDING);
        store.consume(1, token, BINDING);
        assertRequired(1, token, BINDING);
    }

    @Test
    void everyIssueReplacesTheOwnerApprovalEvenWithUnchangedBinding() {
        String oldToken = store.issue(1, BINDING);
        String current = store.issue(1, BINDING);
        assertThat(current).isNotEqualTo(oldToken);
        assertRequired(1, oldToken, BINDING);
        store.consume(1, current, BINDING);
    }

    @Test
    void changedBindingIssueDoesNotLetTheOldTokenBurnItsReplacement() {
        String oldToken = store.issue(1, BINDING);
        String current = store.issue(1, CHANGED_BINDING);
        assertRequired(1, oldToken, CHANGED_BINDING);
        store.consume(1, current, CHANGED_BINDING);
    }

    @Test
    void changedBackBindingCannotReviveSpentApproval() {
        String token = store.issue(1, BINDING);
        assertRequired(1, token, CHANGED_BINDING);
        assertRequired(1, token, BINDING);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"secret-binding", "A", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"})
    void malformedBindingBurnsTheAuthenticOwnerTokenWithoutEcho(String binding) {
        String token = store.issue(1, BINDING);
        assertRequired(1, token, binding);
        assertRequired(1, token, BINDING);
    }

    @Test
    void wrongOwnerCannotBurnEitherOwnersPendingApproval() {
        String ownerOne = store.issue(1, BINDING);
        String ownerTwo = store.issue(2, CHANGED_BINDING);
        assertRequired(2, ownerOne, CHANGED_BINDING);
        assertRequired(3, ownerOne, BINDING);
        store.consume(1, ownerOne, BINDING);
        store.consume(2, ownerTwo, CHANGED_BINDING);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"secret-token", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "x"})
    void malformedTokenCannotBurnTheOwnersCurrentApproval(String token) {
        String current = store.issue(1, BINDING);
        assertRequired(1, token, BINDING);
        store.consume(1, current, BINDING);
    }

    @Test
    void aTokenWithATrailingTerminatorIsRejected() {
        String token = store.issue(1, BINDING);
        for (String suffix : new String[] {"\n", "\r", "\u2028", "\u2029"}) {
            assertRequired(1, token + suffix, BINDING);
        }
        store.consume(1, token, BINDING);
    }

    @Test
    void syntacticallyValidUnknownTokenDoesNotBurnAnotherToken() {
        String current = store.issue(1, BINDING);
        assertRequired(1, "c".repeat(64), BINDING);
        store.consume(1, current, BINDING);
    }

    @Test
    void invalidateIsOwnerScopedIdempotentAndCannotReviveByIssuingAgain() {
        String first = store.issue(1, BINDING);
        String other = store.issue(2, BINDING);
        store.invalidate(1);
        store.invalidate(1);
        store.invalidate(3);
        String replacement = store.issue(1, BINDING);
        assertRequired(1, first, BINDING);
        store.consume(1, replacement, BINDING);
        store.consume(2, other, BINDING);
    }

    @Test
    void aFreshProcessCannotConsumeApprovalFromPreviousProcess() {
        String token = store.issue(1, BINDING);
        var restarted = new AiBudgetApprovalStore(clock, nanos::get);
        assertThatThrownBy(() -> restarted.consume(1, token, BINDING))
                .isInstanceOf(AiRequestPlanRequiredException.class);
    }

    @Test
    void failedActivationCannotRetryTheConsumedToken() {
        String token = store.issue(1, BINDING);
        store.consume(1, token, BINDING);
        // The store has no rollback/reissue API if later journal or database work fails.
        assertRequired(1, token, BINDING);
    }

    @Test
    void approvalIsValidJustBeforeBothExpiryBoundaries() {
        String token = store.issue(1, BINDING);
        clock.now = clock.now.plus(AiBudgetApprovalStore.LIFETIME).minusNanos(1);
        nanos.set(AiBudgetApprovalStore.LIFETIME.toNanos() - 1);
        store.consume(1, token, BINDING);
    }

    @Test
    void exactWallExpiryRejectsEvenIfMonotonicClockHasNotAdvanced() {
        String token = store.issue(1, BINDING);
        clock.now = clock.now.plus(AiBudgetApprovalStore.LIFETIME);
        assertRequired(1, token, BINDING);
    }

    @Test
    void exactMonotonicExpiryRejectsEvenIfWallClockHasNotAdvanced() {
        String token = store.issue(1, BINDING);
        nanos.set(AiBudgetApprovalStore.LIFETIME.toNanos());
        assertRequired(1, token, BINDING);
    }

    @Test
    void replacementGetsItsOwnBoundedLifetime() {
        String old = store.issue(1, BINDING);
        clock.now = clock.now.plusSeconds(299);
        nanos.set(Duration.ofSeconds(299).toNanos());
        String replacement = store.issue(1, BINDING);
        clock.now = clock.now.plusSeconds(1);
        nanos.set(AiBudgetApprovalStore.LIFETIME.toNanos());
        assertRequired(1, old, BINDING);
        store.consume(1, replacement, BINDING);
    }

    @Test
    void wallRollbackInvalidatesAllOwnersAndRequiresRecoveryAndFreshApproval() {
        String first = store.issue(1, BINDING);
        String second = store.issue(2, BINDING);
        Instant highWater = clock.now;
        clock.now = clock.now.minusNanos(1);
        assertRequired(1, first, BINDING);
        assertThatThrownBy(() -> store.issue(3, BINDING)).isInstanceOf(AiRequestPlanRequiredException.class);
        clock.now = highWater;
        assertRequired(1, first, BINDING);
        assertRequired(2, second, BINDING);
        store.consume(1, store.issue(1, BINDING), BINDING);
    }

    @Test
    void monotonicRollbackInvalidatesAllOwnersEvenIfWallTimeAdvances() {
        nanos.set(100);
        String first = store.issue(1, BINDING);
        String second = store.issue(2, BINDING);
        nanos.set(99);
        clock.now = clock.now.plusSeconds(1);
        assertRequired(1, first, BINDING);
        assertThatThrownBy(() -> store.issue(3, BINDING)).isInstanceOf(AiRequestPlanRequiredException.class);
        nanos.set(100);
        assertRequired(1, first, BINDING);
        assertRequired(2, second, BINDING);
        store.consume(2, store.issue(2, BINDING), BINDING);
    }

    @Test
    void rollbackOnIssueAlsoClearsAllPreviouslyIssuedApprovals() {
        String token = store.issue(1, BINDING);
        Instant highWater = clock.now;
        clock.now = clock.now.minusSeconds(1);
        assertThatThrownBy(() -> store.issue(2, BINDING)).isInstanceOf(AiRequestPlanRequiredException.class);
        clock.now = highWater;
        assertRequired(1, token, BINDING);
    }

    @Test
    void bothClocksMustRecoverBeforeNewApprovalsCanBeIssued() {
        nanos.set(10);
        store.issue(1, BINDING);
        Instant highWater = clock.now;
        nanos.set(9);
        clock.now = clock.now.minusSeconds(1);
        assertThatThrownBy(() -> store.issue(2, BINDING)).isInstanceOf(AiRequestPlanRequiredException.class);
        nanos.set(10);
        assertThatThrownBy(() -> store.issue(2, BINDING)).isInstanceOf(AiRequestPlanRequiredException.class);
        clock.now = highWater;
        nanos.set(9);
        assertThatThrownBy(() -> store.issue(2, BINDING)).isInstanceOf(AiRequestPlanRequiredException.class);
        nanos.set(10);
        store.consume(2, store.issue(2, BINDING), BINDING);
    }

    @Test
    void aRollbackBetweenLaterObservationsIsDetectedBeforeInitialExpiry() {
        store.issue(1, BINDING);
        clock.now = clock.now.plusSeconds(60);
        nanos.set(Duration.ofSeconds(60).toNanos());
        String latest = store.issue(2, BINDING);
        clock.now = clock.now.minusSeconds(1);
        assertRequired(2, latest, BINDING);
    }

    @Test
    void signedMonotonicOriginAndNormalSignedWrapAreSupported() {
        nanos.set(-100);
        String negativeOrigin = store.issue(1, BINDING);
        nanos.set(-99);
        store.consume(1, negativeOrigin, BINDING);
        var wrapping = new AiBudgetApprovalStore(clock, nanos::get);
        nanos.set(Long.MAX_VALUE - 1);
        String token = wrapping.issue(1, BINDING);
        nanos.set(Long.MIN_VALUE + 1);
        wrapping.consume(1, token, BINDING);
    }

    @Test
    void capacityIsBoundedButSameOwnerReplacementAndReleaseRemainAvailable() {
        String first = store.issue(1, BINDING);
        for (int owner = 2; owner <= 1024; owner++) store.issue(owner, BINDING);
        assertThatThrownBy(() -> store.issue(1025, BINDING)).isInstanceOf(AiRequestPlanRequiredException.class);
        String replacement = store.issue(1, BINDING);
        assertRequired(1, first, BINDING);
        store.consume(1, replacement, BINDING);
        store.issue(1025, BINDING);
        store.invalidate(2);
        store.issue(1026, BINDING);
    }

    @Test
    void eitherExpiryClockReleasesGlobalCapacity() {
        for (int owner = 1; owner <= 1024; owner++) store.issue(owner, BINDING);
        nanos.set(AiBudgetApprovalStore.LIFETIME.toNanos());
        for (int owner = 1025; owner <= 2048; owner++) store.issue(owner, BINDING);
        assertThatThrownBy(() -> store.issue(2049, BINDING)).isInstanceOf(AiRequestPlanRequiredException.class);
        clock.now = clock.now.plus(AiBudgetApprovalStore.LIFETIME);
        store.issue(2049, BINDING);
    }

    @ParameterizedTest
    @ValueSource(longs = {0, -1, Long.MIN_VALUE})
    void nonpositiveOwnersCannotIssueConsumeOrInvalidate(long owner) {
        String valid = store.issue(1, BINDING);
        assertThatThrownBy(() -> store.issue(owner, BINDING))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Invalid budget approval binding.");
        assertRequired(owner, valid, BINDING);
        assertThatThrownBy(() -> store.invalidate(owner))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Invalid budget approval owner.");
        store.consume(1, valid, BINDING);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(
            strings = {
                "private-request-context",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "a"
            })
    void invalidIssueBindingDoesNotReplaceAnExistingApprovalOrEchoMetadata(String binding) {
        String valid = store.issue(1, BINDING);
        assertThatThrownBy(() -> store.issue(1, binding))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Invalid budget approval binding.")
                .hasNoCause();
        store.consume(1, valid, BINDING);
    }

    @Test
    void clockFailureClearsApprovalsWithoutEchoingItsCause() {
        String token = store.issue(1, BINDING);
        clock.failure = new IllegalStateException("secret-clock-failure");
        assertRequired(1, token, BINDING);
        clock.failure = null;
        assertRequired(1, token, BINDING);
        store.consume(1, store.issue(1, BINDING), BINDING);
    }

    @Test
    void invalidClockInstantClearsApprovals() {
        String token = store.issue(1, BINDING);
        Instant valid = clock.now;
        clock.now = null;
        assertRequired(1, token, BINDING);
        clock.now = valid;
        assertRequired(1, token, BINDING);
    }

    @Test
    void expiryOverflowCannotIssueAnUnboundedApproval() {
        clock.now = Instant.MAX;
        assertThatThrownBy(() -> store.issue(1, BINDING))
                .isInstanceOf(AiRequestPlanRequiredException.class)
                .hasNoCause();
    }

    @Test
    void invalidationWorksEvenWhileTheClockIsUnavailable() {
        String token = store.issue(1, BINDING);
        clock.failure = new IllegalStateException("secret-clock-failure");
        store.invalidate(1);
        clock.failure = null;
        assertRequired(1, token, BINDING);
    }

    @Test
    void concurrentConfirmationsAdmitExactlyOne() throws Exception {
        String token = store.issue(1, BINDING);
        var start = new CountDownLatch(1);
        var admitted = new AtomicInteger();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> consumeAfter(start, token, admitted));
            var second = executor.submit(() -> consumeAfter(start, token, admitted));
            start.countDown();
            first.get();
            second.get();
        }
        assertThat(admitted.get()).isEqualTo(1);
        assertRequired(1, token, BINDING);
    }

    private void assertRequired(long owner, String token, String binding) {
        assertThatThrownBy(() -> store.consume(owner, token, binding))
                .isInstanceOf(AiRequestPlanRequiredException.class)
                .hasMessageNotContaining("secret")
                .hasMessageNotContaining(BINDING)
                .hasNoCause();
    }

    private void consumeAfter(CountDownLatch start, String token, AtomicInteger admitted) {
        try {
            start.await();
            store.consume(1, token, BINDING);
            admitted.incrementAndGet();
        } catch (AiRequestPlanRequiredException expected) {
            // Only the winning confirmation can continue to the activation operation.
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
    }

    private static final class MutableClock extends Clock {
        Instant now = Instant.parse("2026-10-03T00:00:00Z");
        RuntimeException failure;

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
            if (failure != null) throw failure;
            return now;
        }
    }
}
