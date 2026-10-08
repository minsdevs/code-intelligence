package dev.codeintelligence.analysis.feature;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class FeatureMergerTest {

    @Test
    void mergesAtThresholdAndKeepsEndpointName() {
        FeatureMerger.Seed left = new FeatureMerger.Seed("auth", Set.of("a", "b"), true);
        FeatureMerger.Seed right = new FeatureMerger.Seed("security", Set.of("a"), false);
        // Jaccard({a,b},{a}) = 1/2
        assertThat(FeatureMerger.jaccard(left.nodeKeys(), right.nodeKeys())).isCloseTo(0.5, within(1e-9));
        List<FeatureMerger.Seed> merged = FeatureMerger.merge(List.of(left, right), 0.5);
        assertThat(merged).hasSize(1);
        assertThat(merged.getFirst().name()).isEqualTo("auth");
        assertThat(merged.getFirst().endpointDerived()).isTrue();
        assertThat(merged.getFirst().nodeKeys()).containsExactlyInAnyOrder("a", "b");
    }

    @Test
    void doesNotMergeBelowThreshold() {
        FeatureMerger.Seed left = new FeatureMerger.Seed("auth", Set.of("a", "b"), true);
        FeatureMerger.Seed right = new FeatureMerger.Seed("todos", Set.of("c"), true);
        List<FeatureMerger.Seed> merged = FeatureMerger.merge(List.of(left, right), 0.5);
        assertThat(merged).hasSize(2);
    }

    @Test
    void dropsUnmergedPackageSeedsWhenEndpointSeedsExist() {
        List<FeatureMerger.Seed> merged = List.of(
                new FeatureMerger.Seed("auth", Set.of("e1"), true),
                new FeatureMerger.Seed("todo", Set.of("c1", "c2"), false));
        assertThat(FeatureMerger.dropUnmergedPackageSeeds(merged))
                .extracting(FeatureMerger.Seed::name)
                .containsExactly("auth");
    }

    @Test
    void sameNameRouteAndEndpointSeedsKeepBothDomainsRegardlessOfOrder() {
        var backend = new FeatureMerger.Seed("todos", Set.of("endpoint:GET:/todos"), true);
        var frontend = new FeatureMerger.Seed("todos", Set.of("route:/todos"), true);
        for (var seeds : List.of(List.of(backend, frontend), List.of(frontend, backend))) {
            var merged = FeatureMerger.dropUnmergedPackageSeeds(FeatureMerger.merge(seeds, 0.5));
            assertThat(merged).hasSize(1);
            assertThat(merged.getFirst().nodeKeys()).containsExactlyInAnyOrder("endpoint:GET:/todos", "route:/todos");
        }
    }

    /**
     * Large workload: one seed per frontend route prefix (about 4,250) next to one endpoint seed of
     * every API endpoint; each Jaccard comparison copied both sets twice, so comparing every pair
     * copied the large seed thousands of times (20 s of FEATURE_DETECTION).
     */
    @Test
    void comparingManySeedsWithOneLargeSeedDoesNotCopyTheLargeSeedPerPair() {
        java.util.Set<String> api = new java.util.HashSet<>();
        for (int i = 0; i < 100_000; i++) api.add("endpoint:GET:/api/items" + i);
        java.util.List<FeatureMerger.Seed> seeds = new java.util.ArrayList<>();
        seeds.add(new FeatureMerger.Seed("api", api, true));
        for (int i = 0; i < 1_500; i++) seeds.add(new FeatureMerger.Seed("p" + i, Set.of("route:/p" + i), true));

        long started = System.nanoTime();
        List<FeatureMerger.Seed> merged = FeatureMerger.merge(seeds, 0.5);
        long elapsedMs = (System.nanoTime() - started) / 1_000_000;

        assertThat(merged).hasSize(1_501);
        assertThat(FeatureMerger.jaccard(Set.of(), Set.of())).isEqualTo(1.0);
        assertThat(FeatureMerger.jaccard(Set.of("a", "b", "c"), Set.of("b", "c", "d")))
                .isEqualTo(2.0 / 4);
        assertThat(elapsedMs).isLessThan(1_000);
    }
}
