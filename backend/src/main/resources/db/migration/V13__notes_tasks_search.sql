-- Phase 4 (§6.2 Notes/Tasks, §16 Search): notes, tasks, pg_trgm.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE notes (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title text NOT NULL,
    content_md text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_project_id ON notes (project_id);
CREATE INDEX idx_notes_fts ON notes USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content_md, '')));

CREATE TABLE note_references (
    id bigserial PRIMARY KEY,
    note_id bigint NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    subject_type text NOT NULL,
    subject_id bigint,
    raw_target text NOT NULL,
    label text
);

CREATE INDEX idx_note_references_note_id ON note_references (note_id);
CREATE INDEX idx_note_references_subject ON note_references (subject_type, subject_id);

CREATE TABLE tasks (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type IN ('DEVELOPMENT', 'LEARNING', 'REVIEW', 'RESEARCH', 'REFACTORING')),
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'DONE', 'CANCELLED')) DEFAULT 'OPEN',
    origin text NOT NULL CHECK (origin IN ('USER', 'AI')) DEFAULT 'USER',
    source_finding_id bigint REFERENCES analysis_findings (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_project_id ON tasks (project_id);
CREATE INDEX idx_tasks_fts ON tasks USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '')));

CREATE TABLE task_goals (
    id bigserial PRIMARY KEY,
    task_id bigint NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    seq int NOT NULL,
    content text NOT NULL,
    done boolean NOT NULL DEFAULT false
);

CREATE INDEX idx_task_goals_task_id ON task_goals (task_id);

CREATE TABLE learning_records (
    id bigserial PRIMARY KEY,
    task_id bigint NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    note text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_learning_records_task_id ON learning_records (task_id);

CREATE INDEX idx_graph_nodes_name_trgm ON graph_nodes USING gin (name gin_trgm_ops);
CREATE INDEX idx_files_path_trgm ON files USING gin (path gin_trgm_ops);
CREATE INDEX idx_commits_message_fts ON commits USING gin (to_tsvector('simple', coalesce(message, '')));
CREATE INDEX idx_pull_requests_title_fts ON pull_requests USING gin (to_tsvector('simple', coalesce(title, '')));
CREATE INDEX idx_findings_title_fts ON analysis_findings USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(detail, '')));
