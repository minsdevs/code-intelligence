package dev.codeintelligence.job;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * Plain-JDBC state machine over {@code analysis_jobs}/{@code analysis_job_steps}. Deliberately
 * not JPA: rows are updated field-by-field from worker threads and the DB stays the single source
 * of truth for status transitions (guarded UPDATEs return whether the transition happened).
 */
@Repository
public class JobRepository {

    private static final RowMapper<JobRecord> JOB_MAPPER = (rs, rowNum) -> new JobRecord(
            rs.getLong("id"),
            rs.getLong("project_id"),
            rs.getObject("snapshot_id", Long.class),
            JobType.valueOf(rs.getString("type")),
            JobStatus.valueOf(rs.getString("status")),
            rs.getString("error"),
            toInstant(rs.getObject("created_at", OffsetDateTime.class)),
            toInstant(rs.getObject("started_at", OffsetDateTime.class)),
            toInstant(rs.getObject("finished_at", OffsetDateTime.class)));

    private static final RowMapper<JobStepRecord> STEP_MAPPER = (rs, rowNum) -> new JobStepRecord(
            rs.getLong("id"),
            rs.getLong("job_id"),
            rs.getString("step_key"),
            rs.getInt("seq"),
            StepStatus.valueOf(rs.getString("status")),
            rs.getObject("progress_pct", Integer.class),
            rs.getInt("attempt"),
            rs.getString("error"),
            toInstant(rs.getObject("started_at", OffsetDateTime.class)),
            toInstant(rs.getObject("finished_at", OffsetDateTime.class)));

    private static final String JOB_COLUMNS =
            "id, project_id, snapshot_id, type, status, error, created_at, started_at, finished_at";
    private static final String STEP_COLUMNS =
            "id, job_id, step_key, seq, status, progress_pct, attempt, error, started_at, finished_at";

    private static Instant toInstant(OffsetDateTime value) {
        return value == null ? null : value.toInstant();
    }

    private final JdbcClient jdbc;

    public JobRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public long insertJob(long projectId, JobType type) {
        return jdbc.sql("insert into analysis_jobs (project_id, type, status) values (:projectId, :type, 'QUEUED') "
                        + "returning id")
                .param("projectId", projectId)
                .param("type", type.name())
                .query(Long.class)
                .single();
    }

    public void insertStep(long jobId, String stepKey, int seq) {
        jdbc.sql("insert into analysis_job_steps (job_id, step_key, seq, status) "
                        + "values (:jobId, :stepKey, :seq, 'PENDING')")
                .param("jobId", jobId)
                .param("stepKey", stepKey)
                .param("seq", seq)
                .update();
    }

    public Optional<JobRecord> findJob(long jobId) {
        return jdbc.sql("select " + JOB_COLUMNS + " from analysis_jobs where id = :id")
                .param("id", jobId)
                .query(JOB_MAPPER)
                .optional();
    }

    /** Owner scoping (IDOR): resolves only when the job's project belongs to the user. */
    public Optional<JobRecord> findOwnedJob(long jobId, long userId) {
        return jdbc.sql("select j." + JOB_COLUMNS.replace(", ", ", j.") + " from analysis_jobs j "
                        + "join projects p on p.id = j.project_id where j.id = :jobId and p.user_id = :userId")
                .param("jobId", jobId)
                .param("userId", userId)
                .query(JOB_MAPPER)
                .optional();
    }

    public Optional<JobStatus> findJobStatus(long jobId) {
        return jdbc.sql("select status from analysis_jobs where id = :id")
                .param("id", jobId)
                .query(String.class)
                .optional()
                .map(JobStatus::valueOf);
    }

    public List<JobStepRecord> findSteps(long jobId) {
        return jdbc.sql("select " + STEP_COLUMNS + " from analysis_job_steps where job_id = :jobId order by seq")
                .param("jobId", jobId)
                .query(STEP_MAPPER)
                .list();
    }

    public List<JobRecord> findRecentByProject(long projectId, int limit) {
        return jdbc.sql("select " + JOB_COLUMNS + " from analysis_jobs where project_id = :projectId "
                        + "order by id desc limit :limit")
                .param("projectId", projectId)
                .param("limit", limit)
                .query(JOB_MAPPER)
                .list();
    }

    public boolean hasActiveJob(long projectId) {
        return Boolean.TRUE.equals(jdbc.sql("select exists(select 1 from analysis_jobs where project_id = :projectId "
                        + "and status in ('QUEUED', 'RUNNING'))")
                .param("projectId", projectId)
                .query(Boolean.class)
                .single());
    }

    public boolean markJobRunning(long jobId) {
        return jdbc.sql("update analysis_jobs set status = 'RUNNING', error = null, started_at = now(), "
                                + "finished_at = null, updated_at = now() where id = :id and status = 'QUEUED'")
                        .param("id", jobId)
                        .update()
                == 1;
    }

    public boolean markJobDone(long jobId) {
        return jdbc.sql("update analysis_jobs set status = 'DONE', error = null, finished_at = now(), "
                                + "updated_at = now() where id = :id and status = 'RUNNING'")
                        .param("id", jobId)
                        .update()
                == 1;
    }

    /** Guarded so a concurrent cancel wins over a late step failure. */
    public boolean markJobFailed(long jobId, String error) {
        return jdbc.sql("update analysis_jobs set status = 'FAILED', error = :error, finished_at = now(), "
                                + "updated_at = now() where id = :id and status = 'RUNNING'")
                        .param("id", jobId)
                        .param("error", error)
                        .update()
                == 1;
    }

    public boolean markJobCancelled(long jobId) {
        return jdbc.sql("update analysis_jobs set status = 'CANCELLED', finished_at = now(), updated_at = now() "
                                + "where id = :id and status in ('QUEUED', 'RUNNING')")
                        .param("id", jobId)
                        .update()
                == 1;
    }

    public boolean markJobQueuedForRetry(long jobId) {
        return jdbc.sql("update analysis_jobs set status = 'QUEUED', error = null, started_at = null, "
                                + "finished_at = null, updated_at = now() where id = :id and status = 'FAILED'")
                        .param("id", jobId)
                        .update()
                == 1;
    }

    /** Checkpoint (§8.3): DONE steps keep their state; everything else is reset for the retry. */
    public void resetStepsForRetry(long jobId) {
        jdbc.sql("update analysis_job_steps set status = 'PENDING', progress_pct = null, error = null, "
                        + "started_at = null, finished_at = null where job_id = :jobId and status <> 'DONE'")
                .param("jobId", jobId)
                .update();
    }

    public void markStepRunning(long stepId) {
        jdbc.sql("update analysis_job_steps set status = 'RUNNING', attempt = attempt + 1, progress_pct = 0, "
                        + "error = null, started_at = now(), finished_at = null where id = :id")
                .param("id", stepId)
                .update();
    }

    public void markStepDone(long stepId) {
        jdbc.sql("update analysis_job_steps set status = 'DONE', progress_pct = 100, finished_at = now() "
                        + "where id = :id")
                .param("id", stepId)
                .update();
    }

    public void markStepFailed(long stepId, String error) {
        jdbc.sql("update analysis_job_steps set status = 'FAILED', error = :error, finished_at = now() "
                        + "where id = :id")
                .param("id", stepId)
                .param("error", error)
                .update();
    }

    public void updateStepProgress(long stepId, int progressPct) {
        jdbc.sql("update analysis_job_steps set progress_pct = :pct where id = :id")
                .param("id", stepId)
                .param("pct", progressPct)
                .update();
    }

    public void attachSnapshot(long jobId, long snapshotId) {
        jdbc.sql("update analysis_jobs set snapshot_id = :snapshotId, updated_at = now() where id = :jobId")
                .param("jobId", jobId)
                .param("snapshotId", snapshotId)
                .update();
    }

    public int failInterruptedSteps(String error) {
        return jdbc.sql("update analysis_job_steps set status = 'FAILED', error = :error, finished_at = now() "
                        + "where status = 'RUNNING'")
                .param("error", error)
                .update();
    }

    public int failInterruptedJobs(String error) {
        return jdbc.sql("update analysis_jobs set status = 'FAILED', error = :error, finished_at = now(), "
                        + "updated_at = now() where status = 'RUNNING'")
                .param("error", error)
                .update();
    }
}
