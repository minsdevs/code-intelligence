package dev.codeintelligence.job;

import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.listener.PatternTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.databind.json.JsonMapper;

/**
 * Bridges Redis pub/sub job progress to SSE subscribers (§1-3, 위험 R6): every subscriber first
 * gets a {@code snapshot} event with the current state, then {@code update} events relayed from
 * {@code job-progress:{jobId}}, plus a heartbeat comment every 15s. Connections complete once a
 * terminal state is relayed; dead emitters are pruned on send failure.
 */
@Component
public class JobSseBroadcaster implements MessageListener {

    private static final Logger log = LoggerFactory.getLogger(JobSseBroadcaster.class);
    private static final long SSE_TIMEOUT_MS = Duration.ofMinutes(30).toMillis();
    private static final long HEARTBEAT_INTERVAL_MS = Duration.ofSeconds(15).toMillis();
    static final int MAX_PENDING_EVENTS = 64;
    // Pending payloads total at most 1 MiB of UTF-16 storage; one in-flight frame is separate.
    static final int MAX_PENDING_PAYLOAD_CHARS = 512 * 1024;

    private final JsonMapper jsonMapper;
    // Each list is immutable: an old broadcast must not complete a later subscriber.
    private final Map<Long, List<Subscriber>> emitters = new ConcurrentHashMap<>();
    private final ScheduledExecutorService heartbeatScheduler;
    private final AtomicBoolean stopping = new AtomicBoolean();

    public JobSseBroadcaster(RedisMessageListenerContainer jobRedisMessageListenerContainer, JsonMapper jsonMapper) {
        this.jsonMapper = jsonMapper;
        jobRedisMessageListenerContainer.addMessageListener(
                this, new PatternTopic(JobProgressPublisher.CHANNEL_PATTERN));
        this.heartbeatScheduler = Executors.newSingleThreadScheduledExecutor(
                Thread.ofVirtual().name("job-sse-heartbeat-", 0).factory());
        heartbeatScheduler.scheduleAtFixedRate(
                this::sendHeartbeats, HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    /** Compatibility entry point for an already authorized, supplied snapshot. */
    public SseEmitter subscribe(long jobId, JobDetailResponse snapshot) {
        return subscribeAfterOwnership(jobId, () -> snapshot);
    }

    /** Caller must establish ownership before invoking this method; the loader rechecks it. */
    SseEmitter subscribeAfterOwnership(long jobId, Supplier<JobDetailResponse> snapshotLoader) {
        SseEmitter emitter = createEmitter();
        Subscriber subscriber = new Subscriber(jobId, emitter);
        emitter.onCompletion(subscriber::detach);
        emitter.onError(ex -> subscriber.detach());
        emitter.onTimeout(subscriber::complete);
        emitters.compute(jobId, (key, current) -> {
            if (stopping.get()) return current;
            List<Subscriber> next = current == null ? new ArrayList<>() : new ArrayList<>(current);
            next.add(subscriber);
            return List.copyOf(next);
        });
        if (stopping.get()) subscriber.complete();
        if (subscriber.closed()) {
            remove(jobId, subscriber);
            return emitter;
        }
        JobDetailResponse snapshot;
        try {
            // No map/subscriber lock is held over the database lookup. Events queue until initialized.
            snapshot = snapshotLoader.get();
        } catch (RuntimeException | Error ex) {
            subscriber.fail(ex);
            throw ex;
        }
        if (subscriber.closed()) return emitter;
        try {
            subscriber.initialize(
                    jsonMapper.writeValueAsString(snapshot), snapshot.status().terminal());
        } catch (RuntimeException | Error ex) {
            subscriber.fail(ex);
            if (ex instanceof Error error) throw error;
        }
        return emitter;
    }

    // Tests may observe/fail actual SseEmitter sends without substituting the subscription protocol.
    SseEmitter createEmitter() {
        return new SseEmitter(SSE_TIMEOUT_MS);
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        String channel = new String(message.getChannel(), StandardCharsets.UTF_8);
        Long jobId = jobIdFrom(channel);
        if (jobId == null) {
            return;
        }
        List<Subscriber> targets = emitters.get(jobId);
        if (targets == null) return;
        String payload = new String(message.getBody(), StandardCharsets.UTF_8);
        boolean terminal = payload.length() <= MAX_PENDING_PAYLOAD_CHARS && isTerminal(payload);
        for (Subscriber subscriber : targets) subscriber.update(payload, terminal);
    }

    private Long jobIdFrom(String channel) {
        String prefix =
                JobProgressPublisher.CHANNEL_PATTERN.substring(0, JobProgressPublisher.CHANNEL_PATTERN.length() - 1);
        if (channel == null || !channel.startsWith(prefix)) {
            return null;
        }
        try {
            return Long.parseLong(channel.substring(prefix.length()));
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private boolean isTerminal(String payload) {
        try {
            return jsonMapper
                    .readValue(payload, JobDetailResponse.class)
                    .status()
                    .terminal();
        } catch (RuntimeException ex) {
            return false;
        }
    }

    private void sendHeartbeats() {
        emitters.forEach((jobId, list) -> {
            for (Subscriber subscriber : list) subscriber.heartbeat();
        });
    }

    private void remove(long jobId, Subscriber subscriber) {
        emitters.computeIfPresent(jobId, (key, list) -> {
            List<Subscriber> next = new ArrayList<>(list);
            next.remove(subscriber);
            return next.isEmpty() ? null : List.copyOf(next);
        });
    }

    private record PendingEvent(String name, String payload, boolean terminal) {}

    private final class Subscriber {
        private final long jobId;
        private final SseEmitter emitter;
        private final ArrayDeque<PendingEvent> pending = new ArrayDeque<>();
        private int pendingChars;
        private boolean initialized;
        private boolean draining;
        private boolean closed;
        private boolean terminalQueued;
        private boolean completionPending;
        private Throwable completionFailure;

        Subscriber(long jobId, SseEmitter emitter) {
            this.jobId = jobId;
            this.emitter = emitter;
        }

        synchronized boolean closed() {
            return closed;
        }

        void initialize(String payload, boolean terminal) {
            offer(new PendingEvent("snapshot", payload, terminal), true);
        }

        void update(String payload, boolean terminal) {
            offer(new PendingEvent("update", payload, terminal), false);
        }

        private void offer(PendingEvent event, boolean initial) {
            boolean start;
            boolean overflow;
            synchronized (this) {
                if (closed || (!initial && terminalQueued)) return;
                // A terminal database snapshot supersedes events buffered during its lookup.
                if (initial && event.terminal()) clearPending();
                overflow = pending.size() >= MAX_PENDING_EVENTS
                        || event.payload().length() > MAX_PENDING_PAYLOAD_CHARS - pendingChars;
                if (overflow) {
                    closeState(new IllegalStateException("SSE pending event capacity exceeded"));
                } else {
                    if (initial) {
                        pending.addFirst(event);
                        initialized = true;
                    } else {
                        pending.addLast(event);
                    }
                    pendingChars += event.payload().length();
                    terminalQueued |= event.terminal();
                }
                start = claimDrain();
            }
            if (overflow) remove(jobId, this);
            if (start) drain();
        }

        void heartbeat() {
            synchronized (this) {
                // No heartbeat before the snapshot, and no heartbeat backlog behind a blocked write.
                if (!initialized || closed || terminalQueued || draining) return;
                pending.addLast(new PendingEvent(null, "", false));
                draining = true;
            }
            drain();
        }

        void complete() {
            fail(null);
        }

        void fail(Throwable failure) {
            boolean start;
            synchronized (this) {
                if (closed) return;
                closeState(failure);
                start = claimDrain();
            }
            remove(jobId, this);
            if (start) drain();
        }

        void detach() {
            synchronized (this) {
                closed = true;
                clearPending();
                completionPending = false;
                completionFailure = null;
            }
            remove(jobId, this);
        }

        // State-only helpers are called under this subscriber's monitor. No external calls here.
        private void clearPending() {
            pending.clear();
            pendingChars = 0;
        }

        private void closeState(Throwable failure) {
            closed = true;
            clearPending();
            completionFailure = failure;
            completionPending = true;
        }

        private boolean claimDrain() {
            if (draining || (!completionPending && (!initialized || closed || pending.isEmpty()))) return false;
            draining = true;
            return true;
        }

        private void drain() {
            for (; ; ) {
                PendingEvent event = null;
                boolean completing;
                Throwable failure;
                synchronized (this) {
                    completing = completionPending;
                    failure = completionFailure;
                    if (completing) {
                        completionPending = false;
                        completionFailure = null;
                    } else {
                        if (closed || !initialized || pending.isEmpty()) {
                            draining = false;
                            return;
                        }
                        event = pending.removeFirst();
                        pendingChars -= event.payload().length();
                    }
                }
                if (completing) {
                    try {
                        if (failure == null) emitter.complete();
                        else emitter.completeWithError(failure);
                    } catch (RuntimeException ex) {
                        log.debug("SSE completion for job {} failed", jobId);
                    } finally {
                        synchronized (this) {
                            draining = false;
                        }
                    }
                    return;
                }
                try {
                    // Only this drain owner writes. Reentrant publishes enqueue; they cannot overtake it.
                    emitter.send(
                            event.name() == null
                                    ? SseEmitter.event().comment("heartbeat")
                                    : SseEmitter.event()
                                            .name(event.name())
                                            .data(event.payload(), MediaType.APPLICATION_JSON));
                    if (event.terminal()) complete();
                } catch (IOException | RuntimeException ex) {
                    fail(ex);
                }
            }
        }
    }

    @PreDestroy
    void shutdown() {
        stopping.set(true);
        heartbeatScheduler.shutdownNow();
        emitters.values().forEach(list -> list.forEach(Subscriber::complete));
    }
}
