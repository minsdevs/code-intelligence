package dev.codeintelligence.project;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.job.JobSummaryResponse;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/projects")
public class ProjectController {

    public record CreateProjectRequest(String repoOwner, String repoName, String url) {}

    public record CreateLocalProjectRequest(String path, String name) {}

    public record CreateProjectResponse(ProjectResponse project, long jobId) {}

    public record ReanalyzeRequest(Long snapshotId, Integer added, Integer modified, Integer deleted) {
        LocalSourceStatusService.RefreshConfirmation confirmation() {
            if (snapshotId == null || added == null || modified == null || deleted == null) return null;
            return new LocalSourceStatusService.RefreshConfirmation(snapshotId, added, modified, deleted);
        }
    }

    public record ReanalyzeResponse(long jobId) {}

    private final ProjectService projectService;

    public ProjectController(ProjectService projectService) {
        this.projectService = projectService;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public CreateProjectResponse create(
            @RequestBody CreateProjectRequest request, @AuthenticationPrincipal AuthenticatedUser user) {
        ProjectService.CreatedProject created = projectService.create(user.userId(), request);
        return new CreateProjectResponse(created.project(), created.jobId());
    }

    @PostMapping("/local")
    @ResponseStatus(HttpStatus.CREATED)
    public CreateProjectResponse createLocal(
            @RequestBody CreateLocalProjectRequest request, @AuthenticationPrincipal AuthenticatedUser user) {
        ProjectService.CreatedProject created = projectService.createFromLocal(user.userId(), request);
        return new CreateProjectResponse(created.project(), created.jobId());
    }

    @GetMapping
    public List<ProjectResponse> list(@AuthenticationPrincipal AuthenticatedUser user) {
        return projectService.list(user.userId());
    }

    @GetMapping("/{projectId}")
    public ProjectResponse get(@PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return projectService.get(projectId, user.userId());
    }

    @GetMapping("/{projectId}/jobs")
    public List<JobSummaryResponse> jobs(
            @PathVariable long projectId,
            @RequestParam(defaultValue = "10") int limit,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return projectService.listJobs(projectId, user.userId(), Math.clamp(limit, 1, 50));
    }

    @GetMapping("/{projectId}/local-source-status")
    public LocalSourceStatusService.LocalSourceStatus localSourceStatus(
            @PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return projectService.localSourceStatus(projectId, user.userId());
    }

    @DeleteMapping("/{projectId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        projectService.delete(projectId, user.userId());
    }

    @PostMapping("/{projectId}/reanalyze")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public ReanalyzeResponse reanalyze(
            @PathVariable long projectId,
            @RequestBody(required = false) ReanalyzeRequest request,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return new ReanalyzeResponse(
                projectService.reanalyze(projectId, user.userId(), request == null ? null : request.confirmation()));
    }
}
