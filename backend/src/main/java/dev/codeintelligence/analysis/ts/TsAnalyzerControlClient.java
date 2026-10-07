package dev.codeintelligence.analysis.ts;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedByInterruptException;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * ADR-01 production path: one framed request per connection to the desktop main process's
 * install-private control socket, carrying the capability main issued to this backend process.
 * Frames are the adapter wire (4-byte big-endian length, one JSON object). Main runs the analysis in
 * the sandboxed adapter supervisor; this client never starts or reaches an analyzer itself.
 */
final class TsAnalyzerControlClient {
    static final int MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
                    .streamReadConstraints(StreamReadConstraints.builder()
                            .maxDocumentLength(MAX_RESPONSE_BYTES)
                            .maxStringLength(MAX_RESPONSE_BYTES)
                            .build())
                    .build())
            .build();

    private final Path socket;
    private final String capability;
    private final Duration timeout;

    TsAnalyzerControlClient(TsAnalyzerProperties properties) {
        this.socket = Path.of(properties.controlSocket());
        this.capability = properties.controlCapability();
        this.timeout = Duration.ofSeconds(properties.timeoutSeconds());
    }

    void health() {
        accept(exchange("health", null), "ts-analyzer health failed");
    }

    TsAnalyzeDtos.Response analyze(TsAnalyzeDtos.Request request) {
        JsonNode result = accept(exchange("analyze", TsRequestBudget.encode(request)), "ts-analyzer request failed");
        if (result == null || !result.isObject()) throw new TsAnalyzerException("ts-analyzer request failed", null);
        try {
            return JSON.treeToValue(result, TsAnalyzeDtos.Response.class);
        } catch (RuntimeException e) {
            throw new TsAnalyzerException("ts-analyzer response was invalid", null);
        }
    }

    private JsonNode accept(JsonNode response, String failure) {
        JsonNode ok = response.get("ok");
        if (ok != null && ok.isBoolean() && ok.booleanValue()) return response.get("result");
        JsonNode code = response.get("code");
        if (code != null && TsAdapterIsolationException.CODE.equals(code.asString(""))) {
            JsonNode reason = response.get("reason");
            throw new TsAdapterIsolationException(reason == null ? null : reason.asString(null));
        }
        JsonNode error = response.get("error");
        if (error != null && error.isObject() && error.path("status").asInt(0) == 400) {
            TsSyntaxInputException syntax =
                    TsSyntaxInputException.fromResponse(JSON.writeValueAsBytes(error.get("response")));
            if (syntax != null) throw syntax;
            throw new TsAnalyzerException("ts-analyzer rejected input without a recognized diagnostic", null);
        }
        // Neither the capability nor any response text belongs in job errors.
        throw new TsAnalyzerException(failure, null);
    }

    private JsonNode exchange(String op, byte[] body) {
        byte[] request = envelope(op, body);
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            // Closing the channel unblocks a pending read; an interrupted job thread closes it as well.
            Thread watchdog = Thread.ofVirtual().start(() -> {
                try {
                    Thread.sleep(timeout);
                    channel.close();
                } catch (InterruptedException | IOException ignored) {
                    // The exchange finished first.
                }
            });
            try {
                channel.connect(UnixDomainSocketAddress.of(socket));
                ByteBuffer out = ByteBuffer.allocate(4 + request.length)
                        .putInt(request.length)
                        .put(request)
                        .flip();
                while (out.hasRemaining()) channel.write(out);
                ByteBuffer prefix = readFully(channel, 4);
                int length = prefix.getInt();
                if (length <= 0 || length > MAX_RESPONSE_BYTES) throw new IOException("response frame out of bounds");
                return JSON.readTree(readFully(channel, length).array());
            } finally {
                watchdog.interrupt();
            }
        } catch (ClosedByInterruptException e) {
            Thread.currentThread().interrupt();
            throw new TsAnalyzerException("ts-analyzer request interrupted", null);
        } catch (IOException | RuntimeException e) {
            if (e instanceof TsAnalyzerException analyzer) throw analyzer;
            throw new TsAnalyzerException("ts-analyzer control request failed", null);
        }
    }

    private byte[] envelope(String op, byte[] body) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream((body == null ? 0 : body.length) + 128);
        bytes.writeBytes(
                ("{\"capability\":\"" + capability + "\",\"op\":\"" + op + "\"").getBytes(StandardCharsets.UTF_8));
        if (body != null) {
            bytes.writeBytes(",\"body\":".getBytes(StandardCharsets.UTF_8));
            bytes.writeBytes(body);
        }
        bytes.write('}');
        return bytes.toByteArray();
    }

    private static ByteBuffer readFully(SocketChannel channel, int length) throws IOException {
        ByteBuffer buffer = ByteBuffer.allocate(length);
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) throw new IOException("control connection closed");
        }
        return buffer.flip();
    }
}
