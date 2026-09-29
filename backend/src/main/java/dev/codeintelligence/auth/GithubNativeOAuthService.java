package dev.codeintelligence.auth;

import com.fasterxml.jackson.annotation.JsonProperty;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubUserInfo;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
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
import org.springframework.web.util.UriComponentsBuilder;

/** Public-client authorization-code flow. Secrets and access tokens never leave the backend. */
@Service
public class GithubNativeOAuthService {

    private static final SecureRandom RANDOM = new SecureRandom();

    private final GithubNativeOAuthProperties properties;
    private final GithubApiClient githubApiClient;
    private final AccountService accountService;
    private final RestClient restClient;
    private final Clock clock;
    private final Map<UUID, Attempt> attempts = new ConcurrentHashMap<>();
    private final Map<String, UUID> attemptByState = new ConcurrentHashMap<>();

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
        requireConfigured();
        cleanupExpired();
        UUID id = UUID.randomUUID();
        String state = randomUrlToken(32);
        String verifier = randomUrlToken(64);
        String challenge = sha256Url(verifier);
        Instant expiresAt = clock.instant().plusSeconds(properties.attemptTtlSeconds());
        Attempt attempt = new Attempt(id, userId, state, verifier, expiresAt);
        attempts.put(id, attempt);
        attemptByState.put(state, id);

        URI authorizationUrl = UriComponentsBuilder.fromUriString(properties.authorizationUri())
                .queryParam("client_id", properties.clientId())
                .queryParam("redirect_uri", properties.redirectUri())
                .queryParam("state", state)
                .queryParam("code_challenge", challenge)
                .queryParam("code_challenge_method", "S256")
                .build(true)
                .toUri();
        return new StartResult(id, authorizationUrl.toString(), expiresAt);
    }

    public StatusResult status(long userId, UUID id) {
        Attempt attempt = requireOwned(userId, id);
        synchronized (attempt) {
            expireIfNeeded(attempt);
            return attempt.statusResult();
        }
    }

    public StatusResult cancel(long userId, UUID id) {
        Attempt attempt = requireOwned(userId, id);
        synchronized (attempt) {
            if (attempt.status == Status.WAITING) {
                attempt.status = Status.CANCELLED;
                attempt.message = "GitHub login was cancelled.";
                attemptByState.remove(attempt.state, attempt.id);
                attempt.clearVerifier();
            }
            return attempt.statusResult();
        }
    }

    public CallbackResult callback(String code, String state, String error) {
        if (!StringUtils.hasText(state)) {
            return new CallbackResult(Status.INVALID, "Invalid login callback.");
        }
        UUID id = attemptByState.remove(state);
        if (id == null) {
            return new CallbackResult(Status.INVALID, "This login callback is invalid or was already used.");
        }
        Attempt attempt = attempts.get(id);
        if (attempt == null) {
            return new CallbackResult(Status.INVALID, "This login attempt no longer exists.");
        }
        synchronized (attempt) {
            if (attempt.status != Status.WAITING
                    || !MessageDigest.isEqual(
                            attempt.state.getBytes(StandardCharsets.UTF_8), state.getBytes(StandardCharsets.UTF_8))) {
                return new CallbackResult(Status.INVALID, "This login callback is invalid or was already used.");
            }
            if (expireIfNeeded(attempt)) {
                return new CallbackResult(attempt.status, attempt.message);
            }
            if (StringUtils.hasText(error)) {
                attempt.status = "access_denied".equals(error) ? Status.DENIED : Status.FAILED;
                attempt.message = attempt.status == Status.DENIED
                        ? "GitHub authorization was denied."
                        : "GitHub authorization failed.";
                attempt.clearVerifier();
                return new CallbackResult(attempt.status, attempt.message);
            }
            if (!StringUtils.hasText(code)) {
                attempt.status = Status.FAILED;
                attempt.message = "GitHub returned no authorization code.";
                attempt.clearVerifier();
                return new CallbackResult(attempt.status, attempt.message);
            }
            try {
                String token = exchange(code, attempt.verifier);
                GithubUserInfo profile = githubApiClient.getUser(token);
                accountService.linkGithub(attempt.userId, profile, CredentialKind.OAUTH, token);
                attempt.status = Status.CONNECTED;
                attempt.message = "GitHub account connected. You can return to the app.";
            } catch (GithubAccountConflictException conflict) {
                attempt.status = Status.CONFLICT;
                attempt.message = conflict.getMessage();
            } catch (RestClientException | IllegalStateException failure) {
                attempt.status = Status.FAILED;
                attempt.message = "GitHub login could not be completed. Retry from the app.";
            } finally {
                attempt.clearVerifier();
            }
            return new CallbackResult(attempt.status, attempt.message);
        }
    }

    public boolean configured() {
        return properties.configured();
    }

    public String revocationUrl() {
        if (!properties.configured()) {
            return null;
        }
        return "https://github.com/settings/connections/applications/" + properties.clientId();
    }

    private String exchange(String code, String verifier) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("client_id", properties.clientId());
        form.add("code", code);
        form.add("redirect_uri", properties.redirectUri());
        form.add("code_verifier", verifier);
        TokenResponse response = restClient
                .post()
                .uri(properties.tokenUri())
                .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .body(form)
                .retrieve()
                .body(TokenResponse.class);
        if (response == null || !StringUtils.hasText(response.accessToken()) || StringUtils.hasText(response.error())) {
            throw new IllegalStateException("GitHub returned no access token");
        }
        return response.accessToken();
    }

    private Attempt requireOwned(long userId, UUID id) {
        Attempt attempt = attempts.get(id);
        if (attempt == null || attempt.userId != userId) {
            throw new GithubOAuthAttemptNotFoundException();
        }
        return attempt;
    }

    private void requireConfigured() {
        if (!properties.configured()) {
            throw new GithubNativeOAuthUnavailableException();
        }
    }

    private boolean expireIfNeeded(Attempt attempt) {
        if (attempt.status == Status.WAITING && !clock.instant().isBefore(attempt.expiresAt)) {
            attempt.status = Status.EXPIRED;
            attempt.message = "GitHub login expired. Start a new login.";
            attemptByState.remove(attempt.state, attempt.id);
            attempt.clearVerifier();
            return true;
        }
        return false;
    }

    private void cleanupExpired() {
        attempts.values().forEach(attempt -> {
            synchronized (attempt) {
                expireIfNeeded(attempt);
            }
        });
        Instant discardBefore = clock.instant().minusSeconds(properties.attemptTtlSeconds());
        attempts.entrySet()
                .removeIf(entry -> entry.getValue().status != Status.WAITING
                        && entry.getValue().expiresAt.isBefore(discardBefore));
    }

    private static String randomUrlToken(int bytes) {
        byte[] value = new byte[bytes];
        RANDOM.nextBytes(value);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    private static String sha256Url(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    public enum Status {
        WAITING,
        CONNECTED,
        CANCELLED,
        DENIED,
        EXPIRED,
        CONFLICT,
        FAILED,
        INVALID
    }

    public record StartResult(UUID attemptId, String authorizationUrl, Instant expiresAt) {}

    public record StatusResult(UUID attemptId, Status status, String message, Instant expiresAt) {}

    public record CallbackResult(Status status, String message) {}

    private record TokenResponse(
            @JsonProperty("access_token") String accessToken,
            @JsonProperty("token_type") String tokenType,
            String scope,
            String error) {}

    private static final class Attempt {
        private final UUID id;
        private final long userId;
        private final String state;
        private String verifier;
        private final Instant expiresAt;
        private Status status = Status.WAITING;
        private String message = "Waiting for GitHub authorization.";

        private Attempt(UUID id, long userId, String state, String verifier, Instant expiresAt) {
            this.id = id;
            this.userId = userId;
            this.state = state;
            this.verifier = verifier;
            this.expiresAt = expiresAt;
        }

        private void clearVerifier() {
            verifier = null;
        }

        private StatusResult statusResult() {
            return new StatusResult(id, status, message, expiresAt);
        }
    }
}
