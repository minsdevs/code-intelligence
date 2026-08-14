package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

@Component
@Order(SourceParsingStep.ORDER)
public class SourceParsingStep implements JobStep {

    public static final String KEY = "SOURCE_PARSING";
    public static final int ORDER = 600;

    private static final Logger log = LoggerFactory.getLogger(SourceParsingStep.class);

    private final List<CodeAnalyzer> analyzers;
    private final JdbcClient jdbc;
    private final GraphPersistenceService persistence;
    private final EvidenceService evidenceService;

    public SourceParsingStep(
            List<CodeAnalyzer> analyzers,
            JdbcClient jdbc,
            GraphPersistenceService persistence,
            EvidenceService evidenceService) {
        this.analyzers = List.copyOf(analyzers);
        this.jdbc = jdbc;
        this.persistence = persistence;
        this.evidenceService = evidenceService;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        ctx.updateProgress(10);
        FileInventory inventory = loadInventory(snapshotId);
        Accumulator acc = new Accumulator();
        List<NewEvidence> failures = new ArrayList<>();
        List<CodeAnalyzer> matching = analyzers.stream()
                .filter(analyzer -> analyzer.supports(inventory))
                .toList();
        ctx.updateProgress(25);
        if (matching.isEmpty()) {
            persistFailures(ctx.projectId(), snapshotId, failures);
            ctx.updateProgress(100);
            return;
        }
        for (CodeAnalyzer analyzer : matching) {
            try {
                acc.add(analyzer.analyze(new AnalysisContext(ctx.projectId(), snapshotId, ctx.clonePath(), inventory)));
            } catch (RuntimeException e) {
                log.warn(
                        "Analyzer {} failed; isolating per file",
                        analyzer.getClass().getSimpleName(),
                        e);
                isolatePerFile(analyzer, ctx, snapshotId, inventory, acc, failures);
            }
        }
        ctx.updateProgress(70);
        persistence.persist(ctx.projectId(), snapshotId, acc.toResult());
        failures.addAll(acc.snapshotFailures());
        persistFailures(ctx.projectId(), snapshotId, failures);
        ctx.updateProgress(100);
    }

    private void isolatePerFile(
            CodeAnalyzer analyzer,
            JobContext ctx,
            long snapshotId,
            FileInventory inventory,
            Accumulator acc,
            List<NewEvidence> failures) {
        int index = 0;
        List<InventoriedFile> files = inventory.files();
        for (InventoriedFile file : files) {
            FileInventory single = FileInventory.of(file);
            if (!analyzer.supports(single)) {
                continue;
            }
            try {
                acc.add(analyzer.analyze(new AnalysisContext(ctx.projectId(), snapshotId, ctx.clonePath(), single)));
            } catch (RuntimeException e) {
                log.warn(
                        "Skipping {} in {}: {}",
                        file.path(),
                        analyzer.getClass().getSimpleName(),
                        e.toString());
                failures.add(failureEvidence(file, e, ctx.clonePath().toString()));
            }
            index++;
            if (!files.isEmpty()) {
                ctx.updateProgress(25 + Math.min(40, (40 * index) / files.size()));
            }
        }
    }

    private FileInventory loadInventory(long snapshotId) {
        List<InventoriedFile> files = jdbc.sql("""
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
                .list();
        return FileInventory.of(files);
    }

    private void persistFailures(long projectId, long snapshotId, List<NewEvidence> failures) {
        List<NewEvidence> fromAnalyzers = new ArrayList<>(failures);
        evidenceService.replaceLinked(projectId, EvidenceSubjects.SOURCE_PARSING, snapshotId, fromAnalyzers);
    }

    private NewEvidence failureEvidence(InventoriedFile file, Exception e, String clonePath) {
        String message = e.getMessage() == null ? e.toString() : e.getMessage();
        message = message.replace('\n', ' ');
        if (clonePath != null) {
            message = message.replace(clonePath, "");
        }
        if (message.length() > 240) {
            message = message.substring(0, 240);
        }
        return new NewEvidence(EvidenceKind.FILE_LINE, file.path(), 1, 1, "Parse failed: " + message.strip());
    }

    private static final class Accumulator {
        private final Map<String, GraphNodeDraft> nodes = new LinkedHashMap<>();
        private final List<GraphEdgeDraft> edges = new ArrayList<>();
        private final List<AnalyzerEvidence> evidences = new ArrayList<>();
        private final List<NewEvidence> snapshotFailures = new ArrayList<>();

        void add(AnalysisResult result) {
            for (GraphNodeDraft node : result.nodes()) {
                GraphNodeDraft existing = nodes.get(node.naturalKey());
                if (existing == null || (node.lineStart() != null && existing.lineStart() == null)) {
                    nodes.put(node.naturalKey(), node);
                }
            }
            edges.addAll(result.edges());
            for (AnalyzerEvidence evidence : result.evidences()) {
                if (evidence.subjectNaturalKey() == null) {
                    snapshotFailures.add(new NewEvidence(
                            evidence.kind(),
                            evidence.filePath(),
                            evidence.lineStart(),
                            evidence.lineEnd(),
                            evidence.excerpt()));
                } else {
                    evidences.add(evidence);
                }
            }
        }

        List<NewEvidence> snapshotFailures() {
            return snapshotFailures;
        }

        AnalysisResult toResult() {
            return new AnalysisResult(List.copyOf(nodes.values()), List.copyOf(edges), List.copyOf(evidences));
        }
    }
}
