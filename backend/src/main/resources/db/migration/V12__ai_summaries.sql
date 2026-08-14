-- Phase 3 (§6.2 AI tables): summaries + pgvector, conversations, usage.
CREATE TABLE summaries (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    subject_type text NOT NULL,
    subject_id bigint,
    level text NOT NULL,
    content text NOT NULL,
    embedding vector(1536),
    model text,
    token_count int,
    content_hash text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_summaries_subject UNIQUE (snapshot_id, subject_type, subject_id, level)
);

CREATE INDEX idx_summaries_snapshot_id ON summaries (snapshot_id);
CREATE INDEX idx_summaries_embedding ON summaries USING hnsw (embedding vector_cosine_ops);

CREATE TABLE ai_conversations (
    id bigserial PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    snapshot_id bigint REFERENCES snapshots (id) ON DELETE SET NULL,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_conversations_project_id ON ai_conversations (project_id);

CREATE TABLE ai_messages (
    id bigserial PRIMARY KEY,
    conversation_id bigint NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('USER', 'ASSISTANT')),
    content text NOT NULL,
    context jsonb,
    claims jsonb,
    prompt_tokens int,
    completion_tokens int,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_messages_conversation_id ON ai_messages (conversation_id);

CREATE TABLE ai_usage_logs (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id bigint REFERENCES projects (id) ON DELETE SET NULL,
    provider text NOT NULL,
    model text NOT NULL,
    purpose text NOT NULL,
    prompt_tokens int NOT NULL DEFAULT 0,
    completion_tokens int NOT NULL DEFAULT 0,
    cost_estimate numeric,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_usage_logs_user_day ON ai_usage_logs (user_id, created_at);
