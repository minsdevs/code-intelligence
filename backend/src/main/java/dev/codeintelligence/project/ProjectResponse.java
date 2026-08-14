package dev.codeintelligence.project;

import dev.codeintelligence.job.JobSummaryResponse;
import java.time.Instant;

public record ProjectResponse(
        long id,
        String name,
        String repoOwner,
        String repoName,
        String defaultBranch,
        SnapshotView currentSnapshot,
        JobSummaryResponse latestJob,
        Instant createdAt,
        Instant updatedAt) {

    public record SnapshotView(long id, String commitSha, SnapshotStatus status, Instant analyzedAt) {

        public static SnapshotView of(Snapshot snapshot) {
            return new SnapshotView(
                    snapshot.getId(), snapshot.getCommitSha(), snapshot.getStatus(), snapshot.getAnalyzedAt());
        }
    }
}
