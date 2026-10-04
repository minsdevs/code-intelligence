package dev.codeintelligence.source;

import dev.codeintelligence.common.DesktopPrivateBootstrap;
import dev.codeintelligence.common.SourceStoreProperties;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.SocketChannel;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
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

/**
 * One bounded request per private Unix socket connection. Project/job authorization belongs to
 * callers; this bridge has no arbitrary-path, key-export, TCP or process-execution operations.
 */
@Component
public class SourceStoreClient {
    static final int MAX_BYTES = 2 * 1024 * 1024;
    static final int MAX_FRAME = 3 * 1024 * 1024;
    private static final Duration MAX_DEADLINE = Duration.ofSeconds(10);
    private static final Set<String> SUCCESS_FIELDS = Set.of("version", "requestId", "ok", "result");
    private static final Set<String> FAILURE_FIELDS = Set.of("version", "requestId", "ok", "code");
    private static final Set<String> PUT_FIELDS = Set.of("sha256", "byteSize", "keyId");
    private static final Set<String> READ_FIELDS = Set.of("sha256", "byteSize", "bytes");
    private static final Set<String> BROKER_CODES = Set.of(
            "SOURCE_BROKER_UNAVAILABLE",
            "SOURCE_BROKER_INVALID",
            "SOURCE_BROKER_UNSUPPORTED",
            "SOURCE_BROKER_UNAUTHORIZED");
    private static final JsonFactory RESPONSE_JSON = JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder()
                    .maxDocumentLength(MAX_FRAME)
                    .maxNestingDepth(3)
                    .maxTokenCount(64)
                    .maxNameLength(32)
                    .maxStringLength(4 * ((MAX_BYTES + 2) / 3))
                    .maxNumberLength(20)
                    .build())
            .build();

    public record StoredBlob(String sha256, long byteSize, String keyId) {}

    private final SourceStoreProperties properties;
    private final JsonMapper json;
    private final long deadlineNanos;

    @Autowired
    public SourceStoreClient(DesktopPrivateBootstrap bootstrap, JsonMapper json) {
        this(bootstrap.source(), json, MAX_DEADLINE);
    }

    SourceStoreClient(SourceStoreProperties properties, JsonMapper json) {
        this(properties, json, MAX_DEADLINE);
    }

    SourceStoreClient(SourceStoreProperties properties, JsonMapper json, Duration deadline) {
        if (deadline == null || deadline.isZero() || deadline.isNegative() || deadline.compareTo(MAX_DEADLINE) > 0) {
            throw new IllegalArgumentException("Invalid source store deadline");
        }
        this.properties = properties;
        this.json = json;
        this.deadlineNanos = deadline.toNanos();
    }

    public boolean enabled() {
        return properties.enabled();
    }

    public StoredBlob put(long projectId, byte[] bytes) {
        requireEnabled();
        if (bytes == null) throw SourceStoreException.invalidRequest();
        validateInput(projectId, bytes.length);
        Deadline deadline = new Deadline();
        byte[] owned = bytes.clone();
        String sha256 = sha256(owned);
        String requestId = UUID.randomUUID().toString();
        Map<String, Object> request = request(requestId, "PUT", projectId, sha256, owned.length);
        request.put("bytes", Base64.getEncoder().encodeToString(owned));
        JsonNode result = exchange(request, requestId, deadline);
        exactFields(result, PUT_FIELDS);
        verifyAddress(result, sha256, owned.length);
        String keyId = text(result.get("keyId"));
        if (!keyId.matches("[0-9a-f]{32}")) throw SourceStoreException.integrity();
        deadline.check();
        return new StoredBlob(sha256, owned.length, keyId);
    }

    public byte[] read(long projectId, String sha256, long byteSize) {
        requireEnabled();
        validateInput(projectId, byteSize);
        if (sha256 == null || !sha256.matches("[0-9a-f]{64}")) throw SourceStoreException.invalidRequest();
        Deadline deadline = new Deadline();
        String requestId = UUID.randomUUID().toString();
        JsonNode result = exchange(request(requestId, "READ", projectId, sha256, byteSize), requestId, deadline);
        exactFields(result, READ_FIELDS);
        verifyAddress(result, sha256, byteSize);
        String encoded = text(result.get("bytes"));
        if (encoded.length() != 4 * ((byteSize + 2) / 3)) throw SourceStoreException.integrity();
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException ex) {
            throw SourceStoreException.integrity();
        }
        if (bytes.length != byteSize
                || !Base64.getEncoder().encodeToString(bytes).equals(encoded)
                || !sha256(bytes).equals(sha256)) throw SourceStoreException.integrity();
        deadline.check();
        return bytes;
    }

    private Map<String, Object> request(String id, String operation, long project, String hash, long size) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("version", 1);
        request.put("requestId", id);
        request.put("auth", properties.brokerToken());
        request.put("operation", operation);
        request.put("projectId", Long.toString(project));
        request.put("sha256", hash);
        request.put("byteSize", size);
        return request;
    }

    private JsonNode exchange(Map<String, Object> request, String requestId, Deadline deadline) {
        try {
            byte[] payload = json.writeValueAsBytes(request);
            if (payload.length < 2 || payload.length > MAX_FRAME) throw SourceStoreException.invalidRequest();
            deadline.check();
            try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX);
                    Selector selector = Selector.open()) {
                channel.configureBlocking(false);
                SelectionKey key = channel.register(selector, 0);
                if (!channel.connect(UnixDomainSocketAddress.of(properties.socketPath()))) {
                    while (!channel.finishConnect()) ready(selector, key, SelectionKey.OP_CONNECT, deadline);
                }
                ByteBuffer outgoing = ByteBuffer.allocate(4 + payload.length)
                        .putInt(payload.length)
                        .put(payload);
                outgoing.flip();
                while (outgoing.hasRemaining()) {
                    deadline.check();
                    if (channel.write(outgoing) == 0) ready(selector, key, SelectionKey.OP_WRITE, deadline);
                }
                channel.shutdownOutput();
                ByteBuffer prefix = ByteBuffer.allocate(4);
                readFully(channel, selector, key, prefix, deadline);
                int length = prefix.flip().getInt();
                if (length < 2 || length > MAX_FRAME) throw SourceStoreException.integrity();
                ByteBuffer incoming = ByteBuffer.allocate(length);
                readFully(channel, selector, key, incoming, deadline);
                // A response is complete only after the broker's FIN. Reject any extra bytes/frame.
                ByteBuffer extra = ByteBuffer.allocate(1);
                while (true) {
                    deadline.check();
                    int count = channel.read(extra);
                    if (count < 0) break;
                    if (count > 0) throw SourceStoreException.integrity();
                    ready(selector, key, SelectionKey.OP_READ, deadline);
                }
                return response(incoming.array(), requestId, deadline);
            }
        } catch (SourceStoreException ex) {
            throw ex;
        } catch (IOException | RuntimeException ex) {
            throw SourceStoreException.unavailable();
        }
    }

    private JsonNode response(byte[] bytes, String requestId, Deadline deadline) {
        try {
            String body = StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
            try (var parser = RESPONSE_JSON.createParser(body)) {
                JsonNode response = json.readTree(parser);
                if (parser.nextToken() != null) throw SourceStoreException.integrity();
                if (response == null || !response.isObject()) throw SourceStoreException.integrity();
                JsonNode ok = response.get("ok");
                if (ok == null || !ok.isBoolean()) throw SourceStoreException.integrity();
                exactFields(response, ok.booleanValue() ? SUCCESS_FIELDS : FAILURE_FIELDS);
                JsonNode version = response.get("version");
                if (!version.isIntegralNumber()
                        || !version.canConvertToInt()
                        || version.intValue() != 1
                        || !requestId.equals(text(response.get("requestId")))) throw SourceStoreException.integrity();
                deadline.check();
                if (!ok.booleanValue()) {
                    if (!BROKER_CODES.contains(text(response.get("code")))) throw SourceStoreException.integrity();
                    throw SourceStoreException.unavailable();
                }
                return response.get("result");
            }
        } catch (SourceStoreException ex) {
            throw ex;
        } catch (IOException | RuntimeException ex) {
            throw SourceStoreException.integrity();
        }
    }

    private static void readFully(
            SocketChannel channel, Selector selector, SelectionKey key, ByteBuffer buffer, Deadline deadline)
            throws IOException {
        while (buffer.hasRemaining()) {
            deadline.check();
            int count = channel.read(buffer);
            if (count < 0) throw SourceStoreException.integrity();
            if (count == 0) ready(selector, key, SelectionKey.OP_READ, deadline);
        }
    }

    private static void ready(Selector selector, SelectionKey key, int interest, Deadline deadline) throws IOException {
        key.interestOps(interest);
        selector.selectedKeys().clear();
        selector.select(Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline.remaining())));
        deadline.check();
    }

    private static void exactFields(JsonNode value, Set<String> fields) {
        if (value == null
                || !value.isObject()
                || value.size() != fields.size()
                || !Set.copyOf(value.propertyNames()).equals(fields)) throw SourceStoreException.integrity();
    }

    private static String text(JsonNode value) {
        if (value == null || !value.isTextual()) throw SourceStoreException.integrity();
        return value.stringValue();
    }

    private static void verifyAddress(JsonNode result, String sha256, long size) {
        JsonNode returnedSize = result.get("byteSize");
        if (!sha256.equals(text(result.get("sha256")))
                || !returnedSize.isIntegralNumber()
                || !returnedSize.canConvertToLong()
                || returnedSize.longValue() != size) throw SourceStoreException.integrity();
    }

    private void requireEnabled() {
        if (!enabled()) throw SourceStoreException.disabled();
    }

    private static void validateInput(long project, long size) {
        if (project <= 0 || size < 0 || size > MAX_BYTES) throw SourceStoreException.invalidRequest();
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException ex) {
            throw SourceStoreException.unavailable();
        }
    }

    private final class Deadline {
        private final long started = System.nanoTime();

        long remaining() {
            long remaining = deadlineNanos - (System.nanoTime() - started);
            if (remaining <= 0 || Thread.currentThread().isInterrupted()) throw SourceStoreException.unavailable();
            return remaining;
        }

        void check() {
            remaining();
        }
    }
}
