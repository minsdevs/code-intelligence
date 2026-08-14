package dev.codeintelligence.ai;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MockAIProvider implements AIProvider {

    private static final Pattern FILE_REF = Pattern.compile("file:([^\\s]+):(\\d+)");
    private static final Pattern FOCUS_FILE = Pattern.compile("FOCUS_FILE: (\\S+)");

    private volatile String lastUser = "";

    public String lastUser() {
        return lastUser;
    }

    @Override
    public boolean enabled() {
        return true;
    }

    @Override
    public String name() {
        return "mock";
    }

    @Override
    public ChatResponse chat(ChatRequest request) {
        lastUser = request.user() == null ? "" : request.user();
        String explanation = "mock explanation";
        List<Claim> claims = new ArrayList<>();
        if (lastUser.contains("broken-ref")) {
            claims.add(new Claim("broken", "CONFIRMED", List.of("file:missing/nope.java:1")));
        } else {
            List<String> evidence = evidenceFrom(lastUser);
            claims.add(new Claim(
                    "The focused file exists in the snapshot.",
                    evidence.isEmpty() ? "UNKNOWN" : "CONFIRMED",
                    evidence));
        }
        List<Alternative> alternatives = List.of();
        if (lastUser.toLowerCase().contains("alternative") || lastUser.contains("대안")) {
            alternatives = List.of(new Alternative("Keep current", List.of("Known"), List.of("None"), "Fits"));
        }
        String raw = "{\"explanation\":\"" + explanation + "\",\"claims\":[],\"alternatives\":[]}";
        return new ChatResponse(raw, claims, explanation, alternatives, 12, 8);
    }

    @Override
    public void stream(ChatRequest request, TokenConsumer consumer) {
        ChatResponse response = chat(request);
        OpenAIProvider.chunk(response.explanation(), consumer);
    }

    @Override
    public float[] embed(String text) {
        return new float[1536];
    }

    private static List<String> evidenceFrom(String user) {
        Matcher file = FILE_REF.matcher(user);
        if (file.find()) {
            return List.of("file:" + file.group(1) + ":" + file.group(2));
        }
        Matcher focus = FOCUS_FILE.matcher(user);
        if (focus.find()) {
            return List.of("file:" + focus.group(1) + ":1");
        }
        return List.of();
    }
}
