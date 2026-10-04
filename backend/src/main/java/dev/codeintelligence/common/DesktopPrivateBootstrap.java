package dev.codeintelligence.common;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The sole consumer of the inherited main-to-backend capability pipe. */
@Component
public final class DesktopPrivateBootstrap {
    private static final int MAX_BYTES = 8192;
    private static final JsonFactory WIRE = JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder()
                    .maxDocumentLength(MAX_BYTES)
                    .maxNestingDepth(3)
                    .maxTokenCount(40)
                    .maxNameLength(32)
                    .maxStringLength(512)
                    .maxNumberLength(8)
                    .build())
            .build();

    public record AiChannel(String socketPath, String capability, String epoch) {
        @Override
        public String toString() {
            return "AiChannel[redacted]";
        }
    }

    private final AiChannel ai;
    private final SourceStoreProperties source;

    @Autowired
    public DesktopPrivateBootstrap(Environment environment, JsonMapper json) {
        this(
                environment.getProperty("app.desktop.ai-bootstrap-stdin", Boolean.class, false) ? System.in : null,
                json,
                Duration.ofSeconds(3));
    }

    public DesktopPrivateBootstrap(InputStream input, JsonMapper json, Duration timeout) {
        if (timeout == null
                || timeout.isZero()
                || timeout.isNegative()
                || timeout.compareTo(Duration.ofSeconds(3)) > 0) {
            throw unavailable();
        }
        if (input == null) {
            ai = null;
            source = new SourceStoreProperties("", "");
            return;
        }
        var executor = Executors.newSingleThreadExecutor(Thread.ofVirtual().factory());
        var read = executor.submit(() -> input.readNBytes(MAX_BYTES + 1));
        byte[] bytes = null;
        try {
            bytes = read.get(Math.max(1, timeout.toMillis()), TimeUnit.MILLISECONDS);
            if (bytes.length < 2 || bytes.length > MAX_BYTES) throw unavailable();
            String raw = StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
            JsonNode root;
            try (var parser = WIRE.createParser(raw)) {
                root = json.readTree(parser);
                if (parser.nextToken() != null) throw unavailable();
            }
            exact(root, Set.of("version", "ai", "source"));
            if (!root.get("version").isIntegralNumber()
                    || !root.get("version").canConvertToInt()
                    || root.get("version").intValue() != 2) throw unavailable();
            JsonNode channel = root.get("ai");
            exact(channel, Set.of("socketPath", "capability", "epoch"));
            String socket = text(channel.get("socketPath"));
            String capability = text(channel.get("capability"));
            String epoch = text(channel.get("epoch"));
            validatePath(socket);
            if (!capability.matches("[0-9a-f]{64}") || !epoch.matches("[0-9a-f]{64}")) throw unavailable();
            ai = new AiChannel(socket, capability, epoch);
            JsonNode sourceChannel = root.get("source");
            exact(sourceChannel, Set.of("socketPath", "capability"));
            source = new SourceStoreProperties(
                    text(sourceChannel.get("socketPath")), text(sourceChannel.get("capability")));
            if (!source.enabled() || socket.equals(source.socketPath()) || capability.equals(source.brokerToken()))
                throw unavailable();
        } catch (Exception error) {
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            throw unavailable();
        } finally {
            read.cancel(true);
            try {
                input.close();
            } catch (IOException ignored) {
                /* owned pipe */
            }
            executor.shutdownNow();
            if (bytes != null) Arrays.fill(bytes, (byte) 0);
        }
    }

    public AiChannel ai() {
        return ai;
    }

    public SourceStoreProperties source() {
        return source;
    }

    public static void validatePath(String socket) {
        Path path = Path.of(socket);
        if (!path.isAbsolute()
                || !path.normalize().toString().equals(socket)
                || socket.getBytes(StandardCharsets.UTF_8).length > 100
                || !StandardCharsets.UTF_8.newEncoder().canEncode(socket)) throw unavailable();
    }

    private static String text(JsonNode value) {
        if (value == null || !value.isTextual()) throw unavailable();
        return value.stringValue();
    }

    private static void exact(JsonNode value, Set<String> fields) {
        if (value == null
                || !value.isObject()
                || value.size() != fields.size()
                || !Set.copyOf(value.propertyNames()).equals(fields)) throw unavailable();
    }

    private static IllegalStateException unavailable() {
        return new IllegalStateException("Private desktop bootstrap unavailable.");
    }

    @Override
    public String toString() {
        return "DesktopPrivateBootstrap[redacted]";
    }
}
