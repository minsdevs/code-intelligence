package dev.codeintelligence.job;

import java.time.Instant;

public record JobSummaryResponse(
        long id,
        JobType type,
        JobStatus status,
        String error,
        Instant createdAt,
        Instant startedAt,
        Instant finishedAt) {

    public static JobSummaryResponse of(JobRecord job) {
        return new JobSummaryResponse(
                job.id(), job.type(), job.status(), job.error(), job.createdAt(), job.startedAt(), job.finishedAt());
    }
}
