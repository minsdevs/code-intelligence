package dev.codeintelligence.backup;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** One private, bounded framed-JSON conversation. No application logger or Spring context. */
final class SourceProtocol {
    static final int MAX_FRAME = 16 * 1024 * 1024;
    static final int MAX_OBJECT = 2 * 1024 * 1024;
    static final int MAX_OBJECTS = 200_000;
    static final long MAX_TOTAL = 10L * 1024 * 1024 * 1024;
    static final JsonMapper JSON = JsonMapper.builder().build();
    private static final JsonFactory FACTORY = JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder()
                    .maxDocumentLength(MAX_FRAME)
                    .maxNestingDepth(12)
                    .maxTokenCount(1_000_000)
                    .maxNameLength(64)
                    .maxStringLength(MAX_FRAME)
                    .maxNumberLength(20)
                    .build())
            .build();

    private SourceProtocol() {}

    static JsonNode read(DataInputStream input) throws IOException {
        int length;
        try {
            length = input.readInt();
        } catch (EOFException error) {
            throw failure("SOURCE_PROTOCOL_INVALID");
        }
        if (length <= 0 || length > MAX_FRAME) throw failure("SOURCE_LIMIT");
        byte[] bytes = input.readNBytes(length);
        try {
            if (bytes.length != length) throw failure("SOURCE_PROTOCOL_INVALID");
            utf8(bytes);
            try (var parser = FACTORY.createParser(bytes)) {
                JsonNode value = JSON.readTree(parser);
                if (value == null || !value.isObject() || parser.nextToken() != null)
                    throw failure("SOURCE_PROTOCOL_INVALID");
                return value;
            }
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    static void write(DataOutputStream output, Map<String, Object> value) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(value);
        try {
            if (bytes.length > MAX_FRAME) throw failure("SOURCE_LIMIT");
            output.writeInt(bytes.length);
            output.write(bytes);
            output.flush();
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    static void eof(DataInputStream input) throws IOException {
        if (input.read() != -1) throw failure("SOURCE_PROTOCOL_INVALID");
    }

    static void exact(JsonNode value, String... keys) {
        if (value == null || !value.isObject() || value.size() != keys.length) throw failure("SOURCE_PROTOCOL_INVALID");
        for (String key : keys) if (value.get(key) == null) throw failure("SOURCE_PROTOCOL_INVALID");
    }

    static String text(JsonNode value) {
        if (value == null || !value.isTextual()) throw failure("SOURCE_PROTOCOL_INVALID");
        String text = value.stringValue();
        if (!text.equals(utf8(text.getBytes(StandardCharsets.UTF_8)))) throw failure("SOURCE_PROTOCOL_INVALID");
        return text;
    }

    static String id(JsonNode value) {
        String result = text(value);
        if (!result.matches("[1-9][0-9]{0,18}")) throw failure("SOURCE_PROTOCOL_INVALID");
        try {
            if (Long.parseLong(result) <= 0) throw failure("SOURCE_PROTOCOL_INVALID");
        } catch (NumberFormatException error) {
            throw failure("SOURCE_PROTOCOL_INVALID");
        }
        return result;
    }

    static String hex(JsonNode value, int length) {
        String result = text(value);
        if (!result.matches("[0-9a-f]{" + length + "}")) throw failure("SOURCE_PROTOCOL_INVALID");
        return result;
    }

    static long epochSecond(JsonNode value) {
        String result = text(value);
        if (!result.matches("0|[1-9][0-9]{0,11}")) throw failure("SOURCE_PROTOCOL_INVALID");
        long second = Long.parseLong(result);
        if (second > 253402300799L) throw failure("SOURCE_LIMIT");
        return second;
    }

    static long number(JsonNode value, long maximum) {
        if (value == null
                || !value.isIntegralNumber()
                || !value.canConvertToLong()
                || value.longValue() < 0
                || value.longValue() > maximum) throw failure("SOURCE_LIMIT");
        return value.longValue();
    }

    static String utf8(byte[] bytes) {
        try {
            return StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (java.nio.charset.CharacterCodingException error) {
            throw failure("SOURCE_UNSUPPORTED_ENCODING");
        }
    }

    static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 unavailable");
        }
    }

    static String sha256(byte[] bytes) {
        return HexFormat.of().formatHex(digest().digest(bytes));
    }

    static Map<String, Object> map(Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) result.put((String) values[i], values[i + 1]);
        return result;
    }

    static Failure failure(String code) {
        return new Failure(code);
    }

    static final class Failure extends RuntimeException {
        final String code;

        Failure(String code) {
            super(code);
            this.code = code;
        }
    }

    static final class Budget {
        private final long started = System.nanoTime();

        void check() {
            if (Thread.currentThread().isInterrupted() || System.nanoTime() - started > 120_000_000_000L)
                throw failure("SOURCE_LIMIT");
        }
    }
}
