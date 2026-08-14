-- P6 (§3 V6 / 기획서 §6.2): unified code graph. Rollback: drop graph_edges, graph_nodes.
CREATE TABLE graph_nodes (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    node_type text NOT NULL,
    natural_key text NOT NULL,
    name text NOT NULL,
    file_id bigint REFERENCES files (id) ON DELETE SET NULL,
    line_start int,
    line_end int,
    area_type text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_graph_nodes_snapshot_natural_key UNIQUE (snapshot_id, natural_key)
);

CREATE INDEX idx_graph_nodes_snapshot_id ON graph_nodes (snapshot_id);
CREATE INDEX idx_graph_nodes_snapshot_type ON graph_nodes (snapshot_id, node_type);
CREATE INDEX idx_graph_nodes_snapshot_area ON graph_nodes (snapshot_id, area_type);

CREATE TABLE graph_edges (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    source_node_id bigint NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
    target_node_id bigint NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
    edge_type text NOT NULL,
    confidence text NOT NULL CHECK (confidence IN ('CONFIRMED', 'LIKELY', 'POSSIBLE')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_graph_edges_ends_type UNIQUE (snapshot_id, source_node_id, target_node_id, edge_type)
);

CREATE INDEX idx_graph_edges_snapshot_source_type ON graph_edges (snapshot_id, source_node_id, edge_type);
CREATE INDEX idx_graph_edges_snapshot_target_type ON graph_edges (snapshot_id, target_node_id, edge_type);
