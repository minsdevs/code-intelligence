package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.CredentialKind;
import java.io.CharArrayReader;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** GitHub device credentials only. Legacy tokens and AI keys retain the separate v1 codec. */
@Component
public final class GithubDeviceCredentialCodec {

    public static final int VERSION = 2;
    private static final String ORIGIN = "GITHUB_APP_DEVICE";
    // This domain, separators and field order are part of the persistent v2 encryption contract.
    private static final String AAD_DOMAIN = "code-intelligence/github-device-credential";
    private static final int KEY_BYTES = 32;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_TOKEN_LENGTH = 4096;
    private static final int MAX_PLAINTEXT_BYTES = 12 * 1024;
    private static final int MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + TAG_BITS / 8;
    private static final int MAX_BASE64_LENGTH = 4 * ((MAX_CIPHERTEXT_BYTES + 2) / 3);
    private static final long MAX_EPOCH_SECOND = 253402300799L;
    private static final String[] FIELDS = {
        "format",
        "origin",
        "state",
        "clientId",
        "githubId",
        "accessToken",
        "accessExpiresAt",
        "refreshToken",
        "refreshExpiresAt",
        "claimId"
    };
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final JsonFactory FACTORY = JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION)
            .streamReadConstraints(StreamReadConstraints.builder()
                    .maxDocumentLength(MAX_PLAINTEXT_BYTES)
                    .maxNestingDepth(2)
                    .maxTokenCount(64)
                    .maxNameLength(64)
                    .maxStringLength(MAX_TOKEN_LENGTH)
                    .maxNumberLength(20)
                    .build())
            .build();

    private final SecretKey key;
    private final SecureRandom random = new SecureRandom();

    public GithubDeviceCredentialCodec(TokenCryptoProperties properties) {
        if (properties == null || !StringUtils.hasText(properties.tokenEncKey())) {
            throw new IllegalStateException("TOKEN_ENC_KEY is required to start the backend.");
        }
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(properties.tokenEncKey().strip());
        } catch (IllegalArgumentException invalidKey) {
            throw new IllegalStateException("TOKEN_ENC_KEY must be valid base64.");
        }
        try {
            if (decoded.length != KEY_BYTES) {
                throw new IllegalStateException("TOKEN_ENC_KEY must decode to exactly 32 bytes for AES-256.");
            }
            this.key = new SecretKeySpec(decoded, "AES");
        } finally {
            Arrays.fill(decoded, (byte) 0);
        }
    }

    public EncryptedToken encrypt(long userId, Envelope envelope) {
        if (userId <= 0 || envelope == null) throw invalid();
        byte[] plaintext = null;
        byte[] ciphertext = null;
        try {
            plaintext = JSON.writeValueAsBytes(body(envelope));
            if (plaintext.length > MAX_PLAINTEXT_BYTES) throw invalid();
            byte[] nonce = new byte[NONCE_BYTES];
            random.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(associatedData(userId));
            ciphertext = cipher.doFinal(plaintext);
            return new EncryptedToken(VERSION, nonce, Base64.getEncoder().encodeToString(ciphertext));
        } catch (GeneralSecurityException | RuntimeException failure) {
            // Parser, crypto and input errors have the same credential-free public surface.
            throw invalid();
        } finally {
            erase(plaintext);
            erase(ciphertext);
        }
    }

    public Envelope decrypt(long userId, CredentialKind kind, int version, byte[] nonce, String ciphertext) {
        if (userId <= 0
                || kind != CredentialKind.OAUTH
                || version != VERSION
                || nonce == null
                || nonce.length != NONCE_BYTES
                || ciphertext == null
                || ciphertext.isEmpty()
                || ciphertext.length() > MAX_BASE64_LENGTH) throw invalid();
        byte[] encoded = null;
        byte[] plaintext = null;
        try {
            encoded = Base64.getDecoder().decode(ciphertext);
            if (encoded.length <= TAG_BITS / 8
                    || encoded.length > MAX_CIPHERTEXT_BYTES
                    || !Base64.getEncoder().encodeToString(encoded).equals(ciphertext)) throw invalid();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(associatedData(userId));
            plaintext = cipher.doFinal(encoded);
            if (plaintext.length > MAX_PLAINTEXT_BYTES) throw invalid();
            return readEnvelope(plaintext);
        } catch (GeneralSecurityException | RuntimeException failure) {
            throw invalid();
        } finally {
            erase(encoded);
            erase(plaintext);
        }
    }

    private static byte[] associatedData(long userId) {
        return (AAD_DOMAIN + "\u0000" + VERSION + "\u0000" + userId + "\u0000OAUTH")
                .getBytes(StandardCharsets.US_ASCII);
    }

    private static Map<String, Object> body(Envelope envelope) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("format", VERSION);
        result.put("origin", ORIGIN);
        result.put("state", envelope.state().name());
        result.put("clientId", envelope.clientId());
        result.put("githubId", envelope.githubId());
        result.put("accessToken", envelope.accessToken());
        result.put("accessExpiresAt", epochSecond(envelope.accessExpiresAt()));
        result.put("refreshToken", envelope.refreshToken());
        result.put("refreshExpiresAt", epochSecond(envelope.refreshExpiresAt()));
        result.put("claimId", envelope.claimId());
        return result;
    }

    private static Long epochSecond(Instant value) {
        return value == null ? null : value.getEpochSecond();
    }

    private static Envelope readEnvelope(byte[] plaintext) {
        // Own the decode buffer even on malformed input, so a partially decoded secret is erased.
        char[] characters = new char[plaintext.length];
        try {
            CharBuffer decoded = CharBuffer.wrap(characters);
            var decoder = StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            if (!decoder.decode(ByteBuffer.wrap(plaintext), decoded, true).isUnderflow()
                    || !decoder.flush(decoded).isUnderflow()) throw invalid();
            // A character reader prevents JSON's byte-parser UTF-16/32 auto-detection.
            try (var parser = FACTORY.createParser(new CharArrayReader(characters, 0, decoded.position()))) {
                JsonNode root = JSON.readTree(parser);
                if (root == null || !root.isObject() || root.size() != FIELDS.length || parser.nextToken() != null) {
                    throw invalid();
                }
                for (String field : FIELDS) if (root.get(field) == null) throw invalid();
                if (integer(root.get("format")) != VERSION || !ORIGIN.equals(text(root.get("origin")))) {
                    throw invalid();
                }
                return new Envelope(
                        State.valueOf(text(root.get("state"))),
                        text(root.get("clientId")),
                        integer(root.get("githubId")),
                        nullableText(root.get("accessToken")),
                        instant(root.get("accessExpiresAt")),
                        nullableText(root.get("refreshToken")),
                        instant(root.get("refreshExpiresAt")),
                        nullableText(root.get("claimId")));
            }
        } catch (RuntimeException failure) {
            throw invalid();
        } finally {
            Arrays.fill(characters, '\0');
        }
    }

    private static String text(JsonNode value) {
        if (value == null || !value.isTextual()) throw invalid();
        return value.stringValue();
    }

    private static String nullableText(JsonNode value) {
        return value != null && value.isNull() ? null : text(value);
    }

    private static long integer(JsonNode value) {
        if (value == null || !value.isIntegralNumber() || !value.canConvertToLong()) throw invalid();
        return value.longValue();
    }

    private static Instant instant(JsonNode value) {
        if (value != null && value.isNull()) return null;
        long second = integer(value);
        if (second < 1 || second > MAX_EPOCH_SECOND) throw invalid();
        return Instant.ofEpochSecond(second);
    }

    private static Instant normalizedExpiry(Instant value) {
        if (value == null || value.getEpochSecond() < 1 || value.getEpochSecond() > MAX_EPOCH_SECOND) throw invalid();
        return Instant.ofEpochSecond(value.getEpochSecond());
    }

    private static void requireToken(String token) {
        if (token == null || token.isEmpty() || token.length() > MAX_TOKEN_LENGTH) throw invalid();
        for (int i = 0; i < token.length(); i++) {
            char character = token.charAt(i);
            if (character < 0x21 || character > 0x7e) throw invalid();
        }
    }

    private static void requireClaim(String claimId) {
        if (claimId == null || claimId.length() != 36) throw invalid();
        try {
            if (!UUID.fromString(claimId).toString().equals(claimId)) throw invalid();
        } catch (IllegalArgumentException failure) {
            throw invalid();
        }
    }

    private static void erase(byte[] bytes) {
        if (bytes != null) Arrays.fill(bytes, (byte) 0);
    }

    private static GithubReauthenticationRequiredException invalid() {
        return new GithubReauthenticationRequiredException("CREDENTIAL_INVALID");
    }

    public enum State {
        ACTIVE,
        REFRESH_PENDING,
        REAUTH_REQUIRED
    }

    /** Instants are stored at epoch-second precision; checking actual expiration is the caller's job. */
    public record Envelope(
            State state,
            String clientId,
            long githubId,
            String accessToken,
            Instant accessExpiresAt,
            String refreshToken,
            Instant refreshExpiresAt,
            String claimId) {

        public Envelope {
            if (state == null
                    || clientId == null
                    || clientId.isEmpty()
                    || clientId.length() > 200
                    || !clientId.matches("[A-Za-z0-9._-]+")
                    || githubId <= 0) throw invalid();
            if (state == State.ACTIVE) {
                if (claimId != null) throw invalid();
                requireToken(accessToken);
                requireToken(refreshToken);
                accessExpiresAt = normalizedExpiry(accessExpiresAt);
                refreshExpiresAt = normalizedExpiry(refreshExpiresAt);
            } else {
                if (accessToken != null
                        || refreshToken != null
                        || accessExpiresAt != null
                        || refreshExpiresAt != null) {
                    throw invalid();
                }
                if (state == State.REFRESH_PENDING) requireClaim(claimId);
                else if (claimId != null) throw invalid();
            }
        }

        public static Envelope active(
                String clientId,
                long githubId,
                String access,
                Instant accessExpiry,
                String refresh,
                Instant refreshExpiry) {
            return new Envelope(State.ACTIVE, clientId, githubId, access, accessExpiry, refresh, refreshExpiry, null);
        }

        public Envelope pending(String uuid) {
            return new Envelope(State.REFRESH_PENDING, clientId, githubId, null, null, null, null, uuid);
        }

        public Envelope rejected() {
            return new Envelope(State.REAUTH_REQUIRED, clientId, githubId, null, null, null, null, null);
        }

        @Override
        public String toString() {
            return "GithubDeviceCredentialEnvelope[redacted]";
        }
    }
}
