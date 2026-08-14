-- P8 (§3 V8 / 기획서 §6.2): endpoint/entity projection + features.
-- Rollback: drop feature_links, features, db_entities, api_endpoints.
CREATE TABLE api_endpoints (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    node_id bigint NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
    http_method text NOT NULL,
    path text NOT NULL,
    handler_key text NOT NULL,
    CONSTRAINT uq_api_endpoints_node UNIQUE (node_id),
    CONSTRAINT uq_api_endpoints_snapshot_method_path UNIQUE (snapshot_id, http_method, path)
);

CREATE INDEX idx_api_endpoints_snapshot_id ON api_endpoints (snapshot_id);

CREATE TABLE db_entities (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    node_id bigint NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
    entity_name text NOT NULL,
    table_name text NOT NULL,
    source text NOT NULL CHECK (source IN ('JPA', 'MIGRATION')),
    CONSTRAINT uq_db_entities_node UNIQUE (node_id)
);

CREATE INDEX idx_db_entities_snapshot_id ON db_entities (snapshot_id);

CREATE TABLE features (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    parent_id bigint REFERENCES features (id) ON DELETE SET NULL,
    detection text NOT NULL CHECK (detection IN ('STATIC', 'AI_ASSISTED')),
    confidence double precision NOT NULL,
    CONSTRAINT uq_features_snapshot_name UNIQUE (snapshot_id, name)
);

CREATE INDEX idx_features_snapshot_id ON features (snapshot_id);

CREATE TABLE feature_links (
    id bigserial PRIMARY KEY,
    feature_id bigint NOT NULL REFERENCES features (id) ON DELETE CASCADE,
    node_id bigint NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
    role text NOT NULL,
    CONSTRAINT uq_feature_links_feature_node UNIQUE (feature_id, node_id)
);

CREATE INDEX idx_feature_links_feature_id ON feature_links (feature_id);
