package dev.codeintelligence.job;

import java.util.function.Supplier;

/**
 * Cooperative cancellation of one job run (05 §4 cancel bound, T03). {@link JobService#cancel}
 * marks the token of the run that currently owns the job; the worker binds that token to its
 * thread while a step body runs. Long loops call {@link #checkpoint()} per item (a thread-local and
 * a volatile read, no database query), and blocking worker requests run inside
 * {@link #interruptibly(Supplier)} so a cancel interrupts the in-flight call instead of waiting for
 * its read timeout. Both are no-ops on threads that are not running a job step (previews, tests).
 */
public final class JobCancellation {

    private static final ThreadLocal<JobCancellation> CURRENT = new ThreadLocal<>();

    private volatile boolean requested;
    // Guarded by this: the thread inside an interruptible call, and whether a cancel interrupted it.
    private Thread interruptible;
    private boolean interruptedByCancel;

    /** Throws {@link JobCancelledException} once the job running on this thread was cancelled. */
    public static void checkpoint() {
        JobCancellation current = CURRENT.get();
        if (current != null && current.requested) throw new JobCancelledException();
    }

    /**
     * Runs a blocking call (an analyzer HTTP request) that a cancel aborts by interrupting this
     * thread. A failure caused by the cancel surfaces as {@link JobCancelledException}; the interrupt
     * never leaks past the call into later database work.
     */
    public static <T> T interruptibly(Supplier<T> call) {
        JobCancellation current = CURRENT.get();
        return current == null ? call.get() : current.callInterruptibly(call);
    }

    boolean requested() {
        return requested;
    }

    synchronized void request() {
        requested = true;
        if (interruptible != null && !interruptedByCancel) {
            interruptedByCancel = true;
            interruptible.interrupt();
        }
    }

    /** Binds this token to the current thread for one step body. */
    Scope bind() {
        JobCancellation previous = CURRENT.get();
        CURRENT.set(this);
        return () -> {
            if (previous == null) CURRENT.remove();
            else CURRENT.set(previous);
        };
    }

    interface Scope extends AutoCloseable {
        @Override
        void close();
    }

    private <T> T callInterruptibly(Supplier<T> call) {
        synchronized (this) {
            if (requested) throw new JobCancelledException();
            interruptible = Thread.currentThread();
        }
        try {
            return call.get();
        } catch (RuntimeException failure) {
            if (requested) throw new JobCancelledException();
            throw failure;
        } finally {
            synchronized (this) {
                interruptible = null;
                if (interruptedByCancel) {
                    interruptedByCancel = false;
                    Thread.interrupted();
                }
            }
        }
    }
}
