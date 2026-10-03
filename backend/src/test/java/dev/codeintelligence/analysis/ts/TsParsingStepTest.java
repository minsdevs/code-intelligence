package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.graph.GraphPersistenceService;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;

class TsParsingStepTest {
    @TempDir
    Path root;

    private final TsAnalyzerClient client = mock(TsAnalyzerClient.class);
    private final GraphPersistenceService persistence = mock(GraphPersistenceService.class);

    @Test
    void acceptsExplicitTypeScriptModuleExtensionsEvenForOldUnclassifiedInventory() {
        for (String path : List.of("src/worker.mts", "src/worker.cts", "src/UPPER.MTS", "src/types.d.cts")) {
            assertThat(TsParsingStep.isAnalyzerInput(new InventoriedFile(path, null, 0, 1, "fixture")))
                    .as(path)
                    .isTrue();
        }
        assertThat(TsParsingStep.isAnalyzerInput(new InventoriedFile("src/worker.mts.bak", null, 0, 1, "fixture")))
                .isFalse();
    }

    @Test
    void sendsAll501FilesTogetherInsteadOfSplittingProjectContext() throws Exception {
        List<InventoriedFile> files = files(501, "export {};");
        step(files).run(new TestJobContext(1, 2, 3L, root));
        var request = ArgumentCaptor.forClass(TsAnalyzeDtos.Request.class);
        verify(client).analyze(request.capture());
        assertThat(request.getValue().files()).hasSize(501);
        assertThat(request.getValue().files().getFirst().path()).isEqualTo("0000.ts");
        assertThat(request.getValue().files().getLast().path()).isEqualTo("0500.ts");
        verify(persistence).persist(eq(2L), eq(3L), any());
    }

    @Test
    void refusesOverBudgetInputBeforeSendingOrPersistingPartialAnalysis() throws Exception {
        List<InventoriedFile> files = files(11, "x".repeat(1_000_000));
        assertThatThrownBy(() -> step(files).run(new TestJobContext(1, 2, 3L, root)))
                .isInstanceOf(TsAnalyzerException.class)
                .hasMessageContaining("10 MiB");
        verify(client, never()).analyze(any());
        verifyNoInteractions(persistence);
    }

    @SuppressWarnings("unchecked")
    private TsParsingStep step(List<InventoriedFile> files) {
        JdbcClient jdbc = mock(JdbcClient.class);
        JdbcClient.StatementSpec statement = mock(JdbcClient.StatementSpec.class);
        JdbcClient.MappedQuerySpec<InventoriedFile> query = mock(JdbcClient.MappedQuerySpec.class);
        when(jdbc.sql(anyString())).thenReturn(statement);
        when(statement.param("snapshotId", 3L)).thenReturn(statement);
        when(statement.query(any(RowMapper.class))).thenReturn(query);
        when(query.list()).thenReturn(files);
        when(client.enabled()).thenReturn(true);
        when(client.analyze(any())).thenReturn(TsAnalyzeDtos.Response.EMPTY);
        return new TsParsingStep(
                client, jdbc, persistence, new AnalysisProperties(20_000, 1_048_576, 10_000, 5, 1_000, 0.5));
    }

    private List<InventoriedFile> files(int count, String content) throws Exception {
        List<InventoriedFile> result = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String path = "%04d.ts".formatted(i);
            Files.writeString(root.resolve(path), content);
            result.add(new InventoriedFile(path, "typescript", Files.size(root.resolve(path)), 1, "fixture-hash"));
        }
        return result;
    }
}
