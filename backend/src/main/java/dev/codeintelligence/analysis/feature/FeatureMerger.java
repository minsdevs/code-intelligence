package dev.codeintelligence.analysis.feature;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Merges feature seeds when Jaccard overlap of node keys is at least the configured threshold. */
final class FeatureMerger {

    record Seed(String name, Set<String> nodeKeys, boolean endpointDerived) {
        Seed {
            nodeKeys = nodeKeys == null ? Set.of() : Set.copyOf(nodeKeys);
        }
    }

    private FeatureMerger() {}

    static List<Seed> merge(List<Seed> seeds, double threshold) {
        List<Seed> current = new ArrayList<>(seeds);
        boolean changed = true;
        while (changed) {
            changed = false;
            outer:
            for (int i = 0; i < current.size(); i++) {
                for (int j = i + 1; j < current.size(); j++) {
                    if (jaccard(current.get(i).nodeKeys(), current.get(j).nodeKeys()) >= threshold) {
                        Seed merged = mergeTwo(current.get(i), current.get(j));
                        current.remove(j);
                        current.remove(i);
                        current.add(merged);
                        changed = true;
                        break outer;
                    }
                }
            }
        }
        return current;
    }

    static double jaccard(Set<String> left, Set<String> right) {
        if (left.isEmpty() && right.isEmpty()) {
            return 1.0;
        }
        Set<String> intersection = new HashSet<>(left);
        intersection.retainAll(right);
        Set<String> union = new HashSet<>(left);
        union.addAll(right);
        if (union.isEmpty()) {
            return 0.0;
        }
        return (double) intersection.size() / union.size();
    }

    private static Seed mergeTwo(Seed left, Seed right) {
        Set<String> nodes = new HashSet<>(left.nodeKeys());
        nodes.addAll(right.nodeKeys());
        boolean endpoint = left.endpointDerived() || right.endpointDerived();
        String name;
        if (left.endpointDerived() && !right.endpointDerived()) {
            name = left.name();
        } else if (right.endpointDerived() && !left.endpointDerived()) {
            name = right.name();
        } else {
            name = left.name().compareTo(right.name()) <= 0 ? left.name() : right.name();
        }
        return new Seed(name, nodes, endpoint);
    }

    static List<Seed> dropUnmergedPackageSeeds(List<Seed> merged) {
        boolean hasEndpoint = merged.stream().anyMatch(Seed::endpointDerived);
        if (!hasEndpoint) {
            return merged;
        }
        Map<String, Seed> byName = new LinkedHashMap<>();
        for (Seed seed : merged) {
            if (!seed.endpointDerived()) {
                continue;
            }
            // A route and an endpoint can have the same prefix with disjoint natural keys.
            // Retain both domains instead of letting input order discard one seed's links.
            byName.merge(seed.name(), seed, FeatureMerger::mergeTwo);
        }
        return List.copyOf(byName.values());
    }
}
