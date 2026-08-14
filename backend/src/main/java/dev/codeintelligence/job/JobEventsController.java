package dev.codeintelligence.job;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
public class JobEventsController {

    private final JobService jobService;
    private final JobSseBroadcaster broadcaster;

    public JobEventsController(JobService jobService, JobSseBroadcaster broadcaster) {
        this.jobService = jobService;
        this.broadcaster = broadcaster;
    }

    /** The ownership lookup doubles as the initial snapshot sent right after connect (위험 R6). */
    @GetMapping(value = "/api/jobs/{jobId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable long jobId, @AuthenticationPrincipal AuthenticatedUser user) {
        JobDetailResponse snapshot = jobService.getOwnedJob(jobId, user.userId());
        return broadcaster.subscribe(jobId, snapshot);
    }
}
