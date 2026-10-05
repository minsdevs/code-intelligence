package dev.codeintelligence.github;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withException;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import dev.codeintelligence.auth.GithubConnectionCoordinator;
import dev.codeintelligence.auth.GithubCredentialStore;
import dev.codeintelligence.auth.GithubCredentialStore.StoredCredential;
import dev.codeintelligence.auth.GithubDeviceCredentialCodec;
import dev.codeintelligence.auth.GithubNativeOAuthProperties;
import dev.codeintelligence.auth.GithubReauthenticationRequiredException;
import dev.codeintelligence.auth.GithubTokenLifecycle;
import dev.codeintelligence.auth.MissingCredentialException;
import dev.codeintelligence.auth.TokenCryptoService;
import dev.codeintelligence.common.security.CredentialKind;
import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.test.web.client.ResponseCreator;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/** Real API status mapping and borrowed revision callbacks, with HTTP and persistence isolated. */
class GithubRepoCredentialLeaseTest {
    private static final long USER = 7L;
    private static final String TOKEN = "synthetic-repo-lease-token";
    private static final String BASE = "https://api.github.test";
    private static final String REPOS_JSON = """
            [{"owner":{"login":"octocat"},"name":"kept-repo","full_name":"octocat/kept-repo",
              "private":true,"default_branch":"main","description":"Synthetic repository"}]
            """;

    enum Endpoint {
        REPOS,
        INSTALLATIONS,
        INSTALLATION_REPOS,
        BRANCHES;

        Object call(GithubRepoService service) {
            return switch (this) {
                case REPOS -> service.listRepos(USER, 2, 30, "KEPT");
                case INSTALLATIONS -> service.listInstallations(USER, 2, 30);
                case INSTALLATION_REPOS -> service.listInstallationRepos(USER, 41L, 2, 30, "KEPT");
                case BRANCHES -> service.listBranches(USER, "octocat", "kept-repo", 2, 30);
            };
        }

        String path() {
            return switch (this) {
                case REPOS -> "/user/repos?visibility=all&sort=updated&per_page=30&page=2";
                case INSTALLATIONS -> "/user/installations?per_page=30&page=2";
                case INSTALLATION_REPOS -> "/user/installations/41/repositories?per_page=30&page=2";
                case BRANCHES -> "/repos/octocat/kept-repo/branches?per_page=30&page=2";
            };
        }

        String body() {
            return switch (this) {
                case REPOS -> REPOS_JSON;
                case INSTALLATION_REPOS -> "{\"repositories\":" + REPOS_JSON + "}";
                case INSTALLATIONS -> """
                        {"installations":[{"id":41,"account":{"login":"octocat"},
                          "app_slug":"synthetic-app","repository_selection":"selected","suspended_at":null}]}
                        """;
                case BRANCHES -> """
                        [{"name":"main","commit":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"protected":true}]
                        """;
            };
        }

        Object expected() {
            return switch (this) {
                case REPOS, INSTALLATION_REPOS ->
                    new GithubRepoPage(
                            List.of(new GithubRepoSummary(
                                    "octocat",
                                    "kept-repo",
                                    "octocat/kept-repo",
                                    true,
                                    "main",
                                    "Synthetic repository",
                                    null)),
                            true);
                case INSTALLATIONS ->
                    new GithubApiClient.InstallationPage(
                            List.of(new GithubApiClient.InstallationSummary(
                                    41L, "octocat", "synthetic-app", "selected", false)),
                            true);
                case BRANCHES ->
                    new GithubBranchPage(
                            List.of(new GithubBranchSummary("main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true)),
                            true);
            };
        }
    }

    @ParameterizedTest
    @EnumSource(Endpoint.class)
    void eachEndpointUsesOneBorrowedCredentialAndVerifiesBeforeAndAfterHttp(Endpoint endpoint) {
        Fixture f = new Fixture();
        f.respond(
                endpoint,
                withSuccess(endpoint.body(), MediaType.APPLICATION_JSON)
                        .header(HttpHeaders.LINK, "<" + BASE + "/next>; rel=\"next\""),
                () -> {});

        assertThat(endpoint.call(f.service)).isEqualTo(endpoint.expected());

        assertThat(f.events).containsExactly("borrow", "verify", "http", "verify");
        assertThat(f.row.get()).isSameAs(f.initial);
        verify(f.store, never()).compareAndSet(any(), any(), any());
        f.verifyProvider();
    }

    @ParameterizedTest
    @EnumSource(Endpoint.class)
    void aRevokedBorrowBeforeHttpCannotSendOrFallBackToRawTokenResolution(Endpoint endpoint) {
        Fixture f = new Fixture();
        f.beforeVerification = () -> f.row.set(null);

        assertThatThrownBy(() -> endpoint.call(f.service)).isInstanceOf(GithubReauthenticationRequiredException.class);

        assertThat(f.events).containsExactly("borrow", "verify");
        verify(f.store, never()).compareAndSet(any(), any(), any());
        f.verifyProvider();
    }

    @ParameterizedTest
    @EnumSource(Endpoint.class)
    void replacementDuringHttpPreventsReturningTheOldCredentialsResult(Endpoint endpoint) {
        Fixture f = new Fixture();
        StoredCredential replacement = replacement();
        f.respond(endpoint, withSuccess(endpoint.body(), MediaType.APPLICATION_JSON), () -> f.row.set(replacement));

        assertThatThrownBy(() -> endpoint.call(f.service))
                .isInstanceOf(GithubReauthenticationRequiredException.class)
                .satisfies(failure -> assertThat(((GithubReauthenticationRequiredException) failure)
                                .getBody()
                                .getProperties())
                        .containsEntry("reason", "CONNECTION_CHANGED"));

        assertThat(f.events).containsExactly("borrow", "verify", "http", "verify");
        assertThat(f.row.get()).isSameAs(replacement);
        verify(f.store, never()).compareAndSet(any(), any(), any());
        f.verifyProvider();
    }

    @ParameterizedTest
    @EnumSource(Endpoint.class)
    void anActual401RejectsOnlyTheBorrowedRevisionAndPreservesTheMachineCode(Endpoint endpoint) {
        Fixture f = new Fixture();
        f.respond(endpoint, withStatus(HttpStatus.UNAUTHORIZED).body("untrusted " + TOKEN), () -> {});

        assertThatThrownBy(() -> endpoint.call(f.service))
                .isInstanceOf(InvalidGithubTokenException.class)
                .satisfies(failure -> {
                    InvalidGithubTokenException problem = (InvalidGithubTokenException) failure;
                    assertThat(problem.getStatusCode().value()).isEqualTo(401);
                    assertThat(problem.failureCode()).isEqualTo("GITHUB_REAUTHENTICATION_REQUIRED");
                    assertThat(problem.getBody().getProperties())
                            .containsEntry("code", "GITHUB_REAUTHENTICATION_REQUIRED")
                            .containsEntry("reason", "TOKEN_REJECTED");
                    assertThat(problem.getCause()).isNull();
                })
                .hasMessageNotContaining(TOKEN);

        assertThat(f.events).containsExactly("borrow", "verify", "http", "reject", "invalidate");
        assertThat(f.row.get().expiresAt()).isEqualTo(Instant.EPOCH);
        verify(f.store).compareAndSet(eq(f.initial), any(), eq(Instant.EPOCH));
        f.verifyProvider();
    }

    @ParameterizedTest
    @EnumSource(Endpoint.class)
    void aLate401CannotInvalidateAReconnectedIdenticalTokenWithANewStoredRevision(Endpoint endpoint) {
        Fixture f = new Fixture();
        StoredCredential replacement = replacement();
        f.respond(endpoint, withStatus(HttpStatus.UNAUTHORIZED), () -> f.row.set(replacement));

        assertThatThrownBy(() -> endpoint.call(f.service)).isInstanceOf(InvalidGithubTokenException.class);

        assertThat(f.events).containsExactly("borrow", "verify", "http", "reject");
        assertThat(f.row.get()).isSameAs(replacement);
        verify(f.store, never()).compareAndSet(any(), any(), any());
        f.verifyProvider();
    }

    @ParameterizedTest
    @EnumSource(Endpoint.class)
    void permissionSsoRateLimitAndTransportFailuresNeverRejectOrReplayCredentials(Endpoint endpoint) {
        List<ResponseCreator> failures = List.of(
                withStatus(HttpStatus.FORBIDDEN).body("{\"message\":\"Bad credentials\"}"),
                withStatus(HttpStatus.FORBIDDEN)
                        .header("X-GitHub-SSO", "required")
                        .body("{\"message\":\"Organization SSO required\"}"),
                withStatus(HttpStatus.FORBIDDEN).header("x-ratelimit-remaining", "0"),
                withStatus(HttpStatus.TOO_MANY_REQUESTS).header(HttpHeaders.RETRY_AFTER, "2"),
                withStatus(HttpStatus.BAD_GATEWAY),
                withException(new IOException("Synthetic connection failure")));
        for (int index = 0; index < failures.size(); index++) {
            Fixture f = new Fixture();
            f.respond(endpoint, failures.get(index), () -> {});
            Class<? extends RuntimeException> expected = index < 2
                    ? GithubRepositoryAccessException.class
                    : index < 4 ? GithubRateLimitException.class : RestClientException.class;

            assertThatThrownBy(() -> endpoint.call(f.service))
                    .as(endpoint + " failure " + index)
                    .isInstanceOf(expected)
                    .isNotInstanceOf(InvalidGithubTokenException.class);

            assertThat(f.events).containsExactly("borrow", "verify", "http");
            assertThat(f.row.get()).isSameAs(f.initial);
            verify(f.store, never()).compareAndSet(any(), any(), any());
            f.verifyProvider();
        }
    }

    private static StoredCredential replacement() {
        // Reconnecting the same token string still changes the captured ciphertext revision.
        return new StoredCredential(11L, USER, CredentialKind.PAT, 1, new byte[12], "synthetic-replacement", null, 42L);
    }

    private static final class Fixture {
        private final List<String> events = new ArrayList<>();
        private final StoredCredential initial =
                new StoredCredential(11L, USER, CredentialKind.PAT, 1, new byte[12], "synthetic-original", null, 42L);
        private final AtomicReference<StoredCredential> row = new AtomicReference<>(initial);
        private final GithubCredentialStore store = mock(GithubCredentialStore.class);
        private final GithubTokenProvider tokens = mock(GithubTokenProvider.class);
        private final RestClient.Builder builder = RestClient.builder();
        private final MockRestServiceServer server =
                MockRestServiceServer.bindTo(builder).build();
        private final GithubApiClient api =
                new GithubApiClient(builder, new GithubProperties(BASE, "https://github.com"));
        private final GithubRepoService service = new GithubRepoService(tokens, api);
        private Runnable beforeVerification = () -> {};

        private Fixture() {
            TokenCryptoService crypto = mock(TokenCryptoService.class);
            when(crypto.decrypt(eq(1), any(byte[].class), anyString())).thenReturn(TOKEN);
            when(store.find(USER)).thenAnswer(invocation -> Optional.ofNullable(row.get()));
            when(store.compareAndSet(any(), any(), any())).thenAnswer(invocation -> {
                StoredCredential expected = invocation.getArgument(0);
                boolean changed = row.compareAndSet(
                        expected, expected.replaced(invocation.getArgument(1), invocation.getArgument(2)));
                if (changed) events.add("invalidate");
                return changed;
            });
            // The PAT has no expiry; no refresh or real cryptographic material is used.
            GithubTokenLifecycle lifecycle = new GithubTokenLifecycle(
                    store,
                    mock(GithubDeviceCredentialCodec.class),
                    crypto,
                    new GithubConnectionCoordinator(),
                    new GithubNativeOAuthProperties(
                            "synthetic-client", "https://github.test/device", "https://github.test/token", "", 300),
                    api,
                    RestClient.builder());
            when(tokens.requireCredential(USER)).thenAnswer(invocation -> {
                events.add("borrow");
                var borrowed = lifecycle.borrow(USER).orElseThrow(MissingCredentialException::new);
                return new GithubTokenProvider.BorrowedToken(
                        borrowed.value(),
                        () -> {
                            events.add("verify");
                            beforeVerification.run();
                            borrowed.verify();
                        },
                        () -> {
                            events.add("reject");
                            borrowed.reject();
                        },
                        action -> {
                            throw new AssertionError("Repository reads must not invoke a publication callback");
                        },
                        () -> {
                            throw new AssertionError("Repository reads must not probe clone failures");
                        });
            });
        }

        private void respond(Endpoint endpoint, ResponseCreator response, Runnable duringResponse) {
            server.expect(requestTo(BASE + endpoint.path()))
                    .andExpect(method(HttpMethod.GET))
                    .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer " + TOKEN))
                    .andRespond(request -> {
                        assertThat(events).containsExactly("borrow", "verify");
                        events.add("http");
                        duringResponse.run();
                        return response.createResponse(request);
                    });
        }

        private void verifyProvider() {
            verify(tokens).requireCredential(USER);
            verifyNoMoreInteractions(tokens);
            server.verify();
        }
    }
}
