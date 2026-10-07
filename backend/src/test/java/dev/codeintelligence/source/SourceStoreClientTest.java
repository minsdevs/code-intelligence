package dev.codeintelligence.source;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.common.SourceStoreProperties;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Disposable real Unix sockets; no Electron process, TCP, real keyring or user source is touched. */
@Timeout(15)
class SourceStoreClientTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String TOKEN = "a".repeat(64);
    private static final String KEY = "b".repeat(32);
    private static final byte[] BODY = "AAAA".getBytes(StandardCharsets.UTF_8);
    private static final String SESSION = "c".repeat(32);

    @ParameterizedTest
    @ValueSource(ints = {0, 1, SourceStoreClient.MAX_BYTES})
    void putUsesTheExactVersionedFrameAndAcceptsTheInclusiveByteLimit(int size) throws Exception {
        byte[] bytes = new byte[size];
        Arrays.fill(bytes, (byte) 'A');
        String hash = hash(bytes);
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            assertThat(Set.copyOf(request.propertyNames()))
                    .isEqualTo(Set.of(
                            "version", "requestId", "auth", "operation", "projectId", "sha256", "byteSize", "bytes"));
            assertThat(request.get("version").intValue()).isEqualTo(1);
            assertThat(request.get("requestId").stringValue())
                    .matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
            assertThat(request.get("auth").stringValue()).isEqualTo(TOKEN);
            assertThat(request.get("operation").stringValue()).isEqualTo("PUT");
            assertThat(request.get("projectId").stringValue()).isEqualTo(Long.toString(Long.MAX_VALUE));
            assertThat(request.get("sha256").stringValue()).isEqualTo(hash);
            assertThat(request.get("byteSize").intValue()).isEqualTo(size);
            assertThat(Base64.getDecoder().decode(request.get("bytes").stringValue()))
                    .isEqualTo(bytes);
            write(socket, frame(success(request, Map.of("sha256", hash, "byteSize", size, "keyId", KEY))));
        })) {
            var stored = server.client().put(Long.MAX_VALUE, bytes);
            assertThat(stored).isEqualTo(new SourceStoreClient.StoredBlob(hash, size, KEY));
            server.completed();
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {0, 1, SourceStoreClient.MAX_BYTES})
    void readVerifiesTheExactReturnedBytesAtBothBoundaries(int size) throws Exception {
        byte[] bytes = new byte[size];
        Arrays.fill(bytes, (byte) 0xc7);
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            assertThat(Set.copyOf(request.propertyNames()))
                    .isEqualTo(Set.of("version", "requestId", "auth", "operation", "projectId", "sha256", "byteSize"));
            assertThat(request.get("operation").stringValue()).isEqualTo("READ");
            assertThat(request.get("projectId").stringValue()).isEqualTo("17");
            assertThat(request.get("sha256").stringValue()).isEqualTo(hash(bytes));
            assertThat(request.get("byteSize").longValue()).isEqualTo(size);
            write(socket, frame(success(request, readResult(bytes))));
        })) {
            byte[] returned = server.client().read(17, hash(bytes), size);
            assertThat(returned).isEqualTo(bytes).isNotSameAs(bytes);
            server.completed();
        }
    }

    @Test
    void stageSendsAStagedPutAndReturnsTheVaultSessionWatermark() throws Exception {
        String hash = hash(BODY);
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            assertThat(Set.copyOf(request.propertyNames()))
                    .isEqualTo(Set.of(
                            "version", "requestId", "auth", "operation", "projectId", "sha256", "byteSize", "bytes"));
            assertThat(request.get("operation").stringValue()).isEqualTo("STAGE");
            assertThat(Base64.getDecoder().decode(request.get("bytes").stringValue()))
                    .isEqualTo(BODY);
            write(socket, frame(success(request, stagedResult(hash))));
        })) {
            var staged = server.client().stage(3, BODY);
            assertThat(staged).isEqualTo(new SourceStoreClient.StagedBlob(hash, BODY.length, KEY, SESSION, 7));
            assertThat(staged.blob()).isEqualTo(new SourceStoreClient.StoredBlob(hash, BODY.length, KEY));
            server.completed();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"session", "session-type", "sequence-zero", "sequence-type", "missing", "extra", "hash"})
    void stageRejectsAnInvalidSessionWatermark(String attack) throws Exception {
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            Map<String, Object> result = stagedResult(hash(BODY));
            switch (attack) {
                case "session" -> result.put("session", "C".repeat(32));
                case "session-type" -> result.put("session", 1);
                case "sequence-zero" -> result.put("sequence", 0);
                case "sequence-type" -> result.put("sequence", "7");
                case "missing" -> result.remove("session");
                case "extra" -> result.put("path", "/private-fixture");
                case "hash" -> result.put("sha256", "0".repeat(64));
                default -> throw new AssertionError(attack);
            }
            write(socket, frame(success(request, result)));
        })) {
            fails(() -> server.client().stage(3, BODY), "SOURCE_STORE_INTEGRITY");
            server.completed();
        }
    }

    @Test
    void barrierSendsOnlyTheSessionWatermarkAndRequiresItsExactAcknowledgment() throws Exception {
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            assertThat(Set.copyOf(request.propertyNames()))
                    .isEqualTo(Set.of("version", "requestId", "auth", "operation", "session", "sequence"));
            assertThat(request.get("operation").stringValue()).isEqualTo("BARRIER");
            assertThat(request.get("session").stringValue()).isEqualTo(SESSION);
            assertThat(request.get("sequence").longValue()).isEqualTo(7);
            write(socket, frame(success(request, Map.of("session", SESSION, "sequence", 7))));
        })) {
            server.client().barrier(SESSION, 7);
            server.completed();
        }
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            write(socket, frame(success(request, Map.of("session", SESSION, "sequence", 6))));
        })) {
            fails(() -> server.client().barrier(SESSION, 7), "SOURCE_STORE_INTEGRITY");
            server.completed();
        }
    }

    @Test
    void invalidBarrierInputsAreRejectedBeforeAnyConnection() {
        var client = configuredClient("/tmp/ci-missing-barrier.sock");
        fails(() -> client.barrier("C".repeat(32), 1), "SOURCE_STORE_INVALID_REQUEST");
        fails(() -> client.barrier(null, 1), "SOURCE_STORE_INVALID_REQUEST");
        fails(() -> client.barrier(SESSION, 0), "SOURCE_STORE_INVALID_REQUEST");
        fails(() -> client.stage(0, BODY), "SOURCE_STORE_INVALID_REQUEST");
    }

    @Test
    void callerMutationAfterSendingCannotChangeThePutReceipt() throws Exception {
        byte[] bytes = BODY.clone();
        String expected = hash(bytes);
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            Arrays.fill(bytes, (byte) 'Z');
            assertThat(Base64.getDecoder().decode(request.get("bytes").stringValue()))
                    .isEqualTo(BODY);
            write(socket, frame(success(request, Map.of("sha256", expected, "byteSize", BODY.length, "keyId", KEY))));
        })) {
            assertThat(server.client().put(1, bytes).sha256()).isEqualTo(expected);
            assertThat(bytes).containsOnly((byte) 'Z');
            server.completed();
        }
    }

    @Test
    void fragmentedHeaderAndBodyAreReadToCompletion() throws Exception {
        try (var server = new FakeServer(socket -> {
            byte[] framed = frame(success(request(socket), readResult(BODY)));
            for (int start = 0; start < framed.length; start += 3) {
                write(socket, Arrays.copyOfRange(framed, start, Math.min(start + 3, framed.length)));
                Thread.sleep(1);
            }
        })) {
            assertThat(server.client().read(1, hash(BODY), BODY.length)).isEqualTo(BODY);
            server.completed();
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "version",
                "version-type",
                "version-float",
                "request-id",
                "request-id-type",
                "missing-id",
                "ok-type",
                "extra-field",
                "extra-result",
                "hash",
                "size",
                "size-type",
                "size-float",
                "bytes-hash",
                "base64",
                "base64-padding",
                "base64-length",
                "duplicate-field",
                "duplicate-result",
                "trailing-json",
                "array",
                "null",
                "depth",
                "tokens",
                "utf8",
                "malformed",
                "unknown-error",
                "error-extra-field"
            })
    void rejectsMalformedOrSubstitutedReadResponses(String attack) throws Exception {
        try (var server =
                new FakeServer(socket -> write(socket, framedBody(attackedResponse(request(socket), attack))))) {
            fails(() -> server.client().read(1, hash(BODY), BODY.length), "SOURCE_STORE_INTEGRITY");
            server.completed();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"key", "key-type", "extra", "hash", "size", "missing"})
    void putRejectsInvalidAcknowledgmentMetadata(String attack) throws Exception {
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            Map<String, Object> result =
                    new LinkedHashMap<>(Map.of("sha256", hash(BODY), "byteSize", BODY.length, "keyId", KEY));
            switch (attack) {
                case "key" -> result.put("keyId", "../../private-fixture");
                case "key-type" -> result.put("keyId", 123);
                case "extra" -> result.put("rootKey", TOKEN);
                case "hash" -> result.put("sha256", "0".repeat(64));
                case "size" -> result.put("byteSize", BODY.length + 1);
                case "missing" -> result.remove("keyId");
                default -> throw new AssertionError(attack);
            }
            write(socket, frame(success(request, result)));
        })) {
            fails(() -> server.client().put(1, BODY), "SOURCE_STORE_INTEGRITY");
            server.completed();
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "SOURCE_BROKER_UNAVAILABLE",
                "SOURCE_BROKER_INVALID",
                "SOURCE_BROKER_UNSUPPORTED",
                "SOURCE_BROKER_UNAUTHORIZED"
            })
    void validBrokerFailureIsUnavailableWithoutCopyingItsDetails(String code) throws Exception {
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            write(
                    socket,
                    frame(Map.of(
                            "version",
                            1,
                            "requestId",
                            request.get("requestId").stringValue(),
                            "ok",
                            false,
                            "code",
                            code)));
        })) {
            fails(() -> server.client().read(1, hash(BODY), BODY.length), "SOURCE_STORE_UNAVAILABLE");
            server.completed();
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "negative",
                "zero",
                "one",
                "oversized",
                "truncated-header",
                "truncated-body",
                "trailing-byte",
                "second-frame"
            })
    void rejectsInvalidTransportFrames(String attack) throws Exception {
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            byte[] good = frame(success(request, readResult(BODY)));
            byte[] invalid =
                    switch (attack) {
                        case "negative" -> ByteBuffer.allocate(4).putInt(-1).array();
                        case "zero" -> ByteBuffer.allocate(4).putInt(0).array();
                        case "one" -> ByteBuffer.allocate(4).putInt(1).array();
                        case "oversized" ->
                            ByteBuffer.allocate(4)
                                    .putInt(SourceStoreClient.MAX_FRAME + 1)
                                    .array();
                        case "truncated-header" -> new byte[] {0, 0, 1};
                        case "truncated-body" ->
                            ByteBuffer.allocate(6)
                                    .putInt(100)
                                    .put((byte) '{')
                                    .put((byte) '}')
                                    .array();
                        case "trailing-byte" ->
                            ByteBuffer.allocate(good.length + 1)
                                    .put(good)
                                    .put((byte) 0)
                                    .array();
                        case "second-frame" ->
                            ByteBuffer.allocate(2 * good.length)
                                    .put(good)
                                    .put(good)
                                    .array();
                        default -> throw new AssertionError(attack);
                    };
            write(socket, invalid);
        })) {
            fails(() -> server.client().read(1, hash(BODY), BODY.length), "SOURCE_STORE_INTEGRITY");
            server.completed();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"response", "eof", "write"})
    void anOverallDeadlineBoundsEveryWaitingPhase(String phase) throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        try (var server = new FakeServer(socket -> {
            if (!"write".equals(phase)) {
                JsonNode request = request(socket);
                if ("eof".equals(phase)) write(socket, frame(success(request, readResult(BODY))));
            }
            if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("Fixture was not released");
        })) {
            SourceStoreClient client = server.client(Duration.ofMillis("write".equals(phase) ? 1000 : 200));
            long started = System.nanoTime();
            try {
                if ("write".equals(phase)) {
                    fails(() -> client.put(1, new byte[SourceStoreClient.MAX_BYTES]), "SOURCE_STORE_UNAVAILABLE");
                } else {
                    fails(() -> client.read(1, hash(BODY), BODY.length), "SOURCE_STORE_UNAVAILABLE");
                }
                assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(3));
            } finally {
                release.countDown();
            }
            server.completed();
        }
    }

    @Test
    void slowProgressDoesNotResetTheOverallDeadline() throws Exception {
        try (var server = new FakeServer(socket -> {
            JsonNode request = request(socket);
            byte[] response = frame(success(request, readResult(BODY)));
            for (byte next : response) {
                try {
                    write(socket, new byte[] {next});
                } catch (IOException closedByDeadline) {
                    return;
                }
                Thread.sleep(40);
            }
        })) {
            long started = System.nanoTime();
            fails(
                    () -> server.client(Duration.ofMillis(200)).read(1, hash(BODY), BODY.length),
                    "SOURCE_STORE_UNAVAILABLE");
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(3));
        }
    }

    @Test
    void interruptedRequestFailsAndPreservesTheInterruptFlag() throws Exception {
        SourceStoreClient client = configuredClient("/tmp/ci-source-absent-" + UUID.randomUUID());
        try {
            Thread.currentThread().interrupt();
            fails(() -> client.read(1, hash(BODY), BODY.length), "SOURCE_STORE_UNAVAILABLE");
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    void unavailableSocketDoesNotFallBackOrExposeItsPath() {
        String path = "/tmp/private-fixture-" + UUID.randomUUID();
        fails(() -> configuredClient(path).read(1, hash(BODY), BODY.length), "SOURCE_STORE_UNAVAILABLE");
    }

    @Test
    void bothBlankPropertiesDisableTheClientWithoutOpeningASocket() {
        for (var properties : List.of(new SourceStoreProperties(null, null), new SourceStoreProperties(" ", "\t"))) {
            var client = new SourceStoreClient(properties, JSON);
            assertThat(properties.enabled()).isFalse();
            assertThat(client.enabled()).isFalse();
            fails(() -> client.put(1, BODY), "SOURCE_STORE_DISABLED");
            fails(() -> client.read(1, hash(BODY), BODY.length), "SOURCE_STORE_DISABLED");
        }
    }

    @ParameterizedTest
    @MethodSource("invalidProperties")
    void partialOrMalformedConfigurationFailsWithSafeText(String path, String token) {
        assertThatThrownBy(() -> new SourceStoreProperties(path, token))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("app.source-store requires a valid local socket and broker capability")
                .hasNoCause();
    }

    private static Stream<Arguments> invalidProperties() {
        return Stream.of(
                Arguments.of("/tmp/broker", ""),
                Arguments.of("", TOKEN),
                Arguments.of(null, TOKEN),
                Arguments.of("/tmp/broker", null),
                Arguments.of("/tmp/broker", "A".repeat(64)),
                Arguments.of("/tmp/broker", "a".repeat(63)),
                Arguments.of("/tmp/broker", " " + TOKEN),
                Arguments.of("relative/socket", TOKEN),
                Arguments.of("http://127.0.0.1:99", TOKEN),
                Arguments.of("/tmp/a/../broker", TOKEN),
                Arguments.of("/tmp/broker/", TOKEN),
                Arguments.of("/tmp/" + "x".repeat(100), TOKEN),
                Arguments.of("/tmp/invalid\u0000socket", TOKEN));
    }

    @Test
    void configurationPrintingRedactsTheCapabilityAndSocket() {
        var properties = new SourceStoreProperties("/tmp/private-fixture.sock", TOKEN);
        assertThat(properties.toString()).isEqualTo("SourceStoreProperties[enabled=true]");
    }

    @Test
    void invalidInputsAreRejectedBeforeAnyConnection() {
        SourceStoreClient client = configuredClient("/tmp/ci-source-absent-" + UUID.randomUUID());
        for (long project : new long[] {0, -1, Long.MIN_VALUE}) {
            fails(() -> client.put(project, BODY), "SOURCE_STORE_INVALID_REQUEST");
            fails(() -> client.read(project, hash(BODY), BODY.length), "SOURCE_STORE_INVALID_REQUEST");
        }
        fails(() -> client.put(1, null), "SOURCE_STORE_INVALID_REQUEST");
        fails(() -> client.put(1, new byte[SourceStoreClient.MAX_BYTES + 1]), "SOURCE_STORE_INVALID_REQUEST");
        for (long size : new long[] {-1, SourceStoreClient.MAX_BYTES + 1L, Long.MAX_VALUE}) {
            fails(() -> client.read(1, hash(BODY), size), "SOURCE_STORE_INVALID_REQUEST");
        }
        for (String hash : new String[] {null, "", "A".repeat(64), "a".repeat(63), "../private-fixture"}) {
            fails(() -> client.read(1, hash, BODY.length), "SOURCE_STORE_INVALID_REQUEST");
        }
    }

    @Test
    void testDeadlinesCannotDisableOrExpandTheProductionBound() {
        for (Duration invalid : List.of(Duration.ZERO, Duration.ofNanos(-1), Duration.ofSeconds(11))) {
            assertThatThrownBy(() -> new SourceStoreClient(new SourceStoreProperties("", ""), JSON, invalid))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    private static byte[] attackedResponse(JsonNode request, String attack) {
        Map<String, Object> result = new LinkedHashMap<>(readResult(BODY));
        Map<String, Object> response = success(request, result);
        switch (attack) {
            case "version" -> response.put("version", 2);
            case "version-type" -> response.put("version", "1");
            case "version-float" -> response.put("version", 1.0);
            case "request-id" -> response.put("requestId", UUID.randomUUID().toString());
            case "request-id-type" -> response.put("requestId", 1);
            case "missing-id" -> response.remove("requestId");
            case "ok-type" -> response.put("ok", "true");
            case "extra-field" -> response.put("auth", TOKEN);
            case "extra-result" -> result.put("path", "/private-fixture/secret.txt");
            case "hash" -> result.put("sha256", "0".repeat(64));
            case "size" -> result.put("byteSize", BODY.length + 1);
            case "size-type" -> result.put("byteSize", "4");
            case "size-float" -> result.put("byteSize", 4.0);
            case "bytes-hash" ->
                result.put("bytes", Base64.getEncoder().encodeToString("EVIL".getBytes(StandardCharsets.UTF_8)));
            case "base64" -> result.put("bytes", "!!!!!!!!");
            case "base64-padding" -> result.put("bytes", "QUFBQR==");
            case "base64-length" -> result.put("bytes", "");
            case "unknown-error", "error-extra-field" -> {
                response.remove("result");
                response.put("ok", false);
                response.put(
                        "code",
                        attack.equals("unknown-error") ? "/private-fixture/" + TOKEN : "SOURCE_BROKER_UNAVAILABLE");
                if (attack.equals("error-extra-field")) response.put("message", TOKEN);
            }
            case "utf8" -> {
                return new byte[] {(byte) 0xc3, 0x28};
            }
            case "array" -> {
                return "[]".getBytes(StandardCharsets.UTF_8);
            }
            case "null" -> {
                return "null".getBytes(StandardCharsets.UTF_8);
            }
            case "depth" -> {
                return "{\"x\":{\"x\":{\"x\":{\"x\":1}}}}".getBytes(StandardCharsets.UTF_8);
            }
            case "tokens" -> {
                return ("[" + "0,".repeat(80) + "0]").getBytes(StandardCharsets.UTF_8);
            }
            case "malformed" -> {
                return "{private-fixture".getBytes(StandardCharsets.UTF_8);
            }
            case "duplicate-field", "duplicate-result", "trailing-json" -> {
                String good = JSON.writeValueAsString(response);
                return switch (attack) {
                    case "duplicate-field" ->
                        good.replace("\"version\":1", "\"version\":1,\"version\":1")
                                .getBytes(StandardCharsets.UTF_8);
                    case "duplicate-result" ->
                        good.replace("\"byteSize\":4", "\"byteSize\":4,\"byteSize\":4")
                                .getBytes(StandardCharsets.UTF_8);
                    default -> (good + "{}").getBytes(StandardCharsets.UTF_8);
                };
            }
            default -> throw new AssertionError(attack);
        }
        return JSON.writeValueAsBytes(response);
    }

    private static Map<String, Object> success(JsonNode request, Map<String, Object> result) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("version", 1);
        response.put("requestId", request.get("requestId").stringValue());
        response.put("ok", true);
        response.put("result", result);
        return response;
    }

    private static Map<String, Object> stagedResult(String hash) {
        return new LinkedHashMap<>(
                Map.of("sha256", hash, "byteSize", BODY.length, "keyId", KEY, "session", SESSION, "sequence", 7));
    }

    private static Map<String, Object> readResult(byte[] bytes) {
        return Map.of(
                "sha256",
                hash(bytes),
                "byteSize",
                bytes.length,
                "bytes",
                Base64.getEncoder().encodeToString(bytes));
    }

    private static byte[] frame(Object value) {
        return framedBody(JSON.writeValueAsBytes(value));
    }

    private static byte[] framedBody(byte[] bytes) {
        return ByteBuffer.allocate(4 + bytes.length)
                .putInt(bytes.length)
                .put(bytes)
                .array();
    }

    private static JsonNode request(SocketChannel socket) throws IOException {
        ByteBuffer prefix = ByteBuffer.allocate(4);
        readFully(socket, prefix);
        int size = prefix.flip().getInt();
        assertThat(size).isBetween(2, SourceStoreClient.MAX_FRAME);
        ByteBuffer body = ByteBuffer.allocate(size);
        readFully(socket, body);
        assertThat(socket.read(ByteBuffer.allocate(1))).isEqualTo(-1);
        return JSON.readTree(body.array());
    }

    private static void readFully(SocketChannel socket, ByteBuffer bytes) throws IOException {
        while (bytes.hasRemaining()) {
            if (socket.read(bytes) < 0) throw new IOException("Fixture peer closed early");
        }
    }

    private static void write(SocketChannel socket, byte[] bytes) throws IOException {
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (buffer.hasRemaining()) socket.write(buffer);
    }

    private static String hash(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private static SourceStoreClient configuredClient(String socket) {
        return new SourceStoreClient(new SourceStoreProperties(socket, TOKEN), JSON, Duration.ofSeconds(5));
    }

    private static void fails(ThrowingCallable operation, String code) {
        assertThatThrownBy(operation)
                .isInstanceOf(SourceStoreException.class)
                .hasMessage(code)
                .hasNoCause()
                .satisfies(error -> {
                    assertThat(((SourceStoreException) error).code()).isEqualTo(code);
                    assertThat(error.getSuppressed()).isEmpty();
                });
    }

    @FunctionalInterface
    private interface Script {
        void run(SocketChannel socket) throws Exception;
    }

    private static final class FakeServer implements AutoCloseable {
        private final Path directory;
        private final Path socketPath;
        private final ServerSocketChannel listener;
        private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
        private final Future<?> script;
        private volatile SocketChannel peer;

        FakeServer(Script script) throws IOException {
            directory = Files.createTempDirectory(Path.of("/tmp"), "ci-ss-");
            socketPath = directory.resolve("broker.sock");
            listener = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
            listener.bind(UnixDomainSocketAddress.of(socketPath));
            this.script = executor.submit(() -> {
                try (SocketChannel socket = listener.accept()) {
                    peer = socket;
                    script.run(socket);
                    return null;
                }
            });
        }

        SourceStoreClient client() {
            return client(Duration.ofSeconds(5));
        }

        SourceStoreClient client(Duration deadline) {
            return new SourceStoreClient(new SourceStoreProperties(socketPath.toString(), TOKEN), JSON, deadline);
        }

        void completed() throws Exception {
            script.get(5, TimeUnit.SECONDS);
        }

        @Override
        public void close() throws Exception {
            listener.close();
            if (peer != null) peer.close();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
            Files.deleteIfExists(socketPath);
            Files.deleteIfExists(directory);
        }
    }
}
