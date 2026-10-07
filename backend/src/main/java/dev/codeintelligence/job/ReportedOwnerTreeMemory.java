package dev.codeintelligence.job;

import java.time.Duration;
import java.util.OptionalLong;
import java.util.function.LongSupplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Owner-tree resident memory as last reported by the desktop main process, which samples its own
 * process tree and posts the total ({@link OwnerTreeMemoryController}). The backend never starts a
 * process to measure it (05 §1: analysed repositories must never select or start a process). A
 * missing or stale report is unmeasurable, which does not block analysis.
 */
@Component
public class ReportedOwnerTreeMemory implements AnalysisMemoryWatchdog.ResidentMemory {
    /** Main reports every 2 s while a run is watched and every 5 s otherwise. */
    static final Duration MAX_AGE = Duration.ofSeconds(15);

    private record Sample(long bytes, long receivedNanos) {}

    private final LongSupplier nanoTime;
    private volatile Sample latest;

    @Autowired
    public ReportedOwnerTreeMemory() {
        this(System::nanoTime);
    }

    ReportedOwnerTreeMemory(LongSupplier nanoTime) {
        this.nanoTime = nanoTime;
    }

    public void report(long bytes) {
        if (bytes < 0) throw new IllegalArgumentException("owner tree bytes must not be negative");
        latest = new Sample(bytes, nanoTime.getAsLong());
    }

    @Override
    public OptionalLong ownerTreeBytes() {
        Sample sample = latest;
        if (sample == null || nanoTime.getAsLong() - sample.receivedNanos() > MAX_AGE.toNanos())
            return OptionalLong.empty();
        return OptionalLong.of(sample.bytes());
    }
}
