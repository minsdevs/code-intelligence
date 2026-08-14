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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.stereotype.Component;

/** {@code .github/workflows/*.yml} → CI_PIPELINE nodes keyed as {@code ci:{workflow}:{job}}. */
@Component
public class GithubActionsAnalyzer implements CodeAnalyzer {

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(file -> isWorkflow(file.path()));
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        GraphCollector collector = new GraphCollector();
        for (InventoriedFile file : ctx.inventory().files()) {
            if (!isWorkflow(file.path())) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text == null) {
                continue;
            }
            try {
                parseWorkflow(file.path(), text, collector);
            } catch (RuntimeException e) {
                collector.evidence(new AnalyzerEvidence(
                        null,
                        EvidenceKind.FILE_LINE,
                        file.path(),
                        1,
                        1,
                        "Workflow parse failed: " + ConfigFileSupport.sanitize(e.getMessage(), ctx.clonePath())));
            }
        }
        return collector.toResult();
    }

    static boolean isWorkflow(String path) {
        String normalized = path.replace('\\', '/').toLowerCase(Locale.ROOT);
        if (!normalized.contains(".github/workflows/")) {
            return false;
        }
        return normalized.endsWith(".yml") || normalized.endsWith(".yaml");
    }

    private void parseWorkflow(String path, String text, GraphCollector collector) {
        String workflowFile = ConfigFileSupport.filename(path);
        for (Object doc : YamlSupport.loadDocuments(text)) {
            Map<String, Object> root = YamlSupport.asMap(doc);
            String workflowName = root.get("name") == null ? workflowFile : String.valueOf(root.get("name"));
            List<String> triggers = YamlSupport.stringList(root.get("on"));
            Map<String, Object> jobs = YamlSupport.asMap(root.get("jobs"));
            if (jobs.isEmpty()) {
                putJob(collector, path, text, workflowFile, workflowName, "default", triggers, Map.of());
                continue;
            }
            for (Map.Entry<String, Object> entry : jobs.entrySet()) {
                putJob(
                        collector,
                        path,
                        text,
                        workflowFile,
                        workflowName,
                        entry.getKey(),
                        triggers,
                        YamlSupport.asMap(entry.getValue()));
            }
        }
    }

    private void putJob(
            GraphCollector collector,
            String path,
            String text,
            String workflowFile,
            String workflowName,
            String job,
            List<String> triggers,
            Map<String, Object> body) {
        String key = NaturalKeys.ci(workflowFile, job);
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("workflow", workflowName);
        metadata.put("job", job);
        if (!triggers.isEmpty()) {
            metadata.put("triggers", triggers);
        }
        if (body.get("runs-on") != null) {
            metadata.put("runsOn", String.valueOf(body.get("runs-on")));
        }
        List<Map<String, Object>> steps = stepSummaries(body.get("steps"));
        if (!steps.isEmpty()) {
            metadata.put("steps", steps);
        }
        collector.put(GraphNodeDraft.of(
                        GraphNodeType.CI_PIPELINE, key, job, path, ConfigFileSupport.lineOf(text, job + ":"), null)
                .withAreaType(AreaType.DEVOPS.name())
                .withMetadata(metadata));
        collector.evidence(new AnalyzerEvidence(
                key,
                EvidenceKind.FILE_LINE,
                path,
                ConfigFileSupport.lineOf(text, job + ":"),
                null,
                ConfigFileSupport.excerpt(workflowName + " / " + job)));
    }

    private static List<Map<String, Object>> stepSummaries(Object steps) {
        if (!(steps instanceof List<?> list)) {
            return List.of();
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object item : list) {
            Map<String, Object> step = YamlSupport.asMap(item);
            Map<String, Object> summary = new LinkedHashMap<>();
            if (step.get("name") != null) {
                summary.put("name", String.valueOf(step.get("name")));
            }
            if (step.get("uses") != null) {
                summary.put("uses", String.valueOf(step.get("uses")));
            }
            if (step.get("run") != null) {
                summary.put("run", ConfigFileSupport.excerpt(String.valueOf(step.get("run"))));
            }
            if (!summary.isEmpty()) {
                out.add(summary);
            }
        }
        return out;
    }
}
