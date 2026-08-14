-- P2 (§6.2): static analysis findings. Rollback: drop analysis_findings.
CREATE TABLE analysis_findings (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    area_type text,
    category text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
    title text NOT NULL,
    detail text,
    status text NOT NULL CHECK (status IN ('OPEN', 'CONFIRMED', 'DISMISSED')) DEFAULT 'OPEN',
    node_id bigint REFERENCES graph_nodes (id) ON DELETE SET NULL
);

CREATE INDEX idx_analysis_findings_snapshot_id ON analysis_findings (snapshot_id);
CREATE INDEX idx_analysis_findings_snapshot_severity ON analysis_findings (snapshot_id, severity);
