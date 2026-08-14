package dev.codeintelligence.common;

import java.nio.file.Path;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.StringUtils;

/** Local storage layout: cloned repositories live under {@code ${app.data-dir}/repos/{projectId}}. */
@ConfigurationProperties("app")
public record AppProperties(
        String dataDir, @DefaultValue("2") int snapshotRetention) {

    public AppProperties {
        if (!StringUtils.hasText(dataDir)) {
            throw new IllegalStateException("app.data-dir must not be blank");
        }
        if (snapshotRetention < 1) {
            throw new IllegalStateException("app.snapshot-retention must be at least 1");
        }
    }

    public Path reposRoot() {
        return Path.of(dataDir).toAbsolutePath().normalize().resolve("repos");
    }
}
