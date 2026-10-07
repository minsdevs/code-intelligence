package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

class JobCancellationTest {

    @Test
    void checkpointsAreNoOpsOutsideAJobStep() {
        assertThatCode(JobCancellation::checkpoint).doesNotThrowAnyException();
        assertThat(JobCancellation.interruptibly(() -> "done")).isEqualTo("done");
    }

    @Test
    void aCheckpointThrowsOnceTheBoundRunWasCancelledAndNotAfterTheStepLeft() {
        BoundJobCancellation bound = BoundJobCancellation.bind();
        JobCancellation.checkpoint();
        bound.cancel();
        assertThatThrownBy(JobCancellation::checkpoint).isInstanceOf(JobCancelledException.class);
        bound.close();
        assertThatCode(JobCancellation::checkpoint).doesNotThrowAnyException();
    }

    @Test
    void cancelInterruptsABlockedCallAndTheInterruptDoesNotLeakPastIt() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CompletableFuture<BoundJobCancellation> token = new CompletableFuture<>();
        CompletableFuture<Object> outcome = new CompletableFuture<>();
        AtomicBoolean interruptLeaked = new AtomicBoolean(true);
        Thread worker = Thread.ofVirtual().start(() -> {
            try (BoundJobCancellation bound = BoundJobCancellation.bind()) {
                token.complete(bound);
                try {
                    JobCancellation.interruptibly(() -> {
                        entered.countDown();
                        try {
                            Thread.sleep(Duration.ofMinutes(5));
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new IllegalStateException("request was interrupted", interrupted);
                        }
                        return "late result";
                    });
                    outcome.complete("returned");
                } catch (RuntimeException failure) {
                    outcome.complete(failure);
                }
                interruptLeaked.set(Thread.currentThread().isInterrupted());
            }
        });
        assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
        long started = System.nanoTime();
        token.get(10, TimeUnit.SECONDS).cancel();
        assertThat(worker.join(Duration.ofSeconds(10))).isTrue();
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
        assertThat(outcome.get()).isInstanceOf(JobCancelledException.class);
        assertThat(interruptLeaked)
                .as("later database work runs without a pending interrupt")
                .isFalse();
    }

    @Test
    void aFailureWithoutACancelPropagatesUnchanged() {
        try (BoundJobCancellation ignored = BoundJobCancellation.bind()) {
            assertThatThrownBy(() -> JobCancellation.interruptibly(() -> {
                        throw new IllegalArgumentException("analyzer rejected input");
                    }))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("analyzer rejected input");
        }
    }

    @Test
    void anInterruptibleCallIsNotStartedAfterTheCancel() {
        try (BoundJobCancellation bound = BoundJobCancellation.bind()) {
            bound.cancel();
            assertThatThrownBy(() -> JobCancellation.interruptibly(() -> {
                        throw new AssertionError("the request must not be sent");
                    }))
                    .isInstanceOf(JobCancelledException.class);
        }
    }

    @Test
    void aMemoryLimitStopFailsTheStepWithItsRecoveryCodeInsteadOfCancellingIt() {
        BoundJobCancellation bound = BoundJobCancellation.bind();
        JobCancellation.checkpoint();
        bound.exceedMemoryLimit();
        assertThatThrownBy(JobCancellation::checkpoint)
                .isInstanceOf(AnalysisMemoryLimitException.class)
                .isNotInstanceOf(JobCancelledException.class)
                .satisfies(error -> assertThat(((AnalysisMemoryLimitException) error).failureCode())
                        .isEqualTo("ANALYSIS_MEMORY_LIMIT"));
        bound.close();
        assertThatCode(JobCancellation::checkpoint).doesNotThrowAnyException();
    }

    @Test
    void aMemoryLimitStopInterruptsABlockedWorkerCall() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CompletableFuture<BoundJobCancellation> token = new CompletableFuture<>();
        CompletableFuture<Throwable> outcome = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> {
            try (BoundJobCancellation bound = BoundJobCancellation.bind()) {
                token.complete(bound);
                JobCancellation.interruptibly(() -> {
                    entered.countDown();
                    try {
                        Thread.sleep(Duration.ofSeconds(30));
                    } catch (InterruptedException interrupted) {
                        throw new IllegalStateException("worker request aborted", interrupted);
                    }
                    return null;
                });
                outcome.complete(null);
            } catch (Throwable failure) {
                outcome.complete(failure);
            }
        });
        assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
        token.get(5, TimeUnit.SECONDS).exceedMemoryLimit();
        assertThat(outcome.get(5, TimeUnit.SECONDS)).isInstanceOf(AnalysisMemoryLimitException.class);
    }
}
