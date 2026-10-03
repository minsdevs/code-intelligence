package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class TsAnalyzeDtosTest {
    private final JsonMapper json = JsonMapper.builder().build();

    @Test
    void nullableMetadataFromRealAnalyzerRoundTripsAndMapsToGraph() throws Exception {
        try (var input = getClass().getResourceAsStream("/fixtures/ts-nullable-metadata.json")) {
            var wire = json.readTree(input).get("response");
            assertThat(wire.get("endpoints")
                            .get(0)
                            .get("metadata")
                            .get("responseType")
                            .isNull())
                    .isTrue();
            var response = json.treeToValue(wire, TsAnalyzeDtos.Response.class);
            var endpoint = response.endpoints().getFirst();
            assertThat(endpoint.metadata()).doesNotContainKey("responseType");
            var parameterTypes = (List<?>) endpoint.metadata().get("parameterTypes");
            assertThat(parameterTypes).hasSize(1);
            assertThat(parameterTypes.getFirst()).isNull();
            var graph = TsGraphMapper.toGraph(response);
            assertThat(graph.nodes()).anyMatch(node -> "API_ENDPOINT".equals(node.nodeType()));
            assertThat(graph.nodes())
                    .anyMatch(node -> "METHOD".equals(node.nodeType())
                            && !node.metadata().containsKey("returnType")
                            && json.writeValueAsString(node.metadata()).contains("\"type\":null"));
        }
    }

    @Test
    void missingMetadataStillMeansAnEmptyObject() {
        assertThat(new TsAnalyzeDtos.EndpointHit(null, null, null, null, null, null, null, null, null).metadata())
                .isEmpty();
        assertThat(new TsAnalyzeDtos.SemanticNodeHit(null, null, null, null, null, null, null, null).metadata())
                .isEmpty();
        assertThat(new TsAnalyzeDtos.SemanticEdgeHit(null, null, null, null, null, null, null, null).metadata())
                .isEmpty();
    }

    @Test
    void allMetadataRecordsDefensivelyCopyAndRemainImmutable() {
        Map<String, Object> original = new LinkedHashMap<>();
        original.put("unknown", null);
        original.put("known", "value");
        var copies = List.of(
                new TsAnalyzeDtos.EndpointHit(null, null, null, null, null, null, null, null, original).metadata(),
                new TsAnalyzeDtos.SemanticNodeHit(null, null, null, null, null, null, null, original).metadata(),
                new TsAnalyzeDtos.SemanticEdgeHit(null, null, null, null, null, null, null, original).metadata());
        original.put("known", "changed");
        for (var copy : copies) {
            assertThat(copy).containsExactlyInAnyOrderEntriesOf(Map.of("known", "value"));
            assertThatThrownBy(() -> copy.put("new", "value")).isInstanceOf(UnsupportedOperationException.class);
        }
    }

    @Test
    void nullableEdgeMetadataAlsoCrossesTheGraphBoundary() {
        var response = json.readValue("""
                {"edges":[{"sourceKey":"ts:a.ts#a","targetKey":"ts:a.ts#b","type":"CALLS",
                "confidence":"CONFIRMED","filePath":"a.ts","lineStart":1,
                "metadata":{"optional":null,"asyncBoundary":false}}]}
                """, TsAnalyzeDtos.Response.class);
        var edge = TsGraphMapper.toGraph(response).edges().getFirst();
        assertThat(edge.metadata()).doesNotContainKey("optional").containsEntry("asyncBoundary", false);
    }

    @Test
    void nullResponseMembersAreStillRejectedAsProtocolErrors() {
        assertThatThrownBy(() -> json.readValue("{\"nodes\":[null]}", TsAnalyzeDtos.Response.class))
                .isInstanceOf(RuntimeException.class);
    }
}
