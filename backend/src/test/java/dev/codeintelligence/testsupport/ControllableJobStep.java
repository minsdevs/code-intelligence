package dev.codeintelligence.testsupport;

import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Fake pipeline step whose behavior (block, fail once) is scripted per test. */
public final class ControllableJobStep implements JobStep {

    private final String key;
    private final AtomicInteger runCount = new AtomicInteger();
    private volatile boolean failNextRun;
    private volatile CountDownLatch gate;

    public ControllableJobStep(String key) {
        this.key = key;
    }

    @Override
    public String key() {
        return key;
    }

    @Override
    public void run(JobContext ctx) throws Exception {
        runCount.incrementAndGet();
        CountDownLatch currentGate = gate;
        if (currentGate != null && !currentGate.await(30, TimeUnit.SECONDS)) {
            throw new IllegalStateException("test gate for step " + key + " was never released");
        }
        if (failNextRun) {
            failNextRun = false;
            throw new IllegalStateException("simulated failure in " + key);
        }
    }

    public int runCount() {
        return runCount.get();
    }

    public void failOnce() {
        failNextRun = true;
    }

    public void blockUntilReleased() {
        gate = new CountDownLatch(1);
    }

    public void release() {
        CountDownLatch currentGate = gate;
        gate = null;
        if (currentGate != null) {
            currentGate.countDown();
        }
    }

    public void reset() {
        release();
        failNextRun = false;
        runCount.set(0);
    }
}
