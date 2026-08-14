package dev.codeintelligence.analysis.config;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphEdgeType;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class GraphCollector {

    private final Map<String, GraphNodeDraft> nodes = new LinkedHashMap<>();
    private final List<GraphEdgeDraft> edges = new ArrayList<>();
    private final List<AnalyzerEvidence> evidences = new ArrayList<>();

    void put(GraphNodeDraft node) {
        GraphNodeDraft existing = nodes.get(node.naturalKey());
        if (existing == null) {
            nodes.put(node.naturalKey(), node);
            return;
        }
        Map<String, Object> merged = new LinkedHashMap<>(existing.metadata());
        merged.putAll(node.metadata());
        GraphNodeDraft base = node.lineStart() != null && existing.lineStart() == null ? node : existing;
        nodes.put(base.naturalKey(), merged.isEmpty() ? base : base.withMetadata(merged));
    }

    void edge(String source, String target, GraphEdgeType type, EdgeConfidence confidence) {
        edges.add(GraphEdgeDraft.of(source, target, type, confidence));
    }

    void evidence(AnalyzerEvidence evidence) {
        evidences.add(evidence);
    }

    AnalysisResult toResult() {
        return new AnalysisResult(List.copyOf(nodes.values()), List.copyOf(edges), List.copyOf(evidences));
    }
}
