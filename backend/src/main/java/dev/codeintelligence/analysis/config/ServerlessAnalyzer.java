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
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Serverless deployment configs — {@code serverless.yml}, {@code netlify.toml},
 * {@code amplify.yml}, {@code cloudbuild.yaml}, {@code fly.toml}, {@code render.yaml}
 * → CLOUD_RESOURCE nodes.
 */
@Component
public class ServerlessAnalyzer implements CodeAnalyzer {

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(file -> providerOf(file.path()) != null);
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        GraphCollector collector = new GraphCollector();
        for (InventoriedFile file : ctx.inventory().files()) {
            Provider provider = providerOf(file.path());
            if (provider == null) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text == null) {
                continue;
            }
            String configKey = NaturalKeys.config(file.path());
            collector.put(new GraphNodeDraft(
                    GraphNodeType.CONFIG.name(),
                    configKey,
                    provider.fileName,
                    file.path(),
                    1,
                    null,
                    AreaType.INFRASTRUCTURE.name(),
                    Map.of("provider", provider.name)));
            collectResources(provider, text, file.path(), collector);
        }
        return collector.toResult();
    }

    private void collectResources(Provider provider, String text, String path, GraphCollector collector) {
        for (Object doc : YamlSupport.loadDocuments(text)) {
            Map<String, Object> root = YamlSupport.asMap(doc);
            if (provider.name.equals("serverless")) {
                Map<String, Object> functions = YamlSupport.asMap(YamlSupport.nested(root, "functions"));
                for (Map.Entry<String, Object> entry : functions.entrySet()) {
                    putResource(collector, path, text, "serverless", "function", entry.getKey());
                }
                Object service = root.get("service");
                if (service != null) {
                    putResource(collector, path, text, "serverless", "service", String.valueOf(service));
                }
            } else if (provider.name.equals("netlify")) {
                Map<String, Object> site = YamlSupport.asMap(root.get("build"));
                Object publish = site.get("publish");
                putResource(collector, path, text, "netlify", "site", "site");
                if (publish != null) {
                    Map<String, Object> metadata = new LinkedHashMap<>();
                    metadata.put("provider", "netlify");
                    metadata.put("publish", String.valueOf(publish));
                    collector.put(new GraphNodeDraft(
                            GraphNodeType.CLOUD_RESOURCE.name(),
                            NaturalKeys.cloud("netlify", "site:site"),
                            "netlify site",
                            path,
                            ConfigFileSupport.lineOf(text, "publish"),
                            null,
                            AreaType.INFRASTRUCTURE.name(),
                            metadata));
                }
            } else if (provider.name.equals("amplify")) {
                putResource(collector, path, text, "amplify", "app", "app");
            } else if (provider.name.equals("cloudbuild")) {
                putResource(collector, path, text, "cloudbuild", "build", "build");
            } else {
                putResource(collector, path, text, provider.name, "app", provider.fileName);
            }
        }
    }

    private void putResource(
            GraphCollector collector, String path, String text, String provider, String kind, String name) {
        String key = NaturalKeys.cloud(provider, kind + ":" + name);
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("provider", provider);
        metadata.put("kind", kind);
        collector.put(new GraphNodeDraft(
                GraphNodeType.CLOUD_RESOURCE.name(),
                key,
                provider + " " + kind + " " + name,
                path,
                ConfigFileSupport.lineOf(text, name),
                null,
                AreaType.INFRASTRUCTURE.name(),
                metadata));
        collector.evidence(new AnalyzerEvidence(
                key, EvidenceKind.FILE_LINE, path, ConfigFileSupport.lineOf(text, name), null, provider + " " + name));
    }

    private static Provider providerOf(String path) {
        String name = ConfigFileSupport.filename(path).toLowerCase(Locale.ROOT);
        if (name.equals("serverless.yml") || name.equals("serverless.yaml")) {
            return new Provider("serverless", name);
        }
        if (name.equals("netlify.toml")) {
            return new Provider("netlify", name);
        }
        if (name.equals("amplify.yml") || name.equals("amplify.yaml")) {
            return new Provider("amplify", name);
        }
        if (name.equals("cloudbuild.yaml") || name.equals("cloudbuild.yml")) {
            return new Provider("cloudbuild", name);
        }
        if (name.equals("fly.toml")) {
            return new Provider("fly", name);
        }
        if (name.equals("render.yaml") || name.equals("render.yml")) {
            return new Provider("render", name);
        }
        return null;
    }

    private record Provider(String name, String fileName) {}
}
