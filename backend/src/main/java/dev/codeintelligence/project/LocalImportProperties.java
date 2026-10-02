package dev.codeintelligence.project;

import java.nio.file.Path;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Configured roots are an explicit server deployment allowlist. Desktop selections are granted
 * separately for the running process; an empty value grants no filesystem access.
 */
@ConfigurationProperties("app.local-import")
public record LocalImportProperties(@DefaultValue("") String allowedRoots) {

    /** Returns explicitly configured roots. An empty value grants no roots. */
    public List<Path> resolvedAllowedRoots() {
        if (allowedRoots == null || allowedRoots.isBlank()) {
            return List.of();
        }
        return java.util.Arrays.stream(allowedRoots.split(","))
                .map(String::strip)
                .filter(s -> !s.isEmpty())
                .map(s -> Path.of(s).toAbsolutePath().normalize())
                .toList();
    }
}
