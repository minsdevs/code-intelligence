package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.RETURNS_SELF;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.java.JavaAnalyzer;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * G-PERF medium/large SOURCE_PARSING: the annotation and config analyzers (53 s on the large
 * workload) ran only after the Java analyzer finished, although none of them reads another's
 * result. They now run meanwhile on a helper thread; results still merge in analyzer order and
 * an analyzer that fails on the whole inventory is still retried file by file.
 */
class SourceParsingConcurrencyTest {

    @Test
    void laterAnalyzersRunWhileTheFirstOneDoesAndResultsKeepAnalyzerOrder() throws Exception {
        CountDownLatch secondStarted = new CountDownLatch(1);
        AtomicBoolean overlapped = new AtomicBoolean();
        CodeAnalyzer first = analyzer(ctx -> {
            try {
                overlapped.set(secondStarted.await(5, TimeUnit.SECONDS));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return result("first");
        });
        CodeAnalyzer second = analyzer(ctx -> {
            secondStarted.countDown();
            return result("second");
        });
        // Fails on the whole inventory, succeeds per file: the per-file fallback keeps its place.
        CodeAnalyzer third = analyzer(ctx -> {
            if (ctx.inventory().files().size() > 1) throw new IllegalStateException("whole inventory");
            return result("third:" + ctx.inventory().files().getFirst().path());
        });
        GraphPersistenceService persistence = mock(GraphPersistenceService.class);
        SourceParsingStep step =
                new SourceParsingStep(List.of(first, second, third), jdbc(), persistence, mock(EvidenceService.class));

        step.run(new TestJobContext(1, 2, 3L, Path.of("/nonexistent")));

        ArgumentCaptor<AnalysisResult> persisted = ArgumentCaptor.forClass(AnalysisResult.class);
        verify(persistence).persist(anyLong(), anyLong(), persisted.capture());
        assertThat(persisted.getValue().nodes())
                .extracting(GraphNodeDraft::naturalKey)
                .containsExactly("first", "second", "third:a.txt", "third:b.txt");
        assertThat(overlapped).isTrue();
    }

    /** The Java analyzer checks for a cancel per file, so it runs on the job's thread wherever it is ordered. */
    @Test
    void theJavaAnalyzerRunsOnTheJobThread() {
        Thread job = Thread.currentThread();
        AtomicBoolean javaOnJobThread = new AtomicBoolean();
        CodeAnalyzer before = analyzer(ctx -> result("before"));
        CodeAnalyzer java = new JavaAnalyzer() {
            @Override
            public boolean supports(FileInventory inventory) {
                return true;
            }

            @Override
            public AnalysisResult analyze(AnalysisContext ctx) {
                javaOnJobThread.set(Thread.currentThread() == job);
                return result("java");
            }
        };
        GraphPersistenceService persistence = mock(GraphPersistenceService.class);
        new SourceParsingStep(List.of(before, java), jdbc(), persistence, mock(EvidenceService.class))
                .run(new TestJobContext(1, 2, 3L, Path.of("/nonexistent")));

        ArgumentCaptor<AnalysisResult> persisted = ArgumentCaptor.forClass(AnalysisResult.class);
        verify(persistence).persist(anyLong(), anyLong(), persisted.capture());
        assertThat(persisted.getValue().nodes())
                .extracting(GraphNodeDraft::naturalKey)
                .containsExactly("before", "java");
        assertThat(javaOnJobThread).isTrue();
    }

    private static CodeAnalyzer analyzer(Function<AnalysisContext, AnalysisResult> body) {
        return new CodeAnalyzer() {
            @Override
            public boolean supports(FileInventory inventory) {
                return true;
            }

            @Override
            public AnalysisResult analyze(AnalysisContext ctx) {
                return body.apply(ctx);
            }
        };
    }

    private static AnalysisResult result(String key) {
        return new AnalysisResult(
                List.of(GraphNodeDraft.of(GraphNodeType.CLASS, key, key, null, null, null)), List.of(), List.of());
    }

    @SuppressWarnings("unchecked")
    private static JdbcClient jdbc() {
        JdbcClient jdbc = mock(JdbcClient.class);
        JdbcClient.StatementSpec statement = mock(JdbcClient.StatementSpec.class, RETURNS_SELF);
        JdbcClient.MappedQuerySpec<InventoriedFile> query = mock(JdbcClient.MappedQuerySpec.class);
        when(jdbc.sql(anyString())).thenReturn(statement);
        when(statement.query(any(RowMapper.class))).thenReturn(query);
        when(query.list())
                .thenReturn(List.of(
                        new InventoriedFile("a.txt", "text", 1, 1, "a"),
                        new InventoriedFile("b.txt", "text", 1, 1, "b")));
        return jdbc;
    }
}
