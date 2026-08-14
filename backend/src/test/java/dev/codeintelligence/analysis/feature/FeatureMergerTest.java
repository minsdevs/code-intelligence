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
}
