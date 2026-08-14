package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

class OpenAIProviderTest {

    private HttpServer server;
    private OpenAIProvider provider;
    private volatile String lastAuth = "";
    private volatile String lastPath = "";

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/models/gpt-4o-mini", this::model);
        server.createContext("/v1/chat/completions", this::chat);
        server.createContext("/v1/embeddings", this::embed);
        server.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        provider = new OpenAIProvider(
                new AiProperties.OpenAi("sk-test-key", base, "gpt-4o-mini", "text-embedding-3-small"),
                RestClient.builder(),
                JsonMapper.builder().build(),
                null);
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void chatParsesJsonModeResponse() {
        AIProvider.ChatResponse response = provider.chat(new AIProvider.ChatRequest("sys", "QUESTION:\nhello\n", true));
        assertThat(response.explanation()).isEqualTo("Redis stores sessions.");
        assertThat(response.claims()).hasSize(1);
        assertThat(response.claims().getFirst().confidence()).isEqualTo("CONFIRMED");
        assertThat(response.promptTokens()).isEqualTo(10);
        assertThat(lastAuth).isEqualTo("Bearer sk-test-key");
        assertThat(lastPath).isEqualTo("/v1/chat/completions");
    }

    @Test
    void embedPadsTo1536() {
        float[] vector = provider.embed("hello");
        assertThat(vector).hasSize(1536);
        assertThat(vector[0]).isEqualTo(0.5f);
        assertThat(lastPath).isEqualTo("/v1/embeddings");
    }

    @Test
    void testConnectionChecksSelectedModel() {
        provider.testConnection();
        assertThat(lastAuth).isEqualTo("Bearer sk-test-key");
        assertThat(lastPath).isEqualTo("/v1/models/gpt-4o-mini");
    }

    @Test
    void rejectsDisallowedHostEvenWithoutEnvironmentKey() {
        assertThatThrownBy(() -> new AiProperties.OpenAi("", "https://evil.example", "m", "e").validate())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("not allowed");
    }

    @Test
    void rejectsPlaintextTransportForRemoteProviderHost() {
        assertThatThrownBy(() -> new AiProperties.OpenAi("", "http://api.openai.com", "m", "e").validate())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("https");
    }

    private void chat(HttpExchange exchange) throws IOException {
        lastAuth = header(exchange, "Authorization");
        lastPath = exchange.getRequestURI().getPath();
        exchange.getRequestBody().readAllBytes();
        respond(exchange, """
                {"choices":[{"message":{"content":"{\\"explanation\\":\\"Redis stores sessions.\\",\\"claims\\":[{\\"text\\":\\"sessions\\",\\"confidence\\":\\"CONFIRMED\\",\\"evidence\\":[\\"file:Auth.java:1\\"]}],\\"alternatives\\":[]}"}}],"usage":{"prompt_tokens":10,"completion_tokens":4}}
                """);
    }

    private void embed(HttpExchange exchange) throws IOException {
        lastPath = exchange.getRequestURI().getPath();
        exchange.getRequestBody().readAllBytes();
        respond(exchange, "{\"data\":[{\"embedding\":[0.5,0.25]}]}");
    }

    private void model(HttpExchange exchange) throws IOException {
        lastAuth = header(exchange, "Authorization");
        lastPath = exchange.getRequestURI().getPath();
        respond(exchange, "{}");
    }

    private static String header(HttpExchange exchange, String name) {
        List<String> values = exchange.getRequestHeaders().get(name);
        return values == null || values.isEmpty() ? "" : values.getFirst();
    }

    private static void respond(HttpExchange exchange, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
