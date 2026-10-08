package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import dev.codeintelligence.analysis.config.DockerAnalyzer;
import dev.codeintelligence.analysis.core.*;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;

class SourceParsingReuseTest {
    @TempDir
    Path root;

    @Test
    void actualStepReusesConfigAcrossJobWorkspacePathsAndRecomputesChangedBytes() throws Exception {
        Path first = Files.createDirectory(root.resolve("job-one"));
        Path second = Files.createDirectory(root.resolve("job-two"));
        Files.writeString(first.resolve("Dockerfile"), "FROM alpine:3.20\n");
        Files.writeString(second.resolve("Dockerfile"), "FROM alpine:3.20\n");
        Files.writeString(first.resolve("compose.yaml"), "services:\n  app:\n    build: .\n");
        Files.writeString(second.resolve("compose.yaml"), "services:\n  app:\n    build: .\n");
        GraphPersistenceService persistence = mock(GraphPersistenceService.class);
        List<InventoriedFile> files = List.of(
                new InventoriedFile("Dockerfile", "dockerfile", 17, 1, ""),
                new InventoriedFile("compose.yaml", "yaml", 30, 3, ""));
        SourceParsingStep step = new SourceParsingStep(
                List.of(new DockerAnalyzer()), jdbc(files), persistence, mock(EvidenceService.class));
        step.run(new TestJobContext(1, 2, 3L, first));
        step.run(new TestJobContext(2, 2, 4L, second));
        ArgumentCaptor<AnalysisResult> results = ArgumentCaptor.forClass(AnalysisResult.class);
        verify(persistence, times(2)).persist(anyLong(), anyLong(), results.capture());
        assertThat(results.getAllValues().get(0).nodes()).isNotEmpty();
        assertThat(results.getAllValues().get(1))
                .isEqualTo(results.getAllValues().get(0));
        assertThat(results.getAllValues().get(1).nodes().getFirst())
                .isSameAs(results.getAllValues().get(0).nodes().getFirst());
        Files.writeString(second.resolve("Dockerfile"), "FROM alpine:3.21\n");
        step.run(new TestJobContext(3, 2, 5L, second));
        verify(persistence, times(3)).persist(anyLong(), anyLong(), results.capture());
        assertThat(results.getValue())
                .isEqualTo(new DockerAnalyzer().analyze(new AnalysisContext(2, 5, second, FileInventory.of(files))));
    }

    @SuppressWarnings("unchecked")
    private static JdbcClient jdbc(List<InventoriedFile> files) {
        JdbcClient jdbc = mock(JdbcClient.class);
        JdbcClient.StatementSpec statement = mock(JdbcClient.StatementSpec.class, RETURNS_SELF);
        JdbcClient.MappedQuerySpec<InventoriedFile> query = mock(JdbcClient.MappedQuerySpec.class);
        when(jdbc.sql(anyString())).thenReturn(statement);
        when(statement.query(any(RowMapper.class))).thenReturn(query);
        when(query.list()).thenReturn(files);
        return jdbc;
    }
}
