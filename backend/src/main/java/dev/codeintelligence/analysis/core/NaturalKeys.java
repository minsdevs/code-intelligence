package dev.codeintelligence.analysis.core;

import java.util.List;
import java.util.Locale;
import java.util.Objects;

/** Stable natural_key conventions (§8.3) used for idempotent graph upserts. */
public final class NaturalKeys {

    private NaturalKeys() {}

    public static String file(String path) {
        return "file:" + normalizePath(path);
    }

    public static String javaType(String fqcn) {
        return "java:" + require(fqcn, "fqcn");
    }

    public static String javaMethod(String fqcn, String methodName, List<String> paramTypes) {
        String params = String.join(",", paramTypes == null ? List.of() : paramTypes);
        return "java:" + require(fqcn, "fqcn") + "#" + require(methodName, "method") + "(" + params + ")";
    }

    public static String javaField(String fqcn, String fieldName) {
        return "java:" + require(fqcn, "fqcn") + "#" + require(fieldName, "field");
    }

    public static String endpoint(String httpMethod, String path) {
        return "endpoint:" + require(httpMethod, "method").toUpperCase(Locale.ROOT) + ":" + require(path, "path");
    }

    public static String entity(String fqcn) {
        return "entity:" + require(fqcn, "fqcn");
    }

    public static String table(String name) {
        return "table:" + require(name, "table");
    }

    public static String container(String service) {
        return "container:" + require(service, "service");
    }

    public static String ci(String workflow, String job) {
        return "ci:" + require(workflow, "workflow") + ":" + require(job, "job");
    }

    public static String config(String path) {
        return "config:" + normalizePath(path);
    }

    public static String migration(String path) {
        return "migration:" + normalizePath(path);
    }

    public static String dependency(String group, String artifact) {
        String name = require(artifact, "artifact");
        if (group == null || group.isBlank()) {
            return "dep:" + name;
        }
        return "dep:" + group + ":" + name;
    }

    private static String normalizePath(String path) {
        String normalized = require(path, "path").replace('\\', '/');
        if (normalized.startsWith("./")) {
            normalized = normalized.substring(2);
        }
        return normalized;
    }

    private static String require(String value, String what) {
        Objects.requireNonNull(value, what);
        if (value.isBlank()) {
            throw new IllegalArgumentException(what + " must not be blank");
        }
        return value;
    }
}
