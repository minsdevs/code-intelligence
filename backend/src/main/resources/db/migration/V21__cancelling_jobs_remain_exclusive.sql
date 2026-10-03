-- Cancellation is a request until the worker's current step has stopped writing.
ALTER TABLE analysis_jobs DROP CONSTRAINT analysis_jobs_status_check;
ALTER TABLE analysis_jobs ADD CONSTRAINT analysis_jobs_status_check
    CHECK (status IN ('QUEUED', 'RUNNING', 'CANCELLING', 'DONE', 'FAILED', 'CANCELLED'));

DROP INDEX uq_analysis_jobs_active_per_project;
CREATE UNIQUE INDEX uq_analysis_jobs_active_per_project
    ON analysis_jobs (project_id)
    WHERE status IN ('QUEUED', 'RUNNING', 'CANCELLING');
