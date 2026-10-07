package dev.codeintelligence.analysis.feature;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/**
 * G-PERF medium/large FEATURE_DETECTION (49 s medium, 512 s large): matching each DB_ENTITY to an
 * included ENTITY-layer node by file copied and scanned the whole included set once per DB_ENTITY,
 * so one feature cost (entities × included nodes). The workload fixture puts every endpoint in one
 * feature, which is exactly this shape: one controller, method, entity type and table per module.
 */
class FeatureLinkBuilderScaleTest {

    private static final int MODULES = 8_000;
    private static final long BUDGET_MS = 2_000;

    @Test
    void linkingOneFeatureIsLinearInEntitiesAndIncludedNodes() {
        List<FeatureLinkBuilder.GraphNode> nodes = new ArrayList<>();
        List<FeatureLinkBuilder.GraphEdge> edges = new ArrayList<>();
        Set<String> seed = new LinkedHashSet<>();
        for (int i = 0; i < MODULES; i++) {
            long base = 10L * i;
            String controllerFile = "src/main/java/m" + i + "/ItemController.java";
            String entityFile = "src/main/java/m" + i + "/Item.java";
            nodes.add(node(base, "API_ENDPOINT", "endpoint:GET:/api/items" + i, null, controllerFile));
            nodes.add(node(base + 1, "CLASS", "java:m" + i + ".ItemController", "CONTROLLER", controllerFile));
            nodes.add(node(base + 2, "METHOD", "java:m" + i + ".ItemController#get", "CONTROLLER", controllerFile));
            nodes.add(node(base + 3, "CLASS", "java:m" + i + ".Item", "ENTITY", entityFile));
            nodes.add(node(base + 4, "DB_ENTITY", "db:item" + i, null, entityFile));
            // A table whose entity class is in no feature stays out.
            nodes.add(node(base + 5, "DB_ENTITY", "db:orphan" + i, null, "src/main/java/m" + i + "/Orphan.java"));
            edges.add(new FeatureLinkBuilder.GraphEdge(base + 1, base, "EXPOSES"));
            edges.add(new FeatureLinkBuilder.GraphEdge(base + 1, base + 2, "DECLARES"));
            edges.add(new FeatureLinkBuilder.GraphEdge(base + 2, base + 3, "USES_TYPE"));
            seed.add("endpoint:GET:/api/items" + i);
        }
        FeatureLinkBuilder linker = new FeatureLinkBuilder(nodes, edges);

        long started = System.nanoTime();
        List<FeatureLinkBuilder.Link> links = linker.linksFor(seed);
        long elapsedMs = (System.nanoTime() - started) / 1_000_000;

        Map<Long, String> roles = links.stream()
                .collect(Collectors.toMap(FeatureLinkBuilder.Link::nodeId, FeatureLinkBuilder.Link::role));
        assertThat(roles).hasSize(5 * MODULES);
        for (int i = 0; i < MODULES; i++) {
            long base = 10L * i;
            assertThat(roles)
                    .containsEntry(base, "API")
                    .containsEntry(base + 1, "API")
                    .containsEntry(base + 2, "API")
                    .containsEntry(base + 3, "DATA")
                    .containsEntry(base + 4, "DATA")
                    .doesNotContainKey(base + 5);
        }
        assertThat(elapsedMs).isLessThan(BUDGET_MS);
    }

    /**
     * The large workload has one feature per frontend route prefix (about 4,250) over a 768k-node
     * graph; every feature still scanned all graph nodes for tables (119 s in FEATURE_DETECTION).
     */
    @Test
    void linkingManySmallFeaturesDoesNotScanTheWholeGraphForEach() {
        int routes = 4_000;
        int otherNodes = 400_000;
        List<FeatureLinkBuilder.GraphNode> nodes = new ArrayList<>();
        List<FeatureLinkBuilder.GraphEdge> edges = new ArrayList<>();
        for (int i = 0; i < otherNodes; i++)
            nodes.add(node(1_000_000L + i, "METHOD", "m" + i, null, "src/M" + i + ".ts"));
        for (int i = 0; i < routes; i++) {
            long base = 10L * i;
            String entityFile = "src/main/java/m" + i + "/Item.java";
            nodes.add(node(base, "FE_ROUTE", "route:/p" + i, null, "web/src/pages/p" + i + "/Page.tsx"));
            nodes.add(node(base + 1, "CLASS", "java:m" + i + ".Item", "ENTITY", entityFile));
            nodes.add(node(base + 2, "DB_ENTITY", "db:item" + i, null, entityFile));
            edges.add(new FeatureLinkBuilder.GraphEdge(base, base + 1, "USES_TYPE"));
        }
        FeatureLinkBuilder linker = new FeatureLinkBuilder(nodes, edges);

        long started = System.nanoTime();
        int links = 0;
        for (int i = 0; i < routes; i++) {
            List<FeatureLinkBuilder.Link> feature = linker.linksFor(Set.of("route:/p" + i));
            assertThat(feature)
                    .extracting(FeatureLinkBuilder.Link::nodeId)
                    .containsExactlyInAnyOrder(10L * i, 10L * i + 1, 10L * i + 2);
            links += feature.size();
        }
        long elapsedMs = (System.nanoTime() - started) / 1_000_000;

        assertThat(links).isEqualTo(3 * routes);
        assertThat(elapsedMs).isLessThan(BUDGET_MS);
    }

    private static FeatureLinkBuilder.GraphNode node(long id, String type, String key, String layer, String file) {
        return new FeatureLinkBuilder.GraphNode(id, type, key, key, file, layer);
    }
}
