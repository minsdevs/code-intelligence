package dev.codeintelligence.analysis.ts;

import dev.codeintelligence.job.JobInputFailure;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** A bounded, location-only summary suitable for the existing job error/API/SSE fields. */
public final class TsSyntaxInputException extends TsAnalyzerException implements JobInputFailure {
    public static final String CODE = "TS_SYNTAX_ERROR";
    static final int MAX_ERROR_BYTES = 65_536;
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .streamReadConstraints(StreamReadConstraints.builder()
                            .maxDocumentLength(MAX_ERROR_BYTES)
                            .maxNestingDepth(4)
                            .maxTokenCount(3000)
                            .maxNameLength(64)
                            .maxStringLength(4096)
                            .maxNumberLength(10)
                            .build())
                    .build())
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();

    private TsSyntaxInputException(String message) {
        super(message, null);
    }

    /** Unrecognized/malformed responses remain service failures; never forward raw response text. */
    static TsSyntaxInputException fromResponse(byte[] body) {
        if (body.length == 0 || body.length > MAX_ERROR_BYTES) return null;
        try {
            JsonNode root = JSON.readTree(body);
            if (root == null || !root.isObject()) return null;
            JsonNode failureCode = root.get("code");
            JsonNode retryable = root.get("retryable");
            if (failureCode == null
                    || !failureCode.isTextual()
                    || !CODE.equals(failureCode.stringValue())
                    || retryable == null
                    || !retryable.isBoolean()
                    || retryable.booleanValue()) return null;
            JsonNode total = root.get("totalDiagnostics");
            JsonNode diagnostics = root.get("diagnostics");
            if (!positiveInteger(total)
                    || diagnostics == null
                    || !diagnostics.isArray()
                    || diagnostics.isEmpty()
                    || diagnostics.size() > 100
                    || diagnostics.size() > total.intValue()) return null;
            JsonNode first = diagnostics.get(0);
            String location = safeLocation(first);
            return new TsSyntaxInputException("TypeScript/JavaScript syntax errors: " + total.intValue() + ". "
                    + (location == null ? "Location unavailable. " : "First diagnostic: " + location + ". ")
                    + "Fix the source and start a new analysis.");
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static String safeLocation(JsonNode diagnostic) {
        if (diagnostic == null || !diagnostic.isObject()) return null;
        JsonNode file = diagnostic.get("filePath");
        JsonNode code = diagnostic.get("code");
        JsonNode line = diagnostic.get("lineStart");
        JsonNode column = diagnostic.get("columnStart");
        if (file == null
                || !file.isTextual()
                || !positiveInteger(code)
                || !positiveInteger(line)
                || !positiveInteger(column)) return null;
        String path = file.stringValue();
        if (path.isBlank()
                || path.length() > 240
                || path.startsWith("/")
                || path.contains("\\")
                || path.contains(":")
                || path.codePoints()
                        .anyMatch(
                                value -> Character.isISOControl(value) || Character.getType(value) == Character.FORMAT))
            return null;
        for (String segment : path.split("/", -1)) {
            if (segment.isBlank() || segment.equals(".") || segment.equals("..")) return null;
        }
        return path + ":" + line.intValue() + ":" + column.intValue() + " (TS" + code.intValue() + ")";
    }

    private static boolean positiveInteger(JsonNode value) {
        return value != null && value.isIntegralNumber() && value.canConvertToInt() && value.intValue() > 0;
    }

    @Override
    public String failureCode() {
        return CODE;
    }
}
