package dev.codeintelligence.common;

/** A public recovery code independent of auth/provider/job package direction. */
public interface RecoveryActionFailure {
    String failureCode();
}
