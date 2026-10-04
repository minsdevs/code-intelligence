package dev.codeintelligence.ai;

import dev.codeintelligence.common.DesktopPrivateBootstrap;
import java.io.IOException;
import java.io.InputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.SocketChannel;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** No TCP, retry or environment/argv capability. Main supplies one bounded bootstrap on stdin. */
@Component
public final class AiMainGatewayClient {
    private static final int MAX_REQUEST = 2 * 1024 * 1024;
    private static final int MAX_RESPONSE = 4 * 1024 * 1024;
    private static final Set<String> OPERATIONS = Set.of(
            "STATUS",
            "QUOTE",
            "APPROVE",
            "EXECUTE",
            "LATCH",
            "ACTIVATE",
            "DISPATCH_PROOF",
            "USAGE_PROOF",
            "SETTLEMENT_PROOF",
            "JOURNAL",
            "ENROLLMENT");
    private static final JsonFactory WIRE_JSON = JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder()
                    .maxDocumentLength(MAX_RESPONSE)
                    .maxNestingDepth(20)
                    .maxTokenCount(250000)
                    .maxNameLength(128)
                    .maxStringLength(3 * 1024 * 1024)
                    .maxNumberLength(32)
                    .build())
            .build();

    private final DesktopPrivateBootstrap.AiChannel bootstrap;
    private final JsonMapper json;
    private final Duration requestDeadline;

    @Autowired
    public AiMainGatewayClient(DesktopPrivateBootstrap bootstrap, JsonMapper json) {
        this.json = json;
        this.requestDeadline = Duration.ofSeconds(90);
        this.bootstrap = bootstrap.ai();
    }

    AiMainGatewayClient(InputStream input, JsonMapper json, Duration deadline) {
        if (deadline == null
                || deadline.isNegative()
                || deadline.isZero()
                || deadline.compareTo(Duration.ofSeconds(90)) > 0) throw unavailable();
        this.json = json;
        this.requestDeadline = deadline;
        try {
            if (input == null) throw unavailable();
            this.bootstrap = new DesktopPrivateBootstrap(
                            input,
                            json,
                            deadline.compareTo(Duration.ofSeconds(3)) > 0 ? Duration.ofSeconds(3) : deadline)
                    .ai();
        } catch (RuntimeException error) {
            throw unavailable();
        }
    }

    public boolean enabled() {
        return bootstrap != null;
    }

    public String channelEpoch() {
        if (!enabled()) throw unavailable();
        return bootstrap.epoch();
    }

    public JsonNode exchange(String operation, Map<String, ?> payload) {
        if (!enabled() || operation == null || !OPERATIONS.contains(operation) || payload == null) throw unavailable();
        String callId = UUID.randomUUID().toString();
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("version", 1);
        request.put("auth", bootstrap.capability());
        request.put("epoch", bootstrap.epoch());
        request.put("callId", callId);
        request.put("operation", operation);
        request.put("payload", payload);
        byte[] body = null;
        ByteBuffer outgoing = null;
        ByteBuffer incoming = null;
        Deadline deadline = new Deadline(requestDeadline);
        try {
            body = json.writeValueAsBytes(request);
            if (body.length < 2 || body.length > MAX_REQUEST) throw unavailable();
            try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX);
                    Selector selector = Selector.open()) {
                channel.configureBlocking(false);
                SelectionKey key = channel.register(selector, 0);
                if (!channel.connect(UnixDomainSocketAddress.of(bootstrap.socketPath()))) {
                    while (!channel.finishConnect()) ready(selector, key, SelectionKey.OP_CONNECT, deadline);
                }
                outgoing =
                        ByteBuffer.allocate(body.length + 4).putInt(body.length).put(body);
                outgoing.flip();
                while (outgoing.hasRemaining()) {
                    deadline.check();
                    if (channel.write(outgoing) == 0) ready(selector, key, SelectionKey.OP_WRITE, deadline);
                }
                channel.shutdownOutput();
                ByteBuffer prefix = ByteBuffer.allocate(4);
                readFully(channel, selector, key, prefix, deadline);
                int length = prefix.flip().getInt();
                if (length < 2 || length > MAX_RESPONSE) throw unavailable();
                incoming = ByteBuffer.allocate(length);
                readFully(channel, selector, key, incoming, deadline);
                ByteBuffer extra = ByteBuffer.allocate(1);
                while (true) {
                    deadline.check();
                    int count = channel.read(extra);
                    if (count < 0) break;
                    if (count > 0) throw unavailable();
                    ready(selector, key, SelectionKey.OP_READ, deadline);
                }
                JsonNode response = decode(incoming.array(), json);
                boolean ok = response.has("ok")
                        && response.get("ok").isBoolean()
                        && response.get("ok").booleanValue();
                exact(
                        response,
                        ok ? Set.of("version", "callId", "ok", "result") : Set.of("version", "callId", "ok", "code"));
                if (!response.get("version").isIntegralNumber()
                        || !response.get("version").canConvertToInt()
                        || response.get("version").intValue() != 1
                        || !callId.equals(text(response.get("callId")))
                        || !ok) throw unavailable();
                deadline.check();
                return response.get("result");
            }
        } catch (IOException | RuntimeException failure) {
            // Exception messages/causes can contain protocol bodies. Do not attach them.
            throw unavailable();
        } finally {
            request.clear();
            if (body != null) Arrays.fill(body, (byte) 0);
            if (outgoing != null) Arrays.fill(outgoing.array(), (byte) 0);
            if (incoming != null) Arrays.fill(incoming.array(), (byte) 0);
        }
    }

    private static JsonNode decode(byte[] bytes, JsonMapper json) throws IOException {
        String raw = StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString();
        try (var parser = WIRE_JSON.createParser(raw)) {
            JsonNode value = json.readTree(parser);
            if (parser.nextToken() != null) throw unavailable();
            return value;
        }
    }

    private static void exact(JsonNode value, Set<String> fields) {
        if (value == null
                || !value.isObject()
                || value.size() != fields.size()
                || !Set.copyOf(value.propertyNames()).equals(fields)) throw unavailable();
    }

    private static String text(JsonNode value) {
        if (value == null || !value.isTextual()) throw unavailable();
        return value.stringValue();
    }

    private static AiSafetyUnavailableException unavailable() {
        return new AiSafetyUnavailableException();
    }

    private static void readFully(
            SocketChannel channel, Selector selector, SelectionKey key, ByteBuffer buffer, Deadline deadline)
            throws IOException {
        while (buffer.hasRemaining()) {
            deadline.check();
            int count = channel.read(buffer);
            if (count < 0) throw unavailable();
            if (count == 0) ready(selector, key, SelectionKey.OP_READ, deadline);
        }
    }

    private static void ready(Selector selector, SelectionKey key, int interest, Deadline deadline) throws IOException {
        key.interestOps(interest);
        selector.selectedKeys().clear();
        selector.select(Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline.remaining())));
        deadline.check();
    }

    private static final class Deadline {
        private final long start = System.nanoTime();
        private final long duration;

        Deadline(Duration duration) {
            this.duration = duration.toNanos();
        }

        long remaining() {
            long left = duration - (System.nanoTime() - start);
            if (left <= 0 || Thread.currentThread().isInterrupted()) throw unavailable();
            return left;
        }

        void check() {
            remaining();
        }
    }
}
