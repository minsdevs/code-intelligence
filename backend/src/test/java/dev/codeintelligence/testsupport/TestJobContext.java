package dev.codeintelligence.testsupport;

import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobType;
import java.nio.file.Path;
import java.util.Optional;

public final class TestJobContext implements JobContext {

    private final long jobId;
    private final long projectId;
    private Long snapshotId;
    private final Path clonePath;
    private int progress;

    public TestJobContext(long jobId, long projectId, Long snapshotId, Path clonePath) {
        this.jobId = jobId;
        this.projectId = projectId;
        this.snapshotId = snapshotId;
        this.clonePath = clonePath;
    }

    @Override
    public long jobId() {
        return jobId;
    }

    @Override
    public long projectId() {
        return projectId;
    }

    @Override
    public JobType jobType() {
        return JobType.IMPORT;
    }

    @Override
    public Optional<Long> snapshotId() {
        return Optional.ofNullable(snapshotId);
    }

    @Override
    public Path clonePath() {
        return clonePath;
    }

    @Override
    public void updateProgress(int progressPct) {
        this.progress = progressPct;
    }

    @Override
    public void attachSnapshot(long snapshotId) {
        this.snapshotId = snapshotId;
    }

    public int progress() {
        return progress;
    }
}
