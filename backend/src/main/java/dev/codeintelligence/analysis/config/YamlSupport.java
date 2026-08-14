package dev.codeintelligence.analysis.config;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;

final class YamlSupport {

    private YamlSupport() {}

    static List<Object> loadDocuments(String text) {
        LoaderOptions options = new LoaderOptions();
        options.setAllowDuplicateKeys(true);
        options.setMaxAliasesForCollections(50);
        Yaml yaml = new Yaml(new SafeConstructor(options));
        List<Object> docs = new ArrayList<>();
        for (Object doc : yaml.loadAll(text)) {
            if (doc != null) {
                docs.add(doc);
            }
        }
        return docs;
    }

    static Map<String, Object> asMap(Object value) {
        if (!(value instanceof Map<?, ?> raw)) {
            return Map.of();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : raw.entrySet()) {
            if (entry.getKey() != null) {
                out.put(String.valueOf(entry.getKey()), entry.getValue());
            }
        }
        return out;
    }

    static Object nested(Map<String, Object> root, String... path) {
        Object current = root;
        for (String key : path) {
            if (!(current instanceof Map<?, ?> map)) {
                return null;
            }
            current = map.get(key);
            if (current == null) {
                return null;
            }
        }
        return current;
    }

    static List<String> stringList(Object value) {
        List<String> out = new ArrayList<>();
        if (value instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> map) {
                    out.addAll(map.keySet().stream().map(String::valueOf).toList());
                } else if (item != null) {
                    out.add(String.valueOf(item));
                }
            }
        } else if (value instanceof Map<?, ?> map) {
            for (Object key : map.keySet()) {
                out.add(String.valueOf(key));
            }
        } else if (value != null) {
            out.add(String.valueOf(value));
        }
        return List.copyOf(out);
    }

    static List<String> environmentKeys(Object value) {
        List<String> keys = new ArrayList<>();
        if (value instanceof Map<?, ?> map) {
            for (Object key : map.keySet()) {
                keys.add(String.valueOf(key));
            }
        } else if (value instanceof List<?> list) {
            for (Object item : list) {
                if (item == null) {
                    continue;
                }
                String raw = String.valueOf(item);
                int eq = raw.indexOf('=');
                keys.add(eq < 0 ? raw : raw.substring(0, eq));
            }
        }
        return List.copyOf(keys);
    }
}
