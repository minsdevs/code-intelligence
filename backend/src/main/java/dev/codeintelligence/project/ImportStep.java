package dev.codeintelligence.project;

import dev.codeintelligence.github.GitCloneService;
import dev.codeintelligence.github.GithubProperties;
import dev.codeintelligence.github.GithubTokenProvider;
import dev.codeintelligence.github.RepoRef;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import dev.codeintelligence.job.JobWorkspaceProvider;
import java.util.Objects;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * First pipeline step (§4): clone (or fetch) the repository, resolve HEAD, create the ANALYZING
 * snapshot and attach it to the job. Credentials: OAUTH wins over PAT, anonymous when the user
 * has none (public repos); the token is decrypted at call time and never logged.
 */
@Component
@Order(ImportStep.ORDER)
public class ImportStep implements JobStep {

    public static final String KEY = "IMPORT";
    public static final int ORDER = 100;

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final GitCloneService gitCloneService;
    private final GithubTokenProvider tokenProvider;
    private final GithubProperties githubProperties;
    private final LocalImportService localImportService;
    private final LocalImportDiagnostics localImportDiagnostics;
    private final LocalSourceApprovalService approvals;
    private final LocalSnapshotStore retainedSource;
    private final JobWorkspaceProvider workspaces;

    public ImportStep(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            GitCloneService gitCloneService,
            GithubTokenProvider tokenProvider,
            GithubProperties githubProperties,
            LocalImportService localImportService,
            LocalImportDiagnostics localImportDiagnostics,
            LocalSourceApprovalService approvals,
            LocalSnapshotStore retainedSource,
            JobWorkspaceProvider workspaces) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.gitCloneService = gitCloneService;
        this.tokenProvider = tokenProvider;
        this.githubProperties = githubProperties;
        this.localImportService = localImportService;
        this.localImportDiagnostics = localImportDiagnostics;
        this.approvals = approvals;
        this.retainedSource = retainedSource;
        this.workspaces = workspaces;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        Project project = projectRepository
                .findById(ctx.projectId())
                .orElseThrow(() -> new IllegalStateException("project no longer exists"));

        // Delegate to local import for LOCAL source type
        if ("LOCAL".equals(project.getSourceType())) {
            runLocalImport(project, ctx);
            return;
        }

        RepoRef ref = RepoRef.of(project.getRepoOwner(), project.getRepoName());
        String token = tokenProvider.findToken(project.getUserId()).orElse(null);

        GitCloneService.CloneResult result = gitCloneService.cloneOrFetch(
                ctx.clonePath(), ref.cloneUrl(githubProperties.cloneBaseUrl()), token, project.getDefaultBranch());

        if (!Objects.equals(project.getDefaultBranch(), result.branch())) {
            project.updateDefaultBranch(result.branch());
            projectRepository.save(project);
        }
        Snapshot snapshot = snapshotRepository.save(new Snapshot(project.getId(), result.headSha()));
        ctx.attachSnapshot(snapshot.getId());
    }

    private void runLocalImport(Project project, JobContext ctx) {
        // Source publication and the import checkpoint are separate crash boundaries. The worker
        // has already reconstructed a retained input lease; completing this checkpoint must not
        // reopen a changed or missing original folder, or rewrite its committed diagnostics.
        if (ctx.snapshotId().isPresent()
                && workspaces.verifyRetainedCheckpoint(
                        ctx.projectId(), ctx.jobId(), ctx.snapshotId().orElseThrow())) {
            ctx.updateProgress(100);
            return;
        }
        LocalSourceBinding input = approvals.requireJobInput(ctx.jobId(), ctx.projectId());
        var capture = retainedSource.enabled() ? retainedSource.begin(ctx.projectId(), ctx.jobId(), input) : null;
        LocalImportService.LocalImportResult result = localImportService.importApproved(
                input, ctx.clonePath(), () -> approvals.verifyBeforePublish(ctx.jobId(), ctx.projectId()), capture);

        if (result.branch() != null && !Objects.equals(project.getDefaultBranch(), result.branch())) {
            project.updateDefaultBranch(result.branch());
        }
        projectRepository.save(project);
        long snapshotId = capture == null
                ? snapshotRepository
                        .save(new Snapshot(project.getId(), result.headSha()))
                        .getId()
                : capture.publish(result.headSha(), result.summary());
        ctx.attachSnapshot(snapshotId);
        if (capture == null) localImportDiagnostics.record(project.getId(), snapshotId, result.summary());
    }
}
