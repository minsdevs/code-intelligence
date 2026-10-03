-- Additive retained-source identity. Existing Git OIDs, notes, tasks and source rows are unchanged.
ALTER TABLE snapshots ADD CONSTRAINT uq_snapshots_project_identity UNIQUE (id, project_id);
-- Retained identity survives a missing/retired manifest; it must never become a legacy Git read.
ALTER TABLE snapshots ADD COLUMN source_contract_version integer NOT NULL DEFAULT 0
    CHECK (source_contract_version IN (0, 1));
CREATE FUNCTION protect_snapshot_source_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source_contract_version IS DISTINCT FROM OLD.source_contract_version THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Snapshot source identity is immutable';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER snapshot_source_identity_immutable BEFORE UPDATE ON snapshots
    FOR EACH ROW EXECUTE FUNCTION protect_snapshot_source_identity();

CREATE TABLE source_blobs (
    project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    byte_size bigint NOT NULL CHECK (byte_size BETWEEN 0 AND 2097152),
    key_id char(32) NOT NULL CHECK (key_id ~ '^[0-9a-f]{32}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, sha256)
);
CREATE FUNCTION protect_source_blob() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND (
        NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
        OR NOT EXISTS (SELECT 1 FROM source_manifest_entries
                       WHERE project_id = OLD.project_id AND blob_sha256 = OLD.sha256)) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Source blob identity is immutable';
END
$$;
CREATE TRIGGER source_blob_immutable BEFORE UPDATE OR DELETE ON source_blobs
    FOR EACH ROW EXECUTE FUNCTION protect_source_blob();

CREATE TABLE source_manifests (
    id uuid PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    snapshot_id bigint NOT NULL UNIQUE,
    -- Historical job identity: removing an old job must not rewrite a sealed manifest.
    job_id bigint NOT NULL UNIQUE,
    contract_version integer NOT NULL CHECK (contract_version = 1),
    producer_version varchar(64) NOT NULL,
    source_kind varchar(16) NOT NULL CHECK (source_kind = 'LOCAL'),
    approval_manifest_sha256 char(64) NOT NULL CHECK (approval_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    limits_sha256 char(64) NOT NULL CHECK (limits_sha256 ~ '^[0-9a-f]{64}$'),
    policy_version varchar(64) NOT NULL,
    file_count integer NOT NULL CHECK (file_count BETWEEN 0 AND 50000),
    byte_size bigint NOT NULL CHECK (byte_size BETWEEN 0 AND 536870912),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    sealed_at timestamptz,
    UNIQUE (id, project_id),
    UNIQUE (id, project_id, snapshot_id),
    FOREIGN KEY (snapshot_id, project_id) REFERENCES snapshots(id, project_id) ON DELETE CASCADE
);

CREATE TABLE source_manifest_entries (
    manifest_id uuid NOT NULL,
    project_id bigint NOT NULL,
    path text NOT NULL CHECK (octet_length(path) BETWEEN 1 AND 8192),
    blob_sha256 char(64) NOT NULL,
    git_oid char(40) NOT NULL CHECK (git_oid ~ '^[0-9a-f]{40}$'),
    byte_size bigint NOT NULL CHECK (byte_size BETWEEN 0 AND 2097152),
    PRIMARY KEY (manifest_id, path),
    FOREIGN KEY (manifest_id, project_id) REFERENCES source_manifests(id, project_id) ON DELETE CASCADE,
    -- Project deletion removes both sides via separate cascade paths. Check the completed
    -- transaction rather than depending on the order of PostgreSQL's cascade triggers.
    FOREIGN KEY (project_id, blob_sha256) REFERENCES source_blobs(project_id, sha256)
      DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION protect_sealed_source_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_sealed timestamptz;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Source entries cannot be rewritten';
    END IF;
    SELECT sealed_at INTO parent_sealed FROM source_manifests
      WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.manifest_id ELSE NEW.manifest_id END FOR UPDATE;
    IF parent_sealed IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sealed source entries are immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$$;
CREATE TRIGGER source_entry_immutable BEFORE INSERT OR UPDATE OR DELETE ON source_manifest_entries
    FOR EACH ROW EXECUTE FUNCTION protect_sealed_source_entry();

CREATE FUNCTION protect_source_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_count bigint; entry_bytes bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM snapshots WHERE id = OLD.snapshot_id AND project_id = OLD.project_id)
           AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Retained manifests belong to their snapshot';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM snapshots WHERE id = NEW.snapshot_id AND project_id = NEW.project_id
                       AND source_contract_version = 1) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Source manifests require retained snapshot identity';
        END IF;
        IF NEW.sealed_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Source manifests must be assembled before sealing';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.sealed_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sealed source manifest is immutable';
    END IF;
    IF NEW.sealed_at IS NOT NULL THEN
        SELECT count(*), coalesce(sum(byte_size), 0) INTO entry_count, entry_bytes
          FROM source_manifest_entries WHERE manifest_id = NEW.id;
        IF entry_count <> NEW.file_count OR entry_bytes <> NEW.byte_size THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Source manifest entries are incomplete';
        END IF;
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER source_manifest_immutable BEFORE INSERT OR UPDATE OR DELETE ON source_manifests
    FOR EACH ROW EXECUTE FUNCTION protect_source_manifest();

CREATE TABLE analysis_generations (
    id uuid PRIMARY KEY,
    project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    snapshot_id bigint NOT NULL,
    source_manifest_id uuid NOT NULL,
    job_id bigint NOT NULL UNIQUE,
    contract_version integer NOT NULL CHECK (contract_version = 1),
    producer_version varchar(64) NOT NULL,
    -- Null means not yet measured by the v1 adapter translator, never a proven rule/context hash.
    rules_sha256 char(64),
    config_sha256 char(64),
    dependency_context_sha256 char(64),
    status varchar(16) NOT NULL CHECK (status IN ('STAGING', 'COMMITTED', 'FAILED', 'CANCELLED')),
    previous_committed_generation_id uuid,
    fencing_epoch bigint GENERATED ALWAYS AS IDENTITY,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    committed_at timestamptz,
    UNIQUE (id, project_id, snapshot_id),
    FOREIGN KEY (source_manifest_id, project_id, snapshot_id)
      REFERENCES source_manifests(id, project_id, snapshot_id) ON DELETE CASCADE,
    CHECK ((status = 'COMMITTED') = (committed_at IS NOT NULL)),
    CHECK (rules_sha256 IS NULL OR rules_sha256 ~ '^[0-9a-f]{64}$'),
    CHECK (config_sha256 IS NULL OR config_sha256 ~ '^[0-9a-f]{64}$'),
    CHECK (dependency_context_sha256 IS NULL OR dependency_context_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_analysis_generations_project ON analysis_generations(project_id, created_at);

ALTER TABLE projects ADD COLUMN current_generation_id uuid;
ALTER TABLE projects ADD CONSTRAINT ck_generation_has_snapshot
    CHECK (current_generation_id IS NULL OR current_snapshot_id IS NOT NULL);
ALTER TABLE projects ADD CONSTRAINT fk_current_generation_scope
    FOREIGN KEY (current_generation_id, id, current_snapshot_id)
    REFERENCES analysis_generations(id, project_id, snapshot_id) DEFERRABLE INITIALLY DEFERRED;
