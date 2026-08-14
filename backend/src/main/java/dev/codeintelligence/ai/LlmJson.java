package dev.codeintelligence.ai;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

final class LlmJson {

    private LlmJson() {}

    static AIProvider.ChatResponse parse(JsonMapper json, String raw, int promptTokens, int completionTokens) {
        String content = raw == null ? "" : raw.strip();
        if (content.startsWith("```")) {
            int start = content.indexOf('{');
            int end = content.lastIndexOf('}');
            if (start >= 0 && end > start) {
                content = content.substring(start, end + 1);
            }
        }
        try {
            JsonNode root = json.readTree(content);
            String explanation = text(root, "explanation");
            if (explanation.isBlank()) {
                explanation = content;
            }
            return new AIProvider.ChatResponse(
                    raw, claims(root), explanation, alternatives(root), promptTokens, completionTokens);
        } catch (RuntimeException e) {
            return new AIProvider.ChatResponse(raw, List.of(), content, List.of(), promptTokens, completionTokens);
        }
    }

    private static List<AIProvider.Claim> claims(JsonNode root) {
        List<AIProvider.Claim> claims = new ArrayList<>();
        JsonNode array = root.get("claims");
        if (array == null || !array.isArray()) {
            return claims;
        }
        for (JsonNode node : array) {
            claims.add(new AIProvider.Claim(
                    text(node, "text"),
                    text(node, "confidence").isBlank() ? "UNKNOWN" : text(node, "confidence"),
                    strings(node.get("evidence"))));
        }
        return claims;
    }

    private static List<AIProvider.Alternative> alternatives(JsonNode root) {
        List<AIProvider.Alternative> alternatives = new ArrayList<>();
        JsonNode array = root.get("alternatives");
        if (array == null || !array.isArray()) {
            return alternatives;
        }
        for (JsonNode node : array) {
            alternatives.add(new AIProvider.Alternative(
                    text(node, "name"),
                    strings(node.get("pros")),
                    strings(node.get("cons")),
                    text(node, "fitForThisProject")));
        }
        return alternatives;
    }

    private static List<String> strings(JsonNode node) {
        if (node == null || !node.isArray()) {
            return List.of();
        }
        List<String> values = new ArrayList<>();
        for (JsonNode item : node) {
            if (item != null && item.isValueNode() && !item.asString().isBlank()) {
                values.add(item.asString());
            }
        }
        return values;
    }

    private static String text(JsonNode node, String field) {
        if (node == null) {
            return "";
        }
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? "" : value.asString();
    }

    static int intValue(Map<?, ?> map, String key) {
        Object value = map.get(key);
        if (value instanceof Number number) {
            return number.intValue();
        }
        return 0;
    }
}
