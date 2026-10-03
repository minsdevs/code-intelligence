package dev.codeintelligence.job;

import java.nio.file.Path;
import java.util.Optional;

/**
 * Execution context handed to each {@link JobStep}. Exposes ids instead of entities so the job
 * framework stays independent of the project package (steps load what they need themselves).
 */
public interface JobContext {

    long jobId();

    long projectId();

    JobType jobType();

    /** Present once the IMPORT step has attached the snapshot for this run. */
    Optional<Long> snapshotId();

    /** The input directory leased to this run; retained imports use disposable private scratch. */
    Path clonePath();

    void updateProgress(int progressPct);

    void attachSnapshot(long snapshotId);
}
