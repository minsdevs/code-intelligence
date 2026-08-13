package dev.codeintelligence.github;

import java.util.List;

public record GithubRepoPage(List<GithubRepoSummary> items, boolean hasNext) {}
