package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.common.AnalysisMemoryProperties;
import java.time.Duration;
import java.util.OptionalLong;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** 05 §4: above 6 GiB of owner-tree RSS no new analysis work starts and running work is stopped. */
@Timeout(20)
class AnalysisMemoryWatchdogTest {
    private static final long GIB = 1024L * 1024 * 1024;
    private static final Duration FAST = Duration.ofMillis(10);

    @Test
    void theShippedLimitIsSixGibibytes() {
        assertThat(new AnalysisMemoryProperties(6 * GIB, 0).limitBytes()).isEqualTo(6 * GIB);
        assertThatThrownBy(() -> new AnalysisMemoryProperties(0, 0)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new AnalysisMemoryProperties(6 * GIB, -1)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void admissionStopsOnlyAboveTheLimit() {
        AtomicLong rss = new AtomicLong(GIB);
        try (var watchdog = new AnalysisMemoryWatchdog(6 * GIB, () -> OptionalLong.of(rss.get()), FAST)) {
            assertThat(watchdog.admits()).isTrue();
            rss.set(6 * GIB);
            assertThat(watchdog.admits()).isTrue();
            rss.set(6 * GIB + 1);
            assertThat(watchdog.admits()).isFalse();
            rss.set(5 * GIB);
            assertThat(watchdog.admits()).isTrue();
        }
    }

    @Test
    void anUnmeasurableOwnerTreeDoesNotBlockAnalysis() {
        try (var watchdog = new AnalysisMemoryWatchdog(6 * GIB, OptionalLong::empty, FAST)) {
            assertThat(watchdog.admits()).isTrue();
        }
    }

    @Test
    void aWatchedRunIsStoppedOnceWhenTheOwnerTreeExceedsTheLimit() throws Exception {
        AtomicLong rss = new AtomicLong(2 * GIB);
        AtomicInteger samples = new AtomicInteger();
        AtomicInteger stops = new AtomicInteger();
        try (var watchdog = new AnalysisMemoryWatchdog(
                        6 * GIB,
                        () -> {
                            samples.incrementAndGet();
                            return OptionalLong.of(rss.get());
                        },
                        FAST);
                var ignored = watchdog.watch(stops::incrementAndGet)) {
            Awaitility.await().atMost(Duration.ofSeconds(5)).until(() -> samples.get() >= 3);
            assertThat(stops).hasValue(0);
            rss.set(7 * GIB);
            Awaitility.await().atMost(Duration.ofSeconds(5)).until(() -> stops.get() == 1);
            int seen = samples.get();
            Thread.sleep(100);
            assertThat(stops).hasValue(1);
            // A stopped run is no longer watched, so nothing keeps sampling for it.
            assertThat(samples.get()).isLessThanOrEqualTo(seen + 1);
        }
    }

    @Test
    void theOwnerTreeIsNotSampledWhileNoRunIsWatched() throws Exception {
        AtomicInteger samples = new AtomicInteger();
        AtomicInteger stops = new AtomicInteger();
        try (var watchdog = new AnalysisMemoryWatchdog(
                6 * GIB,
                () -> {
                    samples.incrementAndGet();
                    return OptionalLong.of(7 * GIB);
                },
                FAST)) {
            Thread.sleep(150);
            assertThat(samples).hasValue(0);
            watchdog.watch(stops::incrementAndGet).close();
            Thread.sleep(150);
            assertThat(stops).hasValue(0);
        }
    }

    @Test
    void psOutputIsSummedOverTheOwnerTreeOnly() {
        String ps = """
                  1     0   9000
                 50     1    200
                 51    50    300
                 52    51    400
                 60     1   5000
                 61    60   7000
                """;
        assertThat(ProcessTreeMemory.ownerTreeBytes(ps, 50)).hasValue((200 + 300 + 400) * 1024L);
        assertThat(ProcessTreeMemory.ownerTreeBytes(ps, 61)).hasValue(7000 * 1024L);
        assertThat(ProcessTreeMemory.ownerTreeBytes(ps, 99)).isEmpty();
        assertThat(ProcessTreeMemory.ownerTreeBytes("garbage line\n", 1)).isEmpty();
    }

    @Test
    void theRealProcessTreeOfThisJvmIsMeasurable() {
        OptionalLong own = new ProcessTreeMemory(ProcessHandle.current().pid()).ownerTreeBytes();
        assertThat(own).isPresent();
        assertThat(own.getAsLong()).isGreaterThan(16L * 1024 * 1024);
    }
}
