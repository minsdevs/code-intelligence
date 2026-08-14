-- P7 (§3 V7 / 기획서 §6.2): CONTAINER/CI projection. Rollback: drop infra_resources.
CREATE TABLE infra_resources (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    node_id bigint NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('CONTAINER', 'CLOUD', 'CI')),
    name text NOT NULL,
    source_path text,
    CONSTRAINT uq_infra_resources_node UNIQUE (node_id)
);

CREATE INDEX idx_infra_resources_snapshot_id ON infra_resources (snapshot_id);
CREATE INDEX idx_infra_resources_snapshot_kind ON infra_resources (snapshot_id, kind);
