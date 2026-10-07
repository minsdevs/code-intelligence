package dev.codeintelligence.job;

/**
 * Test access to a {@link JobCancellation} bound to the calling thread, as the worker binds it for a
 * step body. Lets tests outside this package (import, analyzers) request a cancel at a chosen point.
 */
public final class BoundJobCancellation implements AutoCloseable {

    private final JobCancellation token = new JobCancellation();
    private final JobCancellation.Scope scope = token.bind();

    public static BoundJobCancellation bind() {
        return new BoundJobCancellation();
    }

    /** What {@link JobService#cancel} does to the run that owns the job. */
    public void cancel() {
        token.request();
    }

    @Override
    public void close() {
        scope.close();
    }
}
