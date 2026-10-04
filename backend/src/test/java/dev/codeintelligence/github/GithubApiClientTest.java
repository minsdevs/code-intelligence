package dev.codeintelligence.github;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

class GithubApiClientTest {

    private static final String BASE_URL = "https://api.github.test";

    private final RestClient.Builder builder = RestClient.builder();
    private final MockRestServiceServer server =
            MockRestServiceServer.bindTo(builder).build();
    private final GithubApiClient client =
            new GithubApiClient(builder, new GithubProperties(BASE_URL, "https://github.com"));

    @Test
    void getUserParsesProfileAndScopesHeader() {
        HttpHeaders responseHeaders = new HttpHeaders();
        responseHeaders.add("X-OAuth-Scopes", "repo, read:user");
        responseHeaders.add("x-ratelimit-remaining", "4999");
        responseHeaders.add("x-ratelimit-reset", "1755100000");
        server.expect(requestTo(BASE_URL + "/user"))
                .andExpect(method(HttpMethod.GET))
                .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer ghp_tok"))
                .andRespond(withSuccess("""
                                {"id":42,"login":"octocat","name":"Octo Cat",
                                 "avatar_url":"https://avatars.test/octocat.png","company":"ignored"}""", MediaType.APPLICATION_JSON).headers(responseHeaders));

        GithubUserInfo user = client.getUser("ghp_tok");

        assertThat(user.id()).isEqualTo(42L);
        assertThat(user.login()).isEqualTo("octocat");
        assertThat(user.name()).isEqualTo("Octo Cat");
        assertThat(user.avatarUrl()).isEqualTo("https://avatars.test/octocat.png");
        assertThat(user.scopes()).isEqualTo("repo, read:user");
        server.verify();
    }

    @Test
    void getUserWith401ThrowsInvalidToken() {
        server.expect(requestTo(BASE_URL + "/user")).andRespond(withStatus(HttpStatus.UNAUTHORIZED));

        assertThatThrownBy(() -> client.getUser("ghp_bad")).isInstanceOf(InvalidGithubTokenException.class);
    }

    @Test
    void listReposMapsItemsAndDetectsNextPageFromLinkHeader() {
        HttpHeaders responseHeaders = new HttpHeaders();
        responseHeaders.add(
                HttpHeaders.LINK, "<" + BASE_URL + "/user/repos?page=2>; rel=\"next\", <...page=5>; rel=\"last\"");
        server.expect(requestTo(BASE_URL + "/user/repos?visibility=all&sort=updated&per_page=2&page=1"))
                .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer ghp_tok"))
                .andRespond(withSuccess("""
                                [{"name":"alpha-service","full_name":"octocat/alpha-service","private":true,
                                  "default_branch":"main","description":"Private service",
                                  "updated_at":"2026-08-01T12:00:00Z","owner":{"login":"octocat"},"fork":false},
                                 {"name":"beta-app","full_name":"octocat/beta-app","private":false,
                                  "default_branch":"develop","description":null,
                                  "updated_at":"2026-07-15T09:30:00Z","owner":{"login":"octocat"}}]""", MediaType.APPLICATION_JSON).headers(responseHeaders));

        GithubRepoPage page = client.listUserRepos("ghp_tok", 1, 2);

        assertThat(page.hasNext()).isTrue();
        assertThat(page.items()).hasSize(2);
        GithubRepoSummary first = page.items().get(0);
        assertThat(first.owner()).isEqualTo("octocat");
        assertThat(first.name()).isEqualTo("alpha-service");
        assertThat(first.fullName()).isEqualTo("octocat/alpha-service");
        assertThat(first.isPrivate()).isTrue();
        assertThat(first.defaultBranch()).isEqualTo("main");
        assertThat(first.updatedAt()).isEqualTo("2026-08-01T12:00:00Z");
    }

    @Test
    void listReposWithoutLinkHeaderHasNoNextPage() {
        server.expect(requestTo(BASE_URL + "/user/repos?visibility=all&sort=updated&per_page=30&page=3"))
                .andRespond(withSuccess("[]", MediaType.APPLICATION_JSON));

        GithubRepoPage page = client.listUserRepos("ghp_tok", 3, 30);

        assertThat(page.items()).isEmpty();
        assertThat(page.hasNext()).isFalse();
    }

    @Test
    void listBranchesMapsCommitProtectionAndPagination() {
        HttpHeaders responseHeaders = new HttpHeaders();
        responseHeaders.add(HttpHeaders.LINK, "<" + BASE_URL + "/repos/octocat/demo/branches?page=2>; rel=\"next\"");
        server.expect(requestTo(BASE_URL + "/repos/octocat/demo/branches?per_page=100&page=1"))
                .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer ghp_tok"))
                .andRespond(withSuccess("""
                                [{"name":"main","commit":{"sha":"abc123"},"protected":true}]
                                """, MediaType.APPLICATION_JSON).headers(responseHeaders));

        GithubBranchPage page = client.listRepoBranches("ghp_tok", "octocat", "demo", 1, 100);

        assertThat(page.hasNext()).isTrue();
        assertThat(page.items()).containsExactly(new GithubBranchSummary("main", "abc123", true));
    }

    @Test
    void installationsArePagedAndDoNotFetchRepositoriesUntilAnInstallationIsSelected() {
        server.expect(requestTo(BASE_URL + "/user/installations?per_page=100&page=1"))
                .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer synthetic-user-token"))
                .andRespond(withSuccess("""
                    {"total_count":2,"installations":[{"id":81,"account":{"login":"team"},
                     "app_slug":"code-intelligence","repository_selection":"selected","suspended_at":null},
                     {"id":82,"account":{"login":"paused"},"suspended_at":"2026-10-01T00:00:00Z"}]}
                    """, MediaType.APPLICATION_JSON)
                        .header(HttpHeaders.LINK, "<https://untrusted.invalid/no-follow>; rel=\"next\""));
        var page = client.listUserInstallations("synthetic-user-token", -1, 999);
        assertThat(page.hasNext()).isTrue();
        assertThat(page.items()).hasSize(2);
        assertThat(page.items().get(0).accountLogin()).isEqualTo("team");
        assertThat(page.items().get(0).repositorySelection()).isEqualTo("selected");
        assertThat(page.items().get(1).suspended()).isTrue();
        server.verify();
    }

    @Test
    void selectedInstallationUsesOnlyItsFixedRepositoryEndpointAndPreservesNextPage() {
        server.expect(requestTo(BASE_URL + "/user/installations/81/repositories?per_page=30&page=2"))
                .andRespond(withSuccess("""
                    {"total_count":31,"repositories":[{"name":"private-repo","full_name":"team/private-repo",
                     "private":true,"default_branch":"main","owner":{"login":"team"}}]}
                    """, MediaType.APPLICATION_JSON)
                        .header(HttpHeaders.LINK, "<ignored>; rel=\"next\""));
        var page = client.listInstallationRepos("synthetic-user-token", 81, 2, 30);
        assertThat(page.items()).extracting(GithubRepoSummary::fullName).containsExactly("team/private-repo");
        assertThat(page.hasNext()).isTrue();
        assertThatThrownBy(() -> client.listInstallationRepos("unused", 0, 1, 30))
                .isInstanceOf(IllegalArgumentException.class);
        server.verify();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(ints = {401, 403, 404, 429})
    void installationFailuresAreTypedAndNeverFallBackToUserRepos(int status) {
        server.expect(requestTo(BASE_URL + "/user/installations?per_page=30&page=1"))
                .andRespond(withStatus(HttpStatus.valueOf(status)));
        Class<? extends Throwable> expected = status == 401
                ? InvalidGithubTokenException.class
                : status == 429 ? GithubRateLimitException.class : GithubRepositoryAccessException.class;
        assertThatThrownBy(() -> client.listUserInstallations("synthetic-user-token", 1, 30))
                .isInstanceOf(expected);
        server.verify();
        server.reset();
        server.expect(requestTo(BASE_URL + "/user/installations/81/repositories?per_page=30&page=1"))
                .andRespond(withStatus(HttpStatus.valueOf(status)));
        assertThatThrownBy(() -> client.listInstallationRepos("synthetic-user-token", 81, 1, 30))
                .isInstanceOf(expected);
        server.verify();
    }

    @Test
    void installationRateLimit403RetainsRetryAfterAndEmptyInstallationsStayEmpty() {
        server.expect(requestTo(BASE_URL + "/user/installations?per_page=30&page=1"))
                .andRespond(withStatus(HttpStatus.FORBIDDEN).header(HttpHeaders.RETRY_AFTER, "45"));
        assertThatThrownBy(() -> client.listUserInstallations("synthetic-user-token", 1, 30))
                .isInstanceOfSatisfying(
                        GithubRateLimitException.class,
                        error -> assertThat(error.retryAfter()).isEqualTo(java.time.Duration.ofSeconds(45)));
        server.verify();
        server.reset();
        server.expect(requestTo(BASE_URL + "/user/installations?per_page=30&page=2"))
                .andRespond(withSuccess("{\"total_count\":0,\"installations\":[]}", MediaType.APPLICATION_JSON));
        assertThat(client.listUserInstallations("synthetic-user-token", 2, 30).items())
                .isEmpty();
    }
}
