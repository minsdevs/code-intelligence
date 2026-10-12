package dev.codeintelligence.analysis.config;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import dev.codeintelligence.analysis.core.FileCapabilityOutcome;
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
    private final Map<String, FileAnalysisOutcome> outcomes = new LinkedHashMap<>();
    private final Map<String, FileCapabilityOutcome> capabilityOutcomes = new LinkedHashMap<>();

    /** Per-file parse verdict of a config/SQL analyzer (06 P cells); later records replace earlier ones. */
    void outcome(FileAnalysisOutcome outcome) {
        outcomes.put(outcome.path(), outcome);
    }

    /** Per-file outcome of one owned capability (S/C/F/X); later records replace earlier ones. */
    void capability(FileCapabilityOutcome outcome) {
        capabilityOutcomes.put(outcome.path() + "\n" + outcome.capability(), outcome);
    }

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
        return new AnalysisResult(
                List.copyOf(nodes.values()),
                List.copyOf(edges),
                List.copyOf(evidences),
                List.copyOf(outcomes.values()),
                List.copyOf(capabilityOutcomes.values()));
    }
}
