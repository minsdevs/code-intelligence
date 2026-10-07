package dev.codeintelligence.job;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Predicate;
import org.springframework.data.redis.core.StringRedisTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * The real Redis publisher with one optional pause point. The worker and enqueue/retry paths call
 * {@link #publish(long)} synchronously, so holding one call parks that exact thread between two of
 * its real database transitions (for example after a step failure was recorded and before the
 * worker's final cancellation check).
 */
final class RacePublisher extends JobProgressPublisher {

    static final class Hold {
        private final Predicate<JobRecord> match;
        private final AtomicBoolean taken = new AtomicBoolean();
        private final CountDownLatch parked = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private volatile Thread thread;
        private volatile long jobId;

        private Hold(Predicate<JobRecord> match) {
            this.match = match;
        }

        void awaitParked() throws InterruptedException {
            if (!parked.await(60, TimeUnit.SECONDS)) throw new IllegalStateException("publisher hold never reached");
        }

        /** The exact thread that was parked (a worker virtual thread or a request thread). */
        Thread thread() {
            return thread;
        }

        long jobId() {
            return jobId;
        }

        void release() {
            release.countDown();
        }

        /** Resumes the parked call with a publish failure (as from a lost DB/Redis connection). */
        void releaseWithFailure() {
            failAfterRelease = true;
            release.countDown();
        }

        private volatile boolean failAfterRelease;
    }

    private final JobRepository repository;
    private volatile Hold hold;

    RacePublisher(JobRepository repository, StringRedisTemplate redisTemplate, JsonMapper jsonMapper) {
        super(repository, redisTemplate, jsonMapper);
        this.repository = repository;
    }

    /** Parks the first publish of {@code jobId} that observes {@code status}. */
    Hold holdFirst(long jobId, JobStatus status) {
        return install(job -> job.id() == jobId && job.status() == status);
    }

    /** Parks the first publish of any QUEUED job of the project (enqueue/retry after commit). */
    Hold holdFirstQueued(long projectId) {
        return install(job -> job.projectId() == projectId && job.status() == JobStatus.QUEUED);
    }

    /**
     * Parks the first progress publish of a RUNNING job of the project made from inside the body of
     * {@code stepKey} (the step row already reports progress above the 0 set when it started).
     */
    Hold holdInStepBody(long projectId, String stepKey) {
        return install(job -> job.projectId() == projectId
                && job.status() == JobStatus.RUNNING
                && repository.findSteps(job.id()).stream()
                        .anyMatch(step -> step.stepKey().equals(stepKey)
                                && step.status() == StepStatus.RUNNING
                                && step.progressPct() != null
                                && step.progressPct() > 0));
    }

    private Hold install(Predicate<JobRecord> match) {
        Hold next = new Hold(match);
        hold = next;
        return next;
    }

    void reset() {
        dropAll = false;
        Hold current = hold;
        hold = null;
        if (current != null) current.release();
    }

    /** Simulates progress messages lost between publisher and subscribers (fire-and-forget pub/sub). */
    void dropAll(boolean value) {
        dropAll = value;
    }

    private volatile boolean dropAll;

    @Override
    public void publish(long jobId) {
        if (dropAll) return;
        Hold current = hold;
        if (current != null
                && !current.taken.get()
                && repository.findJob(jobId).filter(current.match).isPresent()
                && current.taken.compareAndSet(false, true)) {
            current.thread = Thread.currentThread();
            current.jobId = jobId;
            current.parked.countDown();
            try {
                if (!current.release.await(120, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("publisher hold was never released");
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
            if (current.failAfterRelease) throw new IllegalStateException("simulated publish failure");
        }
        super.publish(jobId);
    }
}
