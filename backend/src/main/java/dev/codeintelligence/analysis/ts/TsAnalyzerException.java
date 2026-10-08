package dev.codeintelligence.analysis.ts;

import dev.codeintelligence.analysis.core.AnalyzerFailureKind;
import dev.codeintelligence.common.RecoveryActionFailure;

public class TsAnalyzerException extends RuntimeException implements RecoveryActionFailure {
    private final AnalyzerFailureKind failureKind;

    public TsAnalyzerException(String message, Throwable cause) {
        this(message, cause, true);
    }

    TsAnalyzerException(String message, Throwable cause, boolean retainCause) {
        this(message, retainCause ? cause : null, AnalyzerFailureKind.fromCause(cause));
    }

    private TsAnalyzerException(String message, Throwable cause, AnalyzerFailureKind failureKind) {
        super(message, cause);
        this.failureKind = failureKind;
    }

    static TsAnalyzerException timeout(String message) {
        return new TsAnalyzerException(message, null, AnalyzerFailureKind.TIMEOUT);
    }

    @Override
    public String failureCode() {
        return switch (failureKind) {
            case TIMEOUT -> "TS_ANALYZER_TIMEOUT";
            case REJECTED -> "TS_ANALYZER_REJECTED";
            case TRANSPORT_ERROR -> "TS_ANALYZER_TRANSPORT_ERROR";
        };
    }
}
