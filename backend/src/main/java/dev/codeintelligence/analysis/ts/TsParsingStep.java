package dev.codeintelligence.analysis.ts;

import dev.codeintelligence.analysis.core.AnalysisResult;
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
    static final int BATCH_SIZE = 500;

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
        if (!client.enabled()) {
            ctx.updateProgress(100);
            return;
        }
        ctx.updateProgress(10);
        List<InventoriedFile> files = loadTsFiles(snapshotId);
        if (files.isEmpty()) {
            ctx.updateProgress(100);
            return;
        }
        client.health();
        ctx.updateProgress(20);
        List<TsAnalyzeDtos.FilePayload> payloads = readPayloads(ctx.clonePath(), files);
        if (payloads.isEmpty()) {
            ctx.updateProgress(100);
            return;
        }
        for (int start = 0; start < payloads.size(); start += BATCH_SIZE) {
            int end = Math.min(payloads.size(), start + BATCH_SIZE);
            TsAnalyzeDtos.Response response = client.analyze(new TsAnalyzeDtos.Request(payloads.subList(start, end)));
            AnalysisResult result = TsGraphMapper.toGraph(response);
            persistence.persist(ctx.projectId(), snapshotId, result);
            ctx.updateProgress(20 + Math.min(75, (75 * end) / payloads.size()));
        }
        ctx.updateProgress(100);
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

    private List<TsAnalyzeDtos.FilePayload> readPayloads(Path clonePath, List<InventoriedFile> files) {
        List<TsAnalyzeDtos.FilePayload> payloads = new ArrayList<>();
        for (InventoriedFile file : files) {
            if (file.size() > analysisProperties.maxFileSize()) {
                continue;
            }
            try {
                Path resolved = SafeRelativePath.resolve(clonePath, file.path());
                if (!Files.isRegularFile(resolved)) {
                    continue;
                }
                String content = Files.readString(resolved, StandardCharsets.UTF_8);
                payloads.add(new TsAnalyzeDtos.FilePayload(file.path(), content));
            } catch (InvalidFilePathException | IOException e) {
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
                || path.endsWith(".js")
                || path.endsWith(".jsx")
                || path.endsWith(".py")
                || path.endsWith(".go")
                || name.equals("package.json")
                || name.matches("(?:tsconfig|jsconfig)(?:\\.[^/]+)?\\.json");
    }
}
