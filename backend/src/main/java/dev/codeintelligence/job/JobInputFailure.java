package dev.codeintelligence.job;

/** A safe machine-readable recovery action for a rejected job input. */
public interface JobInputFailure extends dev.codeintelligence.common.RecoveryActionFailure {
    String failureCode();
}
