package dev.codeintelligence.analysis.core;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
@Order(FileInventoryStep.ORDER)
public class FileInventoryStep implements JobStep {

    public static final String KEY = "FILE_INVENTORY";
    public static final int ORDER = 200;

    private final FileInventoryScanner scanner;
    private final JdbcClient jdbc;
    private final TransactionTemplate transactionTemplate;
    private final AnalysisProperties analysisProperties;
    private final EvidenceService evidenceService;

    public FileInventoryStep(
            FileInventoryScanner scanner,
            JdbcClient jdbc,
            TransactionTemplate transactionTemplate,
            AnalysisProperties analysisProperties,
            EvidenceService evidenceService) {
        this.scanner = scanner;
        this.jdbc = jdbc;
        this.transactionTemplate = transactionTemplate;
        this.analysisProperties = analysisProperties;
        this.evidenceService = evidenceService;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) throws Exception {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        ctx.updateProgress(10);
        InventoryResult result =
                scanner.scan(ctx.clonePath(), analysisProperties.maxFiles(), analysisProperties.maxFileSize());
        ctx.updateProgress(70);
        transactionTemplate.executeWithoutResult(tx -> {
            jdbc.sql("delete from files where snapshot_id = :snapshotId")
                    .param("snapshotId", snapshotId)
                    .update();
            for (InventoriedFile file : result.files()) {
                jdbc.sql("""
                                insert into files (snapshot_id, path, language, size, line_count, content_hash)
                                values (:snapshotId, :path, :language, :size, :lineCount, :contentHash)
                                """)
                        .param("snapshotId", snapshotId)
                        .param("path", file.path())
                        .param("language", file.language())
                        .param("size", file.size())
                        .param("lineCount", file.lineCount())
                        .param("contentHash", file.contentHash())
                        .update();
            }
        });
        recordSkipWarnings(ctx.projectId(), snapshotId, result);
        ctx.updateProgress(100);
    }

    private void recordSkipWarnings(long projectId, long snapshotId, InventoryResult result) {
        evidenceService.deleteLinked(EvidenceSubjects.SNAPSHOT, snapshotId);
        if (result.skippedSubmodules() > 0) {
            long id = evidenceService.insertStatic(
                    projectId,
                    new NewEvidence(
                            EvidenceKind.CONFIG,
                            null,
                            null,
                            null,
                            "Skipped " + result.skippedSubmodules()
                                    + " Git submodules; their contents are not analyzed."));
            evidenceService.link(id, EvidenceSubjects.SNAPSHOT, snapshotId);
        }
        if (result.skippedForCount() > 0) {
            long id = evidenceService.insertStatic(
                    projectId,
                    new NewEvidence(
                            EvidenceKind.CONFIG,
                            null,
                            null,
                            null,
                            "Skipped " + result.skippedForCount() + " files over app.analysis.max-files."));
            evidenceService.link(id, EvidenceSubjects.SNAPSHOT, snapshotId);
        }
        if (result.skippedForSize() > 0) {
            long id = evidenceService.insertStatic(
                    projectId,
                    new NewEvidence(
                            EvidenceKind.CONFIG,
                            null,
                            null,
                            null,
                            "Skipped " + result.skippedForSize() + " files over app.analysis.max-file-size."));
            evidenceService.link(id, EvidenceSubjects.SNAPSHOT, snapshotId);
        }
    }
}
