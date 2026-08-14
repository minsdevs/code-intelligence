package dev.codeintelligence.job;

import java.time.Instant;

public record JobStepResponse(
        String stepKey,
        int seq,
        StepStatus status,
        Integer progressPct,
        int attempt,
        String error,
        Instant startedAt,
        Instant finishedAt) {

    public static JobStepResponse of(JobStepRecord step) {
        return new JobStepResponse(
                step.stepKey(),
                step.seq(),
                step.status(),
                step.progressPct(),
                step.attempt(),
                step.error(),
                step.startedAt(),
                step.finishedAt());
    }
}
