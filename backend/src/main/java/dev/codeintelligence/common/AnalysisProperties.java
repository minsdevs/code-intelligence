package dev.codeintelligence.common;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

@ConfigurationProperties("app.analysis")
public record AnalysisProperties(
        @DefaultValue("20000") int maxFiles,
        @DefaultValue("1048576") long maxFileSize,
        @DefaultValue("10000") int maxCommits,
        @DefaultValue("5") int githubRateLimitRetries,
        @DefaultValue("1000") long githubBackoffBaseMs,
        @DefaultValue("0.5") double featureMergeThreshold) {

    public AnalysisProperties {
        if (maxFiles < 1) {
            throw new IllegalStateException("app.analysis.max-files must be at least 1");
        }
        if (maxFileSize < 1) {
            throw new IllegalStateException("app.analysis.max-file-size must be at least 1");
        }
        if (maxCommits < 1) {
            throw new IllegalStateException("app.analysis.max-commits must be at least 1");
        }
        if (githubRateLimitRetries < 0) {
            throw new IllegalStateException("app.analysis.github-rate-limit-retries must be at least 0");
        }
        if (githubBackoffBaseMs < 1) {
            throw new IllegalStateException("app.analysis.github-backoff-base-ms must be at least 1");
        }
        if (featureMergeThreshold < 0 || featureMergeThreshold > 1) {
            throw new IllegalStateException("app.analysis.feature-merge-threshold must be between 0 and 1");
        }
    }
}
