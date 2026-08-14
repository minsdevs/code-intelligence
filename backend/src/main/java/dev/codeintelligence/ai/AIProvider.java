package dev.codeintelligence.ai;

import java.util.List;

public interface AIProvider {

    boolean enabled();

    String name();

    ChatResponse chat(ChatRequest request);

    void stream(ChatRequest request, TokenConsumer consumer);

    float[] embed(String text);

    @FunctionalInterface
    interface TokenConsumer {
        void accept(String token);
    }

    record ChatRequest(String system, String user, boolean jsonMode) {}

    record ChatResponse(
            String raw,
            List<Claim> claims,
            String explanation,
            List<Alternative> alternatives,
            int promptTokens,
            int completionTokens) {
        public static ChatResponse empty(String raw) {
            return new ChatResponse(raw == null ? "" : raw, List.of(), raw == null ? "" : raw, List.of(), 0, 0);
        }
    }

    record Claim(String text, String confidence, List<String> evidence) {}

    record Alternative(String name, List<String> pros, List<String> cons, String fitForThisProject) {}
}
