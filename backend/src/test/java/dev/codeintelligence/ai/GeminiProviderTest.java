package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

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

class GeminiProviderTest {

    private HttpServer server;
    private GeminiProvider provider;
    private volatile String lastKey = "";
    private volatile String lastPath = "";
    private volatile String lastBody = "";

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1beta/models/gemini-2.5-flash", this::model);
        server.createContext("/v1beta/models/gemini-embedding-001:embedContent", this::embed);
        server.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        provider = new GeminiProvider(
                new AiProperties.Gemini("", base, "gemini-2.5-flash", "gemini-embedding-001"),
                RestClient.builder(),
                JsonMapper.builder().build(),
                "gemini-test-key",
                "gemini-2.5-flash");
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void testConnectionChecksSelectedModel() {
        provider.testConnection();

        assertThat(provider.model()).isEqualTo("gemini-2.5-flash");
        assertThat(lastKey).isEqualTo("gemini-test-key");
        assertThat(lastPath).isEqualTo("/v1beta/models/gemini-2.5-flash");
    }

    @Test
    void embeddingRequestsTheDatabaseVectorDimension() {
        float[] vector = provider.embed("hello");

        assertThat(vector).hasSize(1536);
        assertThat(lastPath).isEqualTo("/v1beta/models/gemini-embedding-001:embedContent");
        assertThat(lastBody).contains("\"outputDimensionality\":1536");
    }

    private void model(HttpExchange exchange) throws IOException {
        lastKey = header(exchange, "x-goog-api-key");
        lastPath = exchange.getRequestURI().getPath();
        respond(exchange, "{}");
    }

    private void embed(HttpExchange exchange) throws IOException {
        lastKey = header(exchange, "x-goog-api-key");
        lastPath = exchange.getRequestURI().getPath();
        lastBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        respond(exchange, "{\"embedding\":{\"values\":[0.5]}}");
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
