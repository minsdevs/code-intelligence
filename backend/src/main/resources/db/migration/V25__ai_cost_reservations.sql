-- Installation-wide projection of obligations whose authority survives normal restore in main's journal.
-- No credentials, request bodies, source text or approval capabilities belong in these tables.
create table ai_budget_gate (
    installation_id text primary key,
    owner_user_id bigint not null check (owner_user_id > 0),
    policy_revision bigint not null default 0 check (policy_revision >= 0),
    policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
    daily_limit_micro_usd bigint not null default 0 check (daily_limit_micro_usd >= 0),
    monthly_limit_micro_usd bigint not null default 0 check (monthly_limit_micro_usd >= 0),
    reconciliation_required boolean not null default true,
    legacy_liability_unresolved boolean not null default true,
    journal_sequence bigint not null default 0 check (journal_sequence >= 0),
    journal_hash text not null check (journal_hash ~ '^[0-9a-f]{64}$'),
    journal_projection_sha256 text not null check (journal_projection_sha256 ~ '^[0-9a-f]{64}$'),
    clock_high_water_ms bigint not null default 0 check (clock_high_water_ms >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table ai_request_ledger (
    request_id uuid primary key,
    installation_id text not null references ai_budget_gate (installation_id),
    -- No user/project/snapshot FK: deleting product data must never erase a financial obligation.
    owner_user_id bigint,
    project_id bigint,
    snapshot_id bigint,
    approval_id uuid,
    plan_sha256 text not null check (plan_sha256 ~ '^[0-9a-f]{64}$'),
    payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
    wire_body_sha256 text not null check (wire_body_sha256 ~ '^[0-9a-f]{64}$'),
    -- Exact typed dispatch metadata only; never the HTTP body, key, headers or preview token.
    dispatch_binding jsonb not null check (jsonb_typeof(dispatch_binding) = 'object'),
    budget_day date not null,
    price_version text not null,
    reserved_micro_usd bigint not null check (reserved_micro_usd >= 0),
    status text not null check (status in ('RESERVED', 'DISPATCHED', 'UNKNOWN_HELD', 'SETTLED')),
    actual_micro_usd bigint check (actual_micro_usd >= 0),
    proof_sha256 text check (proof_sha256 ~ '^[0-9a-f]{64}$'),
    liability_floor_micro_usd bigint not null default 0 check (liability_floor_micro_usd >= 0),
    conflict boolean not null default false,
    journal_sequence bigint check (journal_sequence >= 0),
    journal_hash text check (journal_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check ((status = 'SETTLED' and actual_micro_usd is not null and proof_sha256 is not null)
        or (status <> 'SETTLED' and actual_micro_usd is null and proof_sha256 is null))
);
create index ai_request_ledger_installation_day on ai_request_ledger (installation_id, budget_day);

create table ai_usage_evidence (
    request_id uuid not null references ai_request_ledger (request_id),
    proof_sha256 text not null check (proof_sha256 ~ '^[0-9a-f]{64}$'),
    main_epoch text not null,
    receipt_type text not null check (receipt_type in ('USAGE', 'PROVEN_NOT_SENT')),
    provider_request_id text,
    usage_dimensions jsonb not null check (jsonb_typeof(usage_dimensions) = 'object'),
    actual_micro_usd bigint not null check (actual_micro_usd >= 0),
    created_at timestamptz not null default now(),
    primary key (request_id, proof_sha256),
    check (receipt_type <> 'PROVEN_NOT_SENT' or actual_micro_usd = 0)
);

create function guard_ai_cost_immutability() returns trigger language plpgsql as $$
begin
    if TG_OP = 'DELETE' then
        raise exception 'AI cost obligations cannot be deleted';
    end if;
    if TG_TABLE_NAME = 'ai_usage_evidence' then
        raise exception 'AI usage evidence is immutable';
    elsif TG_TABLE_NAME = 'ai_budget_gate' then
        if new.installation_id is distinct from old.installation_id
            or new.owner_user_id is distinct from old.owner_user_id
            or new.policy_revision < old.policy_revision
            or new.journal_sequence < old.journal_sequence
            or new.clock_high_water_ms < old.clock_high_water_ms then
            raise exception 'AI budget authority cannot regress';
        end if;
    else
        if row(new.request_id, new.installation_id, new.owner_user_id, new.project_id, new.snapshot_id,
               new.approval_id, new.plan_sha256, new.payload_sha256, new.wire_body_sha256,
               new.dispatch_binding, new.budget_day, new.price_version, new.reserved_micro_usd, new.created_at)
           is distinct from
           row(old.request_id, old.installation_id, old.owner_user_id, old.project_id, old.snapshot_id,
               old.approval_id, old.plan_sha256, old.payload_sha256, old.wire_body_sha256,
               old.dispatch_binding, old.budget_day, old.price_version, old.reserved_micro_usd, old.created_at)
            or new.liability_floor_micro_usd < old.liability_floor_micro_usd
            or (old.conflict and not new.conflict)
            or (old.journal_sequence is not null and (new.journal_sequence is null
                or new.journal_sequence < old.journal_sequence))
            or (old.status <> 'RESERVED' and new.status = 'RESERVED')
            or (old.status = 'UNKNOWN_HELD' and new.status = 'DISPATCHED')
            or (old.status = 'SETTLED' and row(new.status, new.actual_micro_usd, new.proof_sha256)
                is distinct from row(old.status, old.actual_micro_usd, old.proof_sha256)) then
            raise exception 'AI request identity or obligation cannot regress';
        end if;
    end if;
    return new;
end;
$$;
create trigger ai_budget_gate_immutable before update or delete on ai_budget_gate
    for each row execute function guard_ai_cost_immutability();
create trigger ai_request_ledger_immutable before update or delete on ai_request_ledger
    for each row execute function guard_ai_cost_immutability();
create trigger ai_usage_evidence_immutable before update or delete on ai_usage_evidence
    for each row execute function guard_ai_cost_immutability();
