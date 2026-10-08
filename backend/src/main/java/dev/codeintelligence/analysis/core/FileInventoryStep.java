package dev.codeintelligence.analysis.core;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.job.JobCancellation;
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
    private final org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate batches;
    private final TransactionTemplate transactionTemplate;
    private final AnalysisProperties analysisProperties;
    private final EvidenceService evidenceService;

    public FileInventoryStep(
            FileInventoryScanner scanner,
            JdbcClient jdbc,
            org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate batches,
            TransactionTemplate transactionTemplate,
            AnalysisProperties analysisProperties,
            EvidenceService evidenceService) {
        this.scanner = scanner;
        this.jdbc = jdbc;
        this.batches = batches;
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
            for (int offset = 0; offset < result.files().size(); offset += 500) {
                JobCancellation.checkpoint();
                var batch = new org.springframework.jdbc.core.namedparam.SqlParameterSource
                        [Math.min(500, result.files().size() - offset)];
                for (int index = 0; index < batch.length; index++) {
                    InventoriedFile file = result.files().get(offset + index);
                    String status = FileAnalysisOutcome.initialStatus(file);
                    batch[index] = new org.springframework.jdbc.core.namedparam.MapSqlParameterSource()
                            .addValue("snapshotId", snapshotId)
                            .addValue("path", file.path())
                            .addValue("language", file.language())
                            .addValue("size", file.size())
                            .addValue("lineCount", file.lineCount())
                            .addValue("contentHash", file.contentHash())
                            .addValue("status", status)
                            .addValue(
                                    "reason",
                                    "UNSUPPORTED".equals(status)
                                            ? "SOURCE_LANGUAGE_UNSUPPORTED"
                                            : "PARSER_NOT_MEASURED");
                }
                batches.batchUpdate("""
                        insert into files (snapshot_id, path, language, size, line_count, content_hash, analysis_status, analysis_reason)
                        values (:snapshotId, :path, :language, :size, :lineCount, :contentHash, :status, :reason)
                        """, batch);
            }
            jdbc.sql("""
                    insert into snapshot_inventory_measurements
                    (snapshot_id, discovered_files, excluded_for_count, excluded_for_size, excluded_binary, excluded_submodules)
                    values (:sid,:discovered,:count,:size,:binary,:submodules)
                    on conflict (snapshot_id) do update set discovered_files=excluded.discovered_files,
                    excluded_for_count=excluded.excluded_for_count, excluded_for_size=excluded.excluded_for_size,
                    excluded_binary=excluded.excluded_binary, excluded_submodules=excluded.excluded_submodules
                    """)
                    .param("sid", snapshotId)
                    .param(
                            "discovered",
                            result.files().size()
                                    + result.skippedForCount()
                                    + result.skippedForSize()
                                    + result.skippedBinary())
                    .param("count", result.skippedForCount())
                    .param("size", result.skippedForSize())
                    .param("binary", result.skippedBinary())
                    .param("submodules", result.skippedSubmodules())
                    .update();
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
