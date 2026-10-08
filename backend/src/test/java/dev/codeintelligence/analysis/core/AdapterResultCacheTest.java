package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class AdapterResultCacheTest {
    @Test
    void isolatesProjectsDropsDeletedFilesAndRejectsUnknownCorruptOversizeEntries() {
        var cache = new AdapterResultCache();
        String entry = entry("a.ts", "value");
        cache.replace(1, List.of("a.ts"), List.of(entry, "invalid", entry("other.ts", "other")));
        assertThat(cache.snapshot(1, List.of("a.ts"))).containsEntry("a.ts", entry);
        assertThat(cache.snapshot(2, List.of("a.ts"))).isEmpty();
        cache.replace(1, List.of("b.ts"), List.of(entry("b.ts", "x".repeat(AdapterResultCache.MAX_ENTRY_BYTES))));
        assertThat(cache.snapshot(1, List.of("a.ts", "b.ts"))).isEmpty();
    }

    @Test
    void boundsAllProjectsTogetherAndReturnsImmutableSnapshots() {
        var cache = new AdapterResultCache();
        List<String> paths = new ArrayList<>();
        List<String> entries = new ArrayList<>();
        for (int i = 0; i < 200; i++) {
            paths.add(i + ".ts");
            entries.add(entry(i + ".ts", "x".repeat(50_000)));
        }
        cache.replace(1, paths, entries);
        var snapshot = cache.snapshot(1, paths);
        assertThat(snapshot.values().stream()
                        .mapToInt(value -> value.length() * 2)
                        .sum())
                .isLessThanOrEqualTo(AdapterResultCache.MAX_BYTES);
        assertThat(snapshot).hasSizeLessThan(paths.size());
        cache.replace(1, List.of(), List.of());
        assertThat(snapshot).isNotEmpty();
        assertThat(cache.snapshot(1, paths)).isEmpty();
    }

    private static String entry(String path, String rows) {
        return "{\"path\":\"" + path + "\",\"key\":\"" + "a".repeat(64) + "\",\"rows\":\"" + rows + "\"}";
    }
}
