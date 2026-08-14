package dev.codeintelligence.job;

/**
 * One pipeline step (§8.1). Implementations must be idempotent per snapshot so a retry after a
 * checkpoint is safe (§8.3). Any exception fails the step (and the job); the remaining steps stay
 * PENDING until a retry.
 */
public interface JobStep {

    /** Persisted as {@code analysis_job_steps.step_key} (§4 step table). */
    String key();

    void run(JobContext ctx) throws Exception;
}
