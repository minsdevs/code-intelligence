package dev.codeintelligence.analysis.ts;

import dev.codeintelligence.common.RecoveryActionFailure;
import java.util.regex.Pattern;

/**
 * ADR-01: the desktop could not establish the sandboxed adapter session, so the analysis did not
 * run. The job fails with this code instead of falling back to an unsandboxed analyzer.
 */
public final class TsAdapterIsolationException extends TsAnalyzerException implements RecoveryActionFailure {
    public static final String CODE = "ADAPTER_ISOLATION_UNAVAILABLE";
    private static final Pattern REASON = Pattern.compile("[A-Z][A-Z_]{0,63}");

    private final String reason;

    TsAdapterIsolationException(String reason) {
        super(null, null);
        this.reason = reason != null && REASON.matcher(reason).matches() ? reason : "UNKNOWN";
    }

    public String reason() {
        return reason;
    }

    @Override
    public String getMessage() {
        return "TypeScript/JavaScript analysis isolation is unavailable (" + reason
                + "); the analysis did not run. Reinstall or update the app.";
    }

    @Override
    public String failureCode() {
        return CODE;
    }
}
