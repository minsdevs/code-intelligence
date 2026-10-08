package dev.codeintelligence.analysis.tree;

import dev.codeintelligence.analysis.core.AnalyzerFailureKind;
import dev.codeintelligence.common.RecoveryActionFailure;

public class TreeAnalyzerException extends RuntimeException implements RecoveryActionFailure {
    private final AnalyzerFailureKind failureKind;

    public TreeAnalyzerException(String message, Throwable cause) {
        super(message, cause);
        this.failureKind = AnalyzerFailureKind.fromCause(cause);
    }

    @Override
    public String failureCode() {
        return switch (failureKind) {
            case TIMEOUT -> "TREE_ANALYZER_TIMEOUT";
            case REJECTED -> "TREE_ANALYZER_REJECTED";
            case TRANSPORT_ERROR -> "TREE_ANALYZER_TRANSPORT_ERROR";
        };
    }
}
