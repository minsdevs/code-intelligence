package dev.codeintelligence.job;

import java.util.List;
import java.util.Optional;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Job lifecycle API. The DB is the source of truth for every transition; the partial unique index
 * {@code uq_analysis_jobs_active_per_project} (V3) guarantees at most one QUEUED/RUNNING job per
 * project even under concurrent enqueues.
 */
@Service
public class JobService {

    private static final String ACTIVE_JOB_CONFLICT = "Another analysis job is already active for this project.";

    private final JobRepository repository;
    private final Pipeline pipeline;
    private final JobWorker worker;
    private final JobProgressPublisher publisher;
    private final TransactionTemplate transactionTemplate;

    public JobService(
            JobRepository repository,
            Pipeline pipeline,
            JobWorker worker,
            JobProgressPublisher publisher,
            TransactionTemplate transactionTemplate) {
        this.repository = repository;
        this.pipeline = pipeline;
        this.worker = worker;
        this.publisher = publisher;
        this.transactionTemplate = transactionTemplate;
    }

    /**
     * Creates a QUEUED job with one PENDING step row per pipeline step. Dispatch happens after
     * commit so the worker never races an uncommitted row (enqueue may join a caller transaction,
     * e.g. project creation).
     */
    @Transactional
    public long enqueue(long projectId, JobType type) {
        long jobId;
        try {
            jobId = repository.insertJob(projectId, type);
            int seq = 1;
            for (JobStep step : pipeline.stepsFor(type)) {
                repository.insertStep(jobId, step.key(), seq++);
            }
        } catch (DataIntegrityViolationException e) {
            throw new JobConflictException(ACTIVE_JOB_CONFLICT);
        }
        dispatchAfterCommit(jobId);
        return jobId;
    }

    /** Resumes a FAILED job from its first non-DONE step (checkpoint §8.3); attempt increases on run. */
    public void retry(long jobId, long userId) {
        JobRecord job = requireOwnedJob(jobId, userId);
        if (job.status() != JobStatus.FAILED) {
            throw new JobConflictException("Only FAILED jobs can be retried.");
        }
        try {
            Boolean requeued = transactionTemplate.execute(tx -> {
                repository.resetStepsForRetry(jobId);
                return repository.markJobQueuedForRetry(jobId);
            });
            if (!Boolean.TRUE.equals(requeued)) {
                throw new JobConflictException("Only FAILED jobs can be retried.");
            }
        } catch (DataIntegrityViolationException e) {
            throw new JobConflictException(ACTIVE_JOB_CONFLICT);
        }
        publisher.publish(jobId);
        worker.dispatch(jobId);
    }

    /** The currently RUNNING step finishes; the worker stops before starting the next one. */
    public void cancel(long jobId, long userId) {
        requireOwnedJob(jobId, userId);
        if (!repository.markJobCancelled(jobId)) {
            throw new JobConflictException("Job is already finished.");
        }
        publisher.publish(jobId);
    }

    public JobDetailResponse getOwnedJob(long jobId, long userId) {
        JobRecord job = requireOwnedJob(jobId, userId);
        return JobDetailResponse.of(job, repository.findSteps(jobId));
    }

    /** Caller is responsible for project ownership (ProjectService scopes by user). */
    public List<JobSummaryResponse> listRecent(long projectId, int limit) {
        return repository.findRecentByProject(projectId, limit).stream()
                .map(JobSummaryResponse::of)
                .toList();
    }

    public Optional<JobSummaryResponse> findLatest(long projectId) {
        return repository.findRecentByProject(projectId, 1).stream()
                .map(JobSummaryResponse::of)
                .findFirst();
    }

    public boolean hasActiveJob(long projectId) {
        return repository.hasActiveJob(projectId);
    }

    private JobRecord requireOwnedJob(long jobId, long userId) {
        return repository.findOwnedJob(jobId, userId).orElseThrow(JobNotFoundException::new);
    }

    private void dispatchAfterCommit(long jobId) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                publisher.publish(jobId);
                worker.dispatch(jobId);
            }
        });
    }
}
