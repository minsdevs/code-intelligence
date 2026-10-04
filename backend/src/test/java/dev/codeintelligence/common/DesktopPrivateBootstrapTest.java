package dev.codeintelligence.common;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.ai.AiMainGatewayClient;
import dev.codeintelligence.source.SourceStoreClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import tools.jackson.databind.json.JsonMapper;

class DesktopPrivateBootstrapTest {
    private static final JsonMapper JSON = new JsonMapper();
    private static final String AI_TOKEN = "a".repeat(64);
    private static final String SOURCE_TOKEN = "b".repeat(64);

    private static String socket(String name) {
        return Path.of(System.getProperty("java.io.tmpdir"))
                .toAbsolutePath()
                .getRoot()
                .resolve("ci-bootstrap-fixture")
                .resolve(name)
                .toString();
    }

    private static Map<String, Object> envelope() {
        return new LinkedHashMap<>(Map.of(
                "version",
                2,
                "ai",
                Map.of("socketPath", socket("a.sock"), "capability", AI_TOKEN, "epoch", "c".repeat(64)),
                "source",
                Map.of("socketPath", socket("s.sock"), "capability", SOURCE_TOKEN)));
    }

    @Test
    void bothProductionClientsShareOneBoundedOwnedPipeRead() {
        class Input extends ByteArrayInputStream {
            int reads;
            boolean closed;
            byte[] returned;

            Input() {
                super(JSON.writeValueAsBytes(envelope()));
            }

            @Override
            public byte[] readNBytes(int maximum) throws IOException {
                reads++;
                assertThat(maximum).isEqualTo(8193);
                returned = super.readNBytes(maximum);
                return returned;
            }

            @Override
            public void close() throws IOException {
                closed = true;
                super.close();
            }
        }
        var input = new Input();
        var bootstrap = new DesktopPrivateBootstrap(input, JSON, Duration.ofSeconds(3));
        var ai = new AiMainGatewayClient(bootstrap, JSON);
        var source = new SourceStoreClient(bootstrap, JSON);
        assertThat(ai.enabled()).isTrue();
        assertThat(source.enabled()).isTrue();
        assertThat(input.reads).isEqualTo(1);
        assertThat(input.closed).isTrue();
        assertThat(input.returned).containsOnly((byte) 0);
        assertThat(bootstrap.source().brokerToken()).isEqualTo(SOURCE_TOKEN);
        assertThat(bootstrap.toString()).doesNotContain(AI_TOKEN, SOURCE_TOKEN, socket("s.sock"));
        assertThat(bootstrap.ai().toString()).isEqualTo("AiChannel[redacted]");
    }

    @Test
    void environmentCapabilitiesCannotEnableEitherProductionClient() {
        var environment = new MockEnvironment()
                .withProperty("app.source-store.socket-path", socket("s.sock"))
                .withProperty("app.source-store.broker-token", SOURCE_TOKEN)
                .withProperty("app.desktop.ai-token", AI_TOKEN);
        var bootstrap = new DesktopPrivateBootstrap(environment, JSON);
        assertThat(new AiMainGatewayClient(bootstrap, JSON).enabled()).isFalse();
        assertThat(new SourceStoreClient(bootstrap, JSON).enabled()).isFalse();
    }

    @Test
    void malformedOrCrossWiredSourceCannotLeaveAiEnabled() {
        for (var source : new Object[] {
            Map.of(),
            Map.of("socketPath", socket("s.sock"), "capability", AI_TOKEN),
            Map.of("socketPath", socket("a.sock"), "capability", SOURCE_TOKEN),
            Map.of("socketPath", socket("s.sock"), "capability", SOURCE_TOKEN + "\n"),
            Map.of("socketPath", "relative.sock", "capability", SOURCE_TOKEN),
            Map.of("socketPath", socket("s.sock"), "capability", SOURCE_TOKEN, "extra", true)
        }) {
            var envelope = envelope();
            envelope.put("source", source);
            assertThatThrownBy(() -> new DesktopPrivateBootstrap(
                            new ByteArrayInputStream(JSON.writeValueAsBytes(envelope)), JSON, Duration.ofSeconds(3)))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("Private desktop bootstrap unavailable.")
                    .hasNoCause();
        }
    }
}
