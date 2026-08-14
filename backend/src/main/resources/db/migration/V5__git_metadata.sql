-- P5 (§3 V5 / 기획서 §6.2): Git metadata collected from the clone (commits/branches/tags)
-- plus GitHub pull requests. Rollback: drop commit_files, commits, branches, tags,
-- pull_requests; alter table projects drop column pulls_etag.
ALTER TABLE projects
    ADD COLUMN pulls_etag text;

CREATE TABLE commits (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    sha text NOT NULL,
    author text,
    message text,
    committed_at timestamptz,
    additions int NOT NULL DEFAULT 0,
    deletions int NOT NULL DEFAULT 0,
    CONSTRAINT uq_commits_project_sha UNIQUE (project_id, sha)
);

CREATE INDEX idx_commits_project_committed ON commits (project_id, committed_at DESC);

CREATE TABLE commit_files (
    id bigserial PRIMARY KEY,
    commit_id bigint NOT NULL REFERENCES commits (id) ON DELETE CASCADE,
    path text NOT NULL,
    change_type text NOT NULL CHECK (change_type IN ('ADD', 'MODIFY', 'DELETE', 'RENAME', 'COPY')),
    CONSTRAINT uq_commit_files_commit_path UNIQUE (commit_id, path)
);

CREATE INDEX idx_commit_files_commit_id ON commit_files (commit_id);

CREATE TABLE branches (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name text NOT NULL,
    head_sha text NOT NULL,
    CONSTRAINT uq_branches_project_name UNIQUE (project_id, name)
);

CREATE INDEX idx_branches_project_id ON branches (project_id);

CREATE TABLE tags (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name text NOT NULL,
    head_sha text NOT NULL,
    CONSTRAINT uq_tags_project_name UNIQUE (project_id, name)
);

CREATE INDEX idx_tags_project_id ON tags (project_id);

CREATE TABLE pull_requests (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    number int NOT NULL,
    title text,
    body text,
    state text NOT NULL,
    author text,
    merged_at timestamptz,
    head_sha text,
    base_sha text,
    CONSTRAINT uq_pull_requests_project_number UNIQUE (project_id, number)
);

CREATE INDEX idx_pull_requests_project_state ON pull_requests (project_id, state);
