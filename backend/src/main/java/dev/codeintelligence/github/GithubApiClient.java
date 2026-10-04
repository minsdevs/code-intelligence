package dev.codeintelligence.github;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

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
                .onStatus(status -> status.value() == 401, (request, res) -> {
                    throw new InvalidGithubTokenException();
                })
                .onStatus(status -> status.value() == 403 || status.value() == 429, (request, res) -> {
                    if (isRateLimited(res.getStatusCode().value(), res.getHeaders())) {
                        throw new GithubRateLimitException(parseRetryAfter(res.getHeaders()));
                    }
                    throw new GithubRepositoryAccessException();
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
                .onStatus(status -> status.value() == 401, (request, res) -> {
                    throw new InvalidGithubTokenException();
                })
                .onStatus(status -> status.value() == 403 || status.value() == 429, (request, res) -> {
                    if (isRateLimited(res.getStatusCode().value(), res.getHeaders())) {
                        throw new GithubRateLimitException(parseRetryAfter(res.getHeaders()));
                    }
                    throw new GithubRepositoryAccessException();
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

    public InstallationPage listUserInstallations(String token, int page, int perPage) {
        ResponseEntity<InstallationsResponse> response =
                installationRequest(token, "/user/installations", page, perPage).toEntity(InstallationsResponse.class);
        consumeRateLimit(response.getHeaders());
        List<InstallationResponse> body =
                response.getBody() == null || response.getBody().installations() == null
                        ? List.of()
                        : response.getBody().installations();
        return new InstallationPage(
                body.stream()
                        .map(item -> new InstallationSummary(
                                item.id(),
                                item.account() == null ? null : item.account().login(),
                                item.appSlug(),
                                item.repositorySelection(),
                                item.suspendedAt() != null))
                        .toList(),
                hasNextPage(response.getHeaders()));
    }

    public GithubRepoPage listInstallationRepos(String token, long installationId, int page, int perPage) {
        if (installationId <= 0) throw new IllegalArgumentException("Installation ID must be positive");
        ResponseEntity<InstallationReposResponse> response = installationRequest(
                        token, "/user/installations/" + installationId + "/repositories", page, perPage)
                .toEntity(InstallationReposResponse.class);
        consumeRateLimit(response.getHeaders());
        List<RepoResponse> body =
                response.getBody() == null || response.getBody().repositories() == null
                        ? List.of()
                        : response.getBody().repositories();
        return new GithubRepoPage(
                body.stream()
                        .map(repo -> new GithubRepoSummary(
                                repo.owner() == null ? null : repo.owner().login(),
                                repo.name(),
                                repo.fullName(),
                                repo.isPrivate(),
                                repo.defaultBranch(),
                                repo.description(),
                                repo.updatedAt()))
                        .toList(),
                hasNextPage(response.getHeaders()));
    }

    private RestClient.ResponseSpec installationRequest(String token, String endpoint, int page, int perPage) {
        // Fixed endpoints only: never follow upstream Link/repositories_url into another origin.
        return restClient
                .get()
                .uri(uri -> uri.path(endpoint)
                        .queryParam("per_page", Math.clamp(perPage, 1, 100))
                        .queryParam("page", Math.max(1, page))
                        .build())
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .retrieve()
                .onStatus(status -> status.value() == 401, (request, res) -> {
                    throw new InvalidGithubTokenException();
                })
                .onStatus(
                        status -> status.value() == 403 || status.value() == 404 || status.value() == 429,
                        (request, res) -> {
                            if (res.getStatusCode().value() == 429
                                    || isRateLimited(res.getStatusCode().value(), res.getHeaders())) {
                                throw new GithubRateLimitException(parseRetryAfter(res.getHeaders()));
                            }
                            throw new GithubRepositoryAccessException();
                        });
    }

    public record InstallationSummary(
            long id, String accountLogin, String appSlug, String repositorySelection, boolean suspended) {}

    public record InstallationPage(List<InstallationSummary> items, boolean hasNext) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record InstallationsResponse(List<InstallationResponse> installations) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record InstallationResponse(
            long id,
            RepoOwner account,
            @JsonProperty("app_slug") String appSlug,
            @JsonProperty("repository_selection") String repositorySelection,
            @JsonProperty("suspended_at") String suspendedAt) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record InstallationReposResponse(List<RepoResponse> repositories) {}

    public GithubBranchPage listRepoBranches(String token, String owner, String repo, int page, int perPage) {
        ResponseEntity<List<BranchResponse>> response = restClient
                .get()
                .uri(uriBuilder -> uriBuilder
                        .path("/repos/{owner}/{repo}/branches")
                        .queryParam("per_page", perPage)
                        .queryParam("page", page)
                        .build(owner, repo))
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .retrieve()
                .onStatus(status -> status.value() == 401, (request, res) -> {
                    throw new InvalidGithubTokenException();
                })
                .onStatus(status -> status.value() == 403 || status.value() == 429, (request, res) -> {
                    if (isRateLimited(res.getStatusCode().value(), res.getHeaders())) {
                        throw new GithubRateLimitException(parseRetryAfter(res.getHeaders()));
                    }
                    throw new GithubRepositoryAccessException();
                })
                .toEntity(new ParameterizedTypeReference<>() {});
        consumeRateLimit(response.getHeaders());
        List<BranchResponse> body = response.getBody() == null ? List.of() : response.getBody();
        List<GithubBranchSummary> items = body.stream()
                .map(branch -> new GithubBranchSummary(
                        branch.name(),
                        branch.commit() == null ? null : branch.commit().sha(),
                        branch.isProtected()))
                .toList();
        return new GithubBranchPage(items, hasNextPage(response.getHeaders()));
    }

    public GithubPullsPage listRepoPulls(String token, String owner, String repo, int page, int perPage, String etag) {
        RestClient.RequestHeadersSpec<?> spec = restClient
                .get()
                .uri(uriBuilder -> uriBuilder
                        .path("/repos/{owner}/{repo}/pulls")
                        .queryParam("state", "all")
                        .queryParam("per_page", perPage)
                        .queryParam("page", page)
                        .build(owner, repo))
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token);
        if (StringUtils.hasText(etag)) {
            spec = spec.header(HttpHeaders.IF_NONE_MATCH, etag);
        }
        try {
            ResponseEntity<List<PullResponse>> response = spec.retrieve()
                    .onStatus(status -> status.value() == 304, (request, res) -> {
                        throw new NotModified(etagOf(res));
                    })
                    .onStatus(status -> status.value() == 403 || status.value() == 429, (request, res) -> {
                        HttpHeaders headers = res.getHeaders();
                        if (isRateLimited(res.getStatusCode().value(), headers)) {
                            throw new GithubRateLimitException(parseRetryAfter(headers));
                        }
                        throw new RestClientException("GitHub pulls request failed");
                    })
                    .toEntity(new ParameterizedTypeReference<>() {});
            consumeRateLimit(response.getHeaders());
            List<PullResponse> body = response.getBody() == null ? List.of() : response.getBody();
            List<GithubPullSummary> items = body.stream()
                    .map(pull -> new GithubPullSummary(
                            pull.number(),
                            pull.title(),
                            pull.body(),
                            pull.state(),
                            pull.user() == null ? null : pull.user().login(),
                            pull.mergedAt(),
                            pull.head() == null ? null : pull.head().sha(),
                            pull.base() == null ? null : pull.base().sha()))
                    .toList();
            return new GithubPullsPage(false, items, hasNextPage(response.getHeaders()), etagOf(response.getHeaders()));
        } catch (RuntimeException ex) {
            NotModified notModified = findCause(ex, NotModified.class);
            if (notModified != null) {
                return GithubPullsPage.notModified(notModified.etag);
            }
            GithubRateLimitException rateLimit = findCause(ex, GithubRateLimitException.class);
            if (rateLimit != null) {
                throw rateLimit;
            }
            throw ex;
        }
    }

    static boolean isRateLimited(int status, HttpHeaders headers) {
        if (status != 403 && status != 429) {
            return false;
        }
        if (StringUtils.hasText(headers.getFirst(HttpHeaders.RETRY_AFTER))) {
            return true;
        }
        return "0".equals(headers.getFirst("x-ratelimit-remaining"));
    }

    static Duration parseRetryAfter(HttpHeaders headers) {
        String retryAfter = headers.getFirst(HttpHeaders.RETRY_AFTER);
        if (!StringUtils.hasText(retryAfter)) {
            return null;
        }
        try {
            return Duration.ofSeconds(Long.parseLong(retryAfter.trim()));
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static String etagOf(ClientHttpResponse response) throws IOException {
        return etagOf(response.getHeaders());
    }

    private static String etagOf(HttpHeaders headers) {
        String etag = headers.getETag();
        return StringUtils.hasText(etag) ? etag : headers.getFirst(HttpHeaders.ETAG);
    }

    private static <T extends Throwable> T findCause(Throwable thrown, Class<T> type) {
        Throwable current = thrown;
        while (current != null) {
            if (type.isInstance(current)) {
                return type.cast(current);
            }
            current = current.getCause();
        }
        return null;
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

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record BranchResponse(
            String name,
            BranchCommit commit,
            @JsonProperty("protected") boolean isProtected) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record BranchCommit(String sha) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record PullResponse(
            int number,
            String title,
            String body,
            String state,
            PullUser user,
            @JsonProperty("merged_at") Instant mergedAt,
            ShaRef head,
            ShaRef base) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record PullUser(String login) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ShaRef(String sha) {}

    private static final class NotModified extends RuntimeException {
        private final String etag;

        private NotModified(String etag) {
            this.etag = etag;
        }
    }
}
