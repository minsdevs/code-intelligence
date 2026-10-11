package dev.codeintelligence.job;

import java.util.Set;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Returns committed heap to the operating system between pipeline steps (05 §4 incremental RSS
 * cap, user decision 2026-10-11 option a). With the serial collector the old generation grows to
 * {@code -Xmx} during SOURCE_PARSING/GRAPH_BUILD and stays committed; the TS analyzer worker then
 * runs beside a backend whose resident set is mostly garbage from the previous step, and on a
 * refresh the previous snapshot's graph drafts and parse trees are part of that garbage. A full
 * collection after the heavy steps and at job end lets the heap shrink
 * ({@code -XX:MaxHeapFreeRatio}, {@code -XX:-ShrinkHeapInSteps} in the desktop JVM options) before
 * the next worker starts. This changes no analysis result; it only affects when memory is returned.
 */
@Component
public class StepHeapRelease {
    private static final Logger log = LoggerFactory.getLogger(StepHeapRelease.class);

    /** Steps after which the heap is released: the Java/graph work before the TS worker, the TS and tree workers. */
    static final Set<String> RELEASE_AFTER = Set.of("SOURCE_PARSING", "GRAPH_BUILD", "TS_PARSING", "TREE_PARSING");

    private final Runnable collect;
    private final LongSupplier committedBytes;

    public StepHeapRelease() {
        this(System::gc, () -> Runtime.getRuntime().totalMemory());
    }

    StepHeapRelease(Runnable collect, LongSupplier committedBytes) {
        this.collect = collect;
        this.committedBytes = committedBytes;
    }

    /** After a step completed (DONE); only the configured heavy steps trigger a collection. */
    public void afterStep(String stepKey) {
        if (stepKey != null && RELEASE_AFTER.contains(stepKey)) release("step " + stepKey);
    }

    /** After the job reached a terminal state; the next job or the idle app should not pay for it. */
    public void afterJob(long jobId) {
        release("job " + jobId);
    }

    private void release(String reason) {
        long before = committedBytes.getAsLong();
        long started = System.nanoTime();
        collect.run();
        long after = committedBytes.getAsLong();
        log.info(
                "Heap release after {}: committed {} MiB -> {} MiB in {} ms",
                reason,
                before >> 20,
                after >> 20,
                (System.nanoTime() - started) / 1_000_000);
    }
}
