-- UX P4: an optional preview scope (top-level directories and/or languages) is part of the approved
-- input. NULL is the whole selected root; existing approvals and job inputs keep their meaning.
ALTER TABLE local_source_approvals
    ADD COLUMN scope text CHECK (scope IS NULL OR octet_length(scope) BETWEEN 2 AND 131072);
ALTER TABLE job_local_source_inputs
    ADD COLUMN scope text CHECK (scope IS NULL OR octet_length(scope) BETWEEN 2 AND 131072);
