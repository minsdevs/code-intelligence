-- P1 Phase 2 (§6.2): frontend route projection. Rollback: drop frontend_routes.
CREATE TABLE frontend_routes (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    node_id bigint NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
    path text NOT NULL,
    component_key text,
    CONSTRAINT uq_frontend_routes_node UNIQUE (node_id),
    CONSTRAINT uq_frontend_routes_snapshot_path UNIQUE (snapshot_id, path)
);

CREATE INDEX idx_frontend_routes_snapshot_id ON frontend_routes (snapshot_id);
