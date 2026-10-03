-- Keyless connection preferences survive key deletion and can represent a restored OFF account.
-- This is restorable product state, not the main process safety journal or a budget authority.
CREATE TABLE user_ai_preferences (
    user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    provider text CHECK (provider IN ('openai', 'gemini')),
    model text,
    connection_state text NOT NULL DEFAULT 'OFF'
        CHECK (connection_state IN ('OFF', 'ENABLED', 'RECONNECT_REQUIRED')),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (model IS NULL OR provider IS NOT NULL),
    CHECK (connection_state <> 'ENABLED' OR provider IS NOT NULL)
);

-- Preserve existing explicit BYOK connections without decrypting/changing their credentials.
-- An environment key alone does not create an enabled user preference.
INSERT INTO user_ai_preferences (user_id, provider, model, connection_state, created_at, updated_at)
SELECT user_id, provider, model, 'ENABLED', created_at, updated_at
FROM user_ai_settings;
