package dev.codeintelligence.history;

public record CommitDiff(String changeType, String oldContent, String newContent) {}
