-- Desktop local identity survives GitHub connect/disconnect and owns local projects.
ALTER TABLE users ALTER COLUMN github_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN local_key text;
ALTER TABLE users ADD COLUMN identity_type text NOT NULL DEFAULT 'GITHUB';

CREATE UNIQUE INDEX uq_users_local_key ON users (local_key) WHERE local_key IS NOT NULL;
ALTER TABLE users ADD CONSTRAINT ck_users_identity
    CHECK (github_id IS NOT NULL OR local_key IS NOT NULL);
