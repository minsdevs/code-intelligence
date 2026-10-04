package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class GraphIdentityGuardTest {
    @Test
    void duplicateTypeBlocksAllMembersAndRelationshipsWithoutChoosingAFile() {
        var first = node(GraphNodeType.CLASS, "java:demo.Service", "one/Service.java");
        var second = node(GraphNodeType.CLASS, "java:demo.Service", "two/Service.java");
        var method = node(GraphNodeType.METHOD, "java:demo.Service#run()", "one/Service.java");
        var caller = node(GraphNodeType.METHOD, "java:demo.Caller#call()", "Caller.java");
        var result = GraphIdentityGuard.sanitize(new AnalysisResult(
                List.of(first, second, method, caller),
                List.of(GraphEdgeDraft.of(
                        caller.naturalKey(), method.naturalKey(), GraphEdgeType.CALLS, EdgeConfidence.CONFIRMED)),
                List.of()));
        assertThat(result.edges()).isEmpty();
        assertThat(result.nodes())
                .filteredOn(GraphIdentityGuard::ambiguous)
                .hasSize(2)
                .allMatch(n -> n.filePath() == null
                        && n.lineStart() == null
                        && n.nodeType().equals("AMBIGUOUS"));
        assertThat(result.fileOutcomes())
                .containsExactlyInAnyOrder(
                        new FileAnalysisOutcome("one/Service.java", "PARTIAL", GraphIdentityGuard.REASON),
                        new FileAnalysisOutcome("two/Service.java", "PARTIAL", GraphIdentityGuard.REASON));
        // Re-merging a later analyzer's source node must not resurrect the ambiguous declaration.
        var repeated = new java.util.ArrayList<>(result.nodes());
        repeated.add(first);
        assertThat(GraphIdentityGuard.sanitize(new AnalysisResult(repeated, List.of(), List.of()))
                        .nodes())
                .filteredOn(n -> n.naturalKey().equals(first.naturalKey()))
                .singleElement()
                .matches(GraphIdentityGuard::ambiguous);
    }

    @Test
    void duplicateEndpointsAreBlockedButFilelessEnrichmentAndPackageGroupingAreAllowed() {
        var result = GraphIdentityGuard.sanitize(new AnalysisResult(
                List.of(
                        node(GraphNodeType.API_ENDPOINT, "endpoint:GET:/items", "one/Controller.java"),
                        node(GraphNodeType.API_ENDPOINT, "endpoint:GET:/items", "two/controller.ts"),
                        node(GraphNodeType.PACKAGE, "java:demo", "one/Controller.java"),
                        node(GraphNodeType.PACKAGE, "java:demo", "two/Controller.java"),
                        node(GraphNodeType.CLASS, "java:Shared", "Shared.java"),
                        GraphNodeDraft.of(GraphNodeType.CLASS, "java:Shared", "Shared", null, null, null)
                                .withMetadata(Map.of("role", "SERVICE"))),
                List.of(GraphEdgeDraft.of(
                        "java:Shared", "endpoint:GET:/items", GraphEdgeType.EXPOSES, EdgeConfidence.CONFIRMED)),
                List.of()));
        assertThat(result.edges()).isEmpty();
        assertThat(result.nodes())
                .filteredOn(GraphIdentityGuard::ambiguous)
                .singleElement()
                .matches(n -> n.naturalKey().equals("endpoint:GET:/items"));
        assertThat(result.fileOutcomes()).hasSize(2);
    }

    private static GraphNodeDraft node(GraphNodeType type, String key, String path) {
        return GraphNodeDraft.of(type, key, key, path, 1, 5);
    }
}
