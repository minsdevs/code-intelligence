-- Phase 0 core schema (기획서 §6.2): users/credentials, projects/snapshots,
-- area selections, and the async analysis job tables.
-- pgvector is enabled now to validate the image; embeddings arrive in Phase 3.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
    id bigserial PRIMARY KEY,
    github_id bigint NOT NULL UNIQUE,
    login text NOT NULL,
    name text,
    avatar_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_credentials (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('OAUTH', 'PAT')),
    encrypted_token text NOT NULL,
    scopes text,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_github_credentials_user_id ON github_credentials (user_id);

CREATE TABLE projects (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name text NOT NULL,
    repo_owner text NOT NULL,
    repo_name text NOT NULL,
    default_branch text,
    clone_path text,
    -- FK added below, after snapshots exists (circular reference).
    current_snapshot_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_user_id ON projects (user_id);

CREATE TABLE snapshots (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    commit_sha text NOT NULL,
    status text NOT NULL CHECK (status IN ('ANALYZING', 'READY', 'FAILED')),
    analyzed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_snapshots_project_id ON snapshots (project_id);

ALTER TABLE projects
    ADD CONSTRAINT fk_projects_current_snapshot
    FOREIGN KEY (current_snapshot_id) REFERENCES snapshots (id) ON DELETE SET NULL;

CREATE INDEX idx_projects_current_snapshot_id ON projects (current_snapshot_id);

CREATE TABLE project_area_selections (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    area_type text NOT NULL,
    selected boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_project_area_selections UNIQUE (project_id, area_type)
);

CREATE TABLE analysis_jobs (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- Nullable: an import job starts before its snapshot exists (기획서 §8.1 step 1).
    snapshot_id bigint REFERENCES snapshots (id) ON DELETE CASCADE,
    type text NOT NULL,
    status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED')),
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_analysis_jobs_project_id ON analysis_jobs (project_id);
CREATE INDEX idx_analysis_jobs_snapshot_id ON analysis_jobs (snapshot_id);

CREATE TABLE analysis_job_steps (
    id bigserial PRIMARY KEY,
    job_id bigint NOT NULL REFERENCES analysis_jobs (id) ON DELETE CASCADE,
    step_key text NOT NULL,
    seq int NOT NULL,
    status text NOT NULL,
    progress_pct int,
    error text,
    started_at timestamptz,
    finished_at timestamptz,
    CONSTRAINT uq_analysis_job_steps UNIQUE (job_id, step_key)
);
