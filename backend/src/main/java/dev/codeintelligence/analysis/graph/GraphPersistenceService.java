package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

@Service
public class GraphPersistenceService {

    private final JdbcClient jdbc;
    private final TransactionTemplate transactionTemplate;
    private final EvidenceService evidenceService;
    private final JsonMapper jsonMapper;

    public GraphPersistenceService(
            JdbcClient jdbc,
            TransactionTemplate transactionTemplate,
            EvidenceService evidenceService,
            JsonMapper jsonMapper) {
        this.jdbc = jdbc;
        this.transactionTemplate = transactionTemplate;
        this.evidenceService = evidenceService;
        this.jsonMapper = jsonMapper;
    }

    public void persist(long projectId, long snapshotId, AnalysisResult result) {
        transactionTemplate.executeWithoutResult(tx -> {
            Map<String, Long> ids = new LinkedHashMap<>();
            for (GraphNodeDraft node : result.nodes()) {
                Long fileId = resolveFileId(snapshotId, node.filePath());
                long id = upsertNode(snapshotId, node, fileId);
                ids.put(node.naturalKey(), id);
                persistNodeEvidence(projectId, id, node.naturalKey(), result.evidences());
            }
            for (GraphEdgeDraft edge : result.edges()) {
                Long source = resolveNodeId(snapshotId, ids, edge.sourceNaturalKey());
                Long target = resolveNodeId(snapshotId, ids, edge.targetNaturalKey());
                if (source == null || target == null || source.equals(target)) {
                    continue;
                }
                upsertEdge(snapshotId, source, target, edge);
            }
        });
    }

    public long upsertNode(long snapshotId, GraphNodeDraft node, Long fileId) {
        return jdbc.sql("""
                        insert into graph_nodes (
                            snapshot_id, node_type, natural_key, name, file_id,
                            line_start, line_end, area_type, metadata)
                        values (
                            :snapshotId, :nodeType, :naturalKey, :name, :fileId,
                            :lineStart, :lineEnd, :areaType, cast(:metadata as jsonb))
                        on conflict (snapshot_id, natural_key) do update set
                            node_type = excluded.node_type,
                            name = excluded.name,
                            file_id = coalesce(excluded.file_id, graph_nodes.file_id),
                            line_start = coalesce(excluded.line_start, graph_nodes.line_start),
                            line_end = coalesce(excluded.line_end, graph_nodes.line_end),
                            area_type = coalesce(excluded.area_type, graph_nodes.area_type),
                            metadata = case
                                when excluded.metadata = '{}'::jsonb then graph_nodes.metadata
                                else excluded.metadata
                            end
                        returning id
                        """)
                .param("snapshotId", snapshotId)
                .param("nodeType", node.nodeType())
                .param("naturalKey", node.naturalKey())
                .param("name", node.name())
                .param("fileId", fileId)
                .param("lineStart", node.lineStart())
                .param("lineEnd", node.lineEnd())
                .param("areaType", node.areaType())
                .param("metadata", toJson(node.metadata()))
                .query(Long.class)
                .single();
    }

    private void upsertEdge(long snapshotId, long sourceId, long targetId, GraphEdgeDraft edge) {
        jdbc.sql("""
                        insert into graph_edges (
                            snapshot_id, source_node_id, target_node_id, edge_type, confidence, metadata)
                        values (
                            :snapshotId, :sourceId, :targetId, :edgeType, :confidence, cast(:metadata as jsonb))
                        on conflict (snapshot_id, source_node_id, target_node_id, edge_type) do update set
                            confidence = excluded.confidence,
                            metadata = excluded.metadata
                        """)
                .param("snapshotId", snapshotId)
                .param("sourceId", sourceId)
                .param("targetId", targetId)
                .param("edgeType", edge.edgeType())
                .param("confidence", edge.confidence())
                .param("metadata", toJson(edge.metadata()))
                .update();
    }

    private Long resolveFileId(long snapshotId, String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return null;
        }
        return jdbc.sql("""
                        select id from files where snapshot_id = :snapshotId and path = :path
                        """)
                .param("snapshotId", snapshotId)
                .param("path", filePath.replace('\\', '/'))
                .query(Long.class)
                .optional()
                .orElse(null);
    }

    private Long resolveNodeId(long snapshotId, Map<String, Long> ids, String naturalKey) {
        Long cached = ids.get(naturalKey);
        if (cached != null) {
            return cached;
        }
        return jdbc.sql("""
                        select id from graph_nodes
                        where snapshot_id = :snapshotId and natural_key = :naturalKey
                        """)
                .param("snapshotId", snapshotId)
                .param("naturalKey", naturalKey)
                .query(Long.class)
                .optional()
                .orElse(null);
    }

    private void persistNodeEvidence(long projectId, long nodeId, String naturalKey, List<AnalyzerEvidence> evidences) {
        List<NewEvidence> linked = evidences.stream()
                .filter(evidence -> naturalKey.equals(evidence.subjectNaturalKey()))
                .map(evidence -> new NewEvidence(
                        evidence.kind(),
                        evidence.filePath(),
                        evidence.lineStart(),
                        evidence.lineEnd(),
                        evidence.excerpt()))
                .toList();
        if (linked.isEmpty()) {
            return;
        }
        evidenceService.replaceLinked(projectId, EvidenceSubjects.GRAPH_NODE, nodeId, linked);
    }

    private String toJson(Map<String, Object> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return "{}";
        }
        return jsonMapper.writeValueAsString(metadata);
    }
}
