package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisInputFingerprint;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphIdentityGuard;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.job.JobCancellation;
import dev.codeintelligence.job.JobCancelledException;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
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
    private final SourceResultCache resultCache = new SourceResultCache();

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

    private AnalysisResult analyze(CodeAnalyzer analyzer, AnalysisContext context, AnalysisInputFingerprint.Snapshot input) {
        if (analyzer.getClass() == dev.codeintelligence.analysis.java.JavaAnalyzer.class)
            return ((dev.codeintelligence.analysis.java.JavaAnalyzer) analyzer).analyze(context, input);
        if (analyzer instanceof dev.codeintelligence.analysis.java.JavaFrameworkAnalyzer frameworks)
            return frameworks.analyze(context, input);
        return resultCache.analyze(analyzer, context, input == null ? null : input.complete());
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
        for (InventoriedFile file : inventory.files()) {
            if ("java".equalsIgnoreCase(file.language()) || file.path().endsWith(".java"))
                FileAnalysisOutcome.record(jdbc, snapshotId, file.path(), "TARGETED", "JAVA_PARSER_STARTED");
        }
        AnalysisContext analysis = new AnalysisContext(ctx.projectId(), snapshotId, ctx.clonePath(), inventory);
        AnalysisInputFingerprint.Snapshot input = matching.stream().anyMatch(analyzer ->
                analyzer.getClass() == dev.codeintelligence.analysis.java.JavaAnalyzer.class
                        || analyzer instanceof dev.codeintelligence.analysis.java.JavaFrameworkAnalyzer
                        || SourceResultCache.supports(analyzer)) ? AnalysisInputFingerprint.capture(analysis) : null;
        // No analyzer reads another's result. The Java analyzer, the longest and the one that checks
        // for a cancel per file, runs here; the others run meanwhile, in order, on one helper thread.
        // Results merge in analyzer order.
        CodeAnalyzer inline = matching.stream()
                .filter(analyzer -> analyzer instanceof dev.codeintelligence.analysis.java.JavaAnalyzer)
                .findFirst()
                .orElse(matching.getFirst());
        ExecutorService helper = Executors.newSingleThreadExecutor(runnable ->
                Thread.ofPlatform().daemon().name("source-parsing-analyzers").unstarted(runnable));
        try {
            Map<CodeAnalyzer, Future<AnalysisResult>> later = new LinkedHashMap<>();
            for (CodeAnalyzer analyzer : matching) {
                if (analyzer != inline)
                    later.put(
                            analyzer,
                            helper.submit(() -> analyze(analyzer, analysis, input)));
            }
            for (CodeAnalyzer analyzer : matching) {
                try {
                    acc.add(
                            analyzer == inline
                                    ? analyze(analyzer, analysis, input)
                                    : await(later.get(analyzer)));
                } catch (JobCancelledException cancelled) {
                    throw cancelled;
                } catch (RuntimeException e) {
                    log.warn(
                            "Analyzer {} failed; isolating per file",
                            analyzer.getClass().getSimpleName(),
                            e);
                    isolatePerFile(analyzer, ctx, snapshotId, inventory, acc, failures);
                }
            }
        } finally {
            // After a cancel or failure the remaining analyzers' results are not used.
            helper.shutdownNow();
        }
        ctx.updateProgress(70);
        persistence.persist(ctx.projectId(), snapshotId, acc.toResult());
        for (FileAnalysisOutcome outcome : acc.outcomes.values()) {
            FileAnalysisOutcome.record(jdbc, snapshotId, outcome.path(), outcome.status(), outcome.reason());
        }
        failures.addAll(acc.snapshotFailures());
        persistFailures(ctx.projectId(), snapshotId, failures);
        ctx.updateProgress(100);
    }

    /** A helper-thread analyzer's result; a cancel is still noticed while waiting for it. */
    private static AnalysisResult await(Future<AnalysisResult> result) {
        while (true) {
            JobCancellation.checkpoint();
            try {
                return result.get(200, TimeUnit.MILLISECONDS);
            } catch (TimeoutException waiting) {
                // checkpoint again
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("interrupted while waiting for an analyzer", e);
            } catch (ExecutionException e) {
                if (e.getCause() instanceof RuntimeException failure) throw failure;
                if (e.getCause() instanceof Error error) throw error;
                throw new IllegalStateException(e.getCause());
            }
        }
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
            JobCancellation.checkpoint();
            FileInventory single = FileInventory.of(file);
            if (!analyzer.supports(single)) {
                continue;
            }
            try {
                acc.add(analyzer.analyze(new AnalysisContext(ctx.projectId(), snapshotId, ctx.clonePath(), single)));
            } catch (JobCancelledException cancelled) {
                throw cancelled;
            } catch (RuntimeException e) {
                log.warn(
                        "Skipping {} in {}: {}",
                        file.path(),
                        analyzer.getClass().getSimpleName(),
                        e.toString());
                failures.add(failureEvidence(file, e, ctx.clonePath().toString()));
                if (analyzer instanceof dev.codeintelligence.analysis.java.JavaAnalyzer)
                    acc.outcomes.put(
                            file.path(), new FileAnalysisOutcome(file.path(), "FAILED", "JAVA_ANALYZER_FAILED"));
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
        private final List<GraphNodeDraft> nodes = new ArrayList<>();
        private final List<GraphEdgeDraft> edges = new ArrayList<>();
        private final List<AnalyzerEvidence> evidences = new ArrayList<>();
        private final Map<String, FileAnalysisOutcome> outcomes = new LinkedHashMap<>();
        private final List<NewEvidence> snapshotFailures = new ArrayList<>();

        void add(AnalysisResult result) {
            for (FileAnalysisOutcome outcome : result.fileOutcomes()) outcomes.put(outcome.path(), outcome);
            nodes.addAll(result.nodes());
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
            AnalysisResult safe = GraphIdentityGuard.sanitize(
                    new AnalysisResult(nodes, edges, evidences, List.copyOf(outcomes.values())));
            safe.fileOutcomes().forEach(outcome -> outcomes.put(outcome.path(), outcome));
            Map<String, GraphNodeDraft> merged = new LinkedHashMap<>();
            for (GraphNodeDraft node : safe.nodes()) merged.merge(node.naturalKey(), node, Accumulator::merge);
            return new AnalysisResult(
                    List.copyOf(merged.values()), safe.edges(), safe.evidences(), safe.fileOutcomes());
        }

        private static GraphNodeDraft merge(GraphNodeDraft existing, GraphNodeDraft incoming) {
            boolean incomingRicher = incoming.lineStart() != null && existing.lineStart() == null;
            GraphNodeDraft base = incomingRicher ? incoming : existing;
            GraphNodeDraft other = incomingRicher ? existing : incoming;
            Map<String, Object> metadata = new LinkedHashMap<>(other.metadata());
            metadata.putAll(base.metadata());
            return new GraphNodeDraft(
                    base.nodeType(),
                    base.naturalKey(),
                    base.name(),
                    base.filePath() != null ? base.filePath() : other.filePath(),
                    base.lineStart() != null ? base.lineStart() : other.lineStart(),
                    base.lineEnd() != null ? base.lineEnd() : other.lineEnd(),
                    base.areaType() != null ? base.areaType() : other.areaType(),
                    metadata);
        }
    }
}
