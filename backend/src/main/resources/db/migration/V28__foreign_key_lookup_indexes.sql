-- G-PERF finding 7: deleting a project or snapshot cascades row by row through these foreign
-- keys. V6/V8/V10-V12 index them only behind snapshot_id (or not at all), so each deleted
-- graph node scanned graph_edges and the projections. Rollback: drop the indexes below.
CREATE INDEX idx_graph_edges_source_node_id ON graph_edges (source_node_id);
CREATE INDEX idx_graph_edges_target_node_id ON graph_edges (target_node_id);
CREATE INDEX idx_graph_nodes_file_id ON graph_nodes (file_id);
CREATE INDEX idx_feature_links_node_id ON feature_links (node_id);
CREATE INDEX idx_flows_entry_node_id ON flows (entry_node_id);
CREATE INDEX idx_flow_steps_node_id ON flow_steps (node_id);
CREATE INDEX idx_flow_steps_edge_id ON flow_steps (edge_id);
CREATE INDEX idx_analysis_findings_node_id ON analysis_findings (node_id);
CREATE INDEX idx_ai_conversations_snapshot_id ON ai_conversations (snapshot_id);
