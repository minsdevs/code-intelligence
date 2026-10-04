package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.common.DesktopPrivateBootstrap;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.Arrays;
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
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.env.MockEnvironment;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Real disposable Unix sockets plus Java -> real Node bridge interoperability. No Spring context,
 * provider, keyring, TCP, user data or inherited secrets. Node receives only public synthetic channel
 * material, a cleared minimal environment, and closes its bridge when its owned stdin reaches EOF.
 */
@Timeout(20)
class AiMainGatewayClientTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String CAPABILITY = "a".repeat(64);
    private static final String EPOCH = "b".repeat(64);
    private static final String PUBLIC_SECRET_SENTINEL = "public-synthetic-private-cause";
    private static final int MAX_BOOTSTRAP = 8192;
    private static final int MAX_REQUEST = 2 * 1024 * 1024;
    private static final int MAX_RESPONSE = 4 * 1024 * 1024;

    @Test
    void oneExactAuthenticatedRequestIsFollowedByFinBeforeTheServerResponds() throws Exception {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestId", UUID.randomUUID().toString());
        payload.put("question", "한글·emoji 🧪\nquoted \"text\" and slash / remain exact");
        payload.put("maximumMicroUsd", "9223372036854775807");
        payload.put("selected", List.of("source", "note"));
        try (var server = new FakeServer(socket -> {
            JsonNode request = requestAndFin(socket);
            assertThat(Set.copyOf(request.propertyNames()))
                    .isEqualTo(Set.of("version", "auth", "epoch", "callId", "operation", "payload"));
            assertThat(request.get("version").intValue()).isEqualTo(1);
            assertThat(request.get("auth").stringValue()).isEqualTo(CAPABILITY);
            assertThat(request.get("epoch").stringValue()).isEqualTo(EPOCH);
            assertThat(request.get("operation").stringValue()).isEqualTo("EXECUTE");
            assertThat(request.get("callId").stringValue())
                    .matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
            assertThat(request.get("payload")).isEqualTo(JSON.valueToTree(payload));
            write(socket, frame(success(request, Map.of("accepted", true))));
        })) {
            AiMainGatewayClient client = server.client();
            assertThat(client.enabled()).isTrue();
            assertThat(client.channelEpoch()).isEqualTo(EPOCH).hasSize(64);
            assertThat(client.exchange("EXECUTE", payload).get("accepted").booleanValue())
                    .isTrue();
            server.completed();
            server.assertOnlyOneConnection();
        }
    }

    @Test
    void requestFrameAcceptsTheInclusiveLimitAndRejectsOneByteMoreBeforeConnecting() throws Exception {
        int envelopeSize = JSON.writeValueAsBytes(envelope("EXECUTE", Map.of("text", ""))).length;
        String atLimit = "x".repeat(MAX_REQUEST - envelopeSize);
        try (var server = new FakeServer(socket -> {
            JsonNode request = requestAndFin(socket);
            assertThat(JSON.writeValueAsBytes(request)).hasSize(MAX_REQUEST);
            write(socket, frame(success(request, Map.of("accepted", true))));
        })) {
            assertThat(server.client()
                            .exchange("EXECUTE", Map.of("text", atLimit))
                            .get("accepted")
                            .booleanValue())
                    .isTrue();
            server.completed();
            server.assertOnlyOneConnection();
        }
        try (var listener = new ListeningOnly()) {
            fails(() -> listener.client().exchange("EXECUTE", Map.of("text", atLimit + "x")));
            listener.assertNeverConnected();
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "version",
                "version-type",
                "version-float",
                "version-overflow",
                "wrong-call-id",
                "missing-call-id",
                "call-id-type",
                "ok-type",
                "missing-result",
                "extra-field",
                "duplicate-envelope",
                "duplicate-result",
                "invalid-utf8",
                "malformed-json",
                "trailing-json",
                "array",
                "null",
                "depth",
                "long-name",
                "long-string",
                "token-count",
                "remote-error",
                "remote-secret-error"
            })
    void invalidResponseNeverReturnsPayloadOrCopiesProtocolSecrets(String attack) throws Exception {
        try (var server = new FakeServer(socket -> {
            JsonNode request = requestAndFin(socket);
            write(socket, frameBytes(attackedResponse(request, attack)));
        })) {
            fails(() -> server.client().exchange("STATUS", Map.of()));
            server.completed();
            server.assertOnlyOneConnection();
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
    void invalidTransportFramesAreRejectedWithoutAnotherConnection(String attack) throws Exception {
        try (var server = new FakeServer(socket -> {
            JsonNode request = requestAndFin(socket);
            byte[] good = frame(success(request, Map.of("ready", true)));
            byte[] invalid =
                    switch (attack) {
                        case "negative" -> ByteBuffer.allocate(4).putInt(-1).array();
                        case "zero" -> ByteBuffer.allocate(4).putInt(0).array();
                        case "one" -> ByteBuffer.allocate(4).putInt(1).array();
                        case "oversized" ->
                            ByteBuffer.allocate(4).putInt(MAX_RESPONSE + 1).array();
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
                            ByteBuffer.allocate(good.length * 2)
                                    .put(good)
                                    .put(good)
                                    .array();
                        default -> throw new AssertionError(attack);
                    };
            write(socket, invalid);
        })) {
            fails(() -> server.client().exchange("STATUS", Map.of()));
            server.completed();
            server.assertOnlyOneConnection();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"response", "eof", "write"})
    void oneDeadlineBoundsResponseEofAndBlockedWritesWithoutResending(String phase) throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        try (var server = new FakeServer(socket -> {
            if (!phase.equals("write")) {
                JsonNode request = requestAndFin(socket);
                if (phase.equals("eof")) write(socket, frame(success(request, Map.of("ready", true))));
            }
            if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("Fixture was not released");
        })) {
            AiMainGatewayClient client = server.client(Duration.ofMillis(phase.equals("write") ? 1000 : 200));
            long started = System.nanoTime();
            try {
                fails(() -> client.exchange(
                        "EXECUTE", phase.equals("write") ? Map.of("text", "x".repeat(MAX_REQUEST - 1024)) : Map.of()));
                assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(3));
            } finally {
                release.countDown();
            }
            server.completed();
            server.assertOnlyOneConnection();
        }
    }

    @Test
    void slowlyArrivingResponseBytesDoNotResetTheOverallDeadline() throws Exception {
        try (var server = new FakeServer(socket -> {
            JsonNode request = requestAndFin(socket);
            byte[] bytes = frame(success(request, Map.of("ready", true)));
            for (byte value : bytes) {
                try {
                    write(socket, new byte[] {value});
                } catch (IOException closedAtDeadline) {
                    return;
                }
                Thread.sleep(40);
            }
        })) {
            long started = System.nanoTime();
            fails(() -> server.client(Duration.ofMillis(200)).exchange("STATUS", Map.of()));
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(3));
            server.completed();
            server.assertOnlyOneConnection();
        }
    }

    @Test
    void completeBootstrapWaitsForEofAndClosesItsOwnedInputOnTimeout() {
        WaitingInput input = new WaitingInput(bootstrap("/private/tmp/synthetic-not-opened.sock"));
        long started = System.nanoTime();

        fails(() -> new AiMainGatewayClient(input, JSON, Duration.ofMillis(100)));

        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(3));
        assertThat(input.closed).isTrue();
        assertThat(input.waiting.getCount()).isZero();
    }

    @Test
    void bootstrapReadIsBoundedAndOwnedTemporaryBytesAreCleared() {
        byte[] valid = bootstrap("/private/tmp/synthetic-not-opened.sock");
        byte[] inclusive = Arrays.copyOf(valid, MAX_BOOTSTRAP);
        Arrays.fill(inclusive, valid.length, inclusive.length, (byte) ' ');
        TrackingInput input = new TrackingInput(inclusive);
        AiMainGatewayClient client = new AiMainGatewayClient(input, JSON, Duration.ofSeconds(1));
        assertThat(client.enabled()).isTrue();
        assertThat(input.closed).isTrue();
        assertThat(input.returned).hasSize(MAX_BOOTSTRAP).isEqualTo(new byte[MAX_BOOTSTRAP]);

        TrackingInput oversized = new TrackingInput(new byte[MAX_BOOTSTRAP * 4]);
        fails(() -> new AiMainGatewayClient(oversized, JSON, Duration.ofSeconds(1)));
        assertThat(oversized.bytesRead).isEqualTo(MAX_BOOTSTRAP + 1);
        assertThat(oversized.closed).isTrue();
        assertThat(oversized.returned).isEqualTo(new byte[oversized.returned.length]);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "empty",
                "one-byte",
                "version",
                "version-type",
                "version-float",
                "version-overflow",
                "duplicate",
                "trailing-json",
                "utf8",
                "missing",
                "extra",
                "relative-path",
                "parent-path",
                "trailing-slash",
                "nul-path",
                "long-path",
                "multibyte-path",
                "capability-case",
                "capability-length",
                "capability-type",
                "epoch-case",
                "epoch-newline",
                "main-epoch-uuid"
            })
    void malformedBootstrapFailsClosedWithoutRetainingInputOrRawCause(String attack) {
        TrackingInput input = new TrackingInput(attackedBootstrap(attack));

        fails(() -> new AiMainGatewayClient(input, JSON, Duration.ofSeconds(1)));

        assertThat(input.closed).isTrue();
        assertThat(input.returned).isEqualTo(new byte[input.returned.length]);
    }

    @Test
    void bootstrapInputFailureIsSanitizedAndInputIsStillClosed() {
        TrackingInput input = new TrackingInput(new byte[0]) {
            @Override
            public byte[] readNBytes(int length) throws IOException {
                throw new IOException(PUBLIC_SECRET_SENTINEL + CAPABILITY);
            }
        };
        fails(() -> new AiMainGatewayClient(input, JSON, Duration.ofSeconds(1)));
        assertThat(input.closed).isTrue();
    }

    @Test
    void absentOptInDisablesTheProductionConstructorWithoutReadingTheRealStdin() {
        MockEnvironment environment = new MockEnvironment()
                .withProperty("app.desktop.ai-bootstrap-stdin", "false")
                .withProperty("app.desktop.ai-socket", "/private/tmp/unused.sock")
                .withProperty("app.desktop.ai-token", CAPABILITY);
        AiMainGatewayClient client = new AiMainGatewayClient(new DesktopPrivateBootstrap(environment, JSON), JSON);
        assertThat(client.enabled()).isFalse();
        fails(client::channelEpoch);
        fails(() -> client.exchange("STATUS", Map.of()));
    }

    @ParameterizedTest
    @MethodSource("invalidDeadlines")
    void testDeadlineCannotRemoveOrExpandTheProductionBound(Duration deadline) {
        fails(() -> new AiMainGatewayClient(new ByteArrayInputStream(new byte[0]), JSON, deadline));
    }

    private static Stream<Arguments> invalidDeadlines() {
        return Stream.of(
                Arguments.of((Duration) null),
                Arguments.of(Duration.ZERO),
                Arguments.of(Duration.ofNanos(-1)),
                Arguments.of(Duration.ofSeconds(91)));
    }

    @Test
    void invalidOperationsAndNullPayloadNeverConnectOrExposeAnotherException() throws Exception {
        try (var listener = new ListeningOnly()) {
            AiMainGatewayClient client = listener.client();
            for (String operation : new String[] {null, "", "SEND_URL", "STATUS\n"}) {
                fails(() -> client.exchange(operation, Map.of()));
            }
            fails(() -> client.exchange("STATUS", null));
            listener.assertNeverConnected();
        }
    }

    @Test
    void unavailableSocketHasNoFallbackAndNoSensitiveExceptionCause() {
        AiMainGatewayClient client =
                configured("/private/tmp/ci-ai-absent-" + UUID.randomUUID(), Duration.ofSeconds(1));
        fails(() -> client.exchange("STATUS", Map.of("private", PUBLIC_SECRET_SENTINEL)));
    }

    @Test
    void interruptedRequestPreservesTheInterruptFlag() {
        AiMainGatewayClient client =
                configured("/private/tmp/ci-ai-absent-" + UUID.randomUUID(), Duration.ofSeconds(1));
        try {
            Thread.currentThread().interrupt();
            fails(() -> client.exchange("STATUS", Map.of()));
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    void javaInteroperatesWithTheRealNodeBridgeUsingUnicodeNestedDataAndOneFin() throws Exception {
        try (var node = new NodeBridge()) {
            AiMainGatewayClient client = node.client();
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("question", "로컬 승인 🧪\nquoted \"value\" / path");
            payload.put("maximumMicroUsd", "9223372036854775807");
            payload.put("nested", Map.of("flags", List.of(true, false), "ids", List.of("42", "84")));
            payload.put("nullable", null);

            JsonNode result = client.exchange("QUOTE", payload);

            assertThat(result.get("operation").stringValue()).isEqualTo("QUOTE");
            assertThat(result.get("payload")).isEqualTo(JSON.valueToTree(payload));
            assertThat(result.get("calls").intValue()).isEqualTo(1);
            assertThat(result.toString()).doesNotContain(CAPABILITY, EPOCH);
            assertThat(Files.getPosixFilePermissions(node.socketPath()))
                    .isEqualTo(PosixFilePermissions.fromString("rw-------"));
            node.stopCleanly();
            assertThat(node.socketPath()).doesNotExist();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"capability", "epoch"})
    void nodeRejectsWrongChannelBindingBeforeAnyDomainCall(String field) throws Exception {
        try (var node = new NodeBridge()) {
            AiMainGatewayClient correct = node.client();
            Map<String, Object> forged =
                    new LinkedHashMap<>(bootstrapMap(node.socketPath().toString()));
            ((Map<String, Object>) forged.get("ai")).put(field, "c".repeat(64));
            AiMainGatewayClient wrong = new AiMainGatewayClient(
                    new ByteArrayInputStream(JSON.writeValueAsBytes(forged)), JSON, Duration.ofSeconds(2));
            fails(() -> wrong.exchange("EXECUTE", Map.of("source", PUBLIC_SECRET_SENTINEL)));
            assertThat(correct.exchange("STATUS", Map.of()).get("calls").intValue())
                    .isEqualTo(1);
        }
    }

    @Test
    void nodeHandlerFailureIsStaticAndDoesNotAutomaticallyResend() throws Exception {
        try (var node = new NodeBridge()) {
            AiMainGatewayClient client = node.client();
            fails(() -> client.exchange("EXECUTE", Map.of("mode", "throw")));
            assertThat(client.exchange("STATUS", Map.of()).get("calls").intValue())
                    .isEqualTo(2);
        }
    }

    @Test
    void javaTimeoutDoesNotResendAndStdinEofWaitsForActiveNodeWorkToFinish() throws Exception {
        try (var node = new NodeBridge()) {
            // Keep the Node process startup allowance separate from the short exchange deadline.
            node.client();
            AiMainGatewayClient client = configured(node.socketPath().toString(), Duration.ofMillis(150));
            fails(() -> client.exchange("EXECUTE", Map.of("mode", "delay")));
            // This is a new explicit diagnostic request, not an automatic retry of EXECUTE.
            assertThat(client.exchange("STATUS", Map.of()).get("calls").intValue())
                    .isEqualTo(2);
            node.stopCleanly();
            assertThat(node.socketPath()).doesNotExist();
            assertThat(Files.readString(node.completedFile())).isEqualTo("2");
        }
    }

    private static Map<String, Object> envelope(String operation, Map<String, ?> payload) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("version", 1);
        body.put("auth", CAPABILITY);
        body.put("epoch", EPOCH);
        body.put("callId", "00000000-0000-4000-8000-000000000000");
        body.put("operation", operation);
        body.put("payload", payload);
        return body;
    }

    private static Map<String, Object> bootstrapMap(String socket) {
        return new LinkedHashMap<>(Map.of(
                "version",
                2,
                "ai",
                new LinkedHashMap<>(Map.of("socketPath", socket, "capability", CAPABILITY, "epoch", EPOCH)),
                "source",
                Map.of("socketPath", "/tmp/source-fixture.sock", "capability", "d".repeat(64))));
    }

    private static byte[] bootstrap(String socket) {
        return JSON.writeValueAsBytes(bootstrapMap(socket));
    }

    private static byte[] attackedBootstrap(String attack) {
        Map<String, Object> root = bootstrapMap("/private/tmp/synthetic-private-fixture.sock");
        Map<String, Object> value = (Map<String, Object>) root.get("ai");
        switch (attack) {
            case "empty" -> {
                return new byte[0];
            }
            case "one-byte" -> {
                return new byte[] {'{'};
            }
            case "version" -> root.put("version", 1);
            case "version-type" -> root.put("version", "2");
            case "version-float" -> root.put("version", 2.0);
            case "version-overflow" -> root.put("version", 4294967298L);
            case "missing" -> value.remove("capability");
            case "extra" -> value.put("private", PUBLIC_SECRET_SENTINEL);
            case "relative-path" -> value.put("socketPath", "relative.sock");
            case "parent-path" -> value.put("socketPath", "/private/tmp/a/../b.sock");
            case "trailing-slash" -> value.put("socketPath", "/private/tmp/socket/");
            case "nul-path" -> value.put("socketPath", "/private/tmp/invalid\u0000socket");
            case "long-path" -> value.put("socketPath", "/private/tmp/" + "x".repeat(100));
            case "multibyte-path" -> value.put("socketPath", "/private/tmp/" + "한".repeat(35));
            case "capability-case" -> value.put("capability", "A".repeat(64));
            case "capability-length" -> value.put("capability", "a".repeat(63));
            case "capability-type" -> value.put("capability", 123);
            case "epoch-case" -> value.put("epoch", "B".repeat(64));
            case "epoch-newline" -> value.put("epoch", EPOCH + "\n");
            case "main-epoch-uuid" -> value.put("epoch", UUID.randomUUID().toString());
            case "utf8" -> {
                return new byte[] {(byte) 0xc3, 0x28};
            }
            case "duplicate" -> {
                return JSON.writeValueAsString(root)
                        .replace("\"version\":2", "\"version\":2,\"version\":2")
                        .getBytes(StandardCharsets.UTF_8);
            }
            case "trailing-json" -> {
                return (JSON.writeValueAsString(root) + "{}").getBytes(StandardCharsets.UTF_8);
            }
            default -> throw new AssertionError(attack);
        }
        return JSON.writeValueAsBytes(root);
    }

    private static byte[] attackedResponse(JsonNode request, String attack) {
        Map<String, Object> reply = success(request, Map.of("ready", true));
        switch (attack) {
            case "version" -> reply.put("version", 2);
            case "version-type" -> reply.put("version", "1");
            case "version-float" -> reply.put("version", 1.0);
            case "version-overflow" -> reply.put("version", 4294967297L);
            case "wrong-call-id" -> reply.put("callId", UUID.randomUUID().toString());
            case "missing-call-id" -> reply.remove("callId");
            case "call-id-type" -> reply.put("callId", 1);
            case "ok-type" -> reply.put("ok", "true");
            case "missing-result" -> reply.remove("result");
            case "extra-field" -> reply.put("private", CAPABILITY);
            case "remote-error", "remote-secret-error" -> {
                reply.remove("result");
                reply.put("ok", false);
                reply.put(
                        "code",
                        attack.equals("remote-error") ? "AI_GATEWAY_UNAVAILABLE" : PUBLIC_SECRET_SENTINEL + CAPABILITY);
            }
            case "invalid-utf8" -> {
                return new byte[] {(byte) 0xc3, 0x28};
            }
            case "malformed-json" -> {
                return ("{" + PUBLIC_SECRET_SENTINEL).getBytes(StandardCharsets.UTF_8);
            }
            case "array" -> {
                return "[]".getBytes(StandardCharsets.UTF_8);
            }
            case "null" -> {
                return "null".getBytes(StandardCharsets.UTF_8);
            }
            case "depth" -> {
                return ("[".repeat(25) + "0" + "]".repeat(25)).getBytes(StandardCharsets.UTF_8);
            }
            case "long-name" -> reply.put("x".repeat(129), PUBLIC_SECRET_SENTINEL);
            case "long-string" -> reply.put("result", "x".repeat(3 * 1024 * 1024 + 1));
            case "token-count" -> {
                return ("[" + "0,".repeat(250001) + "0]").getBytes(StandardCharsets.UTF_8);
            }
            case "duplicate-envelope" -> {
                return JSON.writeValueAsString(reply)
                        .replace("\"version\":1", "\"version\":1,\"version\":1")
                        .getBytes(StandardCharsets.UTF_8);
            }
            case "duplicate-result" -> {
                return JSON.writeValueAsString(reply)
                        .replace("\"ready\":true", "\"ready\":true,\"ready\":false")
                        .getBytes(StandardCharsets.UTF_8);
            }
            case "trailing-json" -> {
                return (JSON.writeValueAsString(reply) + "{}").getBytes(StandardCharsets.UTF_8);
            }
            default -> throw new AssertionError(attack);
        }
        return JSON.writeValueAsBytes(reply);
    }

    private static Map<String, Object> success(JsonNode request, Object result) {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("version", 1);
        reply.put("callId", request.get("callId").stringValue());
        reply.put("ok", true);
        reply.put("result", result);
        return reply;
    }

    private static byte[] frame(Object value) {
        return frameBytes(JSON.writeValueAsBytes(value));
    }

    private static byte[] frameBytes(byte[] bytes) {
        return ByteBuffer.allocate(bytes.length + 4)
                .putInt(bytes.length)
                .put(bytes)
                .array();
    }

    private static JsonNode requestAndFin(SocketChannel socket) throws IOException {
        ByteBuffer prefix = ByteBuffer.allocate(4);
        readFully(socket, prefix);
        int length = prefix.flip().getInt();
        assertThat(length).isBetween(2, MAX_REQUEST);
        ByteBuffer bytes = ByteBuffer.allocate(length);
        readFully(socket, bytes);
        // The fixture intentionally refuses to answer until output EOF proves there is one frame.
        assertThat(socket.read(ByteBuffer.allocate(1)))
                .as("one request frame followed by FIN")
                .isEqualTo(-1);
        return JSON.readTree(bytes.array());
    }

    private static void readFully(SocketChannel socket, ByteBuffer target) throws IOException {
        while (target.hasRemaining()) {
            if (socket.read(target) < 0) throw new IOException("Synthetic peer closed early");
        }
    }

    private static void write(SocketChannel socket, byte[] bytes) throws IOException {
        ByteBuffer source = ByteBuffer.wrap(bytes);
        while (source.hasRemaining()) socket.write(source);
    }

    private static AiMainGatewayClient configured(String socket, Duration deadline) {
        return new AiMainGatewayClient(new ByteArrayInputStream(bootstrap(socket)), JSON, deadline);
    }

    private static void fails(ThrowingCallable operation) {
        assertThatThrownBy(operation)
                .isInstanceOf(AiSafetyUnavailableException.class)
                .hasNoCause()
                .satisfies(error -> {
                    AiSafetyUnavailableException safe = (AiSafetyUnavailableException) error;
                    assertThat(safe.getStatusCode().value()).isEqualTo(503);
                    assertThat(safe.getBody().getProperties()).containsEntry("code", "DESKTOP_AI_SAFETY_UNAVAILABLE");
                    assertThat(safe.getSuppressed()).isEmpty();
                    assertThat(safe.toString() + JSON.writeValueAsString(safe.getBody()))
                            .doesNotContain(
                                    CAPABILITY, EPOCH, PUBLIC_SECRET_SENTINEL, "/private/tmp/", "synthetic-private");
                });
    }

    private static Path privateTemporaryDirectory() throws IOException {
        Path directory = Files.createTempDirectory(Path.of("/tmp"), "ci-ai-").toRealPath();
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        return directory;
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
        private final AtomicInteger connections = new AtomicInteger();
        private volatile SocketChannel peer;

        private FakeServer(Script action) throws IOException {
            directory = privateTemporaryDirectory();
            socketPath = directory.resolve("fake.sock");
            listener = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
            listener.bind(UnixDomainSocketAddress.of(socketPath));
            script = executor.submit(() -> {
                try (SocketChannel socket = listener.accept()) {
                    connections.incrementAndGet();
                    peer = socket;
                    action.run(socket);
                    return null;
                }
            });
        }

        private AiMainGatewayClient client() {
            return client(Duration.ofSeconds(5));
        }

        private AiMainGatewayClient client(Duration deadline) {
            return configured(socketPath.toString(), deadline);
        }

        private void completed() throws Exception {
            script.get(5, TimeUnit.SECONDS);
        }

        private void assertOnlyOneConnection() throws IOException {
            assertThat(script.isDone()).isTrue();
            assertThat(connections.get()).isEqualTo(1);
            listener.configureBlocking(false);
            try (SocketChannel retry = listener.accept()) {
                assertThat(retry)
                        .as("There must be no automatic retry queued on the listening socket")
                        .isNull();
            }
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

    private static final class ListeningOnly implements AutoCloseable {
        private final Path directory = privateTemporaryDirectory();
        private final Path socketPath = directory.resolve("unused.sock");
        private final ServerSocketChannel listener = ServerSocketChannel.open(StandardProtocolFamily.UNIX);

        private ListeningOnly() throws IOException {
            listener.bind(UnixDomainSocketAddress.of(socketPath));
            listener.configureBlocking(false);
        }

        private AiMainGatewayClient client() {
            return configured(socketPath.toString(), Duration.ofSeconds(1));
        }

        private void assertNeverConnected() throws IOException {
            try (SocketChannel unexpected = listener.accept()) {
                assertThat(unexpected).isNull();
            }
        }

        @Override
        public void close() throws IOException {
            listener.close();
            Files.deleteIfExists(socketPath);
            Files.deleteIfExists(directory);
        }
    }

    private static class TrackingInput extends InputStream {
        private final ByteArrayInputStream delegate;
        private int bytesRead;
        private byte[] returned;
        private boolean closed;

        private TrackingInput(byte[] bytes) {
            delegate = new ByteArrayInputStream(bytes);
        }

        @Override
        public int read() {
            int value = delegate.read();
            if (value >= 0) bytesRead++;
            return value;
        }

        @Override
        public int read(byte[] bytes, int offset, int length) {
            int count = delegate.read(bytes, offset, length);
            if (count > 0) bytesRead += count;
            return count;
        }

        @Override
        public byte[] readNBytes(int length) throws IOException {
            returned = super.readNBytes(length);
            return returned;
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    private static final class WaitingInput extends InputStream {
        private final ByteArrayInputStream prefix;
        private final CountDownLatch waiting = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private volatile boolean closed;

        private WaitingInput(byte[] bytes) {
            prefix = new ByteArrayInputStream(bytes);
        }

        @Override
        public int read() throws IOException {
            int value = prefix.read();
            if (value >= 0) return value;
            waiting.countDown();
            try {
                release.await();
                return -1;
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException("Synthetic bootstrap interrupted");
            }
        }

        @Override
        public void close() {
            closed = true;
            release.countDown();
        }
    }

    private static final class NodeBridge implements AutoCloseable {
        private static final String SCRIPT = """
                'use strict';
                const fs = require('node:fs/promises');
                const syncFs = require('node:fs');
                const path = require('node:path');
                const { openAiEgressBridge } = require(process.argv[2]);
                const directory = process.argv[3];
                const capability = 'a'.repeat(64);
                const epoch = 'b'.repeat(64);
                let calls = 0;
                let completed = 0;
                let bridge;
                let closing;
                const close = () => closing ||= (async () => {
                  await bridge.close();
                  await fs.writeFile(path.join(directory, 'completed.txt'), String(completed), {mode:0o600});
                })();
                (async () => {
                  bridge = await openAiEgressBridge({ directory, capability, epoch,
                    handler: async (operation, payload) => {
                      calls++;
                      try {
                        if (payload.mode === 'throw') throw new Error('public-synthetic-private-cause' + capability);
                        if (payload.mode === 'delay') await new Promise(resolve => setTimeout(resolve, 500));
                        return { operation, payload, calls };
                      } finally { completed++; }
                    }
                  });
                  process.stdin.resume();
                  process.stdin.once('end', () => close().catch(() => { process.exitCode = 1; }));
                  // Node's process.stdout.end() does not close fd 1 while this bridge stays alive.
                  // Bootstrap is an owned EOF-delimited pipe, so explicitly close that descriptor.
                  const bootstrap = Buffer.from(JSON.stringify({version:2,ai:{socketPath:bridge.socketPath,capability,epoch},
                    source:{socketPath:path.join(directory,'source-unused.sock'),capability:'d'.repeat(64)}}));
                  try { syncFs.writeFileSync(1, bootstrap); }
                  finally { bootstrap.fill(0); syncFs.closeSync(1); }
                })().catch(() => { process.stderr.write('NODE_FIXTURE_FAILED'); process.exitCode = 1; });
                """;

        private final Path directory;
        private final Process process;
        private boolean bootstrapRead;
        private boolean stopped;

        private NodeBridge() throws Exception {
            directory = privateTemporaryDirectory();
            Path script = directory.resolve("fixture.cjs");
            Files.writeString(script, SCRIPT);
            Path module = Path.of("../desktop/src/ai-egress-bridge.cjs").toRealPath();
            Path executable = Stream.of(
                            Path.of("/opt/homebrew/bin/node"), Path.of("/usr/local/bin/node"), Path.of("/usr/bin/node"))
                    .filter(Files::isExecutable)
                    .findFirst()
                    .orElseThrow(() -> new AssertionError("Node executable is required for this integration test"));
            ProcessBuilder builder = new ProcessBuilder(
                    executable.toString(), script.toString(), module.toString(), directory.toString());
            builder.environment().clear();
            builder.environment()
                    .putAll(Map.of(
                            "PATH",
                            "/usr/bin:/bin:/usr/sbin:/sbin",
                            "HOME",
                            directory.toString(),
                            "TMPDIR",
                            directory.toString(),
                            "LANG",
                            "C"));
            builder.directory(directory.toFile());
            builder.redirectError(directory.resolve("node.stderr").toFile());
            process = builder.start();
        }

        private AiMainGatewayClient client() {
            return client(Duration.ofSeconds(3));
        }

        private AiMainGatewayClient client(Duration deadline) {
            if (bootstrapRead) throw new AssertionError("Bootstrap is an owned one-read pipe");
            bootstrapRead = true;
            return new AiMainGatewayClient(process.getInputStream(), JSON, deadline);
        }

        private Path socketPath() {
            return directory.resolve("ai.sock");
        }

        private Path completedFile() {
            return directory.resolve("completed.txt");
        }

        private void stopCleanly() throws Exception {
            if (stopped) return;
            process.getOutputStream().close();
            assertThat(process.waitFor(5, TimeUnit.SECONDS))
                    .as("Node closes the bridge on stdin EOF")
                    .isTrue();
            assertThat(process.exitValue()).isZero();
            assertThat(Files.readString(directory.resolve("node.stderr"))).isEmpty();
            stopped = true;
        }

        @Override
        public void close() throws Exception {
            try {
                stopCleanly();
            } finally {
                if (process.isAlive()) {
                    process.destroyForcibly();
                    process.waitFor(2, TimeUnit.SECONDS);
                }
                process.getInputStream().close();
                process.getErrorStream().close();
                try (var paths = Files.walk(directory)) {
                    for (Path file :
                            paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(file);
                }
            }
        }
    }
}
