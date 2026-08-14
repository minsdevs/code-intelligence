package dev.codeintelligence.github;

import java.util.List;
import java.util.Locale;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

@Service
public class GithubRepoService {

    private final GithubTokenProvider tokenProvider;
    private final GithubApiClient githubApiClient;

    public GithubRepoService(GithubTokenProvider tokenProvider, GithubApiClient githubApiClient) {
        this.tokenProvider = tokenProvider;
        this.githubApiClient = githubApiClient;
    }

    /** q filters within the fetched page. */
    public GithubRepoPage listRepos(long userId, int page, int perPage, String q) {
        String token = tokenProvider.requireToken(userId);
        GithubRepoPage repoPage = githubApiClient.listUserRepos(token, page, perPage);

        if (!StringUtils.hasText(q)) {
            return repoPage;
        }
        String needle = q.toLowerCase(Locale.ROOT);
        List<GithubRepoSummary> filtered = repoPage.items().stream()
                .filter(repo -> repo.fullName() != null
                        && repo.fullName().toLowerCase(Locale.ROOT).contains(needle))
                .toList();
        return new GithubRepoPage(filtered, repoPage.hasNext());
    }
}
