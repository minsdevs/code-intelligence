package dev.codeintelligence.analysis.tree;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import tools.jackson.databind.json.JsonMapper;

@EnabledIfEnvironmentVariable(named = "ADAPTER_REFRESH_SMOKE_DIR", matches = ".+")
class TreeIncrementalGraphSmokeTest {
    @Test
    void productionHttpRefreshMatchesIndependentFullNodesEdgesEvidenceAndOutcomes() throws Exception {
        Path root = Path.of(System.getenv("ADAPTER_REFRESH_SMOKE_DIR"));
        var json = JsonMapper.builder().build();
        var incremental =
                json.readValue(Files.readString(root.resolve("tree-incremental.json")), TreeAnalyzeDtos.Response.class);
        var full = json.readValue(Files.readString(root.resolve("tree-full.json")), TreeAnalyzeDtos.Response.class);
        var graph = TreeGraphMapper.toGraph(incremental);
        assertThat(graph).isEqualTo(TreeGraphMapper.toGraph(full));
        assertThat(graph.nodes()).isNotEmpty();
        assertThat(graph.edges()).isNotEmpty();
        assertThat(graph.evidences()).isNotEmpty();
        assertThat(incremental.fileOutcomes()).isEqualTo(full.fileOutcomes()).isNotEmpty();
        System.out.printf(
                "Tree canonical graph: nodes=%d edges=%d evidence=%d outcomes=%d%n",
                graph.nodes().size(),
                graph.edges().size(),
                graph.evidences().size(),
                incremental.fileOutcomes().size());
    }
}
