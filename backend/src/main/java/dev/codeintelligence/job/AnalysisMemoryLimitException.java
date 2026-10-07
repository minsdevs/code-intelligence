package dev.codeintelligence.job;

import dev.codeintelligence.common.RecoveryActionFailure;

/** A run stopped by the analysis memory watchdog fails (not cancels) with a stable recovery code. */
public class AnalysisMemoryLimitException extends RuntimeException implements RecoveryActionFailure {
    public static final String CODE = "ANALYSIS_MEMORY_LIMIT";
    static final String MESSAGE = "analysis memory limit: the app's processes use more than 6 GiB";

    public AnalysisMemoryLimitException() {
        super(MESSAGE, null, false, false);
    }

    @Override
    public String failureCode() {
        return CODE;
    }
}
