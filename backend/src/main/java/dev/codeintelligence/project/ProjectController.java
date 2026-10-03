package dev.codeintelligence.project;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.job.JobSummaryResponse;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
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

    public record CreateProjectRequest(String repoOwner, String repoName, String url, String branch) {}

    public record CreateLocalProjectRequest(String path, String name, String previewToken) {}

    public record LocalPreviewRequest(String path, String name) {}

    public record PreviewTokenRequest(String previewToken) {}

    public record RelinkLocalProjectRequest(String path) {}

    public record CreateProjectResponse(ProjectResponse project, long jobId) {}

    public record ReanalyzeRequest(String previewToken) {}

    public record ReanalyzeResponse(long jobId) {}

    private final ProjectService projectService;
    private final LocalSourceApprovalService approvals;

    public ProjectController(ProjectService projectService, LocalSourceApprovalService approvals) {
        this.projectService = projectService;
        this.approvals = approvals;
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

    @PostMapping("/local/preview")
    public LocalSourcePreview previewLocal(
            @RequestBody LocalPreviewRequest request, @AuthenticationPrincipal AuthenticatedUser user) {
        return approvals.previewInitial(user.userId(), request.path(), request.name());
    }

    @PostMapping("/{projectId}/local-preview")
    public LocalSourcePreview previewLocalRefresh(
            @PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return approvals.previewRefresh(projectId, user.userId());
    }

    @PostMapping("/local/preview-outcome")
    public LocalSourceApprovalService.Outcome previewOutcome(
            @RequestBody PreviewTokenRequest request, @AuthenticationPrincipal AuthenticatedUser user) {
        return approvals.outcome(user.userId(), request.previewToken());
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

    @PatchMapping("/{projectId}/local-source")
    public ProjectResponse relinkLocalSource(
            @PathVariable long projectId,
            @RequestBody RelinkLocalProjectRequest request,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return projectService.relinkLocalSource(projectId, user.userId(), request.path());
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
                projectService.reanalyze(projectId, user.userId(), request == null ? null : request.previewToken()));
    }
}
