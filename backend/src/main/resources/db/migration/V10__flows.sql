-- P2 (§6.2): call-flow projection. Rollback: drop flow_steps, flows.
CREATE TABLE flows (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('BACKEND', 'FE_BE', 'INFRA', 'EVENT')),
    entry_node_id bigint REFERENCES graph_nodes (id) ON DELETE SET NULL,
    CONSTRAINT uq_flows_snapshot_kind_name UNIQUE (snapshot_id, kind, name)
);

CREATE INDEX idx_flows_snapshot_id ON flows (snapshot_id);

CREATE TABLE flow_steps (
    id bigserial PRIMARY KEY,
    flow_id bigint NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
    seq int NOT NULL,
    node_id bigint REFERENCES graph_nodes (id) ON DELETE SET NULL,
    edge_id bigint REFERENCES graph_edges (id) ON DELETE SET NULL,
    description text,
    CONSTRAINT uq_flow_steps_flow_seq UNIQUE (flow_id, seq)
);

CREATE INDEX idx_flow_steps_flow_id ON flow_steps (flow_id);
