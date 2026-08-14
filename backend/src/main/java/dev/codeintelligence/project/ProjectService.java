package dev.codeintelligence.project;

import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.github.GitCloneService;
import dev.codeintelligence.github.InvalidRepoInputException;
import dev.codeintelligence.github.RepoRef;
import dev.codeintelligence.job.JobService;
import dev.codeintelligence.job.JobSummaryResponse;
import dev.codeintelligence.job.JobType;
import java.nio.file.Path;
import java.util.List;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

@Service
public class ProjectService {

    public record CreatedProject(ProjectResponse project, long jobId) {}

    private static final String DUPLICATE_DETAIL = "This repository is already imported.";

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JobService jobService;
    private final GitCloneService gitCloneService;
    private final AppProperties appProperties;

    public ProjectService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            JobService jobService,
            GitCloneService gitCloneService,
            AppProperties appProperties) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jobService = jobService;
        this.gitCloneService = gitCloneService;
        this.appProperties = appProperties;
    }

    /** Project row and its IMPORT job commit atomically; the worker starts only after commit. */
    @Transactional
    public CreatedProject create(long userId, ProjectController.CreateProjectRequest request) {
        RepoRef ref = resolveRef(request);
        if (projectRepository.existsByUserIdAndRepoOwnerAndRepoName(userId, ref.owner(), ref.name())) {
            throw new ProjectConflictException(DUPLICATE_DETAIL);
        }
        Project project;
        try {
            project = projectRepository.save(new Project(userId, ref.name(), ref.owner(), ref.name()));
        } catch (DataIntegrityViolationException e) {
            throw new ProjectConflictException(DUPLICATE_DETAIL);
        }
        project.assignClonePath(appProperties
                .reposRoot()
                .resolve(String.valueOf(project.getId()))
                .toString());
        long jobId = jobService.enqueue(project.getId(), JobType.IMPORT);
        return new CreatedProject(toResponse(project), jobId);
    }

    @Transactional(readOnly = true)
    public List<ProjectResponse> list(long userId) {
        return projectRepository.findAllByUserIdOrderByCreatedAtDesc(userId).stream()
                .map(this::toResponse)
                .toList();
    }

    @Transactional(readOnly = true)
    public ProjectResponse get(long projectId, long userId) {
        return toResponse(requireOwned(projectId, userId));
    }

    public List<JobSummaryResponse> listJobs(long projectId, long userId, int limit) {
        requireOwned(projectId, userId);
        return jobService.listRecent(projectId, limit);
    }

    public long reanalyze(long projectId, long userId) {
        Project project = requireOwned(projectId, userId);
        return jobService.enqueue(project.getId(), JobType.REANALYZE);
    }

    /**
     * The row (with cascaded snapshots/jobs) goes first; the clone directory is removed after the
     * delete commits, behind the canonical-path re-validation in GitCloneService.
     */
    public void delete(long projectId, long userId) {
        Project project = requireOwned(projectId, userId);
        if (jobService.hasActiveJob(projectId)) {
            throw new ProjectConflictException("An analysis job is active for this project. Cancel it first.");
        }
        projectRepository.delete(project);
        if (project.getClonePath() != null) {
            gitCloneService.deleteClone(Path.of(project.getClonePath()));
        }
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private RepoRef resolveRef(ProjectController.CreateProjectRequest request) {
        boolean hasUrl = StringUtils.hasText(request.url());
        boolean hasCoordinates = StringUtils.hasText(request.repoOwner()) || StringUtils.hasText(request.repoName());
        if (hasUrl && hasCoordinates) {
            throw new InvalidRepoInputException("Provide either url or repoOwner/repoName, not both.");
        }
        if (hasUrl) {
            return RepoRef.fromUrl(request.url());
        }
        if (StringUtils.hasText(request.repoOwner()) && StringUtils.hasText(request.repoName())) {
            return RepoRef.of(request.repoOwner(), request.repoName());
        }
        throw new InvalidRepoInputException("Provide repoOwner and repoName, or a GitHub url.");
    }

    private ProjectResponse toResponse(Project project) {
        ProjectResponse.SnapshotView currentSnapshot = project.getCurrentSnapshotId() == null
                ? null
                : snapshotRepository
                        .findById(project.getCurrentSnapshotId())
                        .map(ProjectResponse.SnapshotView::of)
                        .orElse(null);
        JobSummaryResponse latestJob = jobService.findLatest(project.getId()).orElse(null);
        return new ProjectResponse(
                project.getId(),
                project.getName(),
                project.getRepoOwner(),
                project.getRepoName(),
                project.getDefaultBranch(),
                currentSnapshot,
                latestJob,
                project.getCreatedAt(),
                project.getUpdatedAt());
    }
}
