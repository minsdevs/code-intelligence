package dev.codeintelligence.analysis.core;

import java.util.Map;

public record GraphEdgeDraft(
        String sourceNaturalKey,
        String targetNaturalKey,
        String edgeType,
        String confidence,
        Map<String, Object> metadata) {

    public GraphEdgeDraft {
        metadata = metadata == null ? Map.of() : Map.copyOf(metadata);
    }

    public static GraphEdgeDraft of(
            String sourceNaturalKey, String targetNaturalKey, GraphEdgeType edgeType, EdgeConfidence confidence) {
        return new GraphEdgeDraft(sourceNaturalKey, targetNaturalKey, edgeType.name(), confidence.name(), Map.of());
    }

    public GraphEdgeDraft withMetadata(Map<String, Object> extra) {
        return new GraphEdgeDraft(sourceNaturalKey, targetNaturalKey, edgeType, confidence, extra);
    }
}
