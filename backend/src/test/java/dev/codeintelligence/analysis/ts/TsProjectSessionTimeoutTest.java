package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

/**
 * G-PERF medium: the analyzer extracts the whole sealed project inside the session's one
 * {@code analyze} command (about 37 s for the medium class's 25 MiB of TS/JS), while every other
 * request is bounded by the 30 s per-request timeout. The analyze command gets that timeout once
 * per single-request budget (10 MiB) of source it carries.
 */
class TsProjectSessionTimeoutTest {

    private static final String ID = "0123456789abcdef0123456789abcdef";
    private final JsonMapper json = JsonMapper.builder().build();
    private final List<String> ops = new ArrayList<>();
    private HttpServer server;

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    @Test
    void analyzeCommandOfAProjectOverOneRequestBudgetOutlastsThePerRequestTimeout() throws Exception {
        // 11 MB of source: two single-request budgets, so the analyze command may take 2 x 1 s.
        server = analyzer(Duration.ofMillis(1_500));
        TsAnalyzerClient client = new TsAnalyzerClient(
                new TsAnalyzerProperties(
                        "http://127.0.0.1:" + server.getAddress().getPort(), 1),
                RestClient.builder());
        List<String> paths = new ArrayList<>();
        TsProjectSession.ManifestBuilder manifest = new TsProjectSession.ManifestBuilder();
        for (int i = 0; i < 11; i++) {
            paths.add("%02d.ts".formatted(i));
            manifest.add(paths.getLast(), "x".repeat(1_000_000));
        }

        TsAnalyzeDtos.Response response =
                TsProjectSession.analyze(client, paths, manifest.build(), path -> "x".repeat(1_000_000));

        assertThat(response).isNotNull();
        assertThat(ops).containsSubsequence("open", "seal", "analyze", "close");
        assertThat(TsProjectSession.analyzeTimeout(client, manifest.build())).isEqualTo(Duration.ofSeconds(2));
    }

    @Test
    void analyzeTimeoutIsTheRequestTimeoutPerStartedRequestBudget() {
        TsAnalyzerClient client = new TsAnalyzerClient(new TsAnalyzerProperties("", 30), RestClient.builder());
        assertThat(TsProjectSession.analyzeTimeout(client, new TsProjectSession.Manifest(1, 1, "d")))
                .isEqualTo(Duration.ofSeconds(30));
        assertThat(TsProjectSession.analyzeTimeout(
                        client, new TsProjectSession.Manifest(1, TsRequestBudget.MAX_BYTES, "d")))
                .isEqualTo(Duration.ofSeconds(30));
        assertThat(TsProjectSession.analyzeTimeout(client, new TsProjectSession.Manifest(1, 25L * 1024 * 1024, "d")))
                .isEqualTo(Duration.ofSeconds(90));
    }

    /** Answers session commands; {@code analyze} takes {@code extraction} like a real extraction would. */
    private HttpServer analyzer(Duration extraction) throws Exception {
        HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        http.createContext("/analyze", exchange -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> request =
                    json.readValue(exchange.getRequestBody().readAllBytes(), Map.class);
            @SuppressWarnings("unchecked")
            Map<String, Object> command = (Map<String, Object>) request.get("session");
            String op = String.valueOf(command.get("op"));
            synchronized (ops) {
                ops.add(op);
            }
            if (op.equals("analyze")) {
                try {
                    Thread.sleep(extraction);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            String session = op.equals("analyze")
                    ? "{\"id\":\"%s\",\"op\":\"analyze\",\"page\":0,\"pages\":1}".formatted(ID)
                    : "{\"id\":\"%s\",\"op\":\"%s\"%s}"
                            .formatted(ID, op, command.get("seq") == null ? "" : ",\"seq\":" + command.get("seq"));
            byte[] body = ("{\"session\":" + session + "}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            try {
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            } catch (java.io.IOException closedByTimedOutClient) {
                // The client gave up first.
            }
            exchange.close();
        });
        http.start();
        return http;
    }
}
