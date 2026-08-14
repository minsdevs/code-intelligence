package dev.codeintelligence.analysis.cross;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphEdgeType;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.analysis.graph.GraphPersistenceService;
import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

@Component
@Order(CrossDomainStep.ORDER)
public class CrossDomainStep implements JobStep {

    public static final String KEY = "CROSS_DOMAIN";
    public static final int ORDER = 850;

    private final JdbcClient jdbc;
    private final GraphPersistenceService persistence;
    private final JsonMapper jsonMapper;

    public CrossDomainStep(JdbcClient jdbc, GraphPersistenceService persistence, JsonMapper jsonMapper) {
        this.jdbc = jdbc;
        this.persistence = persistence;
        this.jsonMapper = jsonMapper;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        ctx.updateProgress(15);
        List<GraphEdgeDraft> edges = new ArrayList<>();
        List<AnalyzerEvidence> evidences = new ArrayList<>();
        linkConsumes(snapshotId, edges, evidences);
        ctx.updateProgress(45);
        linkMapsTo(snapshotId, edges, evidences);
        ctx.updateProgress(70);
        linkReadsWrites(snapshotId, edges);
        persistence.persist(ctx.projectId(), snapshotId, new AnalysisResult(List.of(), edges, evidences));
        ctx.updateProgress(100);
    }

    private void linkConsumes(long snapshotId, List<GraphEdgeDraft> edges, List<AnalyzerEvidence> evidences) {
        List<Endpoint> endpoints = jdbc.sql("""
                        select n.natural_key, e.http_method, e.path
                        from api_endpoints e
                        join graph_nodes n on n.id = e.node_id
                        where e.snapshot_id = :snapshotId
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) ->
                        new Endpoint(rs.getString("natural_key"), rs.getString("http_method"), rs.getString("path")))
                .list();
        List<Caller> callers = jdbc.sql("""
                        select natural_key, name, file_id, line_start, metadata::text as metadata
                        from graph_nodes
                        where snapshot_id = :snapshotId
                          and node_type in ('COMPONENT', 'HOOK')
                          and jsonb_exists(metadata, 'apiCalls')
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new Caller(
                        rs.getString("natural_key"), rs.getString("name"), rs.getString("metadata"), (Integer)
                                rs.getObject("line_start")))
                .list();
        for (Caller caller : callers) {
            for (ApiCall call : parseCalls(caller.metadataJson())) {
                Match best = null;
                for (Endpoint endpoint : endpoints) {
                    EdgeConfidence confidence =
                            EndpointPathMatcher.match(call.method(), call.url(), endpoint.method(), endpoint.path());
                    if (confidence == null) {
                        continue;
                    }
                    if (best == null || rank(confidence) > rank(best.confidence())) {
                        best = new Match(endpoint.naturalKey(), confidence, call);
                    }
                }
                if (best == null) {
                    continue;
                }
                edges.add(GraphEdgeDraft.of(
                        caller.naturalKey(), best.endpointKey(), GraphEdgeType.CONSUMES, best.confidence()));
                evidences.add(new AnalyzerEvidence(
                        caller.naturalKey(),
                        EvidenceKind.FILE_LINE,
                        null,
                        best.call().lineStart(),
                        best.call().lineStart(),
                        best.call().method() + " " + best.call().url() + " -> " + best.endpointKey()));
            }
        }
        List<Route> routes = jdbc.sql("""
                        select n.natural_key, r.component_key
                        from frontend_routes r
                        join graph_nodes n on n.id = r.node_id
                        where r.snapshot_id = :snapshotId
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new Route(rs.getString("natural_key"), rs.getString("component_key")))
                .list();
        Map<String, String> componentKeys = new LinkedHashMap<>();
        jdbc.sql("""
                        select name, natural_key from graph_nodes
                        where snapshot_id = :snapshotId and node_type = 'COMPONENT'
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> {
                    componentKeys.put(rs.getString("name"), rs.getString("natural_key"));
                    return 0;
                })
                .list();
        for (Route route : routes) {
            if (route.componentKey() == null) {
                continue;
            }
            String componentNatural = componentKeys.get(route.componentKey());
            if (componentNatural == null) {
                continue;
            }
            for (GraphEdgeDraft edge : List.copyOf(edges)) {
                if (GraphEdgeType.CONSUMES.name().equals(edge.edgeType())
                        && componentNatural.equals(edge.sourceNaturalKey())) {
                    edges.add(GraphEdgeDraft.of(
                            route.naturalKey(),
                            edge.targetNaturalKey(),
                            GraphEdgeType.CONSUMES,
                            EdgeConfidence.valueOf(edge.confidence())));
                }
            }
        }
    }

    private void linkMapsTo(long snapshotId, List<GraphEdgeDraft> edges, List<AnalyzerEvidence> evidences) {
        List<Entity> entities = jdbc.sql("""
                        select n.natural_key, d.table_name, n.name, f.path as file_path, n.line_start
                        from db_entities d
                        join graph_nodes n on n.id = d.node_id
                        left join files f on f.id = n.file_id
                        where d.snapshot_id = :snapshotId
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new Entity(
                        rs.getString("natural_key"), rs.getString("table_name"), rs.getString("file_path"), (Integer)
                                rs.getObject("line_start")))
                .list();
        List<String> tables = jdbc.sql("""
                        select natural_key, lower(name) as name
                        from graph_nodes
                        where snapshot_id = :snapshotId and node_type = 'DB_TABLE'
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> rs.getString("natural_key") + "\t" + rs.getString("name"))
                .list();
        Map<String, String> tableByName = new LinkedHashMap<>();
        for (String row : tables) {
            String[] parts = row.split("\t", 2);
            tableByName.put(parts[1], parts[0]);
        }
        for (Entity entity : entities) {
            String tableKey = tableByName.get(entity.tableName().toLowerCase(Locale.ROOT));
            if (tableKey == null) {
                tableKey = NaturalKeys.table(entity.tableName());
                if (!tableByName.containsValue(tableKey)) {
                    continue;
                }
            }
            edges.add(
                    GraphEdgeDraft.of(entity.naturalKey(), tableKey, GraphEdgeType.MAPS_TO, EdgeConfidence.CONFIRMED));
            evidences.add(new AnalyzerEvidence(
                    entity.naturalKey(),
                    EvidenceKind.FILE_LINE,
                    entity.filePath(),
                    entity.lineStart(),
                    entity.lineStart(),
                    "MAPS_TO " + entity.tableName()));
        }
    }

    private void linkReadsWrites(long snapshotId, List<GraphEdgeDraft> edges) {
        List<Repo> repos = jdbc.sql("""
                        select n.natural_key, n.name
                        from graph_nodes n
                        where n.snapshot_id = :snapshotId
                          and n.metadata->>'layer' = 'REPOSITORY'
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new Repo(rs.getString("natural_key"), rs.getString("name")))
                .list();
        List<Entity> entities = jdbc.sql("""
                        select n.natural_key, d.table_name, n.name as entity_name
                        from db_entities d
                        join graph_nodes n on n.id = d.node_id
                        where d.snapshot_id = :snapshotId
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new Entity(rs.getString("natural_key"), rs.getString("table_name"), null, null))
                .list();
        for (Repo repo : repos) {
            String stem = repo.name().replaceAll("Repository$", "");
            for (Entity entity : entities) {
                if (!stem.equalsIgnoreCase(simpleName(entity.naturalKey()))
                        && !repo.name()
                                .toLowerCase(Locale.ROOT)
                                .contains(entity.tableName().toLowerCase(Locale.ROOT))) {
                    continue;
                }
                edges.add(GraphEdgeDraft.of(
                        repo.naturalKey(),
                        NaturalKeys.table(entity.tableName()),
                        GraphEdgeType.READS_WRITES,
                        EdgeConfidence.LIKELY));
            }
        }
    }

    private List<ApiCall> parseCalls(String metadataJson) {
        if (metadataJson == null || metadataJson.isBlank()) {
            return List.of();
        }
        Map<?, ?> metadata = jsonMapper.readValue(metadataJson, Map.class);
        Object raw = metadata.get("apiCalls");
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        List<ApiCall> calls = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> map)) {
                continue;
            }
            Object method = map.get("method");
            Object url = map.get("url");
            Object line = map.get("lineStart");
            if (method == null || url == null) {
                continue;
            }
            Integer lineStart = line instanceof Number number ? number.intValue() : null;
            calls.add(new ApiCall(String.valueOf(method), String.valueOf(url), lineStart));
        }
        return calls;
    }

    private static int rank(EdgeConfidence confidence) {
        return switch (confidence) {
            case CONFIRMED -> 3;
            case LIKELY -> 2;
            case POSSIBLE -> 1;
        };
    }

    private static String simpleName(String naturalKey) {
        int slash = naturalKey.lastIndexOf('.');
        return slash < 0 ? naturalKey : naturalKey.substring(slash + 1);
    }

    private record Endpoint(String naturalKey, String method, String path) {}

    private record Caller(String naturalKey, String name, String metadataJson, Integer lineStart) {}

    private record ApiCall(String method, String url, Integer lineStart) {}

    private record Match(String endpointKey, EdgeConfidence confidence, ApiCall call) {}

    private record Route(String naturalKey, String componentKey) {}

    private record Entity(String naturalKey, String tableName, String filePath, Integer lineStart) {}

    private record Repo(String naturalKey, String name) {}
}
