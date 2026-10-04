-- Only new runs populate these facts. Historical files deliberately remain unmeasured.
alter table files add column analysis_status varchar(32) not null default 'LEGACY_UNMEASURED';
alter table files add column analysis_reason varchar(128);
alter table files add column analysis_targeted boolean not null default false;
alter table files add constraint files_analysis_status_check check (analysis_status in
    ('LEGACY_UNMEASURED', 'UNMEASURED', 'TARGETED', 'SUCCESS', 'PARTIAL', 'FAILED', 'UNSUPPORTED'));

create table snapshot_inventory_measurements (
    snapshot_id bigint primary key references snapshots(id) on delete cascade,
    discovered_files integer not null check (discovered_files >= 0),
    excluded_for_count integer not null check (excluded_for_count >= 0),
    excluded_for_size integer not null check (excluded_for_size >= 0),
    excluded_binary integer not null check (excluded_binary >= 0),
    excluded_submodules integer not null check (excluded_submodules >= 0)
);
