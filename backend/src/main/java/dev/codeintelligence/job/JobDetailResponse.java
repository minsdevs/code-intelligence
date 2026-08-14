package dev.codeintelligence.job;

import java.time.Instant;
import java.util.List;

/** Payload of {@code GET /api/jobs/{jobId}}, and of every SSE snapshot/update event. */
public record JobDetailResponse(
        long id,
        long projectId,
        Long snapshotId,
        JobType type,
        JobStatus status,
        String error,
        Instant createdAt,
        Instant startedAt,
        Instant finishedAt,
        List<JobStepResponse> steps) {

    public static JobDetailResponse of(JobRecord job, List<JobStepRecord> steps) {
        return new JobDetailResponse(
                job.id(),
                job.projectId(),
                job.snapshotId(),
                job.type(),
                job.status(),
                job.error(),
                job.createdAt(),
                job.startedAt(),
                job.finishedAt(),
                steps.stream().map(JobStepResponse::of).toList());
    }
}
