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
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Dockerfile instructions plus compose services. Compose services become CONTAINER nodes;
 * Dockerfiles are evidence when a service {@code build} references them. {@code depends_on}
 * becomes DEPLOYED_IN (dependent → dependency).
 */
@Component
public class DockerAnalyzer implements CodeAnalyzer {

    private static final Pattern FROM =
            Pattern.compile("^FROM\\s+(\\S+)(?:\\s+AS\\s+(\\S+))?", Pattern.CASE_INSENSITIVE);
    private static final Pattern EXPOSE = Pattern.compile("^EXPOSE\\s+(.+)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern CMD = Pattern.compile("^CMD\\s+(.+)$", Pattern.CASE_INSENSITIVE);

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(file -> isDockerfile(file.path()) || isCompose(file.path()));
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        GraphCollector collector = new GraphCollector();
        Map<String, DockerfileInfo> dockerfiles = new LinkedHashMap<>();
        for (InventoriedFile file : ctx.inventory().files()) {
            if (!isDockerfile(file.path())) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text != null) {
                dockerfiles.put(file.path().replace('\\', '/'), parseDockerfile(file.path(), text));
            }
        }
        for (InventoriedFile file : ctx.inventory().files()) {
            if (!isCompose(file.path())) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text == null) {
                continue;
            }
            try {
                parseCompose(ctx, file.path(), text, dockerfiles, collector);
            } catch (RuntimeException e) {
                collector.evidence(new AnalyzerEvidence(
                        null,
                        EvidenceKind.FILE_LINE,
                        file.path(),
                        1,
                        1,
                        "Compose parse failed: " + ConfigFileSupport.sanitize(e.getMessage(), ctx.clonePath())));
            }
        }
        return collector.toResult();
    }

    static boolean isDockerfile(String path) {
        String name = ConfigFileSupport.filename(path);
        return "Dockerfile".equals(name)
                || "dockerfile".equals(name)
                || name.startsWith("Dockerfile.")
                || name.startsWith("dockerfile.");
    }

    static boolean isCompose(String path) {
        String name = ConfigFileSupport.filename(path).toLowerCase(Locale.ROOT);
        if (name.equals("compose.yml") || name.equals("compose.yaml")) {
            return true;
        }
        return name.startsWith("docker-compose") && (name.endsWith(".yml") || name.endsWith(".yaml"));
    }

    private void parseCompose(
            AnalysisContext ctx,
            String path,
            String text,
            Map<String, DockerfileInfo> dockerfiles,
            GraphCollector collector) {
        for (Object doc : YamlSupport.loadDocuments(text)) {
            Map<String, Object> root = YamlSupport.asMap(doc);
            Map<String, Object> services = YamlSupport.asMap(root.get("services"));
            for (Map.Entry<String, Object> entry : services.entrySet()) {
                String service = entry.getKey();
                Map<String, Object> body = YamlSupport.asMap(entry.getValue());
                String key = NaturalKeys.container(service);
                Map<String, Object> metadata = new LinkedHashMap<>();
                if (body.get("image") != null) {
                    metadata.put("image", String.valueOf(body.get("image")));
                }
                List<String> ports = YamlSupport.stringList(body.get("ports"));
                if (!ports.isEmpty()) {
                    metadata.put("ports", ports);
                }
                List<String> envKeys = YamlSupport.environmentKeys(body.get("environment"));
                if (!envKeys.isEmpty()) {
                    metadata.put("environmentKeys", envKeys);
                }
                List<String> dependsOn = YamlSupport.stringList(body.get("depends_on"));
                if (!dependsOn.isEmpty()) {
                    metadata.put("dependsOn", dependsOn);
                }
                String dockerfilePath = resolveDockerfile(ctx, path, body.get("build"), dockerfiles);
                if (dockerfilePath != null) {
                    DockerfileInfo info = dockerfiles.get(dockerfilePath);
                    metadata.put("dockerfile", dockerfilePath);
                    if (info != null) {
                        metadata.put("from", info.from);
                        metadata.put("expose", info.expose);
                        if (info.cmd != null) {
                            metadata.put("cmd", info.cmd);
                        }
                    }
                    collector.evidence(new AnalyzerEvidence(
                            key,
                            EvidenceKind.FILE_LINE,
                            dockerfilePath,
                            1,
                            1,
                            info == null
                                    ? ConfigFileSupport.excerpt("FROM")
                                    : ConfigFileSupport.excerpt("FROM " + String.join(", ", info.from))));
                }
                collector.put(GraphNodeDraft.of(
                                GraphNodeType.CONTAINER,
                                key,
                                service,
                                path,
                                ConfigFileSupport.lineOf(text, service),
                                null)
                        .withAreaType(AreaType.INFRASTRUCTURE.name())
                        .withMetadata(metadata));
                collector.evidence(new AnalyzerEvidence(
                        key, EvidenceKind.FILE_LINE, path, ConfigFileSupport.lineOf(text, service), null, service));
                for (String dependency : dependsOn) {
                    collector.put(GraphNodeDraft.of(
                                    GraphNodeType.CONTAINER,
                                    NaturalKeys.container(dependency),
                                    dependency,
                                    path,
                                    null,
                                    null)
                            .withAreaType(AreaType.INFRASTRUCTURE.name()));
                    collector.edge(
                            key,
                            NaturalKeys.container(dependency),
                            GraphEdgeType.DEPLOYED_IN,
                            EdgeConfidence.CONFIRMED);
                }
            }
        }
    }

    private String resolveDockerfile(
            AnalysisContext ctx, String composePath, Object build, Map<String, DockerfileInfo> dockerfiles) {
        if (build == null) {
            return null;
        }
        String context = ".";
        String dockerfileName = "Dockerfile";
        if (build instanceof String raw) {
            context = raw;
        } else if (build instanceof Map<?, ?>) {
            Map<String, Object> map = YamlSupport.asMap(build);
            // Inline content is not a reference to a file on disk.
            if (map.containsKey("dockerfile_inline")) return null;
            if (map.get("context") != null) {
                if (!(map.get("context") instanceof String raw)) return null;
                context = raw;
            }
            if (map.get("dockerfile") != null) {
                if (!(map.get("dockerfile") instanceof String raw)) return null;
                dockerfileName = raw;
            }
        } else {
            return null;
        }
        if (!literalRelativePath(context) || !literalRelativePath(dockerfileName)) return null;
        try {
            Path compose = Path.of(composePath.replace('\\', '/'));
            if (compose.isAbsolute() || compose.normalize().startsWith("..")) return null;
            Path composeDir = compose.getParent();
            Path relative = (composeDir == null ? Path.of(context) : composeDir.resolve(context))
                    .resolve(dockerfileName)
                    .normalize();
            if (relative.isAbsolute() || relative.startsWith("..")) return null;
            String normalized = relative.toString().replace('\\', '/');
            // Never probe unlisted working files or substitute an unrelated root Dockerfile.
            boolean inventoried = ctx.inventory().files().stream()
                    .anyMatch(file -> file.path().replace('\\', '/').equals(normalized));
            if (!inventoried) return null;
            if (!dockerfiles.containsKey(normalized)) {
                String text = ConfigFileSupport.read(ctx.clonePath(), normalized);
                if (text == null) return null;
                dockerfiles.put(normalized, parseDockerfile(normalized, text));
            }
            return normalized;
        } catch (InvalidPathException e) {
            return null;
        }
    }

    private static boolean literalRelativePath(String path) {
        // Remote, home-expanded, interpolated, or platform-dependent references are unresolved.
        return !path.isBlank()
                && !path.startsWith("/")
                && !path.startsWith("~")
                && path.indexOf('$') < 0
                && path.indexOf(':') < 0
                && path.indexOf('\\') < 0
                && path.chars().noneMatch(Character::isISOControl);
    }

    private DockerfileInfo parseDockerfile(String path, String text) {
        List<String> from = new ArrayList<>();
        List<String> expose = new ArrayList<>();
        String cmd = null;
        String logical = joinContinuations(text);
        for (String rawLine : logical.split("\n", -1)) {
            String line = stripComment(rawLine).strip();
            if (line.isEmpty()) {
                continue;
            }
            Matcher fromMatcher = FROM.matcher(line);
            if (fromMatcher.matches()) {
                from.add(fromMatcher.group(1));
                continue;
            }
            Matcher exposeMatcher = EXPOSE.matcher(line);
            if (exposeMatcher.matches()) {
                for (String port : exposeMatcher.group(1).strip().split("\\s+")) {
                    expose.add(port);
                }
                continue;
            }
            Matcher cmdMatcher = CMD.matcher(line);
            if (cmdMatcher.matches()) {
                cmd = cmdMatcher.group(1).strip();
            }
        }
        return new DockerfileInfo(path, List.copyOf(from), List.copyOf(expose), cmd);
    }

    private static String joinContinuations(String text) {
        StringBuilder out = new StringBuilder();
        String[] lines = text.split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            while (line.endsWith("\\") && i + 1 < lines.length) {
                line = line.substring(0, line.length() - 1) + " " + lines[++i].strip();
            }
            if (!out.isEmpty()) {
                out.append('\n');
            }
            out.append(line);
        }
        return out.toString();
    }

    private static String stripComment(String line) {
        int hash = line.indexOf('#');
        if (hash < 0) {
            return line;
        }
        return line.substring(0, hash);
    }

    private record DockerfileInfo(String path, List<String> from, List<String> expose, String cmd) {}
}
