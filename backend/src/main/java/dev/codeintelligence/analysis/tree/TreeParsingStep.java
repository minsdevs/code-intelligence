package dev.codeintelligence.analysis.tree;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import dev.codeintelligence.analysis.core.InvalidFilePathException;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.SafeRelativePath;
import dev.codeintelligence.analysis.graph.GraphPersistenceService;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.job.JobCancellation;
import dev.codeintelligence.job.JobCancelledException;
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
    private static final tools.jackson.databind.json.JsonMapper JSON =
            tools.jackson.databind.json.JsonMapper.builder().build();
    private final dev.codeintelligence.analysis.core.AdapterResultCache cache =
            new dev.codeintelligence.analysis.core.AdapterResultCache();

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
        List<InventoriedFile> files = loadFiles(snapshotId);
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
            JobCancellation.interruptibly(() -> {
                client.health();
                return null;
            });
        } catch (JobCancelledException cancelled) {
            throw cancelled;
        } catch (RuntimeException failure) {
            recordAll(snapshotId, files, "FAILED", "ANALYZER_UNAVAILABLE");
            throw failure;
        }
        ctx.updateProgress(20);
        var previous = cache.snapshot(
                ctx.projectId(), files.stream().map(InventoriedFile::path).toList());
        List<TreeAnalyzeDtos.FilePayload> payloads = readPayloads(ctx.clonePath(), files, snapshotId, previous);
        if (payloads.isEmpty()) {
            ctx.updateProgress(100);
            return;
        }
        var localPaths =
                payloads.stream().map(TreeAnalyzeDtos.FilePayload::path).toList();
        List<String> nextCache = new ArrayList<>();
        int cacheBytes = 0;
        int envelopeBytes =
                JSON.writeValueAsBytes(new TreeAnalyzeDtos.Request(List.of(), localPaths, cache.signingKey())).length;
        for (int start = 0; start < payloads.size(); ) {
            int end = start;
            int bytes = envelopeBytes;
            while (end < payloads.size() && end - start < BATCH_SIZE) {
                int size = JSON.writeValueAsBytes(payloads.get(end)).length + 1;
                if (bytes + size > 10 * 1024 * 1024) break;
                bytes += size;
                end++;
            }
            if (end == start) throw new TreeAnalyzerException("Tree analysis request exceeds 10 MiB", null);
            List<TreeAnalyzeDtos.FilePayload> batch = payloads.subList(start, end);
            TreeAnalyzeDtos.Response response;
            try {
                response = JobCancellation.interruptibly(
                        () -> client.analyze(new TreeAnalyzeDtos.Request(batch, localPaths, cache.signingKey())));
            } catch (JobCancelledException cancelled) {
                throw cancelled;
            } catch (RuntimeException failure) {
                FileAnalysisOutcome.recordFiles(
                        jdbc,
                        snapshotId,
                        batch.stream().map(TreeAnalyzeDtos.FilePayload::path)::iterator,
                        "FAILED",
                        "ANALYZER_REQUEST_FAILED");
                throw failure;
            }
            AnalysisResult result = TreeGraphMapper.toGraph(response);
            persistence.persist(ctx.projectId(), snapshotId, result);
            for (String entry : response.cache()) {
                int size = entry.length() * 2;
                if (size <= dev.codeintelligence.analysis.core.AdapterResultCache.MAX_ENTRY_BYTES
                        && cacheBytes + size <= dev.codeintelligence.analysis.core.AdapterResultCache.MAX_BYTES) {
                    nextCache.add(entry);
                    cacheBytes += size;
                }
            }
            FileAnalysisOutcome.recordResponse(
                    jdbc,
                    snapshotId,
                    batch.stream().map(TreeAnalyzeDtos.FilePayload::path)::iterator,
                    response.fileOutcomes());
            ctx.updateProgress(20 + Math.min(75, (75 * end) / payloads.size()));
            start = end;
        }
        cache.replace(ctx.projectId(), localPaths, nextCache);
        ctx.updateProgress(100);
    }

    private void recordAll(long snapshotId, List<InventoriedFile> files, String status, String reason) {
        FileAnalysisOutcome.recordFiles(
                jdbc, snapshotId, files.stream().map(InventoriedFile::path)::iterator, status, reason);
    }

    private void recordOne(long snapshotId, InventoriedFile file, String status, String reason) {

        FileAnalysisOutcome.record(jdbc, snapshotId, file.path(), status, reason);
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

    private List<TreeAnalyzeDtos.FilePayload> readPayloads(
            Path clonePath, List<InventoriedFile> files, long snapshotId, java.util.Map<String, String> previous) {
        List<TreeAnalyzeDtos.FilePayload> payloads = new ArrayList<>();
        for (InventoriedFile file : files) {
            JobCancellation.checkpoint();
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
                payloads.add(
                        new TreeAnalyzeDtos.FilePayload(file.path(), content, previous.getOrDefault(file.path(), "")));
            } catch (InvalidFilePathException | IOException e) {
                recordOne(snapshotId, file, "FAILED", "SOURCE_READ_FAILED");
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
