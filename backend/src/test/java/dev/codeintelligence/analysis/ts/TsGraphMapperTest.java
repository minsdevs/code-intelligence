package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.NaturalKeys;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class TsGraphMapperTest {

    private static final TsAnalyzeDtos.SymbolHit SELECTED =
            new TsAnalyzeDtos.SymbolHit("ActualPage", "COMPONENT", "ui/Page.tsx", 2, 4);

    @Test
    void acceptsAnExactResolvedDefaultReferenceWithoutUsingTheImportAliasAsAComponentName() {
        var route = new TsAnalyzeDtos.RouteHit(
                "/detail",
                "Selected",
                "ui/Router.tsx",
                3,
                3,
                new TsAnalyzeDtos.ComponentResolution(
                        "RESOLVED", new TsAnalyzeDtos.ComponentReference("ActualPage", "ui/Page.tsx", 2, 4)));
        var result = TsGraphMapper.toGraph(routeResponse(
                route,
                List.of(SELECTED, new TsAnalyzeDtos.SymbolHit("Selected", "COMPONENT", "admin/Page.tsx", 1, 8)),
                List.of()));
        assertThat(result.edges())
                .filteredOn(edge -> edge.sourceNaturalKey().equals("route:/detail"))
                .extracting(edge -> edge.targetNaturalKey())
                .containsExactly("component:ui/Page.tsx#ActualPage");
    }

    @Test
    void unresolvedUnknownAndInconsistentReferencesNeverFallBackToLegacyNameMatching() {
        for (var resolution : List.of(
                new TsAnalyzeDtos.ComponentResolution("UNRESOLVED", null),
                new TsAnalyzeDtos.ComponentResolution("FUTURE_VERSION", null),
                new TsAnalyzeDtos.ComponentResolution("RESOLVED", null),
                new TsAnalyzeDtos.ComponentResolution(
                        "RESOLVED", new TsAnalyzeDtos.ComponentReference("ActualPage", "ui/Page.tsx", 1, 4)),
                new TsAnalyzeDtos.ComponentResolution(
                        "RESOLVED", new TsAnalyzeDtos.ComponentReference("ActualPage", "../ui/Page.tsx", 2, 4)),
                new TsAnalyzeDtos.ComponentResolution(
                        "RESOLVED", new TsAnalyzeDtos.ComponentReference("ActualPage", "ui/Page.tsx", 4, 2)))) {
            var route = new TsAnalyzeDtos.RouteHit("/detail", "ActualPage", "ui/Page.tsx", 5, 5, resolution);
            assertThat(TsGraphMapper.toGraph(routeResponse(route, List.of(SELECTED), List.of()))
                            .edges())
                    .as("resolution=%s", resolution)
                    .noneMatch(edge -> edge.sourceNaturalKey().equals("route:/detail"));
        }
    }

    @Test
    void exactPositionCannotDisambiguateSameFileGraphKeyCollisionsOrWrongKinds() {
        var route = new TsAnalyzeDtos.RouteHit(
                "/detail",
                "ActualPage",
                "ui/Router.tsx",
                1,
                1,
                new TsAnalyzeDtos.ComponentResolution(
                        "RESOLVED", new TsAnalyzeDtos.ComponentReference("ActualPage", "ui/Page.tsx", 2, 4)));
        for (var hits : List.of(
                List.of(SELECTED, new TsAnalyzeDtos.SymbolHit("ActualPage", "COMPONENT", "ui/Page.tsx", 8, 12)),
                List.of(SELECTED, SELECTED),
                List.of(new TsAnalyzeDtos.SymbolHit("ActualPage", "HOOK", "ui/Page.tsx", 2, 4)))) {
            assertThat(TsGraphMapper.toGraph(routeResponse(route, hits, List.of()))
                            .edges())
                    .noneMatch(edge -> edge.sourceNaturalKey().equals("route:/detail"));
        }
    }

    @Test
    void wirePresenceDistinguishesAbsentLegacyMarkerFromExplicitNullAndMalformedMarkers() {
        var mapper = JsonMapper.builder().build();
        String prefix =
                "\"path\":\"/detail\",\"component\":\"ActualPage\",\"filePath\":\"ui/Page.tsx\",\"lineStart\":5,\"lineEnd\":5";
        var legacy = mapper.readValue("{" + prefix + "}", TsAnalyzeDtos.RouteHit.class);
        assertThat(legacy.componentResolution()).isNull();
        assertThat(TsGraphMapper.toGraph(routeResponse(legacy, List.of(SELECTED), List.of()))
                        .edges())
                .anyMatch(edge -> edge.sourceNaturalKey().equals("route:/detail"));
        for (String marker :
                List.of("null", "false", "[]", "{}", "{\"target\":{}}", "{\"status\":\"RESOLVED\",\"target\":null}")) {
            var route = mapper.readValue(
                    "{" + prefix + ",\"componentResolution\":" + marker + "}", TsAnalyzeDtos.RouteHit.class);
            assertThat(route.componentResolution()).isNotNull();
            assertThat(TsGraphMapper.toGraph(routeResponse(route, List.of(SELECTED), List.of()))
                            .edges())
                    .as("marker=%s", marker)
                    .noneMatch(edge -> edge.sourceNaturalKey().equals("route:/detail"));
        }
        String valid = "{" + prefix + ",\"componentResolution\":{\"status\":\"RESOLVED\",\"target\":{"
                + "\"name\":\"ActualPage\",\"filePath\":\"ui/Page.tsx\",\"lineStart\":2,\"lineEnd\":4}}}";
        var route = mapper.readValue(valid, TsAnalyzeDtos.RouteHit.class);
        assertThat(route.componentResolution().target().lineStart()).isEqualTo(2);
        assertThat(TsGraphMapper.toGraph(routeResponse(route, List.of(SELECTED), List.of()))
                        .edges())
                .anyMatch(edge -> edge.sourceNaturalKey().equals("route:/detail"));
    }

    @Test
    void legacyTypeOnlyImportDoesNotAuthorizeAValueComponent() {
        var route = new TsAnalyzeDtos.RouteHit("/detail", "Selected", "ui/Router.tsx", 1, 1);
        var imports =
                List.of(new TsAnalyzeDtos.ImportHit("ui/Router.tsx", "ui/Page.tsx", "Selected", "ActualPage", true));
        assertThat(TsGraphMapper.toGraph(routeResponse(route, List.of(SELECTED), imports))
                        .edges())
                .noneMatch(edge -> edge.sourceNaturalKey().equals("route:/detail"));
    }

    @Test
    void legacyDefaultNameMismatchRemainsUnlinkedWithoutExplicitDeclarationEvidence() {
        var route = new TsAnalyzeDtos.RouteHit("/detail", "Selected", "ui/Router.tsx", 1, 1);
        var imports =
                List.of(new TsAnalyzeDtos.ImportHit("ui/Router.tsx", "ui/Page.tsx", "Selected", "default", false));
        assertThat(TsGraphMapper.toGraph(routeResponse(route, List.of(SELECTED), imports))
                        .edges())
                .noneMatch(edge -> edge.sourceNaturalKey().equals("route:/detail"));
    }

    @Test
    void conflictingExplicitRouteKeysCannotRetainOneOfTheirEdges() {
        var one = new TsAnalyzeDtos.RouteHit(
                "/detail",
                "Selected",
                "ui/Router.tsx",
                1,
                1,
                new TsAnalyzeDtos.ComponentResolution(
                        "RESOLVED", new TsAnalyzeDtos.ComponentReference("ActualPage", "ui/Page.tsx", 2, 4)));
        var two = new TsAnalyzeDtos.RouteHit("/detail", "ActualPage", "ui/Router.tsx", 5, 5);
        var result = TsGraphMapper.toGraph(new TsAnalyzeDtos.Response(
                List.of(one, two), List.of(SELECTED), null, null, null, null, null, null, null, null, null));
        assertThat(result.edges()).noneMatch(edge -> edge.sourceNaturalKey().equals("route:/detail"));
        assertThat(result.nodes())
                .filteredOn(node -> node.naturalKey().equals("route:/detail"))
                .allMatch(node -> "UNRESOLVED".equals(node.metadata().get("componentResolution")));
    }

    private static TsAnalyzeDtos.Response routeResponse(
            TsAnalyzeDtos.RouteHit route,
            List<TsAnalyzeDtos.SymbolHit> components,
            List<TsAnalyzeDtos.ImportHit> imports) {
        return new TsAnalyzeDtos.Response(
                List.of(route), components, null, null, null, imports, null, null, null, null, null);
    }

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
    void sameNamedComponentsKeepApiCallsInTheirOwnFileAndRouteRequiresImportEvidence() {
        var response = new TsAnalyzeDtos.Response(
                List.of(new TsAnalyzeDtos.RouteHit("/items", "Page", "app/router.tsx", 1, 1)),
                List.of(
                        new TsAnalyzeDtos.SymbolHit("Page", "COMPONENT", "app/Page.tsx", 1, 8),
                        new TsAnalyzeDtos.SymbolHit("Page", "COMPONENT", "admin/Page.tsx", 1, 8)),
                null,
                null,
                List.of(new TsAnalyzeDtos.ApiCallHit("GET", "/admin", "admin/Page.tsx", 3, "Page")),
                List.of(new TsAnalyzeDtos.ImportHit("app/router.tsx", "app/Page.tsx", "Page", "Page", false)),
                null,
                null,
                null,
                null,
                null);
        var result = TsGraphMapper.toGraph(response);
        assertThat(result.nodes())
                .filteredOn(node -> node.naturalKey().equals(NaturalKeys.component("app/Page.tsx", "Page")))
                .allMatch(node -> !node.metadata().containsKey("apiCalls"));
        assertThat(result.nodes())
                .filteredOn(node -> node.naturalKey().equals(NaturalKeys.component("admin/Page.tsx", "Page")))
                .allMatch(node -> node.metadata().containsKey("apiCalls"));
        assertThat(result.edges())
                .filteredOn(edge -> edge.sourceNaturalKey().equals(NaturalKeys.route("/items")))
                .extracting(edge -> edge.targetNaturalKey())
                .containsExactly(NaturalKeys.component("app/Page.tsx", "Page"));
        var withoutImports = new TsAnalyzeDtos.Response(
                response.routes(),
                response.components(),
                null,
                null,
                response.apiCalls(),
                null,
                null,
                null,
                null,
                null,
                null);
        assertThat(TsGraphMapper.toGraph(withoutImports).edges())
                .noneMatch(edge -> edge.sourceNaturalKey().equals(NaturalKeys.route("/items")));
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
