package dev.codeintelligence.github;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * Thin GitHub REST wrapper. Tokens are passed per call (decrypted at call time by the caller)
 * and never logged; only rate limit headers are surfaced at debug level.
 */
@Component
public class GithubApiClient {

    private static final Logger log = LoggerFactory.getLogger(GithubApiClient.class);
    private static final String SCOPES_HEADER = "X-OAuth-Scopes";

    private final RestClient restClient;

    public GithubApiClient(RestClient.Builder restClientBuilder, GithubProperties properties) {
        this.restClient = restClientBuilder
                .baseUrl(properties.baseUrl())
                .defaultHeader(HttpHeaders.ACCEPT, "application/vnd.github+json")
                .defaultHeader("X-GitHub-Api-Version", "2022-11-28")
                .build();
    }

    public GithubUserInfo getUser(String token) {
        ResponseEntity<UserResponse> response = restClient
                .get()
                .uri("/user")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .retrieve()
                .onStatus(this::isTokenRejection, (request, res) -> {
                    throw new InvalidGithubTokenException();
                })
                .toEntity(UserResponse.class);
        consumeRateLimit(response.getHeaders());
        UserResponse user = response.getBody();
        return new GithubUserInfo(
                user.id(),
                user.login(),
                user.name(),
                user.avatarUrl(),
                response.getHeaders().getFirst(SCOPES_HEADER));
    }

    public GithubRepoPage listUserRepos(String token, int page, int perPage) {
        ResponseEntity<List<RepoResponse>> response = restClient
                .get()
                .uri(uriBuilder -> uriBuilder
                        .path("/user/repos")
                        .queryParam("visibility", "all")
                        .queryParam("sort", "updated")
                        .queryParam("per_page", perPage)
                        .queryParam("page", page)
                        .build())
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .retrieve()
                .onStatus(this::isTokenRejection, (request, res) -> {
                    throw new InvalidGithubTokenException();
                })
                .toEntity(new ParameterizedTypeReference<>() {});
        consumeRateLimit(response.getHeaders());
        List<GithubRepoSummary> items = response.getBody().stream()
                .map(repo -> new GithubRepoSummary(
                        repo.owner() == null ? null : repo.owner().login(),
                        repo.name(),
                        repo.fullName(),
                        repo.isPrivate(),
                        repo.defaultBranch(),
                        repo.description(),
                        repo.updatedAt()))
                .toList();
        return new GithubRepoPage(items, hasNextPage(response.getHeaders()));
    }

    private boolean isTokenRejection(HttpStatusCode status) {
        return status.value() == 401 || status.value() == 403;
    }

    private boolean hasNextPage(HttpHeaders headers) {
        String link = headers.getFirst(HttpHeaders.LINK);
        return link != null && link.contains("rel=\"next\"");
    }

    private void consumeRateLimit(HttpHeaders headers) {
        String remaining = headers.getFirst("x-ratelimit-remaining");
        String reset = headers.getFirst("x-ratelimit-reset");
        if (remaining != null && log.isDebugEnabled()) {
            log.debug("GitHub rate limit remaining={} reset={}", remaining, reset);
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record UserResponse(
            long id,
            String login,
            String name,
            @JsonProperty("avatar_url") String avatarUrl) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record RepoResponse(
            String name,
            @JsonProperty("full_name") String fullName,
            @JsonProperty("private") boolean isPrivate,
            @JsonProperty("default_branch") String defaultBranch,
            String description,
            @JsonProperty("updated_at") String updatedAt,
            RepoOwner owner) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record RepoOwner(String login) {}
}
