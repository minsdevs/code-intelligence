package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import tools.jackson.databind.json.JsonMapper;

@EnabledIfEnvironmentVariable(named = "ADAPTER_REFRESH_SMOKE_DIR", matches = ".+")
class TsIncrementalGraphSmokeTest {
    @Test
    void productionSessionRefreshMatchesIndependentFullNodesEdgesEvidenceAndOutcomes() throws Exception {
        Path root = Path.of(System.getenv("ADAPTER_REFRESH_SMOKE_DIR"));
        var json = JsonMapper.builder().build();
        var incremental =
                json.readValue(Files.readString(root.resolve("ts-incremental.json")), TsAnalyzeDtos.Response.class);
        var full = json.readValue(Files.readString(root.resolve("ts-full.json")), TsAnalyzeDtos.Response.class);
        var graph = TsGraphMapper.toGraph(incremental);
        assertThat(graph).isEqualTo(TsGraphMapper.toGraph(full));
        assertThat(graph.nodes()).isNotEmpty();
        assertThat(graph.edges()).isNotEmpty();
        assertThat(graph.evidences()).isNotEmpty();
        assertThat(graph.fileOutcomes()).isEqualTo(full.fileOutcomes()).isNotEmpty();
        System.out.printf(
                "TS canonical graph: nodes=%d edges=%d evidence=%d outcomes=%d%n",
                graph.nodes().size(),
                graph.edges().size(),
                graph.evidences().size(),
                graph.fileOutcomes().size());
    }
}
