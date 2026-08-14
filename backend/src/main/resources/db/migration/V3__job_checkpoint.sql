-- P2 (§3 V3): step checkpoint/retry fields and job timing, plus the two DB-level
-- invariants this PR introduces: at most one active job per project (partial
-- unique index backs JobService.enqueue) and per-user repository import dedup.
ALTER TABLE analysis_job_steps
    ADD COLUMN attempt int NOT NULL DEFAULT 0;

ALTER TABLE analysis_job_steps
    ADD CONSTRAINT chk_analysis_job_steps_status
    CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED'));

ALTER TABLE analysis_jobs
    ADD COLUMN started_at timestamptz,
    ADD COLUMN finished_at timestamptz;

CREATE UNIQUE INDEX uq_analysis_jobs_active_per_project
    ON analysis_jobs (project_id)
    WHERE status IN ('QUEUED', 'RUNNING');

CREATE UNIQUE INDEX uq_projects_user_repo
    ON projects (user_id, repo_owner, repo_name);
