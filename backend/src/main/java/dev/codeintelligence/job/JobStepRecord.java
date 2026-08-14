package dev.codeintelligence.job;

import java.time.Instant;

public record JobStepRecord(
        long id,
        long jobId,
        String stepKey,
        int seq,
        StepStatus status,
        Integer progressPct,
        int attempt,
        String error,
        Instant startedAt,
        Instant finishedAt) {}
