package dev.codeintelligence.analysis.ts;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import dev.codeintelligence.analysis.core.InvalidFilePathException;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.SafeRelativePath;
import dev.codeintelligence.analysis.graph.GraphPersistenceService;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

@Component
@Order(TsParsingStep.ORDER)
public class TsParsingStep implements JobStep {

    public static final String KEY = "TS_PARSING";
    public static final int ORDER = 750;

    private static final Logger log = LoggerFactory.getLogger(TsParsingStep.class);

    private final TsAnalyzerClient client;
    private final JdbcClient jdbc;
    private final GraphPersistenceService persistence;
    private final AnalysisProperties analysisProperties;

    public TsParsingStep(
            TsAnalyzerClient client,
            JdbcClient jdbc,
            GraphPersistenceService persistence,
            AnalysisProperties analysisProperties) {
        this.client = client;
        this.jdbc = jdbc;
        this.persistence = persistence;
        this.analysisProperties = analysisProperties;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        List<InventoriedFile> files = loadTsFiles(snapshotId);
        if (!client.enabled()) {
            recordAll(snapshotId, files, "UNMEASURED", "ANALYZER_DISABLED");
            ctx.updateProgress(100);
            return;
        }
        ctx.updateProgress(10);
        if (files.isEmpty()) {
            ctx.updateProgress(100);
            return;
        }
        recordAll(snapshotId, files, "TARGETED", "PARSER_STARTED");
        try {
            client.health();
        } catch (RuntimeException failure) {
            recordAll(snapshotId, files, "FAILED", "ANALYZER_UNAVAILABLE");
            throw failure;
        }
        ctx.updateProgress(20);
        List<TsAnalyzeDtos.FilePayload> payloads;
        try {
            payloads = readPayloads(ctx.clonePath(), files, snapshotId);
        } catch (TsAnalyzerException failure) {
            recordAll(snapshotId, files, "UNMEASURED", "PROJECT_REQUEST_LIMIT");
            throw failure;
        }
        if (payloads.isEmpty()) {
            ctx.updateProgress(100);
            return;
        }
        // The analyzer resolves project-wide imports, DI and route prefixes. Independent
        // batches silently change their meaning; reject oversized projects before sending.
        TsAnalyzeDtos.Response response;
        try {
            response = client.analyze(new TsAnalyzeDtos.Request(payloads));
        } catch (RuntimeException failure) {
            var submitted =
                    payloads.stream().map(TsAnalyzeDtos.FilePayload::path).collect(java.util.stream.Collectors.toSet());
            recordAll(
                    snapshotId,
                    files.stream().filter(f -> submitted.contains(f.path())).toList(),
                    "FAILED",
                    failure instanceof TsSyntaxInputException ? "PROJECT_SYNTAX_REJECTED" : "ANALYZER_REQUEST_FAILED");
            throw failure;
        }
        AnalysisResult result = TsGraphMapper.toGraph(response);
        persistence.persist(ctx.projectId(), snapshotId, result);
        FileAnalysisOutcome.recordResponse(
                jdbc,
                snapshotId,
                payloads.stream()
                        .map(TsAnalyzeDtos.FilePayload::path)
                        .filter(TsParsingStep::isPrimarySource)
                        .toList(),
                result.fileOutcomes());
        ctx.updateProgress(100);
    }

    private static boolean isPrimarySource(String path) {
        return path.toLowerCase(Locale.ROOT).matches(".*\\.(?:[cm]?ts|tsx|[cm]?js|jsx)$");
    }

    private void recordAll(long snapshotId, List<InventoriedFile> files, String status, String reason) {
        for (InventoriedFile file : files) recordOne(snapshotId, file, status, reason);
    }

    private void recordOne(long snapshotId, InventoriedFile file, String status, String reason) {
        if (!isPrimarySource(file.path())) return;
        FileAnalysisOutcome.record(jdbc, snapshotId, file.path(), status, reason);
    }

    private List<InventoriedFile> loadTsFiles(long snapshotId) {
        return jdbc
                .sql("""
                        select path, language, size, line_count, content_hash
                        from files where snapshot_id = :snapshotId order by path
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new InventoriedFile(
                        rs.getString("path"),
                        rs.getString("language"),
                        rs.getLong("size"),
                        (Integer) rs.getObject("line_count"),
                        rs.getString("content_hash")))
                .list()
                .stream()
                .filter(TsParsingStep::isAnalyzerInput)
                .toList();
    }

    private List<TsAnalyzeDtos.FilePayload> readPayloads(Path clonePath, List<InventoriedFile> files, long snapshotId) {
        List<TsAnalyzeDtos.FilePayload> payloads = new ArrayList<>();
        TsRequestBudget budget = new TsRequestBudget();
        for (InventoriedFile file : files) {
            if (file.size() > analysisProperties.maxFileSize()) {
                recordOne(snapshotId, file, "UNMEASURED", "SOURCE_SIZE_LIMIT");
                continue;
            }
            try {
                Path resolved = SafeRelativePath.resolve(clonePath, file.path());
                if (!Files.isRegularFile(resolved)) {
                    recordOne(snapshotId, file, "FAILED", "SOURCE_UNAVAILABLE");
                    continue;
                }
                String content = Files.readString(resolved, StandardCharsets.UTF_8);
                TsAnalyzeDtos.FilePayload payload = new TsAnalyzeDtos.FilePayload(file.path(), content);
                budget.add(payload);
                payloads.add(payload);
            } catch (InvalidFilePathException | IOException e) {
                recordOne(snapshotId, file, "FAILED", "SOURCE_READ_FAILED");
                log.warn("Skipping TS file {}: {}", file.path(), e.toString());
            }
        }
        return payloads;
    }

    static boolean isAnalyzerInput(InventoriedFile file) {
        String language = file.language() == null ? "" : file.language().toLowerCase(Locale.ROOT);
        if ("typescript".equals(language)
                || "javascript".equals(language)
                || "python".equals(language)
                || "go".equals(language)) {
            return true;
        }
        String path = file.path().toLowerCase(Locale.ROOT);
        String name = path.substring(path.lastIndexOf('/') + 1);
        return path.endsWith(".ts")
                || path.endsWith(".tsx")
                || path.endsWith(".mts")
                || path.endsWith(".cts")
                || path.endsWith(".mjs")
                || path.endsWith(".cjs")
                || path.endsWith(".js")
                || path.endsWith(".jsx")
                || path.endsWith(".py")
                || path.endsWith(".go")
                || name.equals("package.json")
                || name.matches("(?:tsconfig|jsconfig)(?:\\.[^/]+)?\\.json");
    }
}
