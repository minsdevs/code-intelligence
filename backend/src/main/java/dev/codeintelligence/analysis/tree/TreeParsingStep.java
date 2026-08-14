package dev.codeintelligence.analysis.tree;

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

/**
 * Parses Python, Go, Vue and Svelte files through the tree-sitter sidecar.
 * Runs after {@code TS_PARSING} (750) and before {@code ExtractionStep} (800) so the
 * resulting API_ENDPOINT/FE_ROUTE nodes are projected into their lookup tables.
 */
@Component
@Order(TreeParsingStep.ORDER)
public class TreeParsingStep implements JobStep {

    public static final String KEY = "TREE_PARSING";
    public static final int ORDER = 770;
    static final int BATCH_SIZE = 40;

    private static final Logger log = LoggerFactory.getLogger(TreeParsingStep.class);

    private final TreeAnalyzerClient client;
    private final JdbcClient jdbc;
    private final GraphPersistenceService persistence;
    private final AnalysisProperties analysisProperties;

    public TreeParsingStep(
            TreeAnalyzerClient client,
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
        List<InventoriedFile> files = loadFiles(snapshotId);
        if (files.isEmpty()) {
            ctx.updateProgress(100);
            return;
        }
        client.health();
        ctx.updateProgress(20);
        List<TreeAnalyzeDtos.FilePayload> payloads = readPayloads(ctx.clonePath(), files);
        if (payloads.isEmpty()) {
            ctx.updateProgress(100);
            return;
        }
        for (int start = 0; start < payloads.size(); start += BATCH_SIZE) {
            int end = Math.min(payloads.size(), start + BATCH_SIZE);
            TreeAnalyzeDtos.Response response =
                    client.analyze(new TreeAnalyzeDtos.Request(payloads.subList(start, end)));
            AnalysisResult result = TreeGraphMapper.toGraph(response);
            persistence.persist(ctx.projectId(), snapshotId, result);
            ctx.updateProgress(20 + Math.min(75, (75 * end) / payloads.size()));
        }
        ctx.updateProgress(100);
    }

    private List<InventoriedFile> loadFiles(long snapshotId) {
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
                .filter(TreeParsingStep::isTargetSource)
                .toList();
    }

    private List<TreeAnalyzeDtos.FilePayload> readPayloads(Path clonePath, List<InventoriedFile> files) {
        List<TreeAnalyzeDtos.FilePayload> payloads = new ArrayList<>();
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
                payloads.add(new TreeAnalyzeDtos.FilePayload(file.path(), content));
            } catch (InvalidFilePathException | IOException e) {
                log.warn("Skipping source file {}: {}", file.path(), e.toString());
            }
        }
        return payloads;
    }

    static boolean isTargetSource(InventoriedFile file) {
        String path = file.path().toLowerCase(Locale.ROOT);
        return path.endsWith(".py") || path.endsWith(".go") || path.endsWith(".vue") || path.endsWith(".svelte");
    }
}
