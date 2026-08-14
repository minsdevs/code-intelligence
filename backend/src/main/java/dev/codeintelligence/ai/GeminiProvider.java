package dev.codeintelligence.ai;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import tools.jackson.databind.json.JsonMapper;

public class GeminiProvider implements AIProvider {

    private final AiProperties.Gemini properties;
    private final RestClient restClient;
    private final JsonMapper json;
    private final String apiKey;

    /**
     * @param apiKey explicit key (from Settings) or null to fall back to the env-configured key.
     */
    public GeminiProvider(
            AiProperties.Gemini properties, RestClient.Builder restClientBuilder, JsonMapper json, String apiKey) {
        this.properties = properties;
        this.json = json;
        this.apiKey = apiKey == null || apiKey.isBlank() ? properties.apiKey() : apiKey;
        HttpClient httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(httpClient);
        factory.setReadTimeout(Duration.ofSeconds(60));
        this.restClient = restClientBuilder
                .clone()
                .baseUrl(stripSlash(properties.baseUrl()))
                .requestFactory(factory)
                .build();
    }

    boolean hasKey() {
        return apiKey != null && !apiKey.isBlank();
    }

    @Override
    public boolean enabled() {
        return true;
    }

    @Override
    public String name() {
        return "gemini";
    }

    @Override
    public ChatResponse chat(ChatRequest request) {
        String path = "/v1beta/models/" + properties.chatModel() + ":generateContent";
        Map<String, Object> body = Map.of(
                "systemInstruction",
                Map.of("parts", List.of(Map.of("text", request.system()))),
                "contents",
                List.of(Map.of("role", "user", "parts", List.of(Map.of("text", request.user())))),
                "generationConfig",
                Map.of("responseMimeType", "application/json"));
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> response = restClient
                    .post()
                    .uri(path)
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("x-goog-api-key", apiKey)
                    .body(body)
                    .retrieve()
                    .body(Map.class);
            return parseChat(response);
        } catch (RestClientException e) {
            throw new AiProviderException(e);
        }
    }

    @Override
    public void stream(ChatRequest request, TokenConsumer consumer) {
        ChatResponse response = chat(request);
        OpenAIProvider.chunk(response.explanation(), consumer);
    }

    @Override
    public float[] embed(String text) {
        String path = "/v1beta/models/" + properties.embedModel() + ":embedContent";
        Map<String, Object> body = Map.of("content", Map.of("parts", List.of(Map.of("text", text))));
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> response = restClient
                    .post()
                    .uri(path)
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("x-goog-api-key", apiKey)
                    .body(body)
                    .retrieve()
                    .body(Map.class);
            return parseEmbedding(response);
        } catch (RestClientException e) {
            throw new AiProviderException(e);
        }
    }

    private ChatResponse parseChat(Map<String, Object> response) {
        String content = "";
        if (response != null
                && response.get("candidates") instanceof List<?> candidates
                && !candidates.isEmpty()
                && candidates.getFirst() instanceof Map<?, ?> candidate
                && candidate.get("content") instanceof Map<?, ?> contentMap
                && contentMap.get("parts") instanceof List<?> parts
                && !parts.isEmpty()
                && parts.getFirst() instanceof Map<?, ?> part
                && part.get("text") instanceof String text) {
            content = text;
        }
        int prompt = 0;
        int completion = 0;
        if (response != null && response.get("usageMetadata") instanceof Map<?, ?> usage) {
            prompt = LlmJson.intValue(usage, "promptTokenCount");
            completion = LlmJson.intValue(usage, "candidatesTokenCount");
        }
        return LlmJson.parse(json, content, prompt, completion);
    }

    private float[] parseEmbedding(Map<String, Object> response) {
        float[] vector = new float[1536];
        if (response != null
                && response.get("embedding") instanceof Map<?, ?> embedding
                && embedding.get("values") instanceof List<?> values) {
            int n = Math.min(1536, values.size());
            for (int i = 0; i < n; i++) {
                if (values.get(i) instanceof Number number) {
                    vector[i] = number.floatValue();
                }
            }
        }
        return vector;
    }

    private static String stripSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }
}
