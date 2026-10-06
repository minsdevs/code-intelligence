package dev.codeintelligence.job;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Deterministic latches around the real pipeline steps. Each arm applies to the next execution of
 * one step key only; unarmed steps run their real body unchanged. Used to place cancel/delete/
 * retry/kill events exactly before or after the real body of a step while the step row is RUNNING.
 */
final class RaceStepGates {

    enum Point {
        BEFORE_BODY,
        AFTER_BODY
    }

    static final class Gate {
        private final CountDownLatch entered = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private volatile long jobId;

        void awaitEntered() throws InterruptedException {
            if (!entered.await(60, TimeUnit.SECONDS)) {
                throw new IllegalStateException("gated step was never reached");
            }
        }

        boolean entered() {
            return entered.getCount() == 0;
        }

        long jobId() {
            return jobId;
        }

        void release() {
            release.countDown();
        }

        private void hold(long job) throws InterruptedException {
            jobId = job;
            entered.countDown();
            if (!release.await(120, TimeUnit.SECONDS)) {
                throw new IllegalStateException("gated step was never released");
            }
        }
    }

    private final Map<String, Gate> gates = new ConcurrentHashMap<>();
    private final Map<String, Boolean> failures = new ConcurrentHashMap<>();

    Gate arm(String stepKey, Point point) {
        Gate gate = new Gate();
        if (gates.putIfAbsent(stepKey + "/" + point, gate) != null) {
            throw new IllegalStateException("gate already armed: " + stepKey + "/" + point);
        }
        return gate;
    }

    /** The next execution of the step throws before its real body (a deterministic step failure). */
    void failOnce(String stepKey) {
        failures.put(stepKey, Boolean.TRUE);
    }

    void reset() {
        gates.values().forEach(Gate::release);
        gates.clear();
        failures.clear();
    }

    List<JobStep> wrap(List<JobStep> steps) {
        return steps.stream().map(step -> (JobStep) new Gated(step)).toList();
    }

    private final class Gated implements JobStep {
        private final JobStep delegate;

        private Gated(JobStep delegate) {
            this.delegate = delegate;
        }

        @Override
        public String key() {
            return delegate.key();
        }

        @Override
        public void run(JobContext ctx) throws Exception {
            Gate before = gates.remove(key() + "/" + Point.BEFORE_BODY);
            if (before != null) before.hold(ctx.jobId());
            if (failures.remove(key()) != null) {
                throw new IllegalStateException("simulated failure in " + key());
            }
            delegate.run(ctx);
            Gate after = gates.remove(key() + "/" + Point.AFTER_BODY);
            if (after != null) after.hold(ctx.jobId());
        }
    }
}
