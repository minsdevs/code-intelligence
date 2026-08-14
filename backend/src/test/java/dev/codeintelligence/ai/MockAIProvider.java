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
    public String model() {
        return "mock-chat";
    }

    @Override
    public String embeddingModel() {
        return "mock-embedding";
    }

    @Override
    public void testConnection() {}

    @Override
    public ChatResponse chat(ChatRequest request) {
        lastUser = request.user() == null ? "" : request.user();
        if (request.system() != null && request.system().contains("Propose a Learning")) {
            String taskJson =
                    "{\"type\":\"LEARNING\",\"title\":\"Review unmatched API call\",\"description\":\"Confirm the finding in code.\",\"goals\":[\"Open the evidence file\",\"Decide fix or dismiss\"]}";
            return new ChatResponse(taskJson, List.of(), taskJson, List.of(), 12, 8);
        }
        if (request.system() != null && request.system().contains("Review this pull request")) {
            List<String> evidence = evidenceFrom(lastUser);
            if (lastUser.contains("pr:")) {
                int prStart = lastUser.indexOf("pr:");
                int prEnd = prStart + 3;
                while (prEnd < lastUser.length() && Character.isDigit(lastUser.charAt(prEnd))) {
                    prEnd++;
                }
                evidence = new ArrayList<>(evidence);
                evidence.add(lastUser.substring(prStart, prEnd));
            }
            String path = "src/App.java";
            Matcher changed = Pattern.compile("CHANGED_FILE: (\\S+)").matcher(lastUser);
            if (changed.find()) {
                path = changed.group(1);
            }
            String reviewJson = "{\"summary\":\"mock review\",\"comments\":[{\"filePath\":\""
                    + path
                    + "\",\"line\":1,\"severity\":\"WARNING\",\"body\":\"Check this change.\",\"confidence\":\"CONFIRMED\",\"evidence\":"
                    + toJsonArray(evidence.isEmpty() ? List.of("file:" + path + ":1") : evidence)
                    + "}]}";
            return new ChatResponse(reviewJson, List.of(), reviewJson, List.of(), 12, 8);
        }
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
        float[] vector = new float[1536];
        vector[0] = 1f;
        return vector;
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
        Matcher nodeFile = Pattern.compile("file:(\\S+):(\\d+)").matcher(user);
        if (nodeFile.find()) {
            return List.of("file:" + nodeFile.group(1) + ":" + nodeFile.group(2));
        }
        return List.of();
    }

    private static String toJsonArray(List<String> values) {
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                out.append(',');
            }
            out.append('"')
                    .append(values.get(i).replace("\\", "\\\\").replace("\"", "\\\""))
                    .append('"');
        }
        return out.append(']').toString();
    }
}
