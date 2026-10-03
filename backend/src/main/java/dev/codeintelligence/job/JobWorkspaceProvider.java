package dev.codeintelligence.job;

import java.nio.file.Path;

/** A pipeline owns its input lease until every writer has returned and cleanup completes. */
public interface JobWorkspaceProvider {
    Workspace open(JobRecord job);

    /**
     * Checks whether an attached checkpoint has a supported immutable input contract. False means
     * legacy input; missing or inconsistent retained metadata must throw. The worker still verifies
     * and reconstructs all bytes before resuming any analysis step.
     */
    default boolean verifyRetainedCheckpoint(long projectId, long jobId, long snapshotId) {
        return false;
    }

    interface Workspace extends AutoCloseable {
        Path clonePath();

        @Override
        void close();
    }

    static Workspace unmanaged(Path path) {
        return new Workspace() {
            @Override
            public Path clonePath() {
                return path;
            }

            @Override
            public void close() {}
        };
    }
}
