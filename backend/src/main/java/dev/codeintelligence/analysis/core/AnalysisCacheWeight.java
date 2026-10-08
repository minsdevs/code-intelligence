package dev.codeintelligence.analysis.core;

import java.util.Collection;
import java.util.Map;

/** Conservative retained-heap accounting without serializing graph data or allocating temporary text. */
public final class AnalysisCacheWeight {
    private AnalysisCacheWeight() {}

    public static long of(Object value) {
        if (value == null) return 0;
        if (value instanceof String text) return 48L + 2L * text.length();
        if (value instanceof AnalysisResult result)
            return 48 + of(result.nodes()) + of(result.edges()) + of(result.evidences()) + of(result.fileOutcomes());
        if (value instanceof GraphNodeDraft node)
            return 128 + of(node.nodeType()) + of(node.naturalKey()) + of(node.name()) + of(node.filePath())
                    + of(node.areaType()) + of(node.metadata());
        if (value instanceof GraphEdgeDraft edge)
            return 96 + of(edge.sourceNaturalKey()) + of(edge.targetNaturalKey()) + of(edge.edgeType())
                    + of(edge.confidence()) + of(edge.metadata());
        if (value instanceof AnalyzerEvidence evidence)
            return 96 + of(evidence.subjectNaturalKey()) + of(evidence.filePath()) + of(evidence.excerpt());
        if (value instanceof FileAnalysisOutcome outcome)
            return 64 + of(outcome.path()) + of(outcome.status()) + of(outcome.reason());
        if (value instanceof Map<?, ?> map) {
            long size = 96L + 64L * map.size();
            for (var entry : map.entrySet()) size += of(entry.getKey()) + of(entry.getValue());
            return size;
        }
        if (value instanceof Collection<?> collection) {
            long size = 48L + 8L * collection.size();
            for (Object element : collection) size += of(element);
            return size;
        }
        return 64;
    }
}
