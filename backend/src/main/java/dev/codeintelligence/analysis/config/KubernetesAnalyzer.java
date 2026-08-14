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
import java.util.Set;
import org.springframework.stereotype.Component;

/** Kubernetes manifests → CONTAINER (workloads) and CLOUD_RESOURCE (services/config). */
@Component
public class KubernetesAnalyzer implements CodeAnalyzer {

    private static final Set<String> WORKLOAD_KINDS =
            Set.of("Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob");
    private static final Set<String> CLOUD_KINDS = Set.of(
            "Service",
            "Ingress",
            "ConfigMap",
            "Secret",
            "PersistentVolumeClaim",
            "Namespace",
            "Role",
            "ClusterRole",
            "ServiceAccount",
            "HorizontalPodAutoscaler",
            "NetworkPolicy");

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(file -> isKubernetesCandidate(file.path()));
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        GraphCollector collector = new GraphCollector();
        for (InventoriedFile file : ctx.inventory().files()) {
            if (!isKubernetesCandidate(file.path())) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text == null) {
                continue;
            }
            for (Object doc : YamlSupport.loadDocuments(text)) {
                Map<String, Object> root = YamlSupport.asMap(doc);
                String kind = String.valueOf(root.getOrDefault("kind", ""));
                if (kind.isBlank() || kind.equalsIgnoreCase("List")) {
                    if (kind.equalsIgnoreCase("List")) {
                        collectItems(root, file.path(), text, collector);
                    }
                    continue;
                }
                if (WORKLOAD_KINDS.contains(kind) || CLOUD_KINDS.contains(kind)) {
                    collectResource(root, kind, file.path(), text, collector);
                }
            }
        }
        return collector.toResult();
    }

    private void collectItems(Map<String, Object> root, String path, String text, GraphCollector collector) {
        Object items = root.get("items");
        if (!(items instanceof List<?> list)) {
            return;
        }
        for (Object item : list) {
            Map<String, Object> doc = YamlSupport.asMap(item);
            String kind = String.valueOf(doc.getOrDefault("kind", ""));
            if (WORKLOAD_KINDS.contains(kind) || CLOUD_KINDS.contains(kind)) {
                collectResource(doc, kind, path, text, collector);
            }
        }
    }

    private void collectResource(
            Map<String, Object> root, String kind, String path, String text, GraphCollector collector) {
        Map<String, Object> metadata = YamlSupport.asMap(YamlSupport.nested(root, "metadata"));
        String name = String.valueOf(metadata.getOrDefault("name", kind.toLowerCase(Locale.ROOT)));
        Map<String, Object> nodeMetadata = new LinkedHashMap<>();
        nodeMetadata.put("provider", "kubernetes");
        nodeMetadata.put("kind", kind);
        nodeMetadata.put("namespace", metadata.getOrDefault("namespace", ""));
        List<String> images = containerImages(root);
        if (!images.isEmpty()) {
            nodeMetadata.put("images", images);
        }
        Object replicas = YamlSupport.nested(root, "spec", "replicas");
        if (replicas != null) {
            nodeMetadata.put("replicas", replicas);
        }
        if (WORKLOAD_KINDS.contains(kind)) {
            String key = NaturalKeys.container(name);
            collector.put(new GraphNodeDraft(
                    GraphNodeType.CONTAINER.name(),
                    key,
                    name,
                    path,
                    ConfigFileSupport.lineOf(text, name),
                    null,
                    AreaType.INFRASTRUCTURE.name(),
                    nodeMetadata));
            collector.evidence(new AnalyzerEvidence(
                    key, EvidenceKind.FILE_LINE, path, ConfigFileSupport.lineOf(text, name), null, "k8s " + kind));
        } else {
            String key = NaturalKeys.cloud("kubernetes", kind.toLowerCase(Locale.ROOT) + ":" + name);
            collector.put(new GraphNodeDraft(
                    GraphNodeType.CLOUD_RESOURCE.name(),
                    key,
                    kind + " " + name,
                    path,
                    ConfigFileSupport.lineOf(text, name),
                    null,
                    AreaType.INFRASTRUCTURE.name(),
                    nodeMetadata));
            collector.evidence(new AnalyzerEvidence(
                    key, EvidenceKind.FILE_LINE, path, ConfigFileSupport.lineOf(text, name), null, "k8s " + kind));
        }
    }

    private static List<String> containerImages(Map<String, Object> root) {
        Object containers = YamlSupport.nested(root, "spec", "template", "spec", "containers");
        if (!(containers instanceof List<?> list)) {
            return List.of();
        }
        List<String> images = new ArrayList<>();
        for (Object item : list) {
            Map<String, Object> container = YamlSupport.asMap(item);
            Object image = container.get("image");
            if (image != null) {
                images.add(String.valueOf(image));
            }
        }
        return List.copyOf(images);
    }

    static boolean isKubernetesCandidate(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (!lower.endsWith(".yml") && !lower.endsWith(".yaml")) {
            return false;
        }
        if (lower.startsWith(".github/") || lower.contains("/.github/")) {
            return false;
        }
        String name = ConfigFileSupport.filename(path).toLowerCase(Locale.ROOT);
        if (name.startsWith("docker-compose") || name.startsWith("compose.")) {
            return false;
        }
        return !name.startsWith("chart.") && !name.endsWith(".example") && !lower.contains("/tests/");
    }
}
