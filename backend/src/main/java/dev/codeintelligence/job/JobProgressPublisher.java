package dev.codeintelligence.job;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/**
 * Publishes the full current job state as JSON to Redis pub/sub {@code job-progress:{jobId}} on
 * every status change. Full-state payloads keep SSE clients trivially consistent (each event
 * replaces the previous view). Best-effort: the DB stays the source of truth and polling keeps
 * working when Redis publishing fails.
 */
@Component
public class JobProgressPublisher {

    public static final String CHANNEL_PATTERN = "job-progress:*";

    private static final Logger log = LoggerFactory.getLogger(JobProgressPublisher.class);
    private static final String CHANNEL_PREFIX = "job-progress:";

    private final JobRepository repository;
    private final StringRedisTemplate redisTemplate;
    private final JsonMapper jsonMapper;

    public JobProgressPublisher(JobRepository repository, StringRedisTemplate redisTemplate, JsonMapper jsonMapper) {
        this.repository = repository;
        this.redisTemplate = redisTemplate;
        this.jsonMapper = jsonMapper;
    }

    static String channelFor(long jobId) {
        return CHANNEL_PREFIX + jobId;
    }

    public void publish(long jobId) {
        repository.findJob(jobId).ifPresent(job -> {
            JobDetailResponse state = JobDetailResponse.of(job, repository.findSteps(jobId));
            try {
                redisTemplate.convertAndSend(channelFor(jobId), jsonMapper.writeValueAsString(state));
            } catch (RuntimeException ex) {
                log.warn("Failed to publish progress for job {}: {}", jobId, ex.getMessage());
            }
        });
    }
}
