package dev.codeintelligence.analysis.config;

import dev.codeintelligence.analysis.area.AreaType;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeType;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.evidence.EvidenceKind;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * {@code application*.yml} datasource/redis/kafka settings → CONFIG nodes plus CONFIGURED_BY
 * evidence (§10.3).
 */
@Component
public class YamlConfigAnalyzer implements CodeAnalyzer {

    private static final Pattern JDBC_HOST = Pattern.compile("jdbc:([^:]+):(?://)?([^:/]+)");

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(file -> isApplicationYaml(file.path()));
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        GraphCollector collector = new GraphCollector();
        for (InventoriedFile file : ctx.inventory().files()) {
            if (!isApplicationYaml(file.path())) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text == null) {
                continue;
            }
            try {
                parseApplication(file.path(), text, collector);
            } catch (RuntimeException e) {
                collector.evidence(new AnalyzerEvidence(
                        null,
                        EvidenceKind.FILE_LINE,
                        file.path(),
                        1,
                        1,
                        "YAML config parse failed: " + ConfigFileSupport.sanitize(e.getMessage(), ctx.clonePath())));
            }
        }
        return collector.toResult();
    }

    static boolean isApplicationYaml(String path) {
        String name = ConfigFileSupport.filename(path).toLowerCase(Locale.ROOT);
        return name.startsWith("application") && (name.endsWith(".yml") || name.endsWith(".yaml"));
    }

    private void parseApplication(String path, String text, GraphCollector collector) {
        String key = NaturalKeys.config(path);
        Map<String, Object> metadata = new LinkedHashMap<>();
        List<String> configured = new ArrayList<>();
        for (Object doc : YamlSupport.loadDocuments(text)) {
            Map<String, Object> root = YamlSupport.asMap(doc);
            Object datasource =
                    first(YamlSupport.nested(root, "spring", "datasource"), YamlSupport.nested(root, "datasource"));
            if (datasource != null) {
                configured.add("datasource");
                Map<String, Object> ds = YamlSupport.asMap(datasource);
                Object url = ds.get("url");
                if (url != null) {
                    metadata.put("datasourceUrl", String.valueOf(url));
                    maybeLinkContainer(collector, key, String.valueOf(url));
                }
                int line = ConfigFileSupport.lineOf(text, "datasource");
                collector.evidence(new AnalyzerEvidence(
                        key, EvidenceKind.CONFIG, path, line, line, ConfigFileSupport.excerpt("spring.datasource")));
            }
            Object redis = first(
                    YamlSupport.nested(root, "spring", "data", "redis"),
                    YamlSupport.nested(root, "spring", "redis"),
                    YamlSupport.nested(root, "redis"));
            if (redis != null) {
                configured.add("redis");
                Map<String, Object> redisMap = YamlSupport.asMap(redis);
                if (redisMap.get("host") != null) {
                    metadata.put("redisHost", String.valueOf(redisMap.get("host")));
                }
                int line = ConfigFileSupport.lineOf(text, "redis");
                collector.evidence(new AnalyzerEvidence(
                        key, EvidenceKind.CONFIG, path, line, line, ConfigFileSupport.excerpt("spring.data.redis")));
                collector.edge(
                        key, NaturalKeys.container("redis"), GraphEdgeType.CONFIGURED_BY, EdgeConfidence.POSSIBLE);
            }
            Object kafka = first(YamlSupport.nested(root, "spring", "kafka"), YamlSupport.nested(root, "kafka"));
            if (kafka != null) {
                configured.add("kafka");
                int line = ConfigFileSupport.lineOf(text, "kafka");
                collector.evidence(new AnalyzerEvidence(
                        key, EvidenceKind.CONFIG, path, line, line, ConfigFileSupport.excerpt("spring.kafka")));
            }
        }
        if (!configured.isEmpty()) {
            metadata.put("configured", configured);
        }
        collector.put(GraphNodeDraft.of(
                        GraphNodeType.CONFIG,
                        key,
                        ConfigFileSupport.filename(path),
                        path,
                        1,
                        ConfigFileSupport.lineCount(text))
                .withAreaType(AreaType.BACKEND.name())
                .withMetadata(metadata));
        collector.evidence(new AnalyzerEvidence(key, EvidenceKind.CONFIG, path, 1, 1, ConfigFileSupport.excerpt(text)));
    }

    private void maybeLinkContainer(GraphCollector collector, String configKey, String jdbcUrl) {
        Matcher matcher = JDBC_HOST.matcher(jdbcUrl);
        if (!matcher.find()) {
            return;
        }
        String engine = matcher.group(1);
        String host = matcher.group(2);
        String service =
                "postgresql".equalsIgnoreCase(engine) || "postgres".equalsIgnoreCase(engine) ? "postgres" : engine;
        if ("localhost".equals(host) || "127.0.0.1".equals(host) || service.equalsIgnoreCase(host)) {
            collector.edge(
                    configKey, NaturalKeys.container(service), GraphEdgeType.CONFIGURED_BY, EdgeConfidence.POSSIBLE);
        }
    }

    @SafeVarargs
    private static Object first(Object... values) {
        for (Object value : values) {
            if (value != null) {
                return value;
            }
        }
        return null;
    }
}
