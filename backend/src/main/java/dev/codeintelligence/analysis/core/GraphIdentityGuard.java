package dev.codeintelligence.analysis.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Suppress ambiguous source identities instead of choosing a module by encounter order. */
public final class GraphIdentityGuard {
    public static final String REASON = "AMBIGUOUS_SYMBOL_IDENTITY";

    private GraphIdentityGuard() {}

    public static boolean ambiguous(GraphNodeDraft node) {
        return Boolean.TRUE.equals(node.metadata().get("ambiguousIdentity"));
    }

    private static String declaredType(GraphNodeDraft node) {
        return String.valueOf(node.metadata().getOrDefault("originalNodeType", node.nodeType()));
    }

    public static AnalysisResult sanitize(AnalysisResult input) {
        Map<String, Set<String>> declaredFiles = new LinkedHashMap<>();
        Set<String> blocked = new LinkedHashSet<>();
        Map<String, GraphNodeDraft> representatives = new LinkedHashMap<>();
        for (GraphNodeDraft node : input.nodes()) {
            representatives.putIfAbsent(node.naturalKey(), node);
            if (ambiguous(node)) {
                blocked.add(node.naturalKey());
                Object candidates = node.metadata().get("candidateFiles");
                if (candidates instanceof List<?> paths) {
                    for (Object path : paths)
                        if (path instanceof String value)
                            declaredFiles
                                    .computeIfAbsent(node.naturalKey(), k -> new LinkedHashSet<>())
                                    .add(value);
                }
            }
            // Packages intentionally group files; inferred/fileless nodes are not declarations.
            if (!"PACKAGE".equals(node.nodeType()) && node.filePath() != null && node.lineStart() != null) {
                declaredFiles
                        .computeIfAbsent(node.naturalKey(), k -> new LinkedHashSet<>())
                        .add(node.filePath());
            }
        }
        declaredFiles.forEach((key, paths) -> {
            if (paths.size() > 1) blocked.add(key);
        });
        Set<String> ambiguousTypes = new LinkedHashSet<>();
        for (String key : blocked) {
            GraphNodeDraft node = representatives.get(key);
            if (node != null
                    && key.startsWith("java:")
                    && Set.of("CLASS", "INTERFACE", "ENUM", "ANNOTATION").contains(declaredType(node)))
                ambiguousTypes.add(key);
        }
        for (GraphNodeDraft node : input.nodes()) {
            for (String type : ambiguousTypes) {
                if (node.naturalKey().startsWith(type + "#")
                        || node.naturalKey().startsWith(type + ".")) {
                    blocked.add(node.naturalKey());
                    declaredFiles
                            .computeIfAbsent(node.naturalKey(), k -> new LinkedHashSet<>())
                            .addAll(declaredFiles.getOrDefault(type, Set.of()));
                }
            }
        }
        if (blocked.isEmpty()) return input;
        Set<String> affectedFiles = new LinkedHashSet<>();
        List<GraphNodeDraft> nodes = new ArrayList<>();
        Set<String> emitted = new LinkedHashSet<>();
        for (GraphNodeDraft node : input.nodes()) {
            if (!blocked.contains(node.naturalKey())) {
                nodes.add(node);
            } else if (emitted.add(node.naturalKey())) {
                Set<String> paths = declaredFiles.getOrDefault(node.naturalKey(), Set.of());
                affectedFiles.addAll(paths);
                nodes.add(new GraphNodeDraft(
                        "AMBIGUOUS",
                        node.naturalKey(),
                        node.name(),
                        null,
                        null,
                        null,
                        node.areaType(),
                        Map.of(
                                "ambiguousIdentity",
                                true,
                                "originalNodeType",
                                declaredType(node),
                                "candidateFiles",
                                List.copyOf(paths))));
            }
        }
        Map<String, FileAnalysisOutcome> outcomes = new LinkedHashMap<>();
        input.fileOutcomes().forEach(outcome -> outcomes.put(outcome.path(), outcome));
        for (String path : affectedFiles) {
            if (!"FAILED"
                    .equals(outcomes.getOrDefault(path, new FileAnalysisOutcome(path, "PARTIAL", REASON))
                            .status())) outcomes.put(path, new FileAnalysisOutcome(path, "PARTIAL", REASON));
        }
        return new AnalysisResult(
                nodes,
                input.edges().stream()
                        .filter(edge -> !blocked.contains(edge.sourceNaturalKey())
                                && !blocked.contains(edge.targetNaturalKey()))
                        .toList(),
                input.evidences().stream()
                        .filter(evidence -> !blocked.contains(evidence.subjectNaturalKey()))
                        .toList(),
                List.copyOf(outcomes.values()));
    }
}
