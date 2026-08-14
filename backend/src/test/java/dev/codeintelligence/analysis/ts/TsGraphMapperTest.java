package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.NaturalKeys;
import java.util.List;
import org.junit.jupiter.api.Test;

class TsGraphMapperTest {

    @Test
    void mapsRouteComponentAndApiCallMetadata() {
        TsAnalyzeDtos.Response response = new TsAnalyzeDtos.Response(
                List.of(new TsAnalyzeDtos.RouteHit("/todos", "TodosPage", "src/App.tsx", 10, 10)),
                List.of(new TsAnalyzeDtos.SymbolHit("TodosPage", "COMPONENT", "src/pages/TodosPage.tsx", 3, 10)),
                List.of(),
                List.of(),
                List.of(new TsAnalyzeDtos.ApiCallHit("GET", "/api/todos", "src/pages/TodosPage.tsx", 4, "TodosPage")),
                List.of(),
                List.of(),
                List.of());
        AnalysisResult result = TsGraphMapper.toGraph(response);
        assertThat(result.nodes()).anyMatch(node -> NaturalKeys.route("/todos").equals(node.naturalKey()));
        assertThat(result.nodes())
                .anyMatch(node -> NaturalKeys.component("src/pages/TodosPage.tsx", "TodosPage")
                                .equals(node.naturalKey())
                        && node.metadata().containsKey("apiCalls"));
    }
}
