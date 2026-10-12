package dev.codeintelligence.analysis.core;

import java.util.List;

public record AnalysisResult(
        List<GraphNodeDraft> nodes,
        List<GraphEdgeDraft> edges,
        List<AnalyzerEvidence> evidences,
        List<FileAnalysisOutcome> fileOutcomes,
        List<FileCapabilityOutcome> capabilityOutcomes) {

    public AnalysisResult(List<GraphNodeDraft> nodes, List<GraphEdgeDraft> edges, List<AnalyzerEvidence> evidences) {
        this(nodes, edges, evidences, List.of(), List.of());
    }

    public AnalysisResult(
            List<GraphNodeDraft> nodes,
            List<GraphEdgeDraft> edges,
            List<AnalyzerEvidence> evidences,
            List<FileAnalysisOutcome> fileOutcomes) {
        this(nodes, edges, evidences, fileOutcomes, List.of());
    }

    public static final AnalysisResult EMPTY = new AnalysisResult(List.of(), List.of(), List.of());

    public AnalysisResult {
        nodes = nodes == null ? List.of() : List.copyOf(nodes);
        edges = edges == null ? List.of() : List.copyOf(edges);
        evidences = evidences == null ? List.of() : List.copyOf(evidences);
        fileOutcomes = fileOutcomes == null ? List.of() : List.copyOf(fileOutcomes);
        capabilityOutcomes = capabilityOutcomes == null ? List.of() : List.copyOf(capabilityOutcomes);
    }

    /** The same facts with these capability outcomes (per-file, per-capability adapter results). */
    public AnalysisResult withCapabilityOutcomes(List<FileCapabilityOutcome> capabilityOutcomes) {
        return new AnalysisResult(nodes, edges, evidences, fileOutcomes, capabilityOutcomes);
    }
}
