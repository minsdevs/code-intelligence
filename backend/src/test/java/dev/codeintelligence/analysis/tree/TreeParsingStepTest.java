package dev.codeintelligence.analysis.tree;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
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

class TreeParsingStepTest {
    @TempDir
    Path root;

    @Test
    @SuppressWarnings("unchecked")
    void carriesWholePathInventoryAcrossBatchesAndRetainsCacheAcrossJobsNotProjects() throws Exception {
        var inventory = new ArrayList<InventoriedFile>();
        for (int index = 0; index < 41; index++) {
            String path = "%02d.py".formatted(index);
            Files.writeString(root.resolve(path), "def run():\n    return 1\n");
            inventory.add(new InventoriedFile(path, "python", Files.size(root.resolve(path)), 2, "fixture"));
        }
        var client = mock(TreeAnalyzerClient.class);
        var persistence = mock(GraphPersistenceService.class);
        var jdbc = mock(JdbcClient.class);
        var statement = mock(JdbcClient.StatementSpec.class);
        JdbcClient.MappedQuerySpec<InventoriedFile> query = mock(JdbcClient.MappedQuerySpec.class);
        when(jdbc.sql(anyString())).thenReturn(statement);
        when(statement.param(anyString(), any())).thenReturn(statement);
        when(statement.query(any(RowMapper.class))).thenReturn(query);
        when(query.list()).thenReturn(inventory);
        when(client.enabled()).thenReturn(true);
        String cached = "{\"path\":\"00.py\",\"key\":\"" + "a".repeat(64) + "\",\"result\":{}}";
        when(client.analyze(any()))
                .thenReturn(new TreeAnalyzeDtos.Response(
                        null, null, null, null, null, null, null, null, null, null, List.of(cached)));
        var step = new TreeParsingStep(
                client, jdbc, persistence, new AnalysisProperties(20_000, 1_048_576, 10_000, 5, 1_000, 0.5));
        step.run(new TestJobContext(1, 2, 3L, root));
        Files.writeString(root.resolve("01.py"), "def run():\n    return 2\n");
        step.run(new TestJobContext(2, 2, 3L, root));
        step.run(new TestJobContext(3, 9, 3L, root));
        var requests = ArgumentCaptor.forClass(TreeAnalyzeDtos.Request.class);
        verify(client, times(6)).analyze(requests.capture());
        var sent = requests.getAllValues();
        assertThat(sent).allSatisfy(request -> {
            assertThat(request.localPaths()).hasSize(41).contains("40.py");
            assertThat(request.cacheKey()).matches("[0-9a-f]{64}");
        });
        assertThat(sent.get(0).files()).hasSize(40);
        assertThat(sent.get(1).files()).hasSize(1);
        assertThat(sent.get(0).files().getFirst().cache()).isEmpty();
        assertThat(sent.get(2).files().getFirst().cache()).isEqualTo(cached);
        assertThat(sent.get(2).files().get(1).content()).contains("return 2");
        assertThat(sent.get(4).files().getFirst().cache()).isEmpty();
    }
}
