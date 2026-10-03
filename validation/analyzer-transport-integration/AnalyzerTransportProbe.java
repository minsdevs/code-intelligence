package dev.codeintelligence.analysis.ts;

import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import javax.net.ssl.SSLHandshakeException;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

/** Fixture-only client. Configuration arrives over stdin, never process arguments or logs. */
public final class AnalyzerTransportProbe {
    public record Configuration(String url, String pin, String token, String mode, String fixture) {}

    public static void main(String[] args) {
        try {
            var json = JsonMapper.builder().build();
            byte[] input = System.in.readNBytes(16385);
            if (input.length > 16384) throw new IllegalArgumentException();
            var config = json.readValue(input, Configuration.class);
            var properties = new TsAnalyzerProperties(config.url(), 5, config.pin(), config.token());
            var client = new TsAnalyzerClient(properties, RestClient.builder());
            var fixture = json.readTree(Files.readAllBytes(Path.of(config.fixture())));
            var request = json.treeToValue(fixture.get("input"), TsAnalyzeDtos.Request.class);
            if ("success".equals(config.mode())) {
                client.health();
                var result = client.analyze(request);
                var endpoint = result.endpoints().stream().filter(hit -> "/audit".equals(hit.path()))
                        .findFirst().orElseThrow();
                if (endpoint.metadata().containsKey("responseType")) throw new AssertionError();
                var method = result.nodes().stream().filter(hit -> "METHOD".equals(hit.type()))
                        .findFirst().orElseThrow();
                if (method.metadata().containsKey("returnType")) throw new AssertionError();
                System.out.println("APPLICATION_TRANSPORT_PASSED");
            } else if ("reject-tls".equals(config.mode())) {
                try {
                    client.analyze(request);
                    throw new AssertionError();
                } catch (TsAnalyzerException expected) {
                    if (!"ts-analyzer request failed".equals(expected.getMessage()) || expected.getCause() != null) {
                        throw new AssertionError();
                    }
                    // The product intentionally redacts pinned TLS provider causes. Check the same
                    // production transport directly as well, so an unrelated client error cannot pass.
                    try (var transport = TsAnalyzerClient.transport(properties).build()) {
                        var wire = HttpRequest.newBuilder(URI.create(config.url() + "/analyze"))
                                .timeout(Duration.ofSeconds(5))
                                .header("Authorization", "Bearer " + config.token())
                                .header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofByteArray(TsRequestBudget.encode(request)))
                                .build();
                        transport.send(wire, HttpResponse.BodyHandlers.discarding());
                        throw new AssertionError();
                    } catch (SSLHandshakeException handshakeExpected) {
                        System.out.println("TLS_REJECTED_BEFORE_HTTP");
                    }
                }
            } else throw new IllegalArgumentException();
        } catch (Throwable failure) {
            // Do not include a nested TLS/provider message or configuration in diagnostics.
            System.err.println("ANALYZER_TRANSPORT_PROBE_FAILED");
            System.exit(1);
        }
    }
}
