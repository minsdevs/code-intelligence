-- §18 carry-over ①: per-ciphertext GCM nonce and key rotation support.
-- github_credentials has no rows yet (Phase 0 shipped the empty table),
-- so adding NOT NULL columns without backfill is safe.
ALTER TABLE github_credentials
    ADD COLUMN nonce bytea NOT NULL,
    ADD COLUMN key_version int NOT NULL DEFAULT 1;

-- One credential per (user, kind); logins re-encrypt in place instead of stacking rows.
ALTER TABLE github_credentials
    ADD CONSTRAINT uq_github_credentials_user_kind UNIQUE (user_id, kind);
