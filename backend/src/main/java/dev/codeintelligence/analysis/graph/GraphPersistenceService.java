package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphIdentityGuard;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.common.CustomPlans;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

@Service
public class GraphPersistenceService {

    /** Rows per JDBC batch or IN list: one round trip each instead of one per row. */
    static final int BATCH = 500;

    private static final String UPSERT_NODE = """
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
            """;

    private final JdbcClient jdbc;
    private final NamedParameterJdbcTemplate batches;
    private final TransactionTemplate transactionTemplate;
    private final EvidenceService evidenceService;
    private final JsonMapper jsonMapper;

    public GraphPersistenceService(
            JdbcClient jdbc,
            NamedParameterJdbcTemplate batches,
            TransactionTemplate transactionTemplate,
            EvidenceService evidenceService,
            JsonMapper jsonMapper) {
        this.jdbc = jdbc;
        this.batches = batches;
        this.transactionTemplate = transactionTemplate;
        this.evidenceService = evidenceService;
        this.jsonMapper = jsonMapper;
    }

    public void persist(long projectId, long snapshotId, AnalysisResult result) {
        transactionTemplate.executeWithoutResult(tx -> {
            List<String> keys = result.nodes().stream()
                    .map(GraphNodeDraft::naturalKey)
                    .distinct()
                    .toList();
            List<GraphNodeDraft> candidates = CustomPlans.run(jdbc, () -> storedDrafts(snapshotId, keys));
            candidates.addAll(result.nodes());
            AnalysisResult safe = GraphIdentityGuard.sanitize(
                    new AnalysisResult(candidates, result.edges(), result.evidences(), result.fileOutcomes()));
            var refreshedRoutes = result.nodes().stream()
                    .filter(node -> "FE_ROUTE".equals(node.nodeType())
                            && node.metadata().containsKey("componentResolution"))
                    .map(GraphNodeDraft::naturalKey)
                    .collect(java.util.stream.Collectors.toSet());
            var clearedRoutes = new java.util.HashSet<String>();
            Map<String, Long> fileIds = CustomPlans.run(jdbc, () -> fileIds(snapshotId, safe.nodes()));
            List<Long> nodeIds = upsertNodes(snapshotId, safe.nodes(), fileIds);
            Map<String, List<AnalyzerEvidence>> evidenceByKey = new HashMap<>();
            for (AnalyzerEvidence evidence : safe.evidences()) {
                if (evidence.subjectNaturalKey() != null)
                    evidenceByKey
                            .computeIfAbsent(evidence.subjectNaturalKey(), key -> new ArrayList<>())
                            .add(evidence);
            }
            Map<String, Long> ids = new LinkedHashMap<>();
            Map<Long, List<NewEvidence>> replacedEvidence = new LinkedHashMap<>();
            for (int index = 0; index < safe.nodes().size(); index++) {
                GraphNodeDraft node = safe.nodes().get(index);
                long id = nodeIds.get(index);
                if (refreshedRoutes.contains(node.naturalKey()) && clearedRoutes.add(node.naturalKey())) {
                    // An explicit re-analysis is authoritative for this route's binding.
                    // Remove stale structural/API propagation in the same transaction,
                    // including when the new result is UNRESOLVED. Other snapshots and
                    // incoming file provenance are not part of this replacement.
                    jdbc.sql("""
                            delete from graph_edges e using graph_nodes t
                            where e.snapshot_id=:snapshot and e.source_node_id=:route
                              and t.id=e.target_node_id and t.snapshot_id=:snapshot
                              and ((e.edge_type='CONTAINS' and t.node_type='COMPONENT')
                                or (e.edge_type='CONSUMES' and t.node_type='API_ENDPOINT'))
                            """)
                            .param("snapshot", snapshotId)
                            .param("route", id)
                            .update();
                }
                if (GraphIdentityGuard.ambiguous(node)) {
                    jdbc.sql(
                                    "delete from graph_edges where snapshot_id = :snapshotId and (source_node_id = :id or target_node_id = :id)")
                            .param("snapshotId", snapshotId)
                            .param("id", id)
                            .update();
                    replacedEvidence.put(id, List.of());
                } else {
                    ids.put(node.naturalKey(), id);
                    List<NewEvidence> linked = nodeEvidence(evidenceByKey.get(node.naturalKey()));
                    if (!linked.isEmpty()) replacedEvidence.put(id, linked);
                }
            }
            evidenceService.replaceLinkedAll(projectId, EvidenceSubjects.GRAPH_NODE, replacedEvidence);
            Map<String, Long> stored = CustomPlans.run(jdbc, () -> storedNodeIds(snapshotId, ids, safe.edges()));
            List<SqlParameterSource> edgeRows = new ArrayList<>();
            for (GraphEdgeDraft edge : safe.edges()) {
                Long source = ids.getOrDefault(edge.sourceNaturalKey(), stored.get(edge.sourceNaturalKey()));
                Long target = ids.getOrDefault(edge.targetNaturalKey(), stored.get(edge.targetNaturalKey()));
                if (source == null || target == null || source.equals(target)) {
                    continue;
                }
                edgeRows.add(edgeRow(snapshotId, source, target, edge));
            }
            upsertEdges(edgeRows);
            FileAnalysisOutcome.recordAll(
                    jdbc,
                    snapshotId,
                    safe.fileOutcomes().stream().filter(outcome -> GraphIdentityGuard.REASON.equals(outcome.reason()))
                            ::iterator);
        });
    }

    /** Rows this snapshot already stores for the given keys, merged with the new drafts by the guard. */
    private List<GraphNodeDraft> storedDrafts(long snapshotId, List<String> keys) {
        List<GraphNodeDraft> stored = new ArrayList<>();
        for (int start = 0; start < keys.size(); start += BATCH) {
            stored.addAll(jdbc.sql("""
                            select n.node_type, n.natural_key, n.name, f.path, n.line_start, n.line_end, n.area_type, n.metadata::text as metadata
                            from graph_nodes n left join files f on f.id = n.file_id and f.snapshot_id = n.snapshot_id
                            where n.snapshot_id = :snapshotId and n.natural_key in (:keys)
                            """)
                    .param("snapshotId", snapshotId)
                    .param("keys", keys.subList(start, Math.min(start + BATCH, keys.size())))
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
        return stored;
    }

    /** Upserts in input order (later duplicates merge into earlier rows) and returns each row's id. */
    private List<Long> upsertNodes(long snapshotId, List<GraphNodeDraft> nodes, Map<String, Long> fileIds) {
        List<Long> ids = new ArrayList<>(nodes.size());
        for (int start = 0; start < nodes.size(); start += BATCH) {
            List<GraphNodeDraft> chunk = nodes.subList(start, Math.min(start + BATCH, nodes.size()));
            SqlParameterSource[] rows = chunk.stream()
                    .map(node -> new MapSqlParameterSource()
                            .addValue("snapshotId", snapshotId)
                            .addValue("nodeType", node.nodeType())
                            .addValue("naturalKey", node.naturalKey())
                            .addValue("name", node.name())
                            .addValue("fileId", node.filePath() == null ? null : fileIds.get(node.filePath()))
                            .addValue("lineStart", node.lineStart())
                            .addValue("lineEnd", node.lineEnd())
                            .addValue("areaType", node.areaType())
                            .addValue("metadata", toJson(node.metadata())))
                    .toArray(SqlParameterSource[]::new);
            GeneratedKeyHolder keys = new GeneratedKeyHolder();
            batches.batchUpdate(UPSERT_NODE, rows, keys, new String[] {"id"});
            List<Map<String, Object>> returned = keys.getKeyList();
            if (returned.size() != chunk.size()) {
                throw new IllegalStateException(
                        "graph node upsert returned " + returned.size() + " ids for " + chunk.size() + " rows");
            }
            for (Map<String, Object> key : returned) ids.add(((Number) key.get("id")).longValue());
        }
        return ids;
    }

    private SqlParameterSource edgeRow(long snapshotId, long sourceId, long targetId, GraphEdgeDraft edge) {
        return new MapSqlParameterSource()
                .addValue("snapshotId", snapshotId)
                .addValue("sourceId", sourceId)
                .addValue("targetId", targetId)
                .addValue("edgeType", edge.edgeType())
                .addValue("confidence", edge.confidence())
                .addValue("metadata", toJson(edge.metadata()));
    }

    private void upsertEdges(List<SqlParameterSource> rows) {
        for (int start = 0; start < rows.size(); start += BATCH) {
            batches.batchUpdate(
                    """
                            insert into graph_edges (
                                snapshot_id, source_node_id, target_node_id, edge_type, confidence, metadata)
                            values (
                                :snapshotId, :sourceId, :targetId, :edgeType, :confidence, cast(:metadata as jsonb))
                            on conflict (snapshot_id, source_node_id, target_node_id, edge_type) do update set
                                confidence = excluded.confidence,
                                metadata = excluded.metadata
                            """,
                    rows.subList(start, Math.min(start + BATCH, rows.size())).toArray(SqlParameterSource[]::new));
        }
    }

    /** File ids by the drafts' own path spelling; one query instead of one per node. */
    private Map<String, Long> fileIds(long snapshotId, List<GraphNodeDraft> nodes) {
        Map<String, String> wanted = new HashMap<>();
        for (GraphNodeDraft node : nodes) {
            if (node.filePath() != null && !node.filePath().isBlank())
                wanted.put(node.filePath(), node.filePath().replace('\\', '/'));
        }
        if (wanted.isEmpty()) {
            return Map.of();
        }
        List<String> paths = List.copyOf(new LinkedHashSet<>(wanted.values()));
        Map<String, Long> byPath = new HashMap<>();
        for (int start = 0; start < paths.size(); start += BATCH) {
            jdbc.sql("select path, id from files where snapshot_id = :snapshotId and path in (:paths)")
                    .param("snapshotId", snapshotId)
                    .param("paths", paths.subList(start, Math.min(start + BATCH, paths.size())))
                    .query((rs, row) -> byPath.put(rs.getString("path"), rs.getLong("id")))
                    .list();
        }
        Map<String, Long> result = new HashMap<>();
        wanted.forEach((draftPath, path) -> {
            Long id = byPath.get(path);
            if (id != null) result.put(draftPath, id);
        });
        return result;
    }

    /** Ids of edge endpoints that this result did not upsert (other steps' nodes). */
    private Map<String, Long> storedNodeIds(long snapshotId, Map<String, Long> ids, List<GraphEdgeDraft> edges) {
        Set<String> missing = new LinkedHashSet<>();
        for (GraphEdgeDraft edge : edges) {
            if (!ids.containsKey(edge.sourceNaturalKey())) missing.add(edge.sourceNaturalKey());
            if (!ids.containsKey(edge.targetNaturalKey())) missing.add(edge.targetNaturalKey());
        }
        List<String> keys = List.copyOf(missing);
        Map<String, Long> stored = new HashMap<>();
        for (int start = 0; start < keys.size(); start += BATCH) {
            jdbc.sql("""
                            select natural_key, id from graph_nodes
                            where snapshot_id = :snapshotId and natural_key in (:keys) and node_type <> 'AMBIGUOUS'
                            """)
                    .param("snapshotId", snapshotId)
                    .param("keys", keys.subList(start, Math.min(start + BATCH, keys.size())))
                    .query((rs, row) -> stored.put(rs.getString("natural_key"), rs.getLong("id")))
                    .list();
        }
        return stored;
    }

    private static List<NewEvidence> nodeEvidence(List<AnalyzerEvidence> evidences) {
        if (evidences == null) {
            return List.of();
        }
        return evidences.stream()
                .map(evidence -> new NewEvidence(
                        evidence.kind(),
                        evidence.filePath(),
                        evidence.lineStart(),
                        evidence.lineEnd(),
                        evidence.excerpt()))
                .toList();
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
