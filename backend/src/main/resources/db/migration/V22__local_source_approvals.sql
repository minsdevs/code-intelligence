-- A preview authorizes one job's exact input; legacy rows receive no implicit approval.
ALTER TABLE analysis_jobs ADD COLUMN failure_code varchar(64);

CREATE TABLE local_source_approvals (
    id bigserial PRIMARY KEY,
    token_sha256 char(64) NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose varchar(7) NOT NULL CHECK (purpose IN ('INITIAL', 'REFRESH')),
    project_id bigint REFERENCES projects(id) ON DELETE CASCADE,
    base_snapshot_id bigint,
    project_name varchar(255),
    schema_version integer NOT NULL CHECK (schema_version = 1),
    canonical_root text NOT NULL CHECK (octet_length(canonical_root) BETWEEN 1 AND 16384),
    root_device bigint NOT NULL,
    root_inode bigint NOT NULL,
    policy_version varchar(64) NOT NULL,
    limits_sha256 char(64) NOT NULL CHECK (limits_sha256 ~ '^[0-9a-f]{64}$'),
    manifest_sha256 char(64) NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    selected_files integer NOT NULL CHECK (selected_files BETWEEN 0 AND 50000),
    selected_bytes bigint NOT NULL CHECK (selected_bytes BETWEEN 0 AND 536870912),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    consumed_job_id bigint REFERENCES analysis_jobs(id) ON DELETE SET NULL,
    revoked_at timestamptz,
    CHECK (expires_at = issued_at + interval '10 minutes'),
    CHECK ((purpose = 'INITIAL' AND project_id IS NULL AND base_snapshot_id IS NULL AND project_name IS NOT NULL)
        OR (purpose = 'REFRESH' AND project_id IS NOT NULL AND project_name IS NULL)),
    CHECK (consumed_at IS NOT NULL OR consumed_job_id IS NULL),
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX idx_local_source_approvals_owner ON local_source_approvals(user_id, expires_at);

CREATE TABLE job_local_source_inputs (
    job_id bigint PRIMARY KEY REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    approval_token_sha256 char(64) NOT NULL UNIQUE CHECK (approval_token_sha256 ~ '^[0-9a-f]{64}$'),
    purpose varchar(7) NOT NULL CHECK (purpose IN ('INITIAL', 'REFRESH')),
    -- Historical identity, deliberately not rewritten/nullified when retention removes a snapshot.
    base_snapshot_id bigint,
    schema_version integer NOT NULL CHECK (schema_version = 1),
    canonical_root text NOT NULL CHECK (octet_length(canonical_root) BETWEEN 1 AND 16384),
    root_device bigint NOT NULL,
    root_inode bigint NOT NULL,
    policy_version varchar(64) NOT NULL,
    limits_sha256 char(64) NOT NULL CHECK (limits_sha256 ~ '^[0-9a-f]{64}$'),
    manifest_sha256 char(64) NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    selected_files integer NOT NULL CHECK (selected_files BETWEEN 0 AND 50000),
    selected_bytes bigint NOT NULL CHECK (selected_bytes BETWEEN 0 AND 536870912),
    approved_at timestamptz NOT NULL
);

CREATE FUNCTION reject_local_source_input_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A local job input is immutable';
END
$$;
CREATE TRIGGER local_source_input_immutable BEFORE UPDATE ON job_local_source_inputs
    FOR EACH ROW EXECUTE FUNCTION reject_local_source_input_update();
