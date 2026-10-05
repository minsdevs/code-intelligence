package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.*;

import dev.codeintelligence.auth.GithubCredentialStore.StoredCredential;
import dev.codeintelligence.auth.GithubDeviceCredentialCodec.Envelope;
import dev.codeintelligence.auth.GithubDeviceCredentialCodec.State;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubUserInfo;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

@Timeout(10)
class GithubTokenLifecycleTest {
    private static final long USER = 7L;
    private static final String CLIENT = "fixture-client";
    private static final String TOKEN_URL = "https://github.test/login/oauth/access_token";
    private static final Instant NOW = Instant.parse("2026-10-05T00:00:00Z");
    private static final String NEW_PAIR = """
            {"access_token":"access-new","token_type":"bearer","expires_in":3600,
             "refresh_token":"refresh-new","refresh_token_expires_in":86400}
            """;
    private final TokenCryptoProperties key = new TokenCryptoProperties("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
    private final TokenCryptoService legacy = new TokenCryptoService(key);
    private final GithubDeviceCredentialCodec codec = new GithubDeviceCredentialCodec(key);
    private final GithubCredentialStore store = mock(GithubCredentialStore.class);
    private final GithubConnectionCoordinator coordinator = new GithubConnectionCoordinator();
    private final GithubApiClient github = mock(GithubApiClient.class);
    private final AtomicReference<StoredCredential> row = new AtomicReference<>();
    private final AtomicInteger writes = new AtomicInteger();
    private final RestClient.Builder builder = RestClient.builder();
    private final MockRestServiceServer server =
            MockRestServiceServer.bindTo(builder).build();
    private final GithubNativeOAuthProperties properties =
            new GithubNativeOAuthProperties(CLIENT, "https://github.test/login/device/code", TOKEN_URL, "", 300);
    private final RestClient client = builder.build();

    GithubTokenLifecycleTest() {
        when(store.find(USER)).thenAnswer(invocation -> Optional.ofNullable(row.get()));
        when(store.compareAndSet(any(), any(), any())).thenAnswer(invocation -> {
            StoredCredential expected = invocation.getArgument(0), current = row.get();
            if (!same(current, expected)) return false;
            row.set(expected.replaced(invocation.getArgument(1), invocation.getArgument(2)));
            writes.incrementAndGet();
            return true;
        });
        when(github.getUser("access-new")).thenReturn(new GithubUserInfo(42, "fixture", null, null, ""));
    }

    private GithubTokenLifecycle lifecycle() {
        return new GithubTokenLifecycle(
                store, codec, legacy, coordinator, properties, github, client, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private void device(String token, Instant expiry) {
        var material = Envelope.active(CLIENT, 42, token, expiry, "refresh-old", NOW.plusSeconds(20000));
        var encrypted = codec.encrypt(USER, material);
        row.set(new StoredCredential(
                11,
                USER,
                CredentialKind.OAUTH,
                2,
                encrypted.nonce(),
                encrypted.ciphertext(),
                material.accessExpiresAt(),
                42L));
    }

    private Envelope decoded() {
        var value = row.get();
        return codec.decrypt(USER, value.kind(), value.keyVersion(), value.nonce(), value.ciphertext());
    }

    private static boolean same(StoredCredential a, StoredCredential b) {
        return a != null
                && a.id() == b.id()
                && a.userId() == b.userId()
                && a.keyVersion() == b.keyVersion()
                && a.ciphertext().equals(b.ciphertext())
                && Arrays.equals(a.nonce(), b.nonce())
                && java.util.Objects.equals(a.expiresAt(), b.expiresAt());
    }

    @Test
    void refreshClaimsBeforeProviderAndPublishesOneRotatedPairWithoutASecret() {
        device("access-old", NOW.minusSeconds(1));
        server.expect(requestTo(TOKEN_URL))
                .andExpect(method(HttpMethod.POST))
                .andExpect(
                        content().string("client_id=fixture-client&grant_type=refresh_token&refresh_token=refresh-old"))
                .andRespond(request -> {
                    assertThat(decoded().state()).isEqualTo(State.REFRESH_PENDING);
                    assertThat(decoded().accessToken()).isNull();
                    assertThat(decoded().refreshToken()).isNull();
                    return withSuccess(NEW_PAIR, MediaType.APPLICATION_JSON).createResponse(request);
                });
        var lifecycle = lifecycle();
        assertThat(lifecycle.findToken(USER)).contains("access-new");
        assertThat(lifecycle.findToken(USER)).contains("access-new");
        assertThat(decoded().state()).isEqualTo(State.ACTIVE);
        assertThat(decoded().refreshToken()).isEqualTo("refresh-new");
        assertThat(row.get().expiresAt()).isEqualTo(NOW.plusSeconds(3600));
        assertThat(writes).hasValue(2);
        server.verify();
    }

    @Test
    void concurrentCallersShareOneProviderRequestAndTheCommittedClaim() throws Exception {
        device("access-old", NOW.minusSeconds(1));
        var issued = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var joinedPending = new CountDownLatch(1);
        var secondCaller = new AtomicReference<Thread>();
        var providerClaim = new AtomicReference<StoredCredential>();
        var joinedClaim = new AtomicReference<StoredCredential>();
        var exchanges = new AtomicInteger();
        doAnswer(invocation -> {
                    StoredCredential current = row.get();
                    if (Thread.currentThread() == secondCaller.get() && joinedPending.getCount() != 0) {
                        // This read and flight selection share the publication monitor. The provider
                        // cannot commit a completed token before this caller selects the pending flight.
                        assertThat(Thread.holdsLock(coordinator.connection(USER)))
                                .isTrue();
                        assertThat(release.getCount()).isEqualTo(1L);
                        assertThat(writes).hasValue(1);
                        assertThat(current).isNotNull().isSameAs(providerClaim.get());
                        Envelope pending = codec.decrypt(
                                USER, current.kind(), current.keyVersion(), current.nonce(), current.ciphertext());
                        assertThat(pending.state()).isEqualTo(State.REFRESH_PENDING);
                        assertThat(pending.accessToken()).isNull();
                        assertThat(pending.refreshToken()).isNull();
                        joinedClaim.set(current);
                        joinedPending.countDown();
                    }
                    return Optional.ofNullable(current);
                })
                .when(store)
                .find(USER);
        server.expect(requestTo(TOKEN_URL))
                .andExpect(method(HttpMethod.POST))
                .andExpect(
                        content().string("client_id=fixture-client&grant_type=refresh_token&refresh_token=refresh-old"))
                .andRespond(request -> {
                    assertThat(exchanges.incrementAndGet()).isEqualTo(1);
                    assertThat(writes).hasValue(1);
                    assertThat(decoded().state()).isEqualTo(State.REFRESH_PENDING);
                    providerClaim.set(row.get());
                    issued.countDown();
                    try {
                        if (!release.await(3, TimeUnit.SECONDS))
                            throw new AssertionError(
                                    "Provider response was not released after the second caller joined");
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new AssertionError(interrupted);
                    }
                    assertThat(joinedPending.getCount()).isZero();
                    return withSuccess(NEW_PAIR, MediaType.APPLICATION_JSON).createResponse(request);
                });
        var lifecycle = lifecycle();
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> lifecycle.findToken(USER));
            Future<Optional<String>> second = null;
            try {
                assertThat(issued.await(3, TimeUnit.SECONDS)).isTrue();
                second = pool.submit(() -> {
                    secondCaller.set(Thread.currentThread());
                    return lifecycle.findToken(USER);
                });
                assertThat(joinedPending.await(3, TimeUnit.SECONDS)).isTrue();
                assertThat(joinedClaim.get()).isNotNull().isSameAs(providerClaim.get());
                assertThat(row.get()).isSameAs(joinedClaim.get());
                assertThat(writes).hasValue(1);
                assertThat(exchanges).hasValue(1);
                assertThat(first.isDone()).isFalse();
                assertThat(second.isDone()).isFalse();
                verifyNoInteractions(github);
                release.countDown();
                Optional<String> firstResult = first.get(3, TimeUnit.SECONDS);
                Optional<String> secondResult = second.get(3, TimeUnit.SECONDS);
                assertThat(firstResult).contains("access-new");
                assertThat(secondResult).contains("access-new").isEqualTo(firstResult);
            } finally {
                release.countDown();
                first.cancel(true);
                if (second != null) second.cancel(true);
            }
        }
        assertThat(exchanges).hasValue(1);
        assertThat(writes).hasValue(2);
        assertThat(decoded().state()).isEqualTo(State.ACTIVE);
        assertThat(decoded().accessToken()).isEqualTo("access-new");
        assertThat(decoded().refreshToken()).isEqualTo("refresh-new");
        assertThat(row.get().expiresAt()).isEqualTo(NOW.plusSeconds(3600));
        verify(github).getUser("access-new");
        verifyNoMoreInteractions(github);
        server.verify();
    }

    @Test
    void lostProviderResponseLeavesNoReplayableRefreshTokenEvenInANewServiceInstance() {
        device("access-old", NOW.minusSeconds(1));
        server.expect(requestTo(TOKEN_URL))
                .andRespond(withStatus(HttpStatus.BAD_GATEWAY).body("private-refresh-old"));
        assertThatThrownBy(() -> lifecycle().findToken(USER))
                .isInstanceOf(GithubReauthenticationRequiredException.class)
                .hasMessageNotContaining("private-refresh-old");
        assertThat(decoded().state()).isEqualTo(State.REFRESH_PENDING);
        assertThat(decoded().refreshToken()).isNull();
        assertThatThrownBy(() -> lifecycle().findToken(USER))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThat(writes).hasValue(1);
        server.verify();
    }

    @Test
    void uncertainClaimCommitSendsNothingAndDoesNotReplayAfterRestart() {
        device("access-old", NOW.minusSeconds(1));
        doAnswer(invocation -> {
                    StoredCredential expected = invocation.getArgument(0);
                    row.set(expected.replaced(invocation.getArgument(1), invocation.getArgument(2)));
                    throw new IllegalStateException("private commit response lost");
                })
                .when(store)
                .compareAndSet(any(), any(), any());
        assertThatThrownBy(() -> lifecycle().findToken(USER))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThat(decoded().state()).isEqualTo(State.REFRESH_PENDING);
        assertThatThrownBy(() -> lifecycle().findToken(USER))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        verifyNoInteractions(github);
        server.verify();
    }

    @Test
    void disconnectWhileRefreshIsInFlightCannotRecreateTheDeletedCredential() {
        device("access-old", NOW.minusSeconds(1));
        server.expect(requestTo(TOKEN_URL)).andRespond(request -> {
            var connection = coordinator.connection(USER);
            synchronized (connection) {
                connection.value++;
                row.set(null);
            }
            return withSuccess(NEW_PAIR, MediaType.APPLICATION_JSON).createResponse(request);
        });
        assertThatThrownBy(() -> lifecycle().findToken(USER))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThat(row).hasValue(null);
        assertThat(writes).hasValue(1);
        server.verify();
    }

    @Test
    void aNewLoginWinsAgainstLateRefreshAndLate401() {
        device("access-old", NOW.minusSeconds(1));
        server.expect(requestTo(TOKEN_URL)).andRespond(request -> {
            var connection = coordinator.connection(USER);
            synchronized (connection) {
                connection.value++;
                device("new-login", NOW.plusSeconds(10000));
            }
            return withSuccess(NEW_PAIR, MediaType.APPLICATION_JSON).createResponse(request);
        });
        var lifecycle = lifecycle();
        assertThatThrownBy(() -> lifecycle.findToken(USER)).isInstanceOf(GithubReauthenticationRequiredException.class);
        var replacement = row.get();
        lifecycle.rejectUsedToken(USER, "access-old");
        lifecycle.rejectUsedToken(USER, "access-new");
        assertThat(row).hasValue(replacement);
        assertThat(lifecycle.findToken(USER)).contains("new-login");
        server.verify();
    }

    @Test
    void finalCompareAndSetDoesNotUpsertAfterAnExternalReplacement() {
        device("access-old", NOW.minusSeconds(1));
        server.expect(requestTo(TOKEN_URL)).andRespond(request -> {
            // Model an external process replacing material without this process's monitor.
            device("external-login", NOW.plusSeconds(10000));
            return withSuccess(NEW_PAIR, MediaType.APPLICATION_JSON).createResponse(request);
        });
        assertThatThrownBy(() -> lifecycle().findToken(USER))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThat(decoded().accessToken()).isEqualTo("external-login");
        assertThat(writes).hasValue(1);
        server.verify();
    }

    @Test
    void failedRotatedPairPersistenceNeverReplaysTheOriginalPair() {
        device("access-old", NOW.minusSeconds(1));
        doAnswer(invocation -> {
                    if (writes.get() != 0) throw new IllegalStateException("database unavailable");
                    StoredCredential expected = invocation.getArgument(0);
                    row.set(expected.replaced(invocation.getArgument(1), invocation.getArgument(2)));
                    writes.incrementAndGet();
                    return true;
                })
                .when(store)
                .compareAndSet(any(), any(), any());
        server.expect(requestTo(TOKEN_URL)).andRespond(withSuccess(NEW_PAIR, MediaType.APPLICATION_JSON));
        assertThatThrownBy(() -> lifecycle().findToken(USER))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThat(decoded().state()).isEqualTo(State.REFRESH_PENDING);
        assertThatThrownBy(() -> lifecycle().findToken(USER))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        server.verify();
    }

    @Test
    void rejectedCurrentTokenIsLocallyMarkedBut403IsNotAnInvalidationInput() {
        device("access-old", NOW.plusSeconds(3000));
        var lifecycle = lifecycle();
        lifecycle.rejectUsedToken(USER, "access-old");
        assertThat(decoded().state()).isEqualTo(State.REAUTH_REQUIRED);
        assertThatThrownBy(() -> lifecycle.findToken(USER)).isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThat(decoded().accessToken()).isNull();
        assertThat(writes).hasValue(1);
        server.verify();
    }

    @Test
    void publicationRechecksStoredMaterialAndNeverRunsAfterDisconnect() {
        device("access-old", NOW.plusSeconds(3000));
        var lifecycle = lifecycle();
        var published = new AtomicInteger();
        lifecycle.publishIfCurrent(USER, "access-old", published::incrementAndGet);
        row.set(null);
        assertThatThrownBy(() -> lifecycle.publishIfCurrent(USER, "access-old", published::incrementAndGet))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThat(published).hasValue(1);
        server.verify();
    }

    @Test
    void localStatusDoesNotRefreshAndRejectsUnknownClientOrIdentity() {
        device("access-old", NOW.minusSeconds(1));
        var material = row.get();
        var entity = new GithubCredential(USER, CredentialKind.OAUTH, material.encrypted(), "", material.expiresAt());
        assertThat(lifecycle().reauthenticationReason(entity, 42L)).isNull();
        assertThat(lifecycle().reauthenticationReason(entity, 99L)).isEqualTo("CREDENTIAL_INVALID");
        row.set(new StoredCredential(
                material.id(),
                USER,
                CredentialKind.OAUTH,
                2,
                material.nonce(),
                material.ciphertext(),
                material.expiresAt(),
                99L));
        assertThatThrownBy(() -> lifecycle().findToken(USER))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThat(writes).hasValue(0);
        verifyNoInteractions(github);
        server.verify();
    }

    @Test
    void aNewConnectionDoesNotWaitForTheOldConnectionsInFlightRefresh() throws Exception {
        device("access-old", NOW.minusSeconds(1));
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        server.expect(requestTo(TOKEN_URL)).andRespond(request -> {
            entered.countDown();
            try {
                if (!release.await(3, TimeUnit.SECONDS)) throw new AssertionError("test timeout");
            } catch (InterruptedException interrupted) {
                throw new AssertionError(interrupted);
            }
            return withSuccess(NEW_PAIR, MediaType.APPLICATION_JSON).createResponse(request);
        });
        var lifecycle = lifecycle();
        try (var pool = Executors.newFixedThreadPool(2)) {
            var old = pool.submit(() -> lifecycle.findToken(USER));
            try {
                assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
                var connection = coordinator.connection(USER);
                synchronized (connection) {
                    connection.value++;
                    device("new-login", NOW.plusSeconds(5000));
                }
                assertThat(pool.submit(() -> lifecycle.findToken(USER)).get(1, TimeUnit.SECONDS))
                        .contains("new-login");
                release.countDown();
                assertThatThrownBy(() -> old.get(3, TimeUnit.SECONDS))
                        .hasCauseInstanceOf(GithubReauthenticationRequiredException.class);
            } finally {
                release.countDown();
            }
        }
        assertThat(decoded().accessToken()).isEqualTo("new-login");
        server.verify();
    }

    @Test
    void aBorrowedRevisionCannotRevokeOrPublishAfterTheSamePatIsReconnected() {
        var encrypted = legacy.encrypt("same-pat");
        row.set(new StoredCredential(
                11, USER, CredentialKind.PAT, 1, encrypted.nonce(), encrypted.ciphertext(), null, 42L));
        var lifecycle = lifecycle();
        var borrowed = lifecycle.borrow(USER).orElseThrow();
        var again = legacy.encrypt("same-pat");
        row.set(new StoredCredential(11, USER, CredentialKind.PAT, 1, again.nonce(), again.ciphertext(), null, 42L));
        var replacement = row.get();
        borrowed.reject();
        assertThat(row).hasValue(replacement);
        assertThatThrownBy(borrowed::verify).isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThatThrownBy(() -> borrowed.publish(() -> {
                    throw new AssertionError("must not publish");
                }))
                .isInstanceOf(GithubReauthenticationRequiredException.class);
        assertThat(lifecycle.borrow(USER).orElseThrow().value()).isEqualTo("same-pat");
        assertThat(borrowed.toString()).doesNotContain("same-pat");
        server.verify();
    }

    @Test
    void remainingValidAccessDoesNotRequireAnAlreadyExpiredRefreshToken() {
        var material = Envelope.active(
                CLIENT, 42, "remaining-access", NOW.plusSeconds(5), "expired-refresh", NOW.minusSeconds(1));
        var encrypted = codec.encrypt(USER, material);
        row.set(new StoredCredential(
                11,
                USER,
                CredentialKind.OAUTH,
                2,
                encrypted.nonce(),
                encrypted.ciphertext(),
                material.accessExpiresAt(),
                42L));
        assertThat(lifecycle().findToken(USER)).contains("remaining-access");
        assertThat(writes).hasValue(0);
        server.verify();
    }

    @Test
    void cloneFailureClassificationRequiresActual401RatherThanAnArbitrary403() {
        device("access-old", NOW.plusSeconds(5000));
        var lifecycle = lifecycle();
        var borrowed = lifecycle.borrow(USER).orElseThrow();
        when(github.getUser("access-old")).thenThrow(new dev.codeintelligence.github.GithubRepositoryAccessException());
        borrowed.checkAfterTransportFailure();
        assertThat(writes).hasValue(0);
        doThrow(new dev.codeintelligence.github.InvalidGithubTokenException())
                .when(github)
                .getUser("access-old");
        assertThatThrownBy(borrowed::checkAfterTransportFailure)
                .isInstanceOf(dev.codeintelligence.github.InvalidGithubTokenException.class);
        assertThat(decoded().state()).isEqualTo(State.REAUTH_REQUIRED);
        assertThat(writes).hasValue(1);
        server.verify();
    }
}
