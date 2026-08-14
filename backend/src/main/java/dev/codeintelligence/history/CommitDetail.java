package dev.codeintelligence.history;

import java.time.Instant;
import java.util.List;

public record CommitDetail(
        String sha,
        String author,
        String message,
        Instant committedAt,
        int additions,
        int deletions,
        List<CommitFileView> files) {}
