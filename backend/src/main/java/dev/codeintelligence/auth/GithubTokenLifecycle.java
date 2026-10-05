package dev.codeintelligence.auth;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import dev.codeintelligence.auth.GithubCredentialStore.StoredCredential;
import dev.codeintelligence.auth.GithubDeviceCredentialCodec.Envelope;
import dev.codeintelligence.auth.GithubDeviceCredentialCodec.State;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubHttpClients;
import dev.codeintelligence.github.GithubTokenProvider.BorrowedToken;
import dev.codeintelligence.github.InvalidGithubTokenException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Arrays;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.client.RestClient;

/** Device-origin refresh only. Durable claim precedes provider I/O; ambiguous work is never replayed. */
@Component
public class GithubTokenLifecycle {
    private final GithubCredentialStore store;
    private final GithubDeviceCredentialCodec codec;
    private final TokenCryptoService legacy;
    private final GithubConnectionCoordinator coordinator;
    private final GithubNativeOAuthProperties properties;
    private final GithubApiClient github;
    private final RestClient client;
    private final Clock clock;
    private final Map<Long, RefreshFlight> flights = new ConcurrentHashMap<>();

    private record RefreshFlight(long generation, StoredCredential claimed, CompletableFuture<String> result) {}

    @Autowired
    public GithubTokenLifecycle(
            GithubCredentialStore store,
            GithubDeviceCredentialCodec codec,
            TokenCryptoService legacy,
            GithubConnectionCoordinator coordinator,
            GithubNativeOAuthProperties properties,
            GithubApiClient github,
            RestClient.Builder builder) {
        this(store, codec, legacy, coordinator, properties, github, refreshClient(builder), Clock.systemUTC());
    }

    GithubTokenLifecycle(
            GithubCredentialStore store,
            GithubDeviceCredentialCodec codec,
            TokenCryptoService legacy,
            GithubConnectionCoordinator coordinator,
            GithubNativeOAuthProperties properties,
            GithubApiClient github,
            RestClient client,
            Clock clock) {
        this.store = store;
        this.codec = codec;
        this.legacy = legacy;
        this.coordinator = coordinator;
        this.properties = properties;
        this.github = github;
        this.client = client;
        this.clock = clock;
    }

    private static RestClient refreshClient(RestClient.Builder builder) {
        return GithubHttpClients.bounded(builder).build();
    }

    public Optional<String> findToken(long userId) {
        var connection = coordinator.connection(userId);
        RefreshFlight flight;
        StoredCredential claimed = null;
        Envelope current = null;
        long generation = 0;
        synchronized (connection) {
            StoredCredential row = store.find(userId).orElse(null);
            if (row == null) return Optional.empty();
            flight = flights.get(userId);
            if (flight == null || flight.generation() != connection.value || !sameRevision(flight.claimed(), row)) {
                if (row.keyVersion() == 1) return Optional.of(legacyToken(row));
                current = device(row);
                if (current.state() != State.ACTIVE) throw required(reason(current));
                if (clock.instant().isBefore(current.accessExpiresAt())
                        && (clock.instant().plusSeconds(30).isBefore(current.accessExpiresAt())
                                || !clock.instant().isBefore(current.refreshExpiresAt())))
                    return Optional.of(current.accessToken());
                if (!clock.instant().isBefore(current.refreshExpiresAt())) throw required("REFRESH_EXPIRED");
                // Persist no token in the pending state. A crash/ambiguous response cannot
                // retrieve the old refresh value for a second provider exchange.
                EncryptedToken pending =
                        codec.encrypt(userId, current.pending(UUID.randomUUID().toString()));
                try {
                    if (!store.compareAndSet(row, pending, row.expiresAt())) throw required("CONNECTION_CHANGED");
                } catch (RuntimeException uncertain) {
                    throw required("REFRESH_UNCERTAIN");
                }
                claimed = row.replaced(pending, row.expiresAt());
                generation = connection.value;
                flight = new RefreshFlight(generation, claimed, new CompletableFuture<>());
                flights.put(userId, flight);
            }
        }
        if (claimed == null) {
            try {
                String token = flight.result().get(40, TimeUnit.SECONDS);
                verifyCurrent(userId, token);
                return Optional.of(token);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw required("REFRESH_UNCERTAIN");
            } catch (Exception failure) {
                throw required("REFRESH_UNCERTAIN");
            }
        }
        try {
            Instant started = clock.instant().truncatedTo(ChronoUnit.SECONDS);
            var form = new LinkedMultiValueMap<String, String>();
            form.add("client_id", current.clientId());
            form.add("grant_type", "refresh_token");
            form.add("refresh_token", current.refreshToken());
            TokenResponse response = client.post()
                    .uri(properties.tokenUri())
                    .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(form)
                    .retrieve()
                    .body(TokenResponse.class);
            Envelope renewed = renewed(current, response, started);
            // Bind the rotated pair to the originally linked identity; do not relink a user.
            if (github.getUser(renewed.accessToken()).id() != renewed.githubId()) throw required("CREDENTIAL_INVALID");
            synchronized (connection) {
                if (generation != connection.value || !clock.instant().isBefore(renewed.accessExpiresAt()))
                    throw required("CONNECTION_CHANGED");
                if (!store.compareAndSet(claimed, codec.encrypt(userId, renewed), renewed.accessExpiresAt()))
                    throw required("CONNECTION_CHANGED");
                flight.result().complete(renewed.accessToken());
            }
            return Optional.of(renewed.accessToken());
        } catch (RuntimeException failure) {
            var safe = required("REFRESH_UNCERTAIN");
            flight.result().completeExceptionally(safe);
            throw safe;
        } finally {
            synchronized (connection) {
                flights.remove(userId, flight);
            }
        }
    }

    public Optional<BorrowedToken> borrow(long userId) {
        var connection = coordinator.connection(userId);
        long admittedGeneration;
        synchronized (connection) {
            admittedGeneration = connection.value;
        }
        Optional<String> token = findToken(userId);
        if (token.isEmpty()) return Optional.empty();
        synchronized (connection) {
            if (connection.value != admittedGeneration) throw required("CONNECTION_CHANGED");
            StoredCredential expected = verifyLocked(userId, token.get());
            long generation = connection.value;
            Runnable check = () -> {
                if (connection.value != generation || !sameRevision(expected, verifyLocked(userId, token.get())))
                    throw required("CONNECTION_CHANGED");
            };
            Runnable reject = () -> {
                synchronized (connection) {
                    if (connection.value != generation) return;
                    StoredCredential current = store.find(userId).orElse(null);
                    if (sameRevision(expected, current)) invalidate(expected);
                }
            };
            return Optional.of(new BorrowedToken(
                    token.get(),
                    () -> {
                        synchronized (connection) {
                            check.run();
                        }
                    },
                    reject,
                    publication -> {
                        synchronized (connection) {
                            check.run();
                            publication.run();
                        }
                    },
                    () -> {
                        synchronized (connection) {
                            check.run();
                        }
                        try {
                            var user = github.getUser(token.get());
                            synchronized (connection) {
                                check.run();
                                if (expected.githubId() == null || user.id() != expected.githubId())
                                    throw required("CONNECTION_CHANGED");
                            }
                        } catch (InvalidGithubTokenException rejected) {
                            reject.run();
                            throw rejected;
                        } catch (GithubReauthenticationRequiredException changed) {
                            throw changed;
                        } catch (RuntimeException unavailable) {
                            // Permission/rate-limit/transport failures do not establish token rejection.
                            synchronized (connection) {
                                check.run();
                            }
                        }
                    }));
        }
    }

    private static boolean sameRevision(StoredCredential expected, StoredCredential current) {
        return expected != null
                && current != null
                && expected.id() == current.id()
                && expected.userId() == current.userId()
                && expected.kind() == current.kind()
                && expected.keyVersion() == current.keyVersion()
                && Arrays.equals(expected.nonce(), current.nonce())
                && expected.ciphertext().equals(current.ciphertext())
                && Objects.equals(expected.expiresAt(), current.expiresAt())
                && Objects.equals(expected.githubId(), current.githubId());
    }

    private Envelope renewed(Envelope previous, TokenResponse response, Instant started) {
        if (response == null
                || response.error() != null
                || !"bearer".equalsIgnoreCase(response.tokenType())
                || response.expiresIn() == null
                || response.expiresIn() <= 0
                || response.expiresIn() > 28800
                || response.refreshExpiresIn() == null
                || response.refreshExpiresIn() <= 0
                || response.refreshExpiresIn() > 200L * 86400
                || equal(response.accessToken(), previous.accessToken())
                || equal(response.refreshToken(), previous.refreshToken())) throw required("CREDENTIAL_INVALID");
        return Envelope.active(
                previous.clientId(),
                previous.githubId(),
                response.accessToken(),
                started.plusSeconds(response.expiresIn()),
                response.refreshToken(),
                started.plusSeconds(response.refreshExpiresIn()));
    }

    private Envelope device(StoredCredential row) {
        Envelope value = codec.decrypt(row.userId(), row.kind(), row.keyVersion(), row.nonce(), row.ciphertext());
        if (!properties.configured() || !value.clientId().equals(properties.clientId()))
            throw required("CLIENT_CHANGED");
        if (row.githubId() == null || row.githubId() != value.githubId()) throw required("CONNECTION_CHANGED");
        if (value.state() == State.ACTIVE && !value.accessExpiresAt().equals(row.expiresAt()))
            throw required("CREDENTIAL_INVALID");
        return value;
    }

    private String legacyToken(StoredCredential row) {
        if (row.kind() == CredentialKind.OAUTH && row.expiresAt() == null) throw required("EXPIRY_UNKNOWN");
        if (row.expiresAt() != null && !clock.instant().isBefore(row.expiresAt())) throw required("TOKEN_EXPIRED");
        try {
            return legacy.decrypt(row.keyVersion(), row.nonce(), row.ciphertext());
        } catch (RuntimeException invalid) {
            throw required("CREDENTIAL_INVALID");
        }
    }

    public void verifyCurrent(long userId, String token) {
        synchronized (coordinator.connection(userId)) {
            verifyLocked(userId, token);
        }
    }

    private StoredCredential verifyLocked(long userId, String token) {
        StoredCredential row = store.find(userId).orElseThrow(() -> required("CONNECTION_CHANGED"));
        String current;
        if (row.keyVersion() == 1) current = legacyToken(row);
        else {
            Envelope value = device(row);
            if (value.state() != State.ACTIVE || !clock.instant().isBefore(value.accessExpiresAt()))
                throw required("CONNECTION_CHANGED");
            current = value.accessToken();
        }
        if (!equal(current, token)) throw required("CONNECTION_CHANGED");
        return row;
    }

    public void publishIfCurrent(long userId, String token, Runnable publication) {
        synchronized (coordinator.connection(userId)) {
            verifyLocked(userId, token);
            publication.run();
        }
    }

    public void rejectUsedToken(long userId, String token) {
        synchronized (coordinator.connection(userId)) {
            StoredCredential row = store.find(userId).orElse(null);
            if (row == null) return;
            try {
                String current = row.keyVersion() == 1
                        ? legacy.decrypt(1, row.nonce(), row.ciphertext())
                        : device(row).accessToken();
                if (!equal(current, token)) return;
                invalidate(row);
            } catch (RuntimeException ignored) {
                /* Deny this request; never delete a possibly new credential. */
            }
        }
    }

    private void invalidate(StoredCredential row) {
        try {
            EncryptedToken rejected = row.keyVersion() == 1
                    ? row.encrypted()
                    : codec.encrypt(row.userId(), device(row).rejected());
            store.compareAndSet(row, rejected, Instant.EPOCH);
        } catch (RuntimeException ignored) {
            /* Still reject the request; never delete a newer revision. */
        }
    }

    /** Local status, no provider exchange. A renewable device pair is still connected. */
    public String reauthenticationReason(GithubCredential credential, Long githubId) {
        if (credential.getKeyVersion() == 1) return credential.reauthenticationReason(clock.instant());
        try {
            StoredCredential row = new StoredCredential(
                    credential.getId() == null ? 0 : credential.getId(),
                    credential.getUserId(),
                    credential.getKind(),
                    credential.getKeyVersion(),
                    credential.getNonce(),
                    credential.getEncryptedToken(),
                    credential.getExpiresAt(),
                    githubId);
            Envelope value = device(row);
            if (value.state() == State.REFRESH_PENDING) {
                var flight = flights.get(row.userId());
                return flight != null
                                && flight.generation() == coordinator.connection(row.userId()).value
                                && sameRevision(flight.claimed(), row)
                        ? "REFRESH_IN_PROGRESS"
                        : "REFRESH_UNCERTAIN";
            }
            if (value.state() == State.REAUTH_REQUIRED) return "TOKEN_REJECTED";
            return clock.instant().isBefore(value.accessExpiresAt())
                            || clock.instant().isBefore(value.refreshExpiresAt())
                    ? null
                    : "REFRESH_EXPIRED";
        } catch (RuntimeException failure) {
            return "CREDENTIAL_INVALID";
        }
    }

    private static String reason(Envelope value) {
        return value.state() == State.REFRESH_PENDING ? "REFRESH_UNCERTAIN" : "TOKEN_REJECTED";
    }

    private static GithubReauthenticationRequiredException required(String reason) {
        return new GithubReauthenticationRequiredException(reason);
    }

    private static boolean equal(String left, String right) {
        return left != null
                && right != null
                && MessageDigest.isEqual(left.getBytes(StandardCharsets.UTF_8), right.getBytes(StandardCharsets.UTF_8));
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record TokenResponse(
            @JsonProperty("access_token") String accessToken,
            @JsonProperty("token_type") String tokenType,
            @JsonProperty("expires_in") Long expiresIn,
            @JsonProperty("refresh_token") String refreshToken,
            @JsonProperty("refresh_token_expires_in") Long refreshExpiresIn,
            String error) {
        @Override
        public String toString() {
            return "GithubRefreshResponse{REDACTED}";
        }
    }
}
