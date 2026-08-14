package dev.codeintelligence.history;

import java.time.Instant;

public record PullView(
        int number,
        String title,
        String body,
        String state,
        String author,
        Instant mergedAt,
        String headSha,
        String baseSha) {}
