package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

@Timeout(10)
class AiDispatchGateTest {
    @Test
    void offDoesNotRevokeAnEarlierAdmissionThatHasNotYetSent() throws Exception {
        AiDispatchGate gate =
                new AiDispatchGate(new AiSafetyPolicy(new org.springframework.mock.env.MockEnvironment()));
        AtomicBoolean enabled = new AtomicBoolean(true);
        AtomicInteger sends = new AtomicInteger();
        CountDownLatch admitted = new CountDownLatch(1);
        CountDownLatch allowSend = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var call = executor.submit(() -> gate.call(1, enabled::get, () -> {
                admitted.countDown();
                await(allowSend);
                return sends.incrementAndGet();
            }));
            try {
                assertThat(admitted.await(3, TimeUnit.SECONDS)).isTrue();
                int activeAtOff = gate.control(() -> {
                    enabled.set(false);
                    return gate.activeRequests(1);
                });
                assertThat(activeAtOff).isEqualTo(1);
                assertThat(sends.get()).isZero();
                assertThatThrownBy(() -> gate.call(1, enabled::get, sends::incrementAndGet))
                        .isInstanceOf(AiSettingsChangedException.class);
            } finally {
                allowSend.countDown();
            }
            assertThat(call.get(3, TimeUnit.SECONDS)).isEqualTo(1);
        }
        assertThat(gate.activeRequests(1)).isZero();
    }

    @Test
    void twoActiveCallsAcrossUsersAreTheGlobalLimitAndCompletionReleasesCapacity() throws Exception {
        AiDispatchGate gate =
                new AiDispatchGate(new AiSafetyPolicy(new org.springframework.mock.env.MockEnvironment()));
        CountDownLatch admitted = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> gate.call(1, () -> true, () -> {
                admitted.countDown();
                await(release);
                return 1;
            }));
            var second = executor.submit(() -> gate.call(2, () -> true, () -> {
                admitted.countDown();
                await(release);
                return 2;
            }));
            try {
                assertThat(admitted.await(3, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> gate.call(3, () -> true, () -> "must not run"))
                        .isInstanceOf(AiBusyException.class);
                assertThat(gate.activeRequests(1)).isEqualTo(1);
                assertThat(gate.activeRequests(2)).isEqualTo(1);
                assertThat(gate.activeRequests(3)).isZero();
            } finally {
                release.countDown();
            }
            assertThat(first.get(3, TimeUnit.SECONDS)).isEqualTo(1);
            assertThat(second.get(3, TimeUnit.SECONDS)).isEqualTo(2);
        }
        assertThat(gate.call(3, () -> true, () -> "next call")).isEqualTo("next call");
        assertThat(gate.activeRequests(1) + gate.activeRequests(2) + gate.activeRequests(3))
                .isZero();
    }

    @Test
    void failedAdmissionNeverRunsTheProviderAndDoesNotLeakCapacity() {
        AiDispatchGate gate =
                new AiDispatchGate(new AiSafetyPolicy(new org.springframework.mock.env.MockEnvironment()));
        AtomicInteger calls = new AtomicInteger();
        assertThatThrownBy(() -> gate.call(
                        1,
                        () -> {
                            throw new IllegalStateException("DB unavailable");
                        },
                        calls::incrementAndGet))
                .isInstanceOf(IllegalStateException.class);
        assertThat(calls.get()).isZero();
        assertThat(gate.activeRequests(1)).isZero();
        assertThat(gate.call(1, () -> true, calls::incrementAndGet)).isEqualTo(1);
    }

    @Test
    void providerFailureOrErrorAlwaysReleasesItsLease() {
        AiDispatchGate gate =
                new AiDispatchGate(new AiSafetyPolicy(new org.springframework.mock.env.MockEnvironment()));
        assertThatThrownBy(() -> gate.call(1, () -> true, () -> {
                    throw new IllegalStateException("provider unavailable");
                }))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> gate.call(1, () -> true, () -> {
                    throw new AssertionError("provider failed");
                }))
                .isInstanceOf(AssertionError.class);
        assertThat(gate.activeRequests(1)).isZero();
        assertThat(gate.call(1, () -> true, () -> "recovered")).isEqualTo("recovered");
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(3, TimeUnit.SECONDS)) throw new AssertionError("test latch timed out");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new AssertionError("test interrupted", ex);
        }
    }
}
