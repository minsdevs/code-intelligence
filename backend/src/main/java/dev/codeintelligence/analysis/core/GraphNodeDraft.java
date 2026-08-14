package dev.codeintelligence.analysis.core;

import java.util.Map;

public record GraphNodeDraft(
        String nodeType,
        String naturalKey,
        String name,
        String filePath,
        Integer lineStart,
        Integer lineEnd,
        String areaType,
        Map<String, Object> metadata) {

    public GraphNodeDraft {
        metadata = metadata == null ? Map.of() : Map.copyOf(metadata);
    }

    public static GraphNodeDraft of(
            GraphNodeType type, String naturalKey, String name, String filePath, Integer lineStart, Integer lineEnd) {
        return new GraphNodeDraft(type.name(), naturalKey, name, filePath, lineStart, lineEnd, null, Map.of());
    }

    public GraphNodeDraft withAreaType(String taggedArea) {
        return new GraphNodeDraft(nodeType, naturalKey, name, filePath, lineStart, lineEnd, taggedArea, metadata);
    }

    public GraphNodeDraft withMetadata(Map<String, Object> extra) {
        return new GraphNodeDraft(nodeType, naturalKey, name, filePath, lineStart, lineEnd, areaType, extra);
    }
}
