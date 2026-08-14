package dev.codeintelligence.github;

import java.time.Instant;

public record GithubPullSummary(
        int number,
        String title,
        String body,
        String state,
        String author,
        Instant mergedAt,
        String headSha,
        String baseSha) {}
