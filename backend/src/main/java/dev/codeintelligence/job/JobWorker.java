package dev.codeintelligence.job;

import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.maintenance.MaintenanceGate;
import jakarta.annotation.PreDestroy;
import java.nio.file.Path;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.task.SimpleAsyncTaskExecutor;
import org.springframework.stereotype.Component;

/**
 * Runs each job on its own virtual thread (dedicated executor, separate from Boot's MVC
 * executor). Step loop semantics (§8.2~8.3): DONE steps are skipped (checkpoint), a step failure
 * marks the step and job FAILED while the remaining steps stay PENDING, and a cancel takes effect
 * after the currently RUNNING step completes.
 */
@Component
public class JobWorker {

    private static final Logger log = LoggerFactory.getLogger(JobWorker.class);
    private static final int MAX_ERROR_LENGTH = 500;

    private final JobRepository repository;
    private final Pipeline pipeline;
    private final JobProgressPublisher publisher;
    private final AppProperties appProperties;
    private final JobWorkspaceProvider workspaces;
    private final MaintenanceGate maintenance;
    private final SimpleAsyncTaskExecutor executor;

    public JobWorker(
            JobRepository repository,
            Pipeline pipeline,
            JobProgressPublisher publisher,
            AppProperties appProperties,
            JobWorkspaceProvider workspaces) {
        this(repository, pipeline, publisher, appProperties, workspaces, new MaintenanceGate());
    }

    @Autowired
    public JobWorker(
            JobRepository repository,
            Pipeline pipeline,
            JobProgressPublisher publisher,
            AppProperties appProperties,
            JobWorkspaceProvider workspaces,
            MaintenanceGate maintenance) {
        this.repository = repository;
        this.pipeline = pipeline;
        this.publisher = publisher;
        this.appProperties = appProperties;
        this.workspaces = workspaces;
        this.maintenance = maintenance;
        this.executor = new SimpleAsyncTaskExecutor("job-");
        this.executor.setVirtualThreads(true);
    }

    @PreDestroy
    void shutdown() {
        executor.close();
    }

    public void dispatch(long jobId) {
        MaintenanceGate.Lease lease = maintenance.admitJob();
        try {
            executor.execute(() -> {
                try (lease) {
                    runJob(jobId);
                }
            });
        } catch (RuntimeException | Error error) {
            lease.close();
            throw error;
        }
    }

    void runJob(long jobId) {
        if (!repository.markJobRunning(jobId)) {
            return;
        }
        try {
            publisher.publish(jobId);
            JobRecord job = repository.findJob(jobId).orElseThrow();
            try (var workspace = workspaces.open(job)) {
                Path clonePath = workspace.clonePath();
                for (JobStepRecord step : repository.findSteps(jobId)) {
                    if (step.status() == StepStatus.DONE || step.status() == StepStatus.SKIPPED) {
                        continue;
                    }
                    if (repository.findJobStatus(jobId).orElse(JobStatus.CANCELLED) != JobStatus.RUNNING) {
                        publisher.publish(jobId);
                        return;
                    }
                    if (!runStep(job, step, clonePath)) {
                        return;
                    }
                }
                repository.markJobDone(jobId);
                publisher.publish(jobId);
            }
        } catch (RuntimeException ex) {
            log.error("Job {} aborted by an unexpected framework error", jobId, ex);
            repository.markJobFailed(jobId, "internal error");
            publisher.publish(jobId);
        } finally {
            if (repository.finishCancellation(jobId)) {
                publisher.publish(jobId);
            }
        }
    }

    private boolean runStep(JobRecord job, JobStepRecord step, Path clonePath) {
        JobStep implementation = pipeline.find(job.type(), step.stepKey()).orElse(null);
        if (implementation == null) {
            return failStep(job, step, "no step registered for key '" + step.stepKey() + "'", null);
        }
        try {
            repository.markStepRunning(step.id());
            publisher.publish(job.id());
            implementation.run(new WorkerJobContext(job, step.id(), clonePath));
            repository.markStepDone(step.id());
            publisher.publish(job.id());
            return true;
        } catch (Exception ex) {
            return failStep(job, step, sanitize(ex), ex);
        }
    }

    private boolean failStep(JobRecord job, JobStepRecord step, String message, Exception cause) {
        if (cause == null) {
            log.error("Job {} step '{}' failed: {}", job.id(), step.stepKey(), message);
        } else {
            log.error("Job {} step '{}' failed", job.id(), step.stepKey(), cause);
        }
        repository.markStepFailed(step.id(), message);
        repository.markJobFailed(
                job.id(),
                "step '%s' failed: %s".formatted(step.stepKey(), message),
                cause instanceof JobInputFailure inputFailure ? inputFailure.failureCode() : null);
        publisher.publish(job.id());
        return false;
    }

    /** Error text is exposed through the API and SSE: strip local paths, cap the length. */
    private String sanitize(Exception ex) {
        String message = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
        message = message.replace(appProperties.reposRoot().getParent().toString(), "<data-dir>")
                .replace(appProperties.dataDir(), "<data-dir>");
        return message.length() > MAX_ERROR_LENGTH ? message.substring(0, MAX_ERROR_LENGTH) : message;
    }

    private final class WorkerJobContext implements JobContext {

        private final JobRecord job;
        private final long stepId;
        private final Path clonePath;

        private WorkerJobContext(JobRecord job, long stepId, Path clonePath) {
            this.job = job;
            this.stepId = stepId;
            this.clonePath = clonePath;
        }

        @Override
        public long jobId() {
            return job.id();
        }

        @Override
        public long projectId() {
            return job.projectId();
        }

        @Override
        public JobType jobType() {
            return job.type();
        }

        @Override
        public Optional<Long> snapshotId() {
            return repository.findJob(job.id()).map(JobRecord::snapshotId).filter(id -> id != null);
        }

        @Override
        public Path clonePath() {
            return clonePath;
        }

        @Override
        public void updateProgress(int progressPct) {
            repository.updateStepProgress(stepId, Math.clamp(progressPct, 0, 100));
            publisher.publish(job.id());
        }

        @Override
        public void attachSnapshot(long snapshotId) {
            repository.attachSnapshot(job.id(), snapshotId);
        }
    }
}
