package dev.codeintelligence.job;

import dev.codeintelligence.common.AnalysisMemoryProperties;
import java.time.Duration;
import java.util.OptionalLong;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * 05 §4 analysis memory watchdog (R10). While the owner process tree's resident memory exceeds the
 * limit, {@link #admits()} refuses new analysis work, and every watched run is stopped once so its
 * step fails with {@link AnalysisMemoryLimitException} before the OS runs out of memory. The tree
 * is sampled only while a run is watched. The desktop main process measures the tree and reports
 * it ({@link ReportedOwnerTreeMemory}); without a recent report (Windows, runs outside the desktop)
 * analysis is not blocked and the per-analyzer limits remain the only bound.
 */
@Component
public class AnalysisMemoryWatchdog implements AutoCloseable {
    private static final Logger log = LoggerFactory.getLogger(AnalysisMemoryWatchdog.class);
    private static final Duration INTERVAL = Duration.ofSeconds(2);

    @FunctionalInterface
    public interface ResidentMemory {
        OptionalLong ownerTreeBytes();
    }

    public interface Registration extends AutoCloseable {
        @Override
        void close();
    }

    private final long limitBytes;
    private final ResidentMemory memory;
    private final Set<Watch> watches = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService sampler;

    @Autowired
    public AnalysisMemoryWatchdog(AnalysisMemoryProperties properties, ReportedOwnerTreeMemory memory) {
        this(properties.limitBytes(), memory, INTERVAL);
    }

    public AnalysisMemoryWatchdog(long limitBytes, ResidentMemory memory, Duration interval) {
        this.limitBytes = limitBytes;
        this.memory = memory;
        if (interval == null) {
            this.sampler = null;
            return;
        }
        this.sampler = Executors.newSingleThreadScheduledExecutor(
                Thread.ofPlatform().name("analysis-memory-watchdog").daemon().factory());
        sampler.scheduleWithFixedDelay(this::sample, interval.toMillis(), interval.toMillis(), TimeUnit.MILLISECONDS);
    }

    /** A watchdog that never refuses or stops work, for job workers built outside the application context. */
    static AnalysisMemoryWatchdog disabled() {
        return new AnalysisMemoryWatchdog(Long.MAX_VALUE, OptionalLong::empty, null);
    }

    /** False while the owner tree is above the limit: no new analysis work may start. */
    public boolean admits() {
        OptionalLong used = memory.ownerTreeBytes();
        if (used.isPresent() && used.getAsLong() > limitBytes) {
            log.warn("Analysis admission refused: owner tree uses {} bytes (limit {})", used.getAsLong(), limitBytes);
            return false;
        }
        return true;
    }

    /** Stops the run once (via {@code onExceeded}) if the limit is exceeded before the watch closes. */
    public Registration watch(Runnable onExceeded) {
        Watch watch = new Watch(onExceeded);
        watches.add(watch);
        return () -> watches.remove(watch);
    }

    /** True while at least one run is watched; the memory reporter samples faster then. */
    public boolean watching() {
        return !watches.isEmpty();
    }

    private void sample() {
        if (watches.isEmpty()) return;
        try {
            OptionalLong used = memory.ownerTreeBytes();
            if (used.isEmpty() || used.getAsLong() <= limitBytes) return;
            log.warn(
                    "Analysis memory limit exceeded: owner tree uses {} bytes (limit {})",
                    used.getAsLong(),
                    limitBytes);
            for (Watch watch : watches) {
                if (watches.remove(watch)) watch.onExceeded.run();
            }
        } catch (RuntimeException error) {
            log.error("Analysis memory sample failed", error);
        }
    }

    @Override
    public void close() {
        if (sampler != null) sampler.shutdownNow();
    }

    // Identity, not value, equality: two runs may register equal callbacks.
    private static final class Watch {
        private final Runnable onExceeded;

        private Watch(Runnable onExceeded) {
            this.onExceeded = onExceeded;
        }
    }
}
