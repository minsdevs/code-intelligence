package dev.codeintelligence.analysis.accuracy;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Reviewed semantic facts, never an output snapshot. IDs, timestamps and row order are not facts. */
final class SemanticOracle {
    record Fact(String key, String value) {}

    record Ignored(Fact fact, String reason) {
        Ignored {
            if (reason == null || reason.isBlank()) {
                throw new IllegalArgumentException("An intentionally-ignored fact needs a reason");
            }
        }
    }

    private SemanticOracle() {}

    static void verify(String fixture, Collection<Fact> expected, Collection<Fact> actual, List<Ignored> ignored) {
        List<String> differences = differences(expected, actual, ignored);
        for (Ignored item : ignored) {
            System.out.println("[intentionally-ignored] " + fixture + " " + item.fact() + ": " + item.reason());
        }
        if (!differences.isEmpty()) {
            throw new AssertionError("[accuracy] " + fixture + " — 코드 버그 후보; fixture 의도와 oracle을 검토하세요."
                    + " 자동 baseline 갱신 금지.\n" + String.join("\n", differences));
        }
        System.out.println("[accuracy PASS] " + fixture + ": " + expected.size() + " expected semantic facts");
    }

    static List<String> differences(Collection<Fact> expected, Collection<Fact> actual, List<Ignored> ignored) {
        List<String> diff = new ArrayList<>();
        Map<String, String> want = index(expected, "oracle", diff);
        Map<String, String> got = index(actual, "actual", diff);
        for (Ignored item : ignored) {
            if (want.containsKey(item.fact().key())) {
                throw new IllegalArgumentException(
                        "expected and ignored overlap: " + item.fact().key());
            }
            // Only this exact fact is allowed. A changed severity/value still fails.
            got.remove(item.fact().key(), item.fact().value());
        }
        want.forEach((key, value) -> {
            if (!got.containsKey(key)) {
                diff.add("- missing " + key + " = " + value);
            } else if (!value.equals(got.get(key))) {
                diff.add("~ changed " + key + " expected=" + value + " actual=" + got.get(key));
            }
        });
        got.forEach((key, value) -> {
            if (!want.containsKey(key)) {
                diff.add("+ unexpected " + key + " = " + value);
            }
        });
        return diff.stream().sorted().toList();
    }

    private static Map<String, String> index(Collection<Fact> facts, String source, List<String> diff) {
        Map<String, String> result = new TreeMap<>();
        for (Fact fact : facts) {
            if (result.putIfAbsent(fact.key(), fact.value()) != null) {
                diff.add("! duplicate " + source + " " + fact.key());
            }
        }
        return result;
    }
}
