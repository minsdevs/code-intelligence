package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphIdentityGuard;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import java.util.ArrayList;
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
            List<GraphNodeDraft> candidates = new ArrayList<>();
            List<String> keys = result.nodes().stream()
                    .map(GraphNodeDraft::naturalKey)
                    .distinct()
                    .toList();
            for (int start = 0; start < keys.size(); start += 500) {
                candidates.addAll(jdbc.sql("""
                        select n.node_type, n.natural_key, n.name, f.path, n.line_start, n.line_end, n.area_type, n.metadata::text as metadata
                        from graph_nodes n left join files f on f.id = n.file_id and f.snapshot_id = n.snapshot_id
                        where n.snapshot_id = :snapshotId and n.natural_key in (:keys)
                        """)
                        .param("snapshotId", snapshotId)
                        .param("keys", keys.subList(start, Math.min(start + 500, keys.size())))
                        .query((rs, rowNum) -> new GraphNodeDraft(
                                rs.getString("node_type"),
                                rs.getString("natural_key"),
                                rs.getString("name"),
                                rs.getString("path"),
                                (Integer) rs.getObject("line_start"),
                                (Integer) rs.getObject("line_end"),
                                rs.getString("area_type"),
                                readMetadata(rs.getString("metadata"))))
                        .list());
            }
            candidates.addAll(result.nodes());
            AnalysisResult safe = GraphIdentityGuard.sanitize(
                    new AnalysisResult(candidates, result.edges(), result.evidences(), result.fileOutcomes()));
            Map<String, Long> ids = new LinkedHashMap<>();
            for (GraphNodeDraft node : safe.nodes()) {
                Long fileId = resolveFileId(snapshotId, node.filePath());
                long id = upsertNode(snapshotId, node, fileId);
                if (GraphIdentityGuard.ambiguous(node)) {
                    jdbc.sql(
                                    "delete from graph_edges where snapshot_id = :snapshotId and (source_node_id = :id or target_node_id = :id)")
                            .param("snapshotId", snapshotId)
                            .param("id", id)
                            .update();
                    evidenceService.replaceLinked(projectId, EvidenceSubjects.GRAPH_NODE, id, List.of());
                } else {
                    ids.put(node.naturalKey(), id);
                    persistNodeEvidence(projectId, id, node.naturalKey(), safe.evidences());
                }
            }
            for (GraphEdgeDraft edge : safe.edges()) {
                Long source = resolveNodeId(snapshotId, ids, edge.sourceNaturalKey());
                Long target = resolveNodeId(snapshotId, ids, edge.targetNaturalKey());
                if (source == null || target == null || source.equals(target)) {
                    continue;
                }
                upsertEdge(snapshotId, source, target, edge);
            }
            for (FileAnalysisOutcome outcome : safe.fileOutcomes()) {
                if (GraphIdentityGuard.REASON.equals(outcome.reason()))
                    FileAnalysisOutcome.record(jdbc, snapshotId, outcome.path(), outcome.status(), outcome.reason());
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
                            file_id = case when excluded.node_type = 'AMBIGUOUS' then null else coalesce(excluded.file_id, graph_nodes.file_id) end,
                            line_start = case when excluded.node_type = 'AMBIGUOUS' then null else coalesce(excluded.line_start, graph_nodes.line_start) end,
                            line_end = case when excluded.node_type = 'AMBIGUOUS' then null else coalesce(excluded.line_end, graph_nodes.line_end) end,
                            area_type = coalesce(excluded.area_type, graph_nodes.area_type),
                            metadata = case when excluded.node_type = 'AMBIGUOUS' then excluded.metadata else graph_nodes.metadata || excluded.metadata end
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
                        where snapshot_id = :snapshotId and natural_key = :naturalKey and node_type <> 'AMBIGUOUS'
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

    @SuppressWarnings("unchecked")
    private Map<String, Object> readMetadata(String raw) {
        return raw == null ? Map.of() : jsonMapper.readValue(raw, LinkedHashMap.class);
    }

    private String toJson(Map<String, Object> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return "{}";
        }
        return jsonMapper.writeValueAsString(metadata);
    }
}
