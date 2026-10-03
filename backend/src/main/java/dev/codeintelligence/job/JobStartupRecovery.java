package dev.codeintelligence.job;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * Crash recovery (§8.2): jobs/steps left RUNNING by a previous process cannot make progress in a
 * single-instance deployment, so they transition to FAILED at startup and become resumable via
 * the retry endpoint (which restarts from the interrupted step thanks to the checkpoint).
 */
@Component
public class JobStartupRecovery implements ApplicationRunner {

    static final String INTERRUPTED_ERROR = "interrupted by backend restart";

    private static final Logger log = LoggerFactory.getLogger(JobStartupRecovery.class);

    private final JobRepository repository;

    public JobStartupRecovery(JobRepository repository) {
        this.repository = repository;
    }

    @Override
    public void run(ApplicationArguments args) {
        recover();
    }

    public int recover() {
        int steps = repository.failInterruptedSteps(INTERRUPTED_ERROR);
        int jobs = repository.failInterruptedJobs(INTERRUPTED_ERROR);
        int cancelled = repository.finishInterruptedCancellations();
        if (cancelled > 0) {
            log.warn("Startup recovery completed {} interrupted cancellation(s)", cancelled);
        }
        if (jobs > 0 || steps > 0) {
            log.warn("Startup recovery marked {} job(s) and {} step(s) left RUNNING as FAILED", jobs, steps);
        }
        return jobs;
    }
}
