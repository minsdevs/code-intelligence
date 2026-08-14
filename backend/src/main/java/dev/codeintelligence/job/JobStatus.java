package dev.codeintelligence.job;

public enum JobStatus {
    QUEUED,
    RUNNING,
    DONE,
    FAILED,
    CANCELLED;

    public boolean terminal() {
        return this == DONE || this == FAILED || this == CANCELLED;
    }
}
