-- AI provider API keys, configurable from the Settings screen.
-- The key is encrypted with the same AES-256-GCM scheme as GitHub tokens.
-- One row per user; a user may have zero rows (falls back to environment config).
CREATE TABLE user_ai_settings (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('openai', 'gemini')),
    encrypted_key text NOT NULL,
    nonce bytea NOT NULL,
    key_version int NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_user_ai_settings_user ON user_ai_settings (user_id);
