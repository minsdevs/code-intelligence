package dev.codeintelligence.analysis.ts;

import java.util.regex.Pattern;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The analyzer refused a request without syntax diagnostics (a limit, an unknown or expired 03 §6
 * session, an invalid command). Only the analyzer's stable code reaches the job error; any other
 * response text stays out of it.
 */
public final class TsAnalyzerRejectedException extends TsAnalyzerException {
    public static final String CODE = "TS_ANALYZER_REJECTED";
    static final String ANALYSIS_LIMIT = "ANALYSIS_LIMIT";
    private static final Pattern REASON = Pattern.compile("[A-Z][A-Z_]{0,63}");
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
                    .streamReadConstraints(StreamReadConstraints.builder()
                            .maxDocumentLength(TsSyntaxInputException.MAX_ERROR_BYTES)
                            .maxNestingDepth(4)
                            .maxTokenCount(3000)
                            .maxStringLength(4096)
                            .build())
                    .build())
            .build();

    private final String reason;

    TsAnalyzerRejectedException(String reason) {
        super(null, null);
        this.reason = reason != null && REASON.matcher(reason).matches() ? reason : "UNKNOWN";
    }

    /** The analyzer's 400 body; a missing, malformed or unexpected code is reported as UNKNOWN. */
    static TsAnalyzerRejectedException fromResponse(byte[] body) {
        try {
            JsonNode code = body.length > TsSyntaxInputException.MAX_ERROR_BYTES
                    ? null
                    : JSON.readTree(body).get("code");
            return new TsAnalyzerRejectedException(code != null && code.isTextual() ? code.stringValue() : null);
        } catch (RuntimeException e) {
            return new TsAnalyzerRejectedException(null);
        }
    }

    @Override
    public String getMessage() {
        return "ts-analyzer rejected the analysis request (" + reason + ")";
    }

    @Override
    public String failureCode() {
        return ANALYSIS_LIMIT.equals(reason) ? ANALYSIS_LIMIT : CODE;
    }
}
