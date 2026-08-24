package dev.codeintelligence.project;

import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.nio.file.Path;

/**
 * Import step variant for local folder projects. Copies the local folder into the
 * repos storage and creates the snapshot. This is NOT registered in the pipeline
 * (no @Order) — it is invoked directly by ProjectService for local imports.
 */
public class LocalImportStep implements JobStep {

    public static final String KEY = "LOCAL_IMPORT";

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final LocalImportService localImportService;

    public LocalImportStep(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            LocalImportService localImportService) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.localImportService = localImportService;
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

        String localPath = project.getLocalPath();
        if (localPath == null || localPath.isBlank()) {
            throw new IllegalStateException("project has no local path configured");
        }

        Path source = Path.of(localPath);
        Path target = ctx.clonePath();

        LocalImportService.LocalImportResult result = localImportService.importFolder(source, target);

        if (result.branch() != null && !result.branch().equals(project.getDefaultBranch())) {
            project.updateDefaultBranch(result.branch());
        }
        projectRepository.save(project);

        Snapshot snapshot = snapshotRepository.save(new Snapshot(project.getId(), result.headSha()));
        ctx.attachSnapshot(snapshot.getId());
    }
}
