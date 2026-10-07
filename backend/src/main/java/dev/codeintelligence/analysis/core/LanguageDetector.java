package dev.codeintelligence.analysis.core;

import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

public final class LanguageDetector {

    private static final Map<String, String> BY_EXTENSION = Map.ofEntries(
            Map.entry("java", "java"),
            Map.entry("kt", "kotlin"),
            Map.entry("kts", "kotlin"),
            Map.entry("ts", "typescript"),
            Map.entry("tsx", "typescript"),
            Map.entry("mts", "typescript"),
            Map.entry("cts", "typescript"),
            Map.entry("js", "javascript"),
            Map.entry("jsx", "javascript"),
            Map.entry("mjs", "javascript"),
            Map.entry("cjs", "javascript"),
            Map.entry("py", "python"),
            Map.entry("go", "go"),
            Map.entry("sql", "sql"),
            Map.entry("yml", "yaml"),
            Map.entry("yaml", "yaml"),
            Map.entry("tf", "hcl"),
            Map.entry("md", "markdown"),
            Map.entry("xml", "xml"),
            Map.entry("gradle", "gradle"),
            Map.entry("sh", "shell"),
            Map.entry("bash", "shell"),
            Map.entry("json", "json"),
            Map.entry("html", "html"),
            Map.entry("htm", "html"),
            Map.entry("css", "css"),
            Map.entry("scss", "scss"),
            Map.entry("properties", "properties"),
            Map.entry("toml", "toml"),
            Map.entry("swift", "swift"),
            Map.entry("rs", "rust"),
            Map.entry("rb", "ruby"),
            Map.entry("php", "php"),
            Map.entry("cs", "csharp"),
            Map.entry("c", "c"),
            Map.entry("h", "c"),
            Map.entry("cpp", "cpp"),
            Map.entry("hpp", "cpp"));

    private static final Set<String> KNOWN = known();

    private LanguageDetector() {}

    /** Every language name {@link #detect} can return. */
    public static Set<String> knownLanguages() {
        return KNOWN;
    }

    private static Set<String> known() {
        TreeSet<String> names = new TreeSet<>(BY_EXTENSION.values());
        names.add("dockerfile");
        return Set.copyOf(names);
    }

    public static String detect(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }
        String normalized = path.replace('\\', '/');
        int slash = normalized.lastIndexOf('/');
        String filename = slash >= 0 ? normalized.substring(slash + 1) : normalized;
        if ("Dockerfile".equals(filename) || "dockerfile".equals(filename)) {
            return "dockerfile";
        }
        if (filename.endsWith(".gradle.kts")) {
            return "gradle";
        }
        int dot = filename.lastIndexOf('.');
        if (dot < 0 || dot == filename.length() - 1) {
            return null;
        }
        String ext = filename.substring(dot + 1).toLowerCase(Locale.ROOT);
        return BY_EXTENSION.get(ext);
    }
}
