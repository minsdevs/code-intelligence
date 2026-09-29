package dev.codeintelligence.project;

import dev.codeintelligence.job.JobSummaryResponse;
import java.time.Instant;
import java.util.List;

public record ProjectResponse(
        long id,
        String name,
        String repoOwner,
        String repoName,
        String defaultBranch,
        String sourceType,
        String sourceAddress,
        SnapshotView currentSnapshot,
        JobSummaryResponse latestJob,
        List<String> selectedAreas,
        List<String> topTechnologies,
        LatestCommitView latestCommit,
        LatestPullView latestPull,
        Instant createdAt,
        Instant updatedAt) {

    public record SnapshotView(long id, String commitSha, SnapshotStatus status, Instant analyzedAt) {

        public static SnapshotView of(Snapshot snapshot) {
            return new SnapshotView(
                    snapshot.getId(), snapshot.getCommitSha(), snapshot.getStatus(), snapshot.getAnalyzedAt());
        }
    }

    public record LatestCommitView(String sha, String message) {}

    public record LatestPullView(int number, String title, String state, String author, Instant mergedAt) {}
}
