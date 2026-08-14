package dev.codeintelligence.common;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

@ConfigurationProperties("app.analysis")
public record AnalysisProperties(
        @DefaultValue("20000") int maxFiles,
        @DefaultValue("1048576") long maxFileSize) {

    public AnalysisProperties {
        if (maxFiles < 1) {
            throw new IllegalStateException("app.analysis.max-files must be at least 1");
        }
        if (maxFileSize < 1) {
            throw new IllegalStateException("app.analysis.max-file-size must be at least 1");
        }
    }
}
