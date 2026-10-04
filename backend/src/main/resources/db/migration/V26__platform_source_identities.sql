-- Preserve every V22 approval as its actual POSIX (device,inode) identity while widening
-- future approvals to platform-native identities. Legacy V22 did not persist an owner.
ALTER TABLE local_source_approvals
    ADD COLUMN root_platform varchar(16),
    ADD COLUMN root_identity text,
    ADD COLUMN root_owner text;

UPDATE local_source_approvals
SET root_platform = 'posix',
    root_identity = 'PI1:' || root_device::text || ':' || root_inode::text,
    root_owner = NULL;

ALTER TABLE job_local_source_inputs DISABLE TRIGGER local_source_input_immutable;
ALTER TABLE job_local_source_inputs
    ADD COLUMN root_platform varchar(16),
    ADD COLUMN root_identity text,
    ADD COLUMN root_owner text;
UPDATE job_local_source_inputs
SET root_platform = 'posix',
    root_identity = 'PI1:' || root_device::text || ':' || root_inode::text,
    root_owner = NULL;
ALTER TABLE job_local_source_inputs ENABLE TRIGGER local_source_input_immutable;

ALTER TABLE local_source_approvals
    ALTER COLUMN root_platform SET NOT NULL,
    ALTER COLUMN root_identity SET NOT NULL,
    ADD CONSTRAINT local_source_approval_platform_identity CHECK (
        (root_platform = 'posix' AND root_identity ~ '^PI1:-?[0-9]+:-?[0-9]+$' AND root_owner IS NULL)
        OR (root_platform = 'win32' AND root_identity ~ '^WI1:[0-9]+:[0-9]+:[0-9]+$'
            AND root_owner IS NOT NULL AND root_owner ~ '^S-1-([0-9]+-)*[0-9]+$')),
    ADD CONSTRAINT local_source_approval_identity_length CHECK (
        octet_length(root_identity) BETWEEN 1 AND 256 AND (root_owner IS NULL OR octet_length(root_owner) BETWEEN 1 AND 256)),
    DROP COLUMN root_device,
    DROP COLUMN root_inode;

ALTER TABLE job_local_source_inputs
    ALTER COLUMN root_platform SET NOT NULL,
    ALTER COLUMN root_identity SET NOT NULL,
    ADD CONSTRAINT job_local_source_platform_identity CHECK (
        (root_platform = 'posix' AND root_identity ~ '^PI1:-?[0-9]+:-?[0-9]+$' AND root_owner IS NULL)
        OR (root_platform = 'win32' AND root_identity ~ '^WI1:[0-9]+:[0-9]+:[0-9]+$'
            AND root_owner IS NOT NULL AND root_owner ~ '^S-1-([0-9]+-)*[0-9]+$')),
    ADD CONSTRAINT job_local_source_identity_length CHECK (
        octet_length(root_identity) BETWEEN 1 AND 256 AND (root_owner IS NULL OR octet_length(root_owner) BETWEEN 1 AND 256)),
    DROP COLUMN root_device,
    DROP COLUMN root_inode;
