package dev.codeintelligence.job;

import java.time.Instant;

public record JobRecord(
        long id,
        long projectId,
        Long snapshotId,
        JobType type,
        JobStatus status,
        String error,
        Instant createdAt,
        Instant startedAt,
        Instant finishedAt) {}
