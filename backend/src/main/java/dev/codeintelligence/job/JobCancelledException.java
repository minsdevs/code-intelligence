package dev.codeintelligence.job;

/** Thrown inside a step body when its job was cancelled; the worker ends the run as CANCELLED. */
public class JobCancelledException extends RuntimeException {

    public JobCancelledException() {
        super("cancelled", null, false, false);
    }
}
