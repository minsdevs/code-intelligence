package dev.codeintelligence.history;

import java.time.Instant;

public record CommitSummary(
        String sha, String author, String message, Instant committedAt, int additions, int deletions) {}
