package dev.codeintelligence.history;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.Sleeper;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubPullSummary;
import dev.codeintelligence.github.GithubPullsPage;
import dev.codeintelligence.github.GithubRateLimitException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Fetches GitHub pull requests with ETag short-circuiting and rate-limit backoff. Persistence is
 * left to the caller so 304 responses leave existing rows untouched.
 */
@Component
public class PullRequestCollector {

    public record PullsFetch(boolean notModified, List<GithubPullSummary> pulls, String etag) {}

    private static final int PER_PAGE = 100;

    private final GithubApiClient githubApiClient;
    private final AnalysisProperties analysisProperties;
    private final Sleeper sleeper;

    public PullRequestCollector(
            GithubApiClient githubApiClient, AnalysisProperties analysisProperties, Sleeper sleeper) {
        this.githubApiClient = githubApiClient;
        this.analysisProperties = analysisProperties;
        this.sleeper = sleeper;
    }

    public PullsFetch fetchAll(String token, String owner, String repo, String etag) {
        int failures = 0;
        while (true) {
            try {
                return fetchPages(token, owner, repo, etag);
            } catch (GithubRateLimitException ex) {
                failures++;
                if (failures > analysisProperties.githubRateLimitRetries()) {
                    throw ex;
                }
                try {
                    sleeper.sleep(backoff(ex, failures));
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw ex;
                }
            }
        }
    }

    private PullsFetch fetchPages(String token, String owner, String repo, String etag) {
        List<GithubPullSummary> all = new ArrayList<>();
        String latestEtag = etag;
        for (int page = 1; ; page++) {
            String requestEtag = page == 1 ? etag : null;
            GithubPullsPage result = githubApiClient.listRepoPulls(token, owner, repo, page, PER_PAGE, requestEtag);
            if (result.notModified()) {
                return new PullsFetch(true, List.of(), result.etag() != null ? result.etag() : etag);
            }
            if (result.etag() != null) {
                latestEtag = result.etag();
            }
            all.addAll(result.items());
            if (!result.hasNext()) {
                break;
            }
        }
        return new PullsFetch(false, List.copyOf(all), latestEtag);
    }

    private Duration backoff(GithubRateLimitException ex, int failures) {
        if (ex.retryAfter() != null
                && !ex.retryAfter().isNegative()
                && !ex.retryAfter().isZero()) {
            return ex.retryAfter();
        }
        int shift = Math.min(failures - 1, 16);
        return Duration.ofMillis(analysisProperties.githubBackoffBaseMs() << shift);
    }
}
