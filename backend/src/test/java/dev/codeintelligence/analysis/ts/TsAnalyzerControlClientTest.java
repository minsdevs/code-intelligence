package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.common.RecoveryActionFailure;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** ADR-01 backend control path against a fake desktop main on a real Unix-domain socket. */
class TsAnalyzerControlClientTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String CAPABILITY = "c3".repeat(32);

    /** Accepts one framed request per connection and answers with the scripted frame (or nothing). */
    static final class FakeDesktopMain implements AutoCloseable {
        final Path directory;
        final Path socket;
        final List<JsonNode> requests = new CopyOnWriteArrayList<>();
        private final ServerSocketChannel server;
        private final Thread thread;

        FakeDesktopMain(Function<JsonNode, byte[]> answer) throws IOException {
            // A short private parent keeps the path within sun_path (104 bytes on macOS).
            directory = Files.createTempDirectory(Path.of("/tmp"), "ci-ctl-");
            socket = directory.resolve("c.sock");
            server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
            server.bind(UnixDomainSocketAddress.of(socket));
            thread = Thread.ofVirtual().start(() -> {
                while (server.isOpen()) {
                    try (SocketChannel connection = server.accept()) {
                        ByteBuffer prefix = read(connection, 4);
                        JsonNode request =
                                JSON.readTree(read(connection, prefix.getInt()).array());
                        requests.add(request);
                        byte[] response = answer.apply(request);
                        if (response == null) {
                            Thread.sleep(5_000);
                            continue;
                        }
                        ByteBuffer out = ByteBuffer.allocate(4 + response.length)
                                .putInt(response.length)
                                .put(response)
                                .flip();
                        while (out.hasRemaining()) connection.write(out);
                    } catch (IOException | InterruptedException | RuntimeException e) {
                        if (!server.isOpen()) return;
                    }
                }
            });
        }

        static ByteBuffer read(SocketChannel channel, int length) throws IOException {
            ByteBuffer buffer = ByteBuffer.allocate(length);
            while (buffer.hasRemaining()) if (channel.read(buffer) < 0) throw new IOException("closed");
            return buffer.flip();
        }

        TsAnalyzerClient client(int timeoutSeconds) {
            return new TsAnalyzerClient(
                    new TsAnalyzerProperties("", timeoutSeconds, "", "", socket.toString(), CAPABILITY),
                    RestClient.builder());
        }

        @Override
        public void close() throws IOException {
            server.close();
            thread.interrupt();
            Files.deleteIfExists(socket);
            Files.deleteIfExists(directory);
        }
    }

    private static byte[] bytes(String json) {
        return json.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void sendsTheCapabilityAndTheBudgetedRequestAndMapsTheResult() throws Exception {
        try (var main =
                new FakeDesktopMain(request -> "health".equals(request.get("op").stringValue())
                        ? bytes("{\"ok\":true,\"result\":{}}")
                        : bytes(
                                "{\"ok\":true,\"result\":{\"apiCalls\":[{\"method\":\"GET\",\"url\":\"/api/items\",\"filePath\":\"src/a.ts\","
                                        + "\"lineStart\":1,\"owner\":\"f\"}],\"unknownField\":1}}"))) {
            var client = main.client(5);
            assertThat(client.enabled()).isTrue();
            client.health();
            var request = new TsAnalyzeDtos.Request(
                    List.of(new TsAnalyzeDtos.FilePayload("src/a.ts", "fetch('/api/items')")));
            var response = client.analyze(request);
            assertThat(response.apiCalls())
                    .extracting(TsAnalyzeDtos.ApiCallHit::url)
                    .containsExactly("/api/items");
            assertThat(main.requests).hasSize(2);
            assertThat(JSON.writeValueAsString(main.requests.get(0)))
                    .isEqualTo("{\"capability\":\"" + CAPABILITY + "\",\"op\":\"health\"}");
            JsonNode analyze = main.requests.get(1);
            assertThat(analyze.get("capability").stringValue()).isEqualTo(CAPABILITY);
            assertThat(analyze.get("op").stringValue()).isEqualTo("analyze");
            assertThat(JSON.writeValueAsBytes(analyze.get("body"))).isEqualTo(TsRequestBudget.encode(request));
        }
    }

    @Test
    void anUnavailableIsolationFailsTheJobWithItsRecoveryCodeAndASafeMessage() throws Exception {
        try (var main = new FakeDesktopMain(request -> bytes(
                "{\"ok\":false,\"code\":\"ADAPTER_ISOLATION_UNAVAILABLE\",\"reason\":\"SUPERVISOR_HASH_MISMATCH\"}"))) {
            var client = main.client(5);
            assertThatThrownBy(client::health)
                    .isInstanceOf(TsAdapterIsolationException.class)
                    .isInstanceOf(RecoveryActionFailure.class)
                    .hasNoCause()
                    .hasMessage("TypeScript/JavaScript analysis isolation is unavailable (SUPERVISOR_HASH_MISMATCH); "
                            + "the analysis did not run. Reinstall or update the app.")
                    .satisfies(error -> assertThat(((RecoveryActionFailure) error).failureCode())
                            .isEqualTo("ADAPTER_ISOLATION_UNAVAILABLE"));
        }
        try (var main = new FakeDesktopMain(request ->
                bytes("{\"ok\":false,\"code\":\"ADAPTER_ISOLATION_UNAVAILABLE\",\"reason\":\"/Users/x <script>\"}"))) {
            assertThatThrownBy(() -> main.client(5).analyze(new TsAnalyzeDtos.Request(List.of())))
                    .isInstanceOf(TsAdapterIsolationException.class)
                    .hasMessageContaining("(UNKNOWN)")
                    .hasMessageNotContaining("/Users");
        }
    }

    @Test
    void adapterRejectionsKeepTheSyntaxContractAndOtherFailuresCarryNoText() throws Exception {
        JsonNode fixture;
        try (var stream = getClass().getResourceAsStream("/fixtures/ts-syntax-error.json")) {
            fixture = JSON.readTree(stream);
        }
        byte[] syntax = bytes("{\"ok\":false,\"error\":{\"status\":400,\"response\":"
                + JSON.writeValueAsString(fixture.get("response")) + "}}");
        try (var main = new FakeDesktopMain(request -> syntax)) {
            assertThatThrownBy(() -> main.client(5).analyze(new TsAnalyzeDtos.Request(List.of())))
                    .isInstanceOf(TsSyntaxInputException.class)
                    .hasMessage(fixture.get("jobError").stringValue());
        }
        for (String answer : List.of(
                "{\"ok\":false,\"code\":\"CAPABILITY_REJECTED\"}",
                "{\"ok\":false,\"code\":\"ANALYZER_FAILURE\",\"detail\":\"" + CAPABILITY + " source marker\"}",
                "{\"ok\":true,\"result\":[]}",
                "[]")) {
            try (var main = new FakeDesktopMain(request -> bytes(answer))) {
                assertThatThrownBy(() -> main.client(5).analyze(new TsAnalyzeDtos.Request(List.of())))
                        .isExactlyInstanceOf(TsAnalyzerException.class)
                        .hasNoCause()
                        .hasMessageNotContaining(CAPABILITY)
                        .hasMessageNotContaining("source marker");
            }
        }
    }

    /** G-PERF medium on wFroXK: a refused session command failed the job with no code and no cause. */
    @Test
    void anAnalyzerRejectionWithoutSyntaxDiagnosticsFailsTheJobWithItsCode() throws Exception {
        String rejected = "{\"ok\":false,\"error\":{\"status\":400,\"response\":{\"statusCode\":400,\"code\":\"%s\","
                + "\"message\":\"source marker\",\"retryable\":false}}}";
        for (var expected : List.of(
                List.of(rejected.formatted("SESSION_UNKNOWN"), "SESSION_UNKNOWN", "TS_ANALYZER_REJECTED"),
                List.of(rejected.formatted("ANALYSIS_LIMIT"), "ANALYSIS_LIMIT", "ANALYSIS_LIMIT"),
                List.of(rejected.formatted("/Users/x " + CAPABILITY), "UNKNOWN", "TS_ANALYZER_REJECTED"),
                List.of(
                        "{\"ok\":false,\"error\":{\"status\":400,\"response\":{\"message\":\"source marker\"}}}",
                        "UNKNOWN",
                        "TS_ANALYZER_REJECTED"),
                List.of("{\"ok\":false,\"code\":\"ANALYSIS_LIMIT\"}", "ANALYSIS_LIMIT", "ANALYSIS_LIMIT"))) {
            try (var main = new FakeDesktopMain(request -> bytes(expected.get(0)))) {
                assertThatThrownBy(() -> main.client(5).analyze(new TsAnalyzeDtos.Request(List.of())))
                        .isInstanceOf(TsAnalyzerException.class)
                        .isInstanceOf(RecoveryActionFailure.class)
                        .hasNoCause()
                        .hasMessage("ts-analyzer rejected the analysis request (" + expected.get(1) + ")")
                        .satisfies(error -> assertThat(((RecoveryActionFailure) error).failureCode())
                                .isEqualTo(expected.get(2)));
            }
        }
    }

    @Test
    void anUnansweredOrOversizedResponseFailsWithinTheTimeout() throws Exception {
        try (var main = new FakeDesktopMain(request -> null)) {
            long started = System.nanoTime();
            assertThatThrownBy(() -> main.client(1).health()).isExactlyInstanceOf(TsAnalyzerException.class);
            assertThat(System.nanoTime() - started).isLessThan(4_000_000_000L);
        }
        try (var main = new FakeDesktopMain(request -> null)) {
            Files.delete(main.socket);
            assertThatThrownBy(() -> main.client(1).health())
                    .isExactlyInstanceOf(TsAnalyzerException.class)
                    .hasMessage("ts-analyzer control request failed");
        }
    }

    /** The packaged path of the sealed session's analyze command, which has its own longer bound. */
    @Test
    void aRequestWithItsOwnTimeoutOutlastsTheConfiguredOne() throws Exception {
        try (var main = new FakeDesktopMain(request -> {
            try {
                Thread.sleep(1_500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return bytes("{\"ok\":true,\"result\":{}}");
        })) {
            var client = main.client(1);
            assertThatThrownBy(() -> client.analyze(new TsAnalyzeDtos.Request(List.of())))
                    .isExactlyInstanceOf(TsAnalyzerException.class);
            assertThat(client.analyze(new TsAnalyzeDtos.Request(List.of()), java.time.Duration.ofSeconds(3)))
                    .isNotNull();
        }
    }

    @Test
    void anInterruptedJobThreadEndsTheExchangeAndKeepsItsInterruptStatus() throws Exception {
        try (var main = new FakeDesktopMain(request -> null)) {
            var client = main.client(30);
            var outcome = new java.util.concurrent.atomic.AtomicReference<Object>();
            Thread job = Thread.ofPlatform().start(() -> {
                try {
                    client.health();
                    outcome.set("returned");
                } catch (TsAnalyzerException e) {
                    outcome.set(List.of(e.getMessage(), Thread.currentThread().isInterrupted()));
                }
            });
            while (main.requests.isEmpty()) Thread.sleep(10);
            job.interrupt();
            job.join(5_000);
            assertThat(outcome.get()).isEqualTo(List.of("ts-analyzer request interrupted", true));
        }
    }
}
