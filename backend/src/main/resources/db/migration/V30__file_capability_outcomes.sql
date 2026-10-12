-- Per-file adapter outcomes for the symbol (S), call (C), framework (F) and cross-domain (X) capabilities
-- (03 FileOutcome: one owner outcome per file and capability; 03 coverage invariants). Capability P stays on
-- files.analysis_status. Only new runs write rows; files without a row for a capability are unmeasured.
create table file_capability_outcomes (
    file_id bigint not null references files(id) on delete cascade,
    capability varchar(1) not null check (capability in ('S', 'C', 'F', 'X')),
    status varchar(32) not null check (status in ('TARGETED', 'SUCCESS', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'UNMEASURED')),
    reason varchar(128),
    primary key (file_id, capability)
);
