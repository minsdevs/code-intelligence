package dev.codeintelligence.job;

import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
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

    private final JsonMapper jsonMapper;
    private final Map<Long, List<SseEmitter>> emitters = new ConcurrentHashMap<>();
    private final ScheduledExecutorService heartbeatScheduler;

    public JobSseBroadcaster(RedisMessageListenerContainer jobRedisMessageListenerContainer, JsonMapper jsonMapper) {
        this.jsonMapper = jsonMapper;
        jobRedisMessageListenerContainer.addMessageListener(
                this, new PatternTopic(JobProgressPublisher.CHANNEL_PATTERN));
        this.heartbeatScheduler = Executors.newSingleThreadScheduledExecutor(
                Thread.ofVirtual().name("job-sse-heartbeat-", 0).factory());
        heartbeatScheduler.scheduleAtFixedRate(
                this::sendHeartbeats, HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    public SseEmitter subscribe(long jobId, JobDetailResponse snapshot) {
        SseEmitter emitter = new SseEmitter(SSE_TIMEOUT_MS);
        emitter.onCompletion(() -> remove(jobId, emitter));
        emitter.onError(ex -> remove(jobId, emitter));
        emitter.onTimeout(emitter::complete);
        try {
            emitter.send(SseEmitter.event()
                    .name("snapshot")
                    .data(jsonMapper.writeValueAsString(snapshot), MediaType.APPLICATION_JSON));
        } catch (IOException | RuntimeException ex) {
            emitter.completeWithError(ex);
            return emitter;
        }
        if (snapshot.status().terminal()) {
            emitter.complete();
            return emitter;
        }
        emitters.computeIfAbsent(jobId, key -> new CopyOnWriteArrayList<>()).add(emitter);
        return emitter;
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        String channel = new String(message.getChannel(), StandardCharsets.UTF_8);
        Long jobId = jobIdFrom(channel);
        if (jobId == null) {
            return;
        }
        String payload = new String(message.getBody(), StandardCharsets.UTF_8);
        List<SseEmitter> targets = emitters.get(jobId);
        if (targets != null) {
            for (SseEmitter emitter : targets) {
                try {
                    emitter.send(SseEmitter.event().name("update").data(payload, MediaType.APPLICATION_JSON));
                } catch (IOException | RuntimeException ex) {
                    remove(jobId, emitter);
                }
            }
        }
        if (isTerminal(payload)) {
            completeAll(jobId);
        }
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
            for (SseEmitter emitter : list) {
                try {
                    emitter.send(SseEmitter.event().comment("heartbeat"));
                } catch (IOException | RuntimeException ex) {
                    remove(jobId, emitter);
                }
            }
        });
    }

    private void remove(long jobId, SseEmitter emitter) {
        emitters.computeIfPresent(jobId, (key, list) -> {
            list.remove(emitter);
            return list.isEmpty() ? null : list;
        });
    }

    private void completeAll(long jobId) {
        List<SseEmitter> removed = emitters.remove(jobId);
        if (removed == null) {
            return;
        }
        for (SseEmitter emitter : removed) {
            try {
                emitter.complete();
            } catch (RuntimeException ex) {
                log.debug("SSE completion for job {} failed: {}", jobId, ex.getMessage());
            }
        }
    }

    @PreDestroy
    void shutdown() {
        heartbeatScheduler.shutdownNow();
        List.copyOf(emitters.keySet()).forEach(this::completeAll);
    }
}
