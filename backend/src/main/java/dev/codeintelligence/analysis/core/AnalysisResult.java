package dev.codeintelligence.analysis.core;

import java.util.List;

public record AnalysisResult(List<GraphNodeDraft> nodes, List<GraphEdgeDraft> edges, List<AnalyzerEvidence> evidences) {

    public static final AnalysisResult EMPTY = new AnalysisResult(List.of(), List.of(), List.of());

    public AnalysisResult {
        nodes = nodes == null ? List.of() : List.copyOf(nodes);
        edges = edges == null ? List.of() : List.copyOf(edges);
        evidences = evidences == null ? List.of() : List.copyOf(evidences);
    }
}
