package dev.codeintelligence.github;

public record GithubRepoSummary(
        String owner,
        String name,
        String fullName,
        boolean isPrivate,
        String defaultBranch,
        String description,
        String updatedAt) {}
