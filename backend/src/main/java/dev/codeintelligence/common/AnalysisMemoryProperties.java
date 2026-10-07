package dev.codeintelligence.common;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * 05 §4 analysis memory watchdog. {@code ownerPid} is the root of the owner process tree (the
 * desktop main process, which owns the backend, analyzers and databases); 0 measures the tree of
 * this backend process only.
 */
@ConfigurationProperties("app.analysis.memory")
public record AnalysisMemoryProperties(
        @DefaultValue("6442450944") long limitBytes,
        @DefaultValue("0") long ownerPid) {

    public AnalysisMemoryProperties {
        if (limitBytes < 1) {
            throw new IllegalStateException("app.analysis.memory.limit-bytes must be at least 1");
        }
        if (ownerPid < 0) {
            throw new IllegalStateException("app.analysis.memory.owner-pid must not be negative");
        }
    }
}
