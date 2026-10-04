package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withServerError;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubUserInfo;
import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.test.web.client.ResponseActions;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

class GithubNativeOAuthServiceTest {

    private static final String DEVICE_URL = "https://github.test/login/device/code";
    private static final String TOKEN_URL = "https://github.test/login/oauth/access_token";
    private static final String DEVICE_CODE = "backend-only-device-code";
    private static final String TOKEN = "backend-only-github-token";
    private static final String DEVICE_JSON = """
            {"device_code":"backend-only-device-code","user_code":"ABCD-EFGH",
             "verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}
            """;
    private static final String TOKEN_JSON = """
            {"access_token":"backend-only-github-token","token_type":"bearer"}
            """;
    private static final GithubNativeOAuthProperties PROPERTIES =
            new GithubNativeOAuthProperties("client-id", DEVICE_URL, TOKEN_URL, "read:user user:email repo", 300);
    private static final GithubUserInfo PROFILE =
            new GithubUserInfo(42L, "octocat", "Octo Cat", null, "read:user,repo");

    private final GithubApiClient github = mock(GithubApiClient.class);
    private final AccountService accounts = mock(AccountService.class);
    private final RestClient.Builder builder = RestClient.builder();
    private final MockRestServiceServer server =
            MockRestServiceServer.bindTo(builder).build();
    private final MutableClock clock = new MutableClock(Instant.parse("2026-10-04T00:00:00Z"));
    private final GithubNativeOAuthService service =
            new GithubNativeOAuthService(PROPERTIES, github, accounts, builder.build(), clock);

    @Test
    void completesDeviceAuthorizationOnceWithoutExposingProviderCredentials() throws Exception {
        expectDevice(DEVICE_JSON);
        expectToken().andRespond(withSuccess(TOKEN_JSON, MediaType.APPLICATION_JSON));
        when(github.getUser(TOKEN)).thenReturn(PROFILE);

        var start = service.start(17L);
        assertThat(start.userCode()).isEqualTo("ABCD-EFGH");
        assertThat(start.verificationUri()).isEqualTo("https://github.com/login/device");
        assertThat(service.poll(17L, start.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.WAITING);
        clock.advance(Duration.ofSeconds(5));
        var connected = service.poll(17L, start.attemptId());
        assertThat(connected.status()).isEqualTo(GithubNativeOAuthService.Status.CONNECTED);
        assertThat(service.poll(17L, start.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.CONNECTED);
        verify(accounts, times(1)).linkGithub(17L, PROFILE, CredentialKind.OAUTH, TOKEN);
        JsonMapper mapper = JsonMapper.builder().build();
        assertThat(mapper.writeValueAsString(start)).doesNotContain(DEVICE_CODE, TOKEN, "client_secret");
        assertThat(mapper.writeValueAsString(connected)).doesNotContain(DEVICE_CODE, TOKEN, "client_secret");
        server.verify();
    }

    @Test
    void enforcesProviderIntervalsAndSlowDownEvenWhenTheRendererPollsTooEarly() {
        expectDevice(DEVICE_JSON);
        expectToken().andRespond(withSuccess("{\"error\":\"authorization_pending\"}", MediaType.APPLICATION_JSON));
        expectToken().andRespond(withSuccess("{\"error\":\"slow_down\"}", MediaType.APPLICATION_JSON));
        expectToken().andRespond(withSuccess("{\"error\":\"slow_down\",\"interval\":30}", MediaType.APPLICATION_JSON));
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(4));
        assertThat(service.poll(1L, start.attemptId()).pollAfterSeconds()).isEqualTo(1);
        clock.advance(Duration.ofSeconds(1));
        assertThat(service.poll(1L, start.attemptId()).pollAfterSeconds()).isEqualTo(5);
        clock.advance(Duration.ofSeconds(5));
        assertThat(service.poll(1L, start.attemptId()).pollAfterSeconds()).isEqualTo(10);
        clock.advance(Duration.ofSeconds(9));
        assertThat(service.poll(1L, start.attemptId()).pollAfterSeconds()).isEqualTo(1);
        clock.advance(Duration.ofSeconds(1));
        assertThat(service.poll(1L, start.attemptId()).pollAfterSeconds()).isEqualTo(30);
        clock.advance(Duration.ofSeconds(29));
        assertThat(service.poll(1L, start.attemptId()).pollAfterSeconds()).isEqualTo(1);
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void cancelledAndExpiredAttemptsNeverExchangeTheirDeviceCodes() {
        expectDevice(DEVICE_JSON);
        expectDevice(DEVICE_JSON);
        var cancelled = service.start(1L);
        var expired = service.start(1L);
        assertThat(service.cancel(1L, cancelled.attemptId()).status())
                .isEqualTo(GithubNativeOAuthService.Status.CANCELLED);
        clock.advance(Duration.ofSeconds(300));
        assertThat(service.poll(1L, cancelled.attemptId()).status())
                .isEqualTo(GithubNativeOAuthService.Status.CANCELLED);
        assertThat(service.poll(1L, expired.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.EXPIRED);
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void anInFlightTokenResponseCannotLinkAnAccountAfterCancellation() throws Exception {
        expectDevice(DEVICE_JSON);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        expectToken().andRespond(request -> {
            entered.countDown();
            awaitRelease(release);
            return withSuccess(TOKEN_JSON, MediaType.APPLICATION_JSON).createResponse(request);
        });
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
            var pending = threads.submit(() -> service.poll(1L, start.attemptId()));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                var cancelled = threads.submit(() -> service.cancel(1L, start.attemptId()));
                assertThat(cancelled.get(5, TimeUnit.SECONDS).status())
                        .isEqualTo(GithubNativeOAuthService.Status.CANCELLED);
                release.countDown();
                assertThat(pending.get(5, TimeUnit.SECONDS).status())
                        .isEqualTo(GithubNativeOAuthService.Status.CANCELLED);
            } finally {
                release.countDown();
            }
        }
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void cancellationDuringProfileLookupPreventsLateCredentialPublication() throws Exception {
        expectDevice(DEVICE_JSON);
        expectToken().andRespond(withSuccess(TOKEN_JSON, MediaType.APPLICATION_JSON));
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        when(github.getUser(TOKEN)).thenAnswer(invocation -> {
            entered.countDown();
            awaitRelease(release);
            return PROFILE;
        });
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
            var pending = threads.submit(() -> service.poll(1L, start.attemptId()));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                var cancelled = threads.submit(() -> service.cancel(1L, start.attemptId()));
                assertThat(cancelled.get(5, TimeUnit.SECONDS).status())
                        .isEqualTo(GithubNativeOAuthService.Status.CANCELLED);
                release.countDown();
                assertThat(pending.get(5, TimeUnit.SECONDS).status())
                        .isEqualTo(GithubNativeOAuthService.Status.CANCELLED);
            } finally {
                release.countDown();
            }
        }
        verifyNoInteractions(accounts);
        server.verify();
    }

    @Test
    void disconnectDuringProfileLookupPreventsLateCredentialPublication() throws Exception {
        expectDevice(DEVICE_JSON);
        expectToken().andRespond(withSuccess(TOKEN_JSON, MediaType.APPLICATION_JSON));
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        when(github.getUser(TOKEN)).thenAnswer(invocation -> {
            entered.countDown();
            awaitRelease(release);
            return PROFILE;
        });
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
            var pending = threads.submit(() -> service.poll(1L, start.attemptId()));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                threads.submit(() -> service.disconnect(1L)).get(5, TimeUnit.SECONDS);
                release.countDown();
                assertThat(pending.get(5, TimeUnit.SECONDS).status())
                        .isEqualTo(GithubNativeOAuthService.Status.CANCELLED);
            } finally {
                release.countDown();
            }
        }
        verify(accounts).disconnectGithub(1L);
        org.mockito.Mockito.verifyNoMoreInteractions(accounts);
        server.verify();
    }

    @Test
    void disconnectInvalidatesADeviceRequestThatHasNotReturnedYet() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        server.expect(requestTo(DEVICE_URL)).andRespond(request -> {
            entered.countDown();
            awaitRelease(release);
            return withSuccess(DEVICE_JSON, MediaType.APPLICATION_JSON).createResponse(request);
        });
        try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
            var pending = threads.submit(() -> service.start(1L));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                threads.submit(() -> service.disconnect(1L)).get(5, TimeUnit.SECONDS);
                release.countDown();
                assertThatThrownBy(() -> pending.get(5, TimeUnit.SECONDS))
                        .hasCauseInstanceOf(GithubNativeOAuthUnavailableException.class);
            } finally {
                release.countDown();
            }
        }
        verify(accounts).disconnectGithub(1L);
        org.mockito.Mockito.verifyNoMoreInteractions(accounts);
        server.verify();
    }

    @Test
    void aNewLoginSupersedesOnlyTheSameUsersPreviousAttempt() {
        expectDevice(DEVICE_JSON);
        expectDevice(DEVICE_JSON);
        expectDevice(DEVICE_JSON);
        var old = service.start(1L);
        var otherUser = service.start(2L);
        var current = service.start(1L);
        assertThat(service.poll(1L, old.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.CANCELLED);
        assertThat(service.poll(2L, otherUser.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.WAITING);
        assertThat(service.poll(1L, current.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.WAITING);
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void concurrentPollsCannotExchangeTheSameDeviceCodeTwice() throws Exception {
        expectDevice(DEVICE_JSON);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        expectToken().andRespond(request -> {
            entered.countDown();
            awaitRelease(release);
            return withSuccess("{\"error\":\"authorization_pending\"}", MediaType.APPLICATION_JSON)
                    .createResponse(request);
        });
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
            var pending = threads.submit(() -> service.poll(1L, start.attemptId()));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                var concurrent = threads.submit(() -> service.poll(1L, start.attemptId()));
                assertThat(concurrent.get(5, TimeUnit.SECONDS).status())
                        .isEqualTo(GithubNativeOAuthService.Status.WAITING);
                release.countDown();
                assertThat(pending.get(5, TimeUnit.SECONDS).pollAfterSeconds()).isEqualTo(5);
            } finally {
                release.countDown();
            }
        }
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void providerSuccessAfterTheDeadlineCannotPublishCredentials() throws Exception {
        expectDevice(DEVICE_JSON);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        expectToken().andRespond(request -> {
            entered.countDown();
            awaitRelease(release);
            return withSuccess(TOKEN_JSON, MediaType.APPLICATION_JSON).createResponse(request);
        });
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
            var pending = threads.submit(() -> service.poll(1L, start.attemptId()));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                clock.advance(Duration.ofSeconds(295));
                release.countDown();
                assertThat(pending.get(5, TimeUnit.SECONDS).status())
                        .isEqualTo(GithubNativeOAuthService.Status.EXPIRED);
            } finally {
                release.countDown();
            }
        }
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @ParameterizedTest
    @CsvSource({"access_denied,DENIED", "expired_token,EXPIRED", "device_flow_disabled,FAILED"})
    void providerTerminalErrorsStayTerminalAndPrivate(String error, GithubNativeOAuthService.Status expected) {
        expectDevice(DEVICE_JSON);
        expectToken()
                .andRespond(withSuccess(
                        "{\"error\":\"" + error + "\",\"error_description\":\"private-provider-data\"}",
                        MediaType.APPLICATION_JSON));
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        var result = service.poll(1L, start.attemptId());
        assertThat(result.status()).isEqualTo(expected);
        assertThat(result.message()).doesNotContain("private-provider-data");
        clock.advance(Duration.ofSeconds(30));
        assertThat(service.poll(1L, start.attemptId()).status()).isEqualTo(expected);
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void failedProviderRequestsDoNotExposeTheResponseBody() {
        expectDevice(DEVICE_JSON);
        expectToken().andRespond(withServerError().body("private-provider-data"));
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        var result = service.poll(1L, start.attemptId());
        assertThat(result.status()).isEqualTo(GithubNativeOAuthService.Status.FAILED);
        assertThat(result.message()).doesNotContain("private-provider-data");
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void anotherUserCannotPollOrCancelAnAttempt() {
        expectDevice(DEVICE_JSON);
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        assertThatThrownBy(() -> service.poll(2L, start.attemptId()))
                .isInstanceOf(GithubOAuthAttemptNotFoundException.class);
        assertThatThrownBy(() -> service.cancel(2L, start.attemptId()))
                .isInstanceOf(GithubOAuthAttemptNotFoundException.class);
        assertThat(service.cancel(1L, start.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.CANCELLED);
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void rejectsADeviceResponseThatWouldOpenAnUntrustedVerificationPage() {
        expectDevice(
                DEVICE_JSON.replace("https://github.com/login/device", "https://github.com.evil.test/login/device"));
        assertThatThrownBy(() -> service.start(1L)).isInstanceOf(GithubNativeOAuthUnavailableException.class);
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void malformedTokenSuccessCannotReachAccountLinking() {
        expectDevice(DEVICE_JSON);
        expectToken()
                .andRespond(withSuccess(
                        "{\"access_token\":\"backend-only-github-token\",\"token_type\":\"unsupported\"}",
                        MediaType.APPLICATION_JSON));
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        assertThat(service.poll(1L, start.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.FAILED);
        verifyNoInteractions(github, accounts);
        server.verify();
    }

    @Test
    void anAccountConflictCannotBeRetriedByReplayingTheAttempt() {
        expectDevice(DEVICE_JSON);
        expectToken().andRespond(withSuccess(TOKEN_JSON, MediaType.APPLICATION_JSON));
        when(github.getUser(TOKEN)).thenReturn(PROFILE);
        doThrow(new GithubAccountConflictException())
                .when(accounts)
                .linkGithub(1L, PROFILE, CredentialKind.OAUTH, TOKEN);
        var start = service.start(1L);
        clock.advance(Duration.ofSeconds(5));
        assertThat(service.poll(1L, start.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.CONFLICT);
        assertThat(service.poll(1L, start.attemptId()).status()).isEqualTo(GithubNativeOAuthService.Status.CONFLICT);
        verify(accounts, times(1)).linkGithub(1L, PROFILE, CredentialKind.OAUTH, TOKEN);
        server.verify();
    }

    private void expectDevice(String body) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("client_id", PROPERTIES.clientId());
        form.add("scope", PROPERTIES.scope());
        server.expect(requestTo(DEVICE_URL))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("Accept", MediaType.APPLICATION_JSON_VALUE))
                .andExpect(content().formData(form))
                .andRespond(withSuccess(body, MediaType.APPLICATION_JSON));
    }

    private ResponseActions expectToken() {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("client_id", PROPERTIES.clientId());
        form.add("device_code", DEVICE_CODE);
        form.add("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
        return server.expect(requestTo(TOKEN_URL))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("Accept", MediaType.APPLICATION_JSON_VALUE))
                .andExpect(content().formData(form));
    }

    private static void awaitRelease(CountDownLatch release) throws IOException {
        try {
            if (!release.await(5, TimeUnit.SECONDS)) throw new IOException("Provider response was not released");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException(interrupted);
        }
    }

    private static final class MutableClock extends Clock {
        private volatile Instant now;

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
