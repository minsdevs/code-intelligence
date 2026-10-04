package dev.codeintelligence.auth;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubRateLimitException;
import dev.codeintelligence.github.GithubRepositoryAccessException;
import dev.codeintelligence.github.GithubUserInfo;
import dev.codeintelligence.github.InvalidGithubTokenException;
import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/** GitHub device authorization. Device codes and access tokens never leave the backend. */
@Service
public class GithubNativeOAuthService {

    private static final String VERIFICATION_URI = "https://github.com/login/device";
    private static final String DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
    private static final String FAILED_MESSAGE = "GitHub login could not be completed. Retry from the app.";

    private final GithubNativeOAuthProperties properties;
    private final GithubApiClient githubApiClient;
    private final AccountService accountService;
    private final RestClient restClient;
    private final Clock clock;
    private final Map<UUID, Attempt> attempts = new ConcurrentHashMap<>();
    private final Map<Long, ConnectionGeneration> connections = new ConcurrentHashMap<>();

    @Autowired
    public GithubNativeOAuthService(
            GithubNativeOAuthProperties properties,
            GithubApiClient githubApiClient,
            AccountService accountService,
            RestClient.Builder restClientBuilder) {
        this(properties, githubApiClient, accountService, restClientBuilder.build(), Clock.systemUTC());
    }

    GithubNativeOAuthService(
            GithubNativeOAuthProperties properties,
            GithubApiClient githubApiClient,
            AccountService accountService,
            RestClient restClient,
            Clock clock) {
        this.properties = properties;
        this.githubApiClient = githubApiClient;
        this.accountService = accountService;
        this.restClient = restClient;
        this.clock = clock;
    }

    public StartResult start(long userId) {
        if (!configured()) {
            throw new GithubNativeOAuthUnavailableException();
        }
        cleanupExpired();
        ConnectionGeneration connection = connection(userId);
        long generation;
        synchronized (connection) {
            generation = ++connection.value;
        }
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("client_id", properties.clientId());
        form.add("scope", properties.scope());
        DeviceResponse response;
        Instant requestedAt = clock.instant();
        try {
            response = restClient
                    .post()
                    .uri(properties.deviceCodeUri())
                    .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(form)
                    .retrieve()
                    .body(DeviceResponse.class);
        } catch (RestClientException failure) {
            throw new GithubNativeOAuthUnavailableException("GitHub device authorization is temporarily unavailable.");
        }
        if (response != null && "device_flow_disabled".equals(response.error())) {
            throw new GithubNativeOAuthUnavailableException("Enable device flow for the configured GitHub OAuth app.");
        }
        if (response == null
                || StringUtils.hasText(response.error())
                || !StringUtils.hasText(response.deviceCode())
                || !StringUtils.hasText(response.userCode())
                || !VERIFICATION_URI.equals(response.verificationUri())
                || response.expiresIn() == null
                || response.expiresIn() <= 0
                || response.expiresIn() > 900
                || response.interval() == null
                || response.interval() <= 0
                || response.interval() > response.expiresIn()) {
            throw new GithubNativeOAuthUnavailableException(
                    "GitHub returned an invalid device authorization response.");
        }
        Instant expiresAt = requestedAt.plusSeconds(Math.min(properties.attemptTtlSeconds(), response.expiresIn()));
        if (!clock.instant().isBefore(expiresAt)) {
            throw new GithubNativeOAuthUnavailableException(
                    "GitHub device authorization expired before it could start.");
        }
        UUID id = UUID.randomUUID();
        Attempt attempt = new Attempt(
                id, userId, generation, response.deviceCode(), expiresAt, response.interval(), clock.instant());
        synchronized (connection) {
            if (connection.value != generation) {
                throw new GithubNativeOAuthUnavailableException("GitHub connection changed. Start a new login.");
            }
            attempts.put(id, attempt);
        }
        return new StartResult(id, VERIFICATION_URI, response.userCode(), expiresAt, attempt.intervalSeconds);
    }

    public StatusResult poll(long userId, UUID id) {
        Attempt attempt = requireOwned(userId, id);
        String deviceCode;
        synchronized (attempt) {
            expireIfNeeded(attempt);
            if (attempt.status != Status.WAITING
                    || attempt.polling
                    || clock.instant().isBefore(attempt.nextPollAt)) {
                return statusResult(attempt);
            }
            attempt.polling = true;
            deviceCode = attempt.deviceCode;
        }
        // Provider I/O must not hold the cancellation lock. Recheck before publishing credentials.
        try {
            TokenResponse response = exchange(deviceCode);
            GithubUserInfo profile = null;
            boolean authorized = response != null
                    && !StringUtils.hasText(response.error())
                    && StringUtils.hasText(response.accessToken())
                    && "bearer".equalsIgnoreCase(response.tokenType());
            if (authorized) {
                synchronized (attempt) {
                    expireIfNeeded(attempt);
                    if (attempt.status != Status.WAITING) {
                        return statusResult(attempt);
                    }
                }
                profile = githubApiClient.getUser(response.accessToken());
            }
            synchronized (attempt) {
                expireIfNeeded(attempt);
                if (attempt.status == Status.WAITING) {
                    if (authorized) {
                        // Disconnect and credential publication share a short per-user lock;
                        // provider I/O never holds it. Older attempts cannot reconnect the account.
                        synchronized (connection(attempt.userId)) {
                            expireIfNeeded(attempt);
                            if (attempt.status == Status.WAITING) {
                                accountService.linkGithub(
                                        attempt.userId, profile, CredentialKind.OAUTH, response.accessToken());
                                finish(attempt, Status.CONNECTED, "GitHub account connected.");
                            }
                        }
                    } else {
                        applyProviderError(attempt, response);
                    }
                }
            }
        } catch (GithubAccountConflictException conflict) {
            synchronized (attempt) {
                expireIfNeeded(attempt);
                if (attempt.status == Status.WAITING) {
                    finish(attempt, Status.CONFLICT, "This GitHub account is already connected to another account.");
                }
            }
        } catch (RestClientException
                | InvalidGithubTokenException
                | GithubRateLimitException
                | GithubRepositoryAccessException failure) {
            synchronized (attempt) {
                expireIfNeeded(attempt);
                if (attempt.status == Status.WAITING) {
                    finish(attempt, Status.FAILED, FAILED_MESSAGE);
                }
            }
        } catch (RuntimeException failure) {
            synchronized (attempt) {
                if (attempt.status == Status.WAITING) {
                    finish(attempt, Status.FAILED, FAILED_MESSAGE);
                }
            }
            throw failure;
        } finally {
            synchronized (attempt) {
                attempt.polling = false;
                expireIfNeeded(attempt);
                if (attempt.status == Status.WAITING) {
                    attempt.nextPollAt = clock.instant().plusSeconds(attempt.intervalSeconds);
                }
            }
        }
        synchronized (attempt) {
            return statusResult(attempt);
        }
    }

    public StatusResult cancel(long userId, UUID id) {
        Attempt attempt = requireOwned(userId, id);
        synchronized (attempt) {
            expireIfNeeded(attempt);
            if (attempt.status == Status.WAITING) {
                finish(attempt, Status.CANCELLED, "GitHub login was cancelled.");
            }
            return statusResult(attempt);
        }
    }

    public void disconnect(long userId) {
        ConnectionGeneration connection = connection(userId);
        synchronized (connection) {
            connection.value++;
            accountService.disconnectGithub(userId);
        }
    }

    private ConnectionGeneration connection(long userId) {
        return connections.computeIfAbsent(userId, ignored -> new ConnectionGeneration());
    }

    public boolean configured() {
        return properties.configured();
    }

    public String revocationUrl() {
        return configured() ? "https://github.com/settings/connections/applications/" + properties.clientId() : null;
    }

    private TokenResponse exchange(String deviceCode) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("client_id", properties.clientId());
        form.add("device_code", deviceCode);
        form.add("grant_type", DEVICE_GRANT);
        return restClient
                .post()
                .uri(properties.tokenUri())
                .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .body(form)
                .retrieve()
                .body(TokenResponse.class);
    }

    private void applyProviderError(Attempt attempt, TokenResponse response) {
        String error = response == null || response.error() == null ? "" : response.error();
        switch (error) {
            case "authorization_pending" -> {}
            case "slow_down" -> {
                int requested = response.interval() == null ? 0 : response.interval();
                if (requested < 0 || requested > 900 || attempt.intervalSeconds > 895) {
                    finish(attempt, Status.FAILED, FAILED_MESSAGE);
                } else {
                    attempt.intervalSeconds = Math.max(attempt.intervalSeconds + 5, requested);
                }
            }
            case "expired_token", "token_expired" ->
                finish(attempt, Status.EXPIRED, "GitHub login expired. Start a new login.");
            case "access_denied" -> finish(attempt, Status.DENIED, "GitHub authorization was denied.");
            case "device_flow_disabled" ->
                finish(attempt, Status.FAILED, "Enable device flow for the configured GitHub OAuth app.");
            case "incorrect_client_credentials" ->
                finish(attempt, Status.FAILED, "The configured GitHub OAuth client ID is invalid.");
            default -> finish(attempt, Status.FAILED, FAILED_MESSAGE);
        }
    }

    private Attempt requireOwned(long userId, UUID id) {
        Attempt attempt = attempts.get(id);
        if (attempt == null || attempt.userId != userId) {
            throw new GithubOAuthAttemptNotFoundException();
        }
        return attempt;
    }

    private void expireIfNeeded(Attempt attempt) {
        if (attempt.status == Status.WAITING && connection(attempt.userId).value != attempt.generation) {
            finish(attempt, Status.CANCELLED, "GitHub connection changed. Start a new login.");
        }
        if (attempt.status == Status.WAITING && !clock.instant().isBefore(attempt.expiresAt)) {
            finish(attempt, Status.EXPIRED, "GitHub login expired. Start a new login.");
        }
    }

    private static void finish(Attempt attempt, Status status, String message) {
        attempt.status = status;
        attempt.message = message;
        attempt.deviceCode = null;
    }

    private StatusResult statusResult(Attempt attempt) {
        int waitSeconds = attempt.status == Status.WAITING
                ? (int) Math.max(1, (attempt.nextPollAt.toEpochMilli() - clock.millis() + 999) / 1000)
                : 0;
        return new StatusResult(attempt.id, attempt.status, attempt.message, attempt.expiresAt, waitSeconds);
    }

    private void cleanupExpired() {
        Instant discardBefore = clock.instant().minusSeconds(properties.attemptTtlSeconds());
        attempts.entrySet().removeIf(entry -> {
            Attempt attempt = entry.getValue();
            synchronized (attempt) {
                expireIfNeeded(attempt);
                return attempt.status != Status.WAITING && attempt.expiresAt.isBefore(discardBefore);
            }
        });
    }

    public enum Status {
        WAITING,
        CONNECTED,
        CANCELLED,
        DENIED,
        EXPIRED,
        CONFLICT,
        FAILED
    }

    public record StartResult(
            UUID attemptId, String verificationUri, String userCode, Instant expiresAt, int pollAfterSeconds) {}

    public record StatusResult(
            UUID attemptId, Status status, String message, Instant expiresAt, int pollAfterSeconds) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record DeviceResponse(
            @JsonProperty("device_code") String deviceCode,
            @JsonProperty("user_code") String userCode,
            @JsonProperty("verification_uri") String verificationUri,
            @JsonProperty("expires_in") Integer expiresIn,
            Integer interval,
            String error) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record TokenResponse(
            @JsonProperty("access_token") String accessToken,
            @JsonProperty("token_type") String tokenType,
            String error,
            Integer interval) {}

    private static final class ConnectionGeneration {
        private volatile long value;
    }

    private static final class Attempt {
        private final UUID id;
        private final long userId;
        private final long generation;
        private String deviceCode;
        private final Instant expiresAt;
        private Status status = Status.WAITING;
        private String message = "Waiting for GitHub authorization.";
        private int intervalSeconds;
        private Instant nextPollAt;
        private boolean polling;

        private Attempt(
                UUID id,
                long userId,
                long generation,
                String deviceCode,
                Instant expiresAt,
                int intervalSeconds,
                Instant now) {
            this.id = id;
            this.userId = userId;
            this.generation = generation;
            this.deviceCode = deviceCode;
            this.expiresAt = expiresAt;
            this.intervalSeconds = intervalSeconds;
            this.nextPollAt = now.plusSeconds(intervalSeconds);
        }
    }
}
