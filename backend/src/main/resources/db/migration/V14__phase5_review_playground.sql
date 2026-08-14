-- Phase 5 (§21): PR reviews and playground sessions. Hypothetical snippets are
-- stored as text only and are never written into the clone tree.
CREATE TABLE pr_reviews (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    pull_request_id bigint NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
    summary text NOT NULL DEFAULT '',
    origin text NOT NULL CHECK (origin IN ('AI')) DEFAULT 'AI',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pr_reviews_pull ON pr_reviews (pull_request_id, created_at DESC);
CREATE INDEX idx_pr_reviews_project ON pr_reviews (project_id);

CREATE TABLE pr_review_comments (
    id bigserial PRIMARY KEY,
    review_id bigint NOT NULL REFERENCES pr_reviews (id) ON DELETE CASCADE,
    seq int NOT NULL,
    file_path text,
    line int,
    severity text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR')),
    body text NOT NULL,
    confidence text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX idx_pr_review_comments_review ON pr_review_comments (review_id, seq);

CREATE TABLE playground_sessions (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title text NOT NULL,
    selected_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
    proposed_snippet text NOT NULL DEFAULT '',
    last_question text,
    last_explanation text,
    last_claims jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_playground_sessions_project ON playground_sessions (project_id, updated_at DESC);
