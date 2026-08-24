-- User-owned finding adjudication. Original analysis_findings rows remain immutable.
CREATE TABLE finding_judgments (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    stable_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('NEEDS_REVIEW', 'ACCEPTED', 'FALSE_POSITIVE', 'RESOLVED')),
    reason text NOT NULL DEFAULT '',
    rule_id text NOT NULL,
    rule_version text NOT NULL,
    evidence_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_finding_judgment_owner_key UNIQUE (user_id, project_id, stable_key)
);

CREATE INDEX idx_finding_judgments_project_user
    ON finding_judgments (project_id, user_id, status);
