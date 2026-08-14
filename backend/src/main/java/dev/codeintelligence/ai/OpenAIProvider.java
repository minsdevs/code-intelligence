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

public class OpenAIProvider implements AIProvider {

    private final AiProperties.OpenAi properties;
    private final RestClient restClient;
    private final JsonMapper json;

    public OpenAIProvider(AiProperties.OpenAi properties, RestClient.Builder restClientBuilder, JsonMapper json) {
        this.properties = properties;
        this.json = json;
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

    @Override
    public boolean enabled() {
        return true;
    }

    @Override
    public String name() {
        return "openai";
    }

    @Override
    public ChatResponse chat(ChatRequest request) {
        Map<String, Object> body = Map.of(
                "model",
                properties.chatModel(),
                "response_format",
                Map.of("type", "json_object"),
                "messages",
                List.of(
                        Map.of("role", "system", "content", request.system()),
                        Map.of("role", "user", "content", request.user())));
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> response = restClient
                    .post()
                    .uri("/v1/chat/completions")
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("Authorization", "Bearer " + properties.apiKey())
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
        chunk(response.explanation(), consumer);
    }

    @Override
    public float[] embed(String text) {
        Map<String, Object> body = Map.of("model", properties.embedModel(), "input", text);
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> response = restClient
                    .post()
                    .uri("/v1/embeddings")
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("Authorization", "Bearer " + properties.apiKey())
                    .body(body)
                    .retrieve()
                    .body(Map.class);
            return parseEmbedding(response);
        } catch (RestClientException e) {
            throw new AiProviderException(e);
        }
    }

    private ChatResponse parseChat(Map<String, Object> response) {
        if (response == null) {
            return ChatResponse.empty("");
        }
        String content = "";
        Object choices = response.get("choices");
        if (choices instanceof List<?> list && !list.isEmpty() && list.getFirst() instanceof Map<?, ?> choice) {
            Object message = choice.get("message");
            if (message instanceof Map<?, ?> msg && msg.get("content") instanceof String text) {
                content = text;
            }
        }
        int prompt = 0;
        int completion = 0;
        if (response.get("usage") instanceof Map<?, ?> usage) {
            prompt = LlmJson.intValue(usage, "prompt_tokens");
            completion = LlmJson.intValue(usage, "completion_tokens");
        }
        return LlmJson.parse(json, content, prompt, completion);
    }

    private float[] parseEmbedding(Map<String, Object> response) {
        if (response != null
                && response.get("data") instanceof List<?> data
                && !data.isEmpty()
                && data.getFirst() instanceof Map<?, ?> first
                && first.get("embedding") instanceof List<?> values) {
            float[] vector = new float[1536];
            int n = Math.min(1536, values.size());
            for (int i = 0; i < n; i++) {
                if (values.get(i) instanceof Number number) {
                    vector[i] = number.floatValue();
                }
            }
            return vector;
        }
        return new float[1536];
    }

    static void chunk(String explanation, TokenConsumer consumer) {
        if (explanation == null || explanation.isBlank()) {
            return;
        }
        int size = 24;
        for (int i = 0; i < explanation.length(); i += size) {
            consumer.accept(explanation.substring(i, Math.min(explanation.length(), i + size)));
        }
    }

    private static String stripSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }
}
