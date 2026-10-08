package dev.codeintelligence.analysis.core;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import tools.jackson.databind.json.JsonMapper;

/** Process-lifetime, project-isolated opaque adapter results. Never stores source text or writes disk. */
public final class AdapterResultCache {
    public static final int MAX_ENTRY_BYTES = 128 * 1024;
    public static final int MAX_BYTES = 16 * 1024 * 1024;
    private static final int MAX_ENTRIES = 50_000;
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final LinkedHashMap<Key, String> entries = new LinkedHashMap<>(16, 0.75f, true);
    private int bytes;
    private final String signingKey;

    public AdapterResultCache() {
        byte[] key = new byte[32];
        new java.security.SecureRandom().nextBytes(key);
        signingKey = java.util.HexFormat.of().formatHex(key);
    }

    public String signingKey() {
        return signingKey;
    }

    private record Key(long projectId, String path) {}

    public synchronized Map<String, String> snapshot(long projectId, List<String> paths) {
        Map<String, String> result = new LinkedHashMap<>();
        for (String path : paths) {
            String entry = entries.get(new Key(projectId, path));
            if (entry != null) result.put(path, entry);
        }
        return Map.copyOf(result);
    }

    public synchronized void replace(long projectId, List<String> paths, List<String> values) {
        var iterator = entries.entrySet().iterator();
        while (iterator.hasNext()) {
            var entry = iterator.next();
            if (entry.getKey().projectId() == projectId) {
                bytes -= entry.getValue().length() * 2;
                iterator.remove();
            }
        }
        Set<String> allowed = Set.copyOf(paths);
        for (String value : values) {
            if (value == null || value.length() * 2 > MAX_ENTRY_BYTES) continue;
            try {
                var parsed = JSON.readTree(value);
                String path = parsed.path("path").asString("");
                if (!allowed.contains(path) || !parsed.path("key").asString("").matches("[0-9a-f]{64}")) continue;
                Key key = new Key(projectId, path);
                String prior = entries.put(key, value);
                bytes += value.length() * 2 - (prior == null ? 0 : prior.length() * 2);
            } catch (RuntimeException ignored) {
                // A malformed optional result is a cache miss, never a failed analysis.
            }
            while (bytes > MAX_BYTES || entries.size() > MAX_ENTRIES) {
                var eldest = entries.pollFirstEntry();
                bytes -= eldest.getValue().length() * 2;
            }
        }
    }
}
