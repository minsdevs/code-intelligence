package dev.codeintelligence.project;

import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.github.GitCloneService;
import dev.codeintelligence.github.InvalidRepoInputException;
import dev.codeintelligence.github.RepoRef;
import dev.codeintelligence.job.JobService;
import dev.codeintelligence.job.JobSummaryResponse;
import dev.codeintelligence.job.JobType;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

@Service
public class ProjectService {

    public record CreatedProject(ProjectResponse project, long jobId) {}

    private static final String DUPLICATE_DETAIL = "This repository is already imported.";
    static final int TOP_TECHNOLOGIES_LIMIT = 5;

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JobService jobService;
    private final GitCloneService gitCloneService;
    private final LocalImportService localImportService;
    private final LocalSourceStatusService localSourceStatusService;
    private final AppProperties appProperties;
    private final JdbcClient jdbc;

    public ProjectService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            JobService jobService,
            GitCloneService gitCloneService,
            LocalImportService localImportService,
            LocalSourceStatusService localSourceStatusService,
            AppProperties appProperties,
            JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jobService = jobService;
        this.gitCloneService = gitCloneService;
        this.localImportService = localImportService;
        this.localSourceStatusService = localSourceStatusService;
        this.appProperties = appProperties;
        this.jdbc = jdbc;
    }

    /** Project row and its IMPORT job commit atomically; the worker starts only after commit. */
    @Transactional
    public CreatedProject create(long userId, ProjectController.CreateProjectRequest request) {
        RepoRef ref = resolveRef(request);
        if (projectRepository.existsByUserIdAndRepoOwnerAndRepoName(userId, ref.owner(), ref.name())) {
            throw new ProjectConflictException(DUPLICATE_DETAIL);
        }
        Project project = new Project(userId, ref.name(), ref.owner(), ref.name());
        if (StringUtils.hasText(request.branch())) {
            project.updateDefaultBranch(request.branch().trim());
        }
        try {
            project = projectRepository.save(project);
        } catch (DataIntegrityViolationException e) {
            throw new ProjectConflictException(DUPLICATE_DETAIL);
        }
        project.assignClonePath(appProperties
                .reposRoot()
                .resolve(String.valueOf(project.getId()))
                .toString());
        long jobId = jobService.enqueue(project.getId(), JobType.IMPORT);
        return new CreatedProject(toResponse(project, ProjectSummaries.empty()), jobId);
    }

    /** Create a project from a local folder path. */
    @Transactional
    public CreatedProject createFromLocal(long userId, ProjectController.CreateLocalProjectRequest request) {
        if (request.path() == null || request.path().isBlank()) {
            throw new LocalImportException("path is required", null);
        }
        String name = request.name() != null && !request.name().isBlank()
                ? request.name()
                : Path.of(request.path()).getFileName().toString();

        // Validate path before creating any DB rows
        localImportService.validateSource(Path.of(request.path()));

        if (projectRepository.existsByUserIdAndRepoOwnerAndRepoName(userId, "local", name)) {
            throw new ProjectConflictException("A local project with this name already exists.");
        }
        Project project;
        try {
            project = projectRepository.save(new Project(userId, name, request.path()));
        } catch (DataIntegrityViolationException e) {
            throw new ProjectConflictException("A local project with this name already exists.");
        }
        project.assignClonePath(appProperties
                .reposRoot()
                .resolve(String.valueOf(project.getId()))
                .toString());
        long jobId = jobService.enqueue(project.getId(), JobType.IMPORT);
        return new CreatedProject(toResponse(project, ProjectSummaries.empty()), jobId);
    }

    @Transactional(readOnly = true)
    public List<ProjectResponse> list(long userId) {
        List<Project> projects = projectRepository.findAllByUserIdOrderByCreatedAtDesc(userId);
        ProjectSummaries summaries = loadSummaries(projects);
        return projects.stream().map(project -> toResponse(project, summaries)).toList();
    }

    @Transactional(readOnly = true)
    public ProjectResponse get(long projectId, long userId) {
        Project project = requireOwned(projectId, userId);
        return toResponse(project, loadSummaries(List.of(project)));
    }

    @Transactional
    public ProjectResponse relinkLocalSource(long projectId, long userId, String path) {
        if (!StringUtils.hasText(path)) {
            throw new LocalImportException("path is required", null);
        }
        Project project = requireOwned(projectId, userId);
        if (!"LOCAL".equals(project.getSourceType())) {
            throw new LocalImportException("Only local projects can be relinked.", null);
        }
        Path authorizedPath = localImportService.validateSource(Path.of(path));
        project.updateLocalPath(authorizedPath.toString());
        return toResponse(project, loadSummaries(List.of(project)));
    }

    @Transactional(readOnly = true)
    public LocalSourceStatusService.LocalSourceStatus localSourceStatus(long projectId, long userId) {
        return localSourceStatusService.get(projectId, userId);
    }

    public List<JobSummaryResponse> listJobs(long projectId, long userId, int limit) {
        requireOwned(projectId, userId);
        return jobService.listRecent(projectId, limit);
    }

    public long reanalyze(long projectId, long userId, LocalSourceStatusService.RefreshConfirmation confirmation) {
        Project project = requireOwned(projectId, userId);
        localSourceStatusService.verifyRefresh(projectId, userId, confirmation);
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

    private ProjectResponse toResponse(Project project, ProjectSummaries summaries) {
        long id = project.getId();
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
                project.getSourceType(),
                "LOCAL".equals(project.getSourceType())
                        ? project.getLocalPath()
                        : project.getRepoOwner() + "/" + project.getRepoName(),
                currentSnapshot,
                latestJob,
                summaries.selectedAreas(id),
                summaries.topTechnologies(id),
                summaries.latestCommit(id),
                summaries.latestPull(id),
                project.getCreatedAt(),
                project.getUpdatedAt());
    }

    private ProjectSummaries loadSummaries(List<Project> projects) {
        if (projects.isEmpty()) {
            return ProjectSummaries.empty();
        }
        List<Long> ids = projects.stream().map(Project::getId).toList();
        ProjectSummaries summaries = new ProjectSummaries();
        jdbc.sql("""
                        select project_id, area_type
                        from project_area_selections
                        where project_id in (:ids) and selected = true
                        order by project_id, area_type
                        """)
                .param("ids", ids)
                .query((rs, rowNum) -> {
                    summaries.addArea(rs.getLong("project_id"), rs.getString("area_type"));
                    return 0;
                })
                .list();
        jdbc.sql("""
                        select project_id, name
                        from (
                            select p.id as project_id,
                                   t.name as name,
                                   row_number() over (
                                       partition by p.id
                                       order by count(*) desc, t.name
                                   ) as rn
                            from projects p
                            join project_areas a on a.snapshot_id = p.current_snapshot_id
                            join area_technologies t on t.area_id = a.id
                            join project_area_selections s
                              on s.project_id = p.id
                             and s.area_type = a.area_type
                             and s.selected = true
                            where p.id in (:ids)
                            group by p.id, t.name
                        ) ranked
                        where rn <= :limit
                        order by project_id, rn
                        """)
                .param("ids", ids)
                .param("limit", TOP_TECHNOLOGIES_LIMIT)
                .query((rs, rowNum) -> {
                    summaries.addTechnology(rs.getLong("project_id"), rs.getString("name"));
                    return 0;
                })
                .list();
        jdbc.sql("""
                        select project_id, sha, message
                        from (
                            select project_id, sha, message,
                                   row_number() over (
                                       partition by project_id
                                       order by committed_at desc, sha
                                   ) as rn
                            from commits
                            where project_id in (:ids)
                        ) ranked
                        where rn = 1
                        """)
                .param("ids", ids)
                .query((rs, rowNum) -> {
                    summaries.putCommit(
                            rs.getLong("project_id"),
                            new ProjectResponse.LatestCommitView(rs.getString("sha"), rs.getString("message")));
                    return 0;
                })
                .list();
        jdbc.sql("""
                        select project_id, number, title, state, author, merged_at
                        from (
                            select project_id, number, title, state, author, merged_at,
                                   row_number() over (
                                       partition by project_id
                                       order by number desc
                                   ) as rn
                            from pull_requests
                            where project_id in (:ids)
                        ) ranked
                        where rn = 1
                        """)
                .param("ids", ids)
                .query((rs, rowNum) -> {
                    summaries.putPull(
                            rs.getLong("project_id"),
                            new ProjectResponse.LatestPullView(
                                    rs.getInt("number"),
                                    rs.getString("title"),
                                    rs.getString("state"),
                                    rs.getString("author"),
                                    toInstant(rs.getObject("merged_at", OffsetDateTime.class))));
                    return 0;
                })
                .list();
        return summaries;
    }

    private static Instant toInstant(OffsetDateTime value) {
        return value == null ? null : value.toInstant();
    }

    private static final class ProjectSummaries {
        private final Map<Long, List<String>> selectedAreas = new HashMap<>();
        private final Map<Long, List<String>> topTechnologies = new HashMap<>();
        private final Map<Long, ProjectResponse.LatestCommitView> latestCommits = new HashMap<>();
        private final Map<Long, ProjectResponse.LatestPullView> latestPulls = new HashMap<>();

        static ProjectSummaries empty() {
            return new ProjectSummaries();
        }

        void addArea(long projectId, String areaType) {
            selectedAreas.computeIfAbsent(projectId, key -> new ArrayList<>()).add(areaType);
        }

        void addTechnology(long projectId, String name) {
            topTechnologies.computeIfAbsent(projectId, key -> new ArrayList<>()).add(name);
        }

        void putCommit(long projectId, ProjectResponse.LatestCommitView commit) {
            latestCommits.put(projectId, commit);
        }

        void putPull(long projectId, ProjectResponse.LatestPullView pull) {
            latestPulls.put(projectId, pull);
        }

        List<String> selectedAreas(long projectId) {
            return List.copyOf(selectedAreas.getOrDefault(projectId, List.of()));
        }

        List<String> topTechnologies(long projectId) {
            return List.copyOf(topTechnologies.getOrDefault(projectId, List.of()));
        }

        ProjectResponse.LatestCommitView latestCommit(long projectId) {
            return latestCommits.get(projectId);
        }

        ProjectResponse.LatestPullView latestPull(long projectId) {
            return latestPulls.get(projectId);
        }
    }
}
