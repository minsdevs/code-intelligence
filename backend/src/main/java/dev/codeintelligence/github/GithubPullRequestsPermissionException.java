package dev.codeintelligence.github;

/** GitHub explicitly denied the optional pull-request metadata permission. */
public final class GithubPullRequestsPermissionException extends RuntimeException {
    public GithubPullRequestsPermissionException() {
        super("Pull request metadata unavailable: GitHub permission was not granted");
    }
}
