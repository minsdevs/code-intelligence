package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.NaturalKeys;
import java.util.List;
import java.util.Map;
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
                List.of(),
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

    @Test
    void mapsSemanticEdgesWithSourceEvidenceAndUncertainty() {
        String controllerKey = "ts:src/users.controller.ts#UsersController";
        String methodKey = controllerKey + ".list";
        String serviceKey = "ts:src/users.service.ts#UsersService.list";
        TsAnalyzeDtos.Response response = new TsAnalyzeDtos.Response(
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(new TsAnalyzeDtos.ImportHit(
                        "src/users.controller.ts", "src/users.service.ts", "UsersService", "UsersService", true)),
                List.of(),
                List.of(new TsAnalyzeDtos.EndpointHit(
                        "GET",
                        "/users",
                        methodKey,
                        "list",
                        controllerKey,
                        "src/users.controller.ts",
                        10,
                        12,
                        Map.of("version", "1"))),
                List.of(
                        new TsAnalyzeDtos.SemanticNodeHit(
                                controllerKey,
                                "CLASS",
                                "UsersController",
                                "src/users.controller.ts",
                                3,
                                14,
                                "BACKEND",
                                Map.of("nestRole", "CONTROLLER")),
                        new TsAnalyzeDtos.SemanticNodeHit(
                                methodKey, "METHOD", "list", "src/users.controller.ts", 10, 12, "BACKEND", Map.of()),
                        new TsAnalyzeDtos.SemanticNodeHit(
                                serviceKey, "METHOD", "list", "src/users.service.ts", 5, 7, "BACKEND", Map.of())),
                List.of(new TsAnalyzeDtos.SemanticEdgeHit(
                        methodKey,
                        serviceKey,
                        "CALLS",
                        "LIKELY",
                        "src/users.controller.ts",
                        11,
                        11,
                        Map.of("asyncBoundary", true))),
                List.of(new TsAnalyzeDtos.UnresolvedCallHit(
                        methodKey, "this.dynamic[target]()", "src/users.controller.ts", 12, "DYNAMIC_MEMBER")));

        AnalysisResult result = TsGraphMapper.toGraph(response);

        assertThat(result.edges())
                .anyMatch(edge -> controllerKey.equals(edge.sourceNaturalKey())
                        && NaturalKeys.endpoint("GET", "/users").equals(edge.targetNaturalKey())
                        && "EXPOSES".equals(edge.edgeType()))
                .anyMatch(edge -> methodKey.equals(edge.sourceNaturalKey())
                        && serviceKey.equals(edge.targetNaturalKey())
                        && "LIKELY".equals(edge.confidence())
                        && Integer.valueOf(11).equals(edge.metadata().get("lineStart")))
                .anyMatch(edge -> "IMPORTS".equals(edge.edgeType())
                        && Boolean.TRUE.equals(edge.metadata().get("typeOnly")));
        assertThat(result.nodes())
                .anyMatch(node ->
                        methodKey.equals(node.naturalKey()) && node.metadata().containsKey("unresolvedCalls"));
    }
}
