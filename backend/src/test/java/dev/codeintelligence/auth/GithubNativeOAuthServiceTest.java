package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.ExpectedCount.once;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubUserInfo;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import org.springframework.web.util.UriComponentsBuilder;

class GithubNativeOAuthServiceTest {

    private static final String TOKEN_URL = "https://github.test/login/oauth/access_token";
    private static final GithubNativeOAuthProperties PROPERTIES = new GithubNativeOAuthProperties(
            "client-id",
            "https://github.test/login/oauth/authorize",
            TOKEN_URL,
            "http://127.0.0.1:8080/api/auth/github/native/callback",
            300);

    private final GithubApiClient github = mock(GithubApiClient.class);
    private final AccountService accounts = mock(AccountService.class);
    private final RestClient.Builder builder = RestClient.builder();
    private final MockRestServiceServer server =
            MockRestServiceServer.bindTo(builder).build();
    private final GithubNativeOAuthService service =
            new GithubNativeOAuthService(PROPERTIES, github, accounts, builder.build(), Clock.systemUTC());

    @Test
    void completesPkceOnceAndKeepsTokenInsideBackend() {
        GithubNativeOAuthService.StartResult start = service.start(17L);
        String state = UriComponentsBuilder.fromUriString(start.authorizationUrl())
                .build()
                .getQueryParams()
                .getFirst("state");
        assertThat(UriComponentsBuilder.fromUriString(start.authorizationUrl())
                        .build()
                        .getQueryParams()
                        .getFirst("redirect_uri"))
                .isEqualTo(PROPERTIES.redirectUri());
        assertThat(start.authorizationUrl())
                .contains("code_challenge_method=S256")
                .doesNotContain("client_secret");

        server.expect(once(), requestTo(TOKEN_URL))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("Accept", MediaType.APPLICATION_JSON_VALUE))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("code_verifier=")))
                .andExpect(content().formDataContains(java.util.Map.of("redirect_uri", PROPERTIES.redirectUri())))
                .andRespond(withSuccess(
                        "{\"access_token\":\"github-token\",\"token_type\":\"bearer\"}", MediaType.APPLICATION_JSON));
        GithubUserInfo profile = new GithubUserInfo(42L, "octocat", "Octo Cat", null, "read:user");
        when(github.getUser("github-token")).thenReturn(profile);

        assertThat(service.callback("one-time-code", state, null).status())
                .isEqualTo(GithubNativeOAuthService.Status.CONNECTED);
        verify(accounts).linkGithub(17L, profile, CredentialKind.OAUTH, "github-token");
        assertThat(service.status(17L, start.attemptId()).status())
                .isEqualTo(GithubNativeOAuthService.Status.CONNECTED);
        assertThat(service.callback("replayed", state, null).status())
                .isEqualTo(GithubNativeOAuthService.Status.INVALID);
        server.verify();
    }

    @Test
    void distinguishesCancellationAndGithubDenial() {
        GithubNativeOAuthService.StartResult cancelled = service.start(1L);
        assertThat(service.cancel(1L, cancelled.attemptId()).status())
                .isEqualTo(GithubNativeOAuthService.Status.CANCELLED);

        GithubNativeOAuthService.StartResult denied = service.start(1L);
        String state = UriComponentsBuilder.fromUriString(denied.authorizationUrl())
                .build()
                .getQueryParams()
                .getFirst("state");
        assertThat(service.callback(null, state, "access_denied").status())
                .isEqualTo(GithubNativeOAuthService.Status.DENIED);
    }

    @Test
    void expiresAttemptsBeforeAcceptingCallbacks() {
        Instant now = Instant.parse("2026-09-28T00:00:00Z");
        MutableClock clock = new MutableClock(now);
        GithubNativeOAuthService expiring = new GithubNativeOAuthService(
                new GithubNativeOAuthProperties(
                        "client-id",
                        "https://github.test/login/oauth/authorize",
                        TOKEN_URL,
                        "http://127.0.0.1:8080/api/auth/github/native/callback",
                        30),
                github,
                accounts,
                RestClient.create(),
                clock);
        GithubNativeOAuthService.StartResult start = expiring.start(1L);
        clock.advance(Duration.ofSeconds(31));

        assertThat(expiring.status(1L, start.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.EXPIRED);
    }

    private static final class MutableClock extends Clock {
        private Instant now;

        private MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration duration) {
            now = now.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
