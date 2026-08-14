package dev.codeintelligence.analysis.config;

import dev.codeintelligence.analysis.area.AreaType;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.evidence.EvidenceKind;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** {@code vercel.json} → CLOUD_RESOURCE nodes for crons and rewrites (§10.3). */
@Component
public class VercelAnalyzer implements CodeAnalyzer {

    private final JsonMapper jsonMapper = JsonMapper.builder().build();

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(file -> isVercelConfig(file.path()));
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        GraphCollector collector = new GraphCollector();
        for (InventoriedFile file : ctx.inventory().files()) {
            if (!isVercelConfig(file.path())) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text == null) {
                continue;
            }
            Map<String, Object> root = parseJson(text);
            if (root == null) {
                collector.evidence(new AnalyzerEvidence(
                        null, EvidenceKind.FILE_LINE, file.path(), 1, 1, "vercel.json is not valid JSON"));
                continue;
            }
            collector.put(new GraphNodeDraft(
                    GraphNodeType.CONFIG.name(),
                    NaturalKeys.config(file.path()),
                    "vercel.json",
                    file.path(),
                    1,
                    null,
                    AreaType.INFRASTRUCTURE.name(),
                    Map.of("provider", "vercel")));
            Object crons = root.get("crons");
            if (crons instanceof List<?> list) {
                for (Object item : list) {
                    if (!(item instanceof Map<?, ?> cron)) {
                        continue;
                    }
                    Object path = cron.get("path");
                    Object schedule = cron.get("schedule");
                    String name = "cron " + (path == null ? "" : path);
                    String key = NaturalKeys.cloud("vercel", "cron:" + (path == null ? "unknown" : path));
                    Map<String, Object> metadata = new java.util.LinkedHashMap<>();
                    metadata.put("provider", "vercel");
                    metadata.put("kind", "cron");
                    if (schedule != null) {
                        metadata.put("schedule", String.valueOf(schedule));
                    }
                    collector.put(new GraphNodeDraft(
                            GraphNodeType.CLOUD_RESOURCE.name(),
                            key,
                            name,
                            file.path(),
                            ConfigFileSupport.lineOf(text, String.valueOf(path)),
                            null,
                            AreaType.INFRASTRUCTURE.name(),
                            metadata));
                    collector.evidence(new AnalyzerEvidence(
                            key,
                            EvidenceKind.FILE_LINE,
                            file.path(),
                            ConfigFileSupport.lineOf(text, String.valueOf(path)),
                            ConfigFileSupport.lineOf(text, String.valueOf(path)),
                            "cron " + path));
                }
            }
        }
        return collector.toResult();
    }

    static boolean isVercelConfig(String path) {
        return "vercel.json".equals(ConfigFileSupport.filename(path).toLowerCase(Locale.ROOT));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseJson(String text) {
        try {
            Object value = jsonMapper.readValue(text, Object.class);
            return value instanceof Map<?, ?> map ? (Map<String, Object>) map : null;
        } catch (Exception e) {
            return null;
        }
    }
}
