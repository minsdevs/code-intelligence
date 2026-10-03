package dev.codeintelligence.project;

import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;

/**
 * Import step variant for local folder projects. Copies the local folder into the
 * repos storage and creates the snapshot. This is NOT registered in the pipeline
 * (no component or @Order). The active pipeline uses ImportStep's LOCAL branch.
 */
public class LocalImportStep implements JobStep {

    public static final String KEY = "LOCAL_IMPORT";

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final LocalImportService localImportService;
    private final LocalImportDiagnostics diagnostics;
    private final LocalSourceApprovalService approvals;

    public LocalImportStep(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            LocalImportService localImportService,
            LocalImportDiagnostics diagnostics,
            LocalSourceApprovalService approvals) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.localImportService = localImportService;
        this.diagnostics = diagnostics;
        this.approvals = approvals;
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

        LocalSourceBinding input = approvals.requireJobInput(ctx.jobId(), ctx.projectId());
        LocalImportService.LocalImportResult result = localImportService.importApproved(
                input, ctx.clonePath(), () -> approvals.verifyBeforePublish(ctx.jobId(), ctx.projectId()));

        if (result.branch() != null && !result.branch().equals(project.getDefaultBranch())) {
            project.updateDefaultBranch(result.branch());
        }
        projectRepository.save(project);

        Snapshot snapshot = snapshotRepository.save(new Snapshot(project.getId(), result.headSha()));
        ctx.attachSnapshot(snapshot.getId());
        diagnostics.record(project.getId(), snapshot.getId(), result.summary());
    }
}
