package dev.codeintelligence.analysis.feature;

import dev.codeintelligence.analysis.graph.AreaPathTagger;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Static feature clustering (§12.1): endpoint path prefix + Java package seeds, Jaccard merge,
 * then CALLS-depth links. UI role linking is Phase 2.
 */
@Component
@Order(FeatureDetectionStep.ORDER)
public class FeatureDetectionStep implements JobStep {

    public static final String KEY = "FEATURE_DETECTION";
    public static final int ORDER = 900;

    /** Feature links per JDBC batch: one round trip each instead of one per link. */
    private static final int BATCH = 500;

    private final JdbcClient jdbc;
    private final NamedParameterJdbcTemplate batches;
    private final TransactionTemplate transactionTemplate;
    private final EvidenceService evidenceService;
    private final AnalysisProperties analysisProperties;

    public FeatureDetectionStep(
            JdbcClient jdbc,
            NamedParameterJdbcTemplate batches,
            TransactionTemplate transactionTemplate,
            EvidenceService evidenceService,
            AnalysisProperties analysisProperties) {
        this.jdbc = jdbc;
        this.batches = batches;
        this.transactionTemplate = transactionTemplate;
        this.evidenceService = evidenceService;
        this.analysisProperties = analysisProperties;
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
        List<EndpointRow> endpoints = loadEndpoints(snapshotId);
        List<TypeRow> types = loadBackendTypes(snapshotId);
        List<FeatureMerger.Seed> seeds = new ArrayList<>();
        seeds.addAll(endpointSeeds(endpoints));
        seeds.addAll(routeSeeds(snapshotId));
        seeds.addAll(packageSeeds(types));
        List<FeatureMerger.Seed> merged = FeatureMerger.dropUnmergedPackageSeeds(
                FeatureMerger.merge(seeds, analysisProperties.featureMergeThreshold()));
        ctx.updateProgress(45);
        FeatureLinkBuilder linker = new FeatureLinkBuilder(loadNodes(snapshotId), loadEdges(snapshotId));
        transactionTemplate.executeWithoutResult(tx -> {
            jdbc.sql("""
                            delete from evidences e
                            where e.id in (
                                select el.evidence_id
                                from evidence_links el
                                join features f on f.id = el.subject_id
                                where el.subject_type = 'FEATURE' and f.snapshot_id = :snapshotId
                            )
                            """).param("snapshotId", snapshotId).update();
            jdbc.sql("delete from features where snapshot_id = :snapshotId")
                    .param("snapshotId", snapshotId)
                    .update();
            for (FeatureMerger.Seed seed : merged) {
                persistFeature(ctx.projectId(), snapshotId, seed, linker, endpoints);
            }
        });
        ctx.updateProgress(100);
    }

    private void persistFeature(
            long projectId,
            long snapshotId,
            FeatureMerger.Seed seed,
            FeatureLinkBuilder linker,
            List<EndpointRow> endpoints) {
        double confidence = seed.endpointDerived() ? 1.0 : 0.7;
        long featureId = jdbc.sql("""
                        insert into features (snapshot_id, name, description, parent_id, detection, confidence)
                        values (:snapshotId, :name, :description, null, 'STATIC', :confidence)
                        returning id
                        """)
                .param("snapshotId", snapshotId)
                .param("name", seed.name())
                .param("description", seed.endpointDerived() ? "/" + seed.name() + "/*" : seed.name())
                .param("confidence", confidence)
                .query(Long.class)
                .single();
        List<SqlParameterSource> links = linker.linksFor(seed.nodeKeys()).stream()
                .map(link -> (SqlParameterSource) new MapSqlParameterSource()
                        .addValue("featureId", featureId)
                        .addValue("nodeId", link.nodeId())
                        .addValue("role", link.role()))
                .toList();
        for (int start = 0; start < links.size(); start += BATCH) {
            batches.batchUpdate(
                    """
                            insert into feature_links (feature_id, node_id, role)
                            values (:featureId, :nodeId, :role)
                            on conflict (feature_id, node_id) do update set role = excluded.role
                            """,
                    links.subList(start, Math.min(start + BATCH, links.size())).toArray(SqlParameterSource[]::new));
        }
        List<NewEvidence> evidences = new ArrayList<>();
        for (EndpointRow endpoint : endpoints) {
            if (seed.nodeKeys().contains(endpoint.naturalKey()) && endpoint.filePath() != null) {
                evidences.add(new NewEvidence(
                        EvidenceKind.FILE_LINE,
                        endpoint.filePath(),
                        endpoint.lineStart(),
                        endpoint.lineStart(),
                        endpoint.httpMethod() + " " + endpoint.path()));
            }
        }
        evidenceService.replaceLinkedAll(projectId, EvidenceSubjects.FEATURE, Map.of(featureId, evidences));
    }

    private List<FeatureMerger.Seed> endpointSeeds(List<EndpointRow> endpoints) {
        Map<String, Set<String>> grouped = new LinkedHashMap<>();
        for (EndpointRow endpoint : endpoints) {
            String prefix = pathPrefix(endpoint.path());
            if (prefix == null) {
                continue;
            }
            grouped.computeIfAbsent(prefix, key -> new LinkedHashSet<>()).add(endpoint.naturalKey());
        }
        List<FeatureMerger.Seed> seeds = new ArrayList<>();
        for (Map.Entry<String, Set<String>> entry : grouped.entrySet()) {
            seeds.add(new FeatureMerger.Seed(entry.getKey(), entry.getValue(), true));
        }
        return seeds;
    }

    private List<FeatureMerger.Seed> routeSeeds(long snapshotId) {
        List<EndpointRow> routes = jdbc.sql("""
                        select n.natural_key, n.name, 'GET' as http_method, r.path, f.path as file_path, n.line_start
                        from frontend_routes r
                        join graph_nodes n on n.id = r.node_id
                        left join files f on f.id = n.file_id
                        where r.snapshot_id = :snapshotId
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new EndpointRow(
                        rs.getString("natural_key"),
                        rs.getString("http_method"),
                        rs.getString("path"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start")))
                .list();
        return endpointSeeds(routes.stream()
                .filter(route -> !"TESTING".equals(AreaPathTagger.tag(route.filePath())))
                .toList());
    }

    private List<FeatureMerger.Seed> packageSeeds(List<TypeRow> types) {
        Map<String, Set<String>> grouped = new LinkedHashMap<>();
        for (TypeRow type : types) {
            String cluster = packageCluster(type.naturalKey());
            if (cluster == null) {
                continue;
            }
            grouped.computeIfAbsent(cluster, key -> new LinkedHashSet<>()).add(type.naturalKey());
        }
        List<FeatureMerger.Seed> seeds = new ArrayList<>();
        for (Map.Entry<String, Set<String>> entry : grouped.entrySet()) {
            seeds.add(new FeatureMerger.Seed(entry.getKey(), entry.getValue(), false));
        }
        return seeds;
    }

    static String pathPrefix(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }
        String normalized = path.startsWith("/") ? path.substring(1) : path;
        int slash = normalized.indexOf('/');
        String first = slash < 0 ? normalized : normalized.substring(0, slash);
        if (first.isBlank() || first.startsWith("{")) {
            return null;
        }
        return first.toLowerCase(Locale.ROOT);
    }

    static String packageCluster(String naturalKey) {
        if (naturalKey == null || !naturalKey.startsWith("java:")) {
            return null;
        }
        String fqcn = naturalKey.substring("java:".length());
        int lastDot = fqcn.lastIndexOf('.');
        if (lastDot <= 0) {
            return null;
        }
        String pkg = fqcn.substring(0, lastDot);
        String[] parts = pkg.split("\\.");
        int index = 0;
        if (parts.length >= 2 && isVendorPrefix(parts[0])) {
            index = 2;
        }
        if (index >= parts.length) {
            return parts[parts.length - 1].toLowerCase(Locale.ROOT);
        }
        return parts[index].toLowerCase(Locale.ROOT);
    }

    private static boolean isVendorPrefix(String part) {
        return switch (part) {
            case "com", "org", "net", "io" -> true;
            default -> false;
        };
    }

    private List<EndpointRow> loadEndpoints(long snapshotId) {
        return jdbc
                .sql("""
                        select n.natural_key, n.name, e.http_method, e.path, f.path as file_path, n.line_start
                        from api_endpoints e
                        join graph_nodes n on n.id = e.node_id
                        left join files f on f.id = n.file_id
                        where e.snapshot_id = :snapshotId
                        order by e.path, e.http_method
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new EndpointRow(
                        rs.getString("natural_key"),
                        rs.getString("http_method"),
                        rs.getString("path"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start")))
                .list()
                .stream()
                .filter(endpoint -> !"TESTING".equals(AreaPathTagger.tag(endpoint.filePath())))
                .toList();
    }

    private List<TypeRow> loadBackendTypes(long snapshotId) {
        return jdbc.sql("""
                        select n.natural_key
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and n.node_type in ('CLASS', 'INTERFACE')
                          and f.path like '%src/main/java%'
                          and f.path not like '%src/test%'
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new TypeRow(rs.getString("natural_key")))
                .list();
    }

    private List<FeatureLinkBuilder.GraphNode> loadNodes(long snapshotId) {
        return jdbc
                .sql("""
                        select n.id, n.node_type, n.natural_key, n.name, f.path as file_path,
                               n.metadata->>'layer' as layer
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new FeatureLinkBuilder.GraphNode(
                        rs.getLong("id"),
                        rs.getString("node_type"),
                        rs.getString("natural_key"),
                        rs.getString("name"),
                        rs.getString("file_path"),
                        rs.getString("layer")))
                .list()
                .stream()
                .filter(node -> !"TESTING".equals(AreaPathTagger.tag(node.filePath())))
                .toList();
    }

    private List<FeatureLinkBuilder.GraphEdge> loadEdges(long snapshotId) {
        return jdbc.sql("""
                        select source_node_id, target_node_id, edge_type
                        from graph_edges
                        where snapshot_id = :snapshotId
                          and edge_type in ('CALLS', 'EXPOSES', 'DECLARES', 'USES_TYPE', 'CONSUMES', 'MAPS_TO')
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new FeatureLinkBuilder.GraphEdge(
                        rs.getLong("source_node_id"), rs.getLong("target_node_id"), rs.getString("edge_type")))
                .list();
    }

    private record EndpointRow(String naturalKey, String httpMethod, String path, String filePath, Integer lineStart) {}

    private record TypeRow(String naturalKey) {}
}
