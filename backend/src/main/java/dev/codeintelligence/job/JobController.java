package dev.codeintelligence.job;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/jobs")
public class JobController {

    private final JobService jobService;

    public JobController(JobService jobService) {
        this.jobService = jobService;
    }

    @GetMapping("/{jobId}")
    public JobDetailResponse get(@PathVariable long jobId, @AuthenticationPrincipal AuthenticatedUser user) {
        return jobService.getOwnedJob(jobId, user.userId());
    }

    @PostMapping("/{jobId}/retry")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public void retry(@PathVariable long jobId, @AuthenticationPrincipal AuthenticatedUser user) {
        jobService.retry(jobId, user.userId());
    }

    @PostMapping("/{jobId}/cancel")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public void cancel(@PathVariable long jobId, @AuthenticationPrincipal AuthenticatedUser user) {
        jobService.cancel(jobId, user.userId());
    }
}
