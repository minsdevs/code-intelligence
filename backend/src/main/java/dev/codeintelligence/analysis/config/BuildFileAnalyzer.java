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
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.springframework.stereotype.Component;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

/**
 * pom.xml (DOM) and build.gradle(.kts) (regex + structure) → CONFIG nodes and DEPENDS_ON edges
 * (§10.3).
 */
@Component
public class BuildFileAnalyzer implements CodeAnalyzer {

    private static final Pattern STRING_DEP =
            Pattern.compile("(?m)^\\s*(?<conf>implementation|api|compileOnly|runtimeOnly|testImplementation"
                    + "|testCompileOnly|testRuntimeOnly|annotationProcessor|compile|provided"
                    + "|developmentOnly|runtime)\\s*"
                    + "(?:\\(\\s*)?(?:platform\\s*\\(\\s*)?['\"](?<coord>[^'\"]+)['\"]");

    private static final Pattern MAP_DEP =
            Pattern.compile("(?m)^\\s*(?<conf>implementation|api|compileOnly|runtimeOnly|testImplementation"
                    + "|testCompileOnly|testRuntimeOnly|annotationProcessor|compile|provided"
                    + "|developmentOnly|runtime)\\s*\\(?\\s*"
                    + "group\\s*[:=]\\s*['\"](?<group>[^'\"]+)['\"]\\s*,\\s*"
                    + "name\\s*[:=]\\s*['\"](?<name>[^'\"]+)['\"]"
                    + "(?:\\s*,\\s*version\\s*[:=]\\s*['\"](?<version>[^'\"]+)['\"])?");

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(BuildFileAnalyzer::isBuildFile);
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        GraphCollector collector = new GraphCollector();
        for (InventoriedFile file : ctx.inventory().files()) {
            if (!isBuildFile(file)) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text == null) {
                continue;
            }
            try {
                if (isPom(file.path())) {
                    parsePom(file.path(), text, collector);
                } else {
                    parseGradle(file.path(), text, collector);
                }
            } catch (RuntimeException e) {
                collector.evidence(new AnalyzerEvidence(
                        null,
                        EvidenceKind.FILE_LINE,
                        file.path(),
                        1,
                        1,
                        "Build file parse failed: " + ConfigFileSupport.sanitize(e.getMessage(), ctx.clonePath())));
            }
        }
        return collector.toResult();
    }

    static boolean isBuildFile(InventoriedFile file) {
        String name = ConfigFileSupport.filename(file.path()).toLowerCase(Locale.ROOT);
        return "pom.xml".equals(name) || "build.gradle".equals(name) || "build.gradle.kts".equals(name);
    }

    private static boolean isPom(String path) {
        return ConfigFileSupport.filename(path).equalsIgnoreCase("pom.xml");
    }

    private void parseGradle(String path, String text, GraphCollector collector) {
        String configKey = putConfigNode(path, text, collector);
        List<Map<String, Object>> deps = new ArrayList<>();
        Matcher map = MAP_DEP.matcher(text);
        while (map.find()) {
            addDependency(
                    collector,
                    configKey,
                    path,
                    map.group("conf"),
                    map.group("group"),
                    map.group("name"),
                    map.group("version"),
                    map.group("group") + ":" + map.group("name")
                            + (map.group("version") == null ? "" : ":" + map.group("version")),
                    deps);
        }
        Matcher str = STRING_DEP.matcher(text);
        while (str.find()) {
            ParsedGav gav = parseGav(str.group("coord"));
            addDependency(
                    collector,
                    configKey,
                    path,
                    str.group("conf"),
                    gav.group,
                    gav.artifact,
                    gav.version,
                    str.group("coord"),
                    deps);
        }
        GraphNodeDraft node = collectorNode(collector, configKey, path, text);
        collector.put(node.withMetadata(Map.of("dependencies", deps, "kind", "gradle")));
    }

    private void parsePom(String path, String text, GraphCollector collector) {
        String configKey = putConfigNode(path, text, collector);
        Document document = parseXml(text);
        Element project = document.getDocumentElement();
        List<Map<String, Object>> deps = new ArrayList<>();
        Element dependencies = child(project, "dependencies");
        if (dependencies != null) {
            NodeList nodes = dependencies.getChildNodes();
            for (int i = 0; i < nodes.getLength(); i++) {
                Node node = nodes.item(i);
                if (node.getNodeType() != Node.ELEMENT_NODE || !"dependency".equals(node.getNodeName())) {
                    continue;
                }
                Element dep = (Element) node;
                String group = text(dep, "groupId");
                String artifact = text(dep, "artifactId");
                if (artifact == null || artifact.isBlank()) {
                    continue;
                }
                String version = text(dep, "version");
                String scope = text(dep, "scope");
                addDependency(
                        collector,
                        configKey,
                        path,
                        scope == null ? "compile" : scope,
                        group,
                        artifact,
                        version,
                        (group == null ? "" : group + ":") + artifact + (version == null ? "" : ":" + version),
                        deps);
            }
        }
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("kind", "maven");
        metadata.put("groupId", text(project, "groupId"));
        metadata.put("artifactId", text(project, "artifactId"));
        metadata.put("version", text(project, "version"));
        metadata.put("dependencies", deps);
        collector.put(collectorNode(collector, configKey, path, text).withMetadata(metadata));
    }

    private String putConfigNode(String path, String text, GraphCollector collector) {
        String key = NaturalKeys.config(path);
        collector.put(
                GraphNodeDraft.of(GraphNodeType.CONFIG, key, ConfigFileSupport.filename(path), path, 1, lineCount(text))
                        .withAreaType(AreaType.BUILD_TOOLING.name()));
        collector.evidence(
                new AnalyzerEvidence(key, EvidenceKind.DEPENDENCY, path, 1, 1, ConfigFileSupport.excerpt(text)));
        return key;
    }

    private GraphNodeDraft collectorNode(GraphCollector collector, String key, String path, String text) {
        return GraphNodeDraft.of(GraphNodeType.CONFIG, key, ConfigFileSupport.filename(path), path, 1, lineCount(text))
                .withAreaType(AreaType.BUILD_TOOLING.name());
    }

    private void addDependency(
            GraphCollector collector,
            String configKey,
            String path,
            String configuration,
            String group,
            String artifact,
            String version,
            String raw,
            List<Map<String, Object>> deps) {
        if (artifact == null || artifact.isBlank()) {
            return;
        }
        String depKey = NaturalKeys.dependency(group, artifact);
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("configuration", configuration);
        if (group != null && !group.isBlank()) {
            meta.put("group", group);
        }
        meta.put("artifact", artifact);
        if (version != null && !version.isBlank()) {
            meta.put("version", version);
        }
        meta.put("raw", raw);
        deps.add(Map.copyOf(meta));
        collector.put(GraphNodeDraft.of(GraphNodeType.CONFIG, depKey, artifact, path, null, null)
                .withAreaType(AreaType.BUILD_TOOLING.name())
                .withMetadata(meta));
        collector.edge(configKey, depKey, GraphEdgeType.DEPENDS_ON, EdgeConfidence.CONFIRMED);
    }

    static ParsedGav parseGav(String coordinate) {
        String[] parts = coordinate.split(":");
        if (parts.length == 1) {
            return new ParsedGav(null, parts[0], null);
        }
        if (parts.length == 2) {
            return new ParsedGav(parts[0], parts[1], null);
        }
        return new ParsedGav(parts[0], parts[1], parts[2]);
    }

    private static Document parseXml(String text) {
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(false);
            factory.setXIncludeAware(false);
            factory.setExpandEntityReferences(false);
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            return factory.newDocumentBuilder().parse(new InputSource(new java.io.StringReader(text)));
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
    }

    private static Element child(Element parent, String name) {
        NodeList nodes = parent.getChildNodes();
        for (int i = 0; i < nodes.getLength(); i++) {
            Node node = nodes.item(i);
            if (node.getNodeType() == Node.ELEMENT_NODE && name.equals(node.getNodeName())) {
                return (Element) node;
            }
        }
        return null;
    }

    private static String text(Element parent, String name) {
        Element child = child(parent, name);
        if (child == null) {
            return null;
        }
        String value = child.getTextContent();
        return value == null ? null : value.strip();
    }

    private static int lineCount(String text) {
        int lines = 1;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '\n') {
                lines++;
            }
        }
        return lines;
    }

    record ParsedGav(String group, String artifact, String version) {}
}
