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
        Instant finishedAt,
        String failureCode) {
    public JobRecord(
            long id,
            long projectId,
            Long snapshotId,
            JobType type,
            JobStatus status,
            String error,
            Instant createdAt,
            Instant startedAt,
            Instant finishedAt) {
        this(id, projectId, snapshotId, type, status, error, createdAt, startedAt, finishedAt, null);
    }
}
