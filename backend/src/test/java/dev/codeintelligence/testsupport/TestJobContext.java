package dev.codeintelligence.testsupport;

import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobType;
import java.nio.file.Path;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;

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

    /** Golden analysis fixtures still pass through the real final publication state machine. */
    public static TestJobContext running(JdbcTemplate jdbc, long projectId, long snapshotId, Path clonePath) {
        long jobId = jdbc.queryForObject(
                "insert into analysis_jobs(project_id,snapshot_id,type,status) "
                        + "values (?,?,'IMPORT','RUNNING') returning id",
                Long.class,
                projectId,
                snapshotId);
        jdbc.update(
                "insert into analysis_job_steps(job_id,step_key,seq,status,attempt,started_at) "
                        + "values (?,'FINALIZE',10000,'RUNNING',1,now())",
                jobId);
        return new TestJobContext(jobId, projectId, snapshotId, clonePath);
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
