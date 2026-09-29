package dev.codeintelligence.github;

import java.util.List;

public record GithubBranchPage(List<GithubBranchSummary> items, boolean hasNext) {}
