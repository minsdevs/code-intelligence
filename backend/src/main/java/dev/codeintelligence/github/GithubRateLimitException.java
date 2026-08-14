package dev.codeintelligence.github;

import java.time.Duration;

/** GitHub refused the request because the rate limit was exhausted (or Retry-After was set). */
public class GithubRateLimitException extends RuntimeException {

    private final Duration retryAfter;

    public GithubRateLimitException(Duration retryAfter) {
        super("GitHub rate limit exceeded");
        this.retryAfter = retryAfter;
    }

    public Duration retryAfter() {
        return retryAfter;
    }
}
