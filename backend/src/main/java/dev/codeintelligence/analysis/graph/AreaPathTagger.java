package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.analysis.area.AreaType;
import java.util.Locale;

/** Path-based area_type tagging for graph nodes (기획서 §9.3, task 1-8 example: src/test → TESTING). */
public final class AreaPathTagger {

    private AreaPathTagger() {}

    public static String tag(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }
        String normalized = path.replace('\\', '/');
        String lower = normalized.toLowerCase(Locale.ROOT);
        if (normalized.contains("src/test") || lower.contains("/test/") && lower.endsWith(".java")) {
            return AreaType.TESTING.name();
        }
        if (normalized.contains("src/main/java") || lower.endsWith(".java")) {
            return AreaType.BACKEND.name();
        }
        if (lower.endsWith(".tsx")
                || lower.endsWith(".jsx")
                || lower.contains("/frontend/")
                || lower.contains("src/pages/")
                || lower.contains("src/components/")
                || (lower.endsWith(".ts") || lower.endsWith(".js") || lower.endsWith(".mjs"))
                        && !lower.contains("/backend/")) {
            return AreaType.FRONTEND.name();
        }
        if (normalized.contains("db/migration") || lower.endsWith(".sql")) {
            return AreaType.DATABASE.name();
        }
        if (normalized.contains(".github/workflows")) {
            return AreaType.DEVOPS.name();
        }
        if (lower.contains("dockerfile") || lower.contains("docker-compose") || lower.endsWith(".tf")) {
            return AreaType.INFRASTRUCTURE.name();
        }
        if (lower.endsWith(".md") || normalized.startsWith("docs/") || normalized.contains("/docs/")) {
            return AreaType.DOCUMENTATION.name();
        }
        if (lower.endsWith(".gradle")
                || lower.endsWith(".gradle.kts")
                || lower.endsWith("pom.xml")
                || lower.endsWith("package.json")
                || lower.endsWith("settings.gradle")
                || lower.endsWith("settings.gradle.kts")) {
            return AreaType.BUILD_TOOLING.name();
        }
        return null;
    }
}
