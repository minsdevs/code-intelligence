package dev.codeintelligence.maintenance;

import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * Process-local admission barrier. A drain is not a durable backup checkpoint: the desktop must
 * still stop this process and recheck PostgreSQL before replacing application data.
 */
@Component
public class MaintenanceGate {
    private final ThreadLocal<RequestLease> requestOnThread = new ThreadLocal<>();
    private UUID transactionId;
    private long generation;
    private long activityRevision;
    private long requests;
    private long writers;
    private long jobs;

    public MaintenanceGate() {}

    @Autowired
    public MaintenanceGate(@Value("${app.desktop.maintenance-startup-id:}") String startupId) {
        if (startupId != null && !startupId.isEmpty()) {
            UUID id = UUID.fromString(startupId);
            if (!id.toString().equals(startupId)) throw new IllegalArgumentException("Invalid startup maintenance id");
            begin(id);
        }
    }

    /** The servlet filter owns this lease through the complete synchronous filter chain. */
    public synchronized RequestLease admitRequest() {
        if (transactionId != null) throw unavailable();
        activityRevision = Math.incrementExact(activityRevision);
        RequestLease lease = new RequestLease(requestOnThread.get());
        requests = Math.incrementExact(requests);
        requestOnThread.set(lease);
        return lease;
    }

    /** Acquire before submitting the AI task, never from inside the executor task. */
    public synchronized Lease admitWriter() {
        requireBackgroundAdmission();
        activityRevision = Math.incrementExact(activityRevision);
        writers = Math.incrementExact(writers);
        return new Lease(false);
    }

    /** Acquire before dispatch and retain through workspace close and cancellation cleanup. */
    public synchronized Lease admitJob() {
        requireBackgroundAdmission();
        activityRevision = Math.incrementExact(activityRevision);
        jobs = Math.incrementExact(jobs);
        return new Lease(true);
    }

    private void requireBackgroundAdmission() {
        RequestLease parent = requestOnThread.get();
        // A previously admitted request may commit a QUEUED job after BEGIN. Its child lease
        // must be acquired before the request lease closes, so there is no zero-count window.
        if (transactionId != null && (parent == null || parent.closed)) throw unavailable();
    }

    public synchronized Ticket begin(UUID id) {
        Objects.requireNonNull(id);
        if (transactionId == null) {
            generation = Math.incrementExact(generation);
            transactionId = id;
        } else if (!transactionId.equals(id)) {
            throw conflict();
        }
        return new Ticket(id, generation, activityRevision);
    }

    public synchronized Ticket current(UUID id) {
        if (id == null || !id.equals(transactionId)) throw conflict();
        return new Ticket(id, generation, activityRevision);
    }

    public synchronized boolean active() {
        return transactionId != null;
    }

    public synchronized View snapshot(Ticket ticket, long databaseJobs) {
        requireCurrent(ticket);
        if (databaseJobs < 0) throw new IllegalStateException("Maintenance job count unavailable");
        // An earlier request may have committed a QUEUED job after the SQL snapshot and then
        // failed to dispatch it. If any lease changed during that query, require another poll.
        boolean drained = ticket.activityRevision() == activityRevision
                && requests == 0
                && writers == 0
                && jobs == 0
                && databaseJobs == 0;
        // SQL rows and executor leases usually describe the same jobs. Neither observation may
        // disappear from the drain predicate; max is a conservative, non-additive display count.
        return new View(
                transactionId.toString(),
                drained ? "DRAINED" : "DRAINING",
                requests,
                writers,
                Math.max(jobs, databaseJobs));
    }

    /** Return the pre-END snapshot, then reopen admission. Never invoked implicitly on failure. */
    public synchronized View end(Ticket ticket, long databaseJobs) {
        View view = snapshot(ticket, databaseJobs);
        generation = Math.incrementExact(generation);
        transactionId = null;
        return view;
    }

    private void requireCurrent(Ticket ticket) {
        if (ticket == null
                || ticket.generation() != generation
                || !ticket.transactionId().equals(transactionId)) {
            throw conflict();
        }
    }

    static ResponseStatusException unavailable() {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "DESKTOP_MAINTENANCE_ACTIVE");
    }

    static ResponseStatusException conflict() {
        return new ResponseStatusException(HttpStatus.CONFLICT, "DESKTOP_MAINTENANCE_CONFLICT");
    }

    public record Ticket(UUID transactionId, long generation, long activityRevision) {}

    public record View(String transactionId, String state, long activeRequests, long activeWriters, long activeJobs) {}

    public final class RequestLease implements AutoCloseable {
        private final RequestLease previous;
        private final Thread owner = Thread.currentThread();
        private boolean closed;

        private RequestLease(RequestLease previous) {
            this.previous = previous;
        }

        @Override
        public void close() {
            synchronized (MaintenanceGate.this) {
                if (closed) return;
                if (owner != Thread.currentThread() || requestOnThread.get() != this) {
                    throw new IllegalStateException("Maintenance request lease closed out of scope");
                }
                activityRevision = Math.incrementExact(activityRevision);
                closed = true;
                requests--;
                if (previous == null) requestOnThread.remove();
                else requestOnThread.set(previous);
            }
        }
    }

    public final class Lease implements AutoCloseable {
        private final boolean job;
        private boolean closed;

        private Lease(boolean job) {
            this.job = job;
        }

        @Override
        public void close() {
            synchronized (MaintenanceGate.this) {
                if (closed) return;
                activityRevision = Math.incrementExact(activityRevision);
                closed = true;
                if (job) jobs--;
                else writers--;
            }
        }
    }
}
