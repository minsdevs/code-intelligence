package dev.codeintelligence.github;

import java.util.List;

public record GithubPullsPage(boolean notModified, List<GithubPullSummary> items, boolean hasNext, String etag) {

    public static GithubPullsPage notModified(String etag) {
        return new GithubPullsPage(true, List.of(), false, etag);
    }
}
