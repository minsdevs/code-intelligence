package dev.codeintelligence.common;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** 05 §4 analysis memory watchdog limit over the owner process tree reported by desktop main. */
@ConfigurationProperties("app.analysis.memory")
public record AnalysisMemoryProperties(
        @DefaultValue("6442450944") long limitBytes) {

    public AnalysisMemoryProperties {
        if (limitBytes < 1) {
            throw new IllegalStateException("app.analysis.memory.limit-bytes must be at least 1");
        }
    }
}
