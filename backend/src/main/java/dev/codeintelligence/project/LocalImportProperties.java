package dev.codeintelligence.project;

import java.nio.file.Path;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Configuration for local folder import. The {@code allowed-roots} property defines which
 * directories may be used as source for local project imports. If empty, the user's home
 * directory is used as the single allowed root.
 */
@ConfigurationProperties("app.local-import")
public record LocalImportProperties(@DefaultValue("") String allowedRoots) {

    /**
     * Returns the list of allowed root paths. If none are configured, defaults to the
     * user's home directory.
     */
    public List<Path> resolvedAllowedRoots() {
        if (allowedRoots == null || allowedRoots.isBlank()) {
            String home = System.getProperty("user.home");
            if (home == null || home.isBlank()) {
                return List.of();
            }
            return List.of(Path.of(home).toAbsolutePath().normalize());
        }
        return java.util.Arrays.stream(allowedRoots.split(","))
                .map(String::strip)
                .filter(s -> !s.isEmpty())
                .map(s -> Path.of(s).toAbsolutePath().normalize())
                .toList();
    }
}
