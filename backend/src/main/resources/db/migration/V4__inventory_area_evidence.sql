-- P3 (§3 V4 / 기획서 §6.2): file inventory, project areas, evidence.
CREATE TABLE files (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    path text NOT NULL,
    language text,
    size bigint NOT NULL,
    line_count int,
    content_hash text NOT NULL,
    CONSTRAINT uq_files_snapshot_path UNIQUE (snapshot_id, path)
);

CREATE INDEX idx_files_snapshot_id ON files (snapshot_id);

CREATE TABLE project_areas (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    area_type text NOT NULL CHECK (area_type IN (
        'BACKEND', 'FRONTEND', 'MOBILE', 'DATABASE', 'INFRASTRUCTURE', 'DEVOPS',
        'SECURITY', 'TESTING', 'AI_ML', 'DOCUMENTATION', 'BUILD_TOOLING', 'OTHER'
    )),
    confidence double precision NOT NULL,
    summary text,
    CONSTRAINT uq_project_areas_snapshot_type UNIQUE (snapshot_id, area_type)
);

CREATE INDEX idx_project_areas_snapshot_id ON project_areas (snapshot_id);

CREATE TABLE area_technologies (
    id bigserial PRIMARY KEY,
    area_id bigint NOT NULL REFERENCES project_areas (id) ON DELETE CASCADE,
    name text NOT NULL,
    version text,
    CONSTRAINT uq_area_technologies UNIQUE (area_id, name)
);

CREATE TABLE evidences (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('FILE_LINE', 'COMMIT', 'PR', 'ISSUE', 'CONFIG', 'DEPENDENCY', 'URL')),
    file_path text,
    line_start int,
    line_end int,
    commit_sha text,
    pr_number int,
    url text,
    excerpt text,
    created_by text NOT NULL CHECK (created_by IN ('STATIC', 'AI')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidences_project_id ON evidences (project_id);

CREATE TABLE evidence_links (
    id bigserial PRIMARY KEY,
    evidence_id bigint NOT NULL REFERENCES evidences (id) ON DELETE CASCADE,
    subject_type text NOT NULL,
    subject_id bigint NOT NULL,
    CONSTRAINT uq_evidence_links UNIQUE (evidence_id, subject_type, subject_id)
);

CREATE INDEX idx_evidence_links_subject ON evidence_links (subject_type, subject_id);
