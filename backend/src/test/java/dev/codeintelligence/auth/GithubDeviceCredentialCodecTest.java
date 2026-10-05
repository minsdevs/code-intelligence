package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.auth.GithubDeviceCredentialCodec.Envelope;
import dev.codeintelligence.auth.GithubDeviceCredentialCodec.State;
import dev.codeintelligence.common.security.CredentialKind;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.stream.Stream;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.json.JsonMapper;

class GithubDeviceCredentialCodecTest {

    // The existing TokenCryptoServiceTest's public fixture, never an application key.
    private static final String KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    private static final long USER_ID = 17L;
    private static final String CLIENT_ID = "Iv-fixture.client_2";
    private static final String ACCESS = "fixture-access-secret";
    private static final String REFRESH = "fixture-refresh-secret";
    private static final String CLAIM = "a3e1cbd2-829f-4357-9a60-5307f53e5b46";
    private static final Instant ACCESS_EXPIRY = Instant.ofEpochSecond(1_800_000_000L, 987_654_321);
    private static final Instant REFRESH_EXPIRY = Instant.ofEpochSecond(1_815_552_000L, 123_456_789);
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final GithubDeviceCredentialCodec codec = new GithubDeviceCredentialCodec(new TokenCryptoProperties(KEY));

    @Test
    void v2RoundTripNormalizesDatesAndDoesNotExposeSecrets() {
        Envelope original = active();
        EncryptedToken encrypted = codec.encrypt(USER_ID, original);
        assertThat(encrypted.keyVersion()).isEqualTo(2);
        assertThat(encrypted.nonce()).hasSize(12);
        assertThat(encrypted.ciphertext()).doesNotContain(ACCESS, REFRESH);
        Envelope decoded = decrypt(encrypted);
        assertThat(decoded).isEqualTo(original);
        assertThat(decoded.state()).isEqualTo(State.ACTIVE);
        assertThat(decoded.clientId()).isEqualTo(CLIENT_ID);
        assertThat(decoded.githubId()).isEqualTo(42L);
        assertThat(decoded.accessToken()).isEqualTo(ACCESS);
        assertThat(decoded.refreshToken()).isEqualTo(REFRESH);
        assertThat(decoded.accessExpiresAt()).isEqualTo(Instant.ofEpochSecond(1_800_000_000L));
        assertThat(decoded.refreshExpiresAt()).isEqualTo(Instant.ofEpochSecond(1_815_552_000L));
        assertThat(decoded.claimId()).isNull();
        assertThat(decoded.toString()).isEqualTo("GithubDeviceCredentialEnvelope[redacted]");
    }

    @Test
    void encryptionAlwaysUsesAFreshNonceAndDecryptionLeavesInputUnchanged() {
        EncryptedToken first = codec.encrypt(USER_ID, active());
        EncryptedToken second = codec.encrypt(USER_ID, active());
        byte[] firstNonce = first.nonce().clone();
        assertThat(first.nonce()).isNotEqualTo(second.nonce());
        assertThat(first.ciphertext()).isNotEqualTo(second.ciphertext());
        assertThat(decrypt(first)).isEqualTo(decrypt(second));
        assertThat(first.nonce()).containsExactly(firstNonce);
    }

    @Test
    void legacySharedCryptoStillWorksButDoesNotDecodeV2EvenAfterMetadataDowngrade() {
        var legacy = new TokenCryptoService(new TokenCryptoProperties(KEY));
        EncryptedToken v1 = legacy.encrypt(ACCESS);
        assertThat(v1.keyVersion()).isEqualTo(1);
        assertThat(legacy.decrypt(v1.keyVersion(), v1.nonce(), v1.ciphertext())).isEqualTo(ACCESS);
        assertInvalid(() -> codec.decrypt(USER_ID, CredentialKind.OAUTH, 1, v1.nonce(), v1.ciphertext()));

        EncryptedToken v2 = codec.encrypt(USER_ID, active());
        assertThatThrownBy(() -> legacy.decrypt(2, v2.nonce(), v2.ciphertext()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Unsupported token key version");
        assertThatThrownBy(() -> legacy.decrypt(1, v2.nonce(), v2.ciphertext()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Token decryption failed");

        EncryptedToken legacyJson = legacy.encrypt(validJson());
        assertInvalid(
                () -> codec.decrypt(USER_ID, CredentialKind.OAUTH, 2, legacyJson.nonce(), legacyJson.ciphertext()));
    }

    @Test
    void rejectsWrongOwnerKindVersionAndKey() {
        EncryptedToken encrypted = codec.encrypt(USER_ID, active());
        for (long owner : new long[] {0L, -1L, USER_ID + 1}) {
            assertInvalid(
                    () -> codec.decrypt(owner, CredentialKind.OAUTH, 2, encrypted.nonce(), encrypted.ciphertext()));
        }
        for (CredentialKind kind : new CredentialKind[] {null, CredentialKind.LOCAL, CredentialKind.PAT}) {
            assertInvalid(() -> codec.decrypt(USER_ID, kind, 2, encrypted.nonce(), encrypted.ciphertext()));
        }
        for (int version : new int[] {0, 1, 3, -1}) {
            assertInvalid(() ->
                    codec.decrypt(USER_ID, CredentialKind.OAUTH, version, encrypted.nonce(), encrypted.ciphertext()));
        }
        byte[] otherFixtureKey = new byte[32];
        Arrays.fill(otherFixtureKey, (byte) 7);
        var other = new GithubDeviceCredentialCodec(
                new TokenCryptoProperties(Base64.getEncoder().encodeToString(otherFixtureKey)));
        Arrays.fill(otherFixtureKey, (byte) 0);
        assertInvalid(() -> other.decrypt(USER_ID, CredentialKind.OAUTH, 2, encrypted.nonce(), encrypted.ciphertext()));
        assertInvalid(() -> codec.encrypt(0, active()));
        assertInvalid(() -> codec.encrypt(-1, active()));
        assertInvalid(() -> codec.encrypt(USER_ID, null));
        assertThat(decrypt(encrypted)).isEqualTo(active());
    }

    @Test
    void rejectsAlteredCiphertextTagAndNonceWithoutPrivateCauses() {
        EncryptedToken encrypted = codec.encrypt(USER_ID, active());
        byte[] bytes = Base64.getDecoder().decode(encrypted.ciphertext());
        for (int index : new int[] {0, bytes.length / 2, bytes.length - 1}) {
            byte[] changed = bytes.clone();
            changed[index] ^= 1;
            String ciphertext = Base64.getEncoder().encodeToString(changed);
            assertInvalid(() -> codec.decrypt(USER_ID, CredentialKind.OAUTH, 2, encrypted.nonce(), ciphertext));
        }
        byte[] nonce = encrypted.nonce().clone();
        nonce[0] ^= 1;
        assertInvalid(() -> codec.decrypt(USER_ID, CredentialKind.OAUTH, 2, nonce, encrypted.ciphertext()));
        String truncated = Base64.getEncoder().encodeToString(Arrays.copyOf(bytes, bytes.length - 1));
        assertInvalid(() -> codec.decrypt(USER_ID, CredentialKind.OAUTH, 2, encrypted.nonce(), truncated));
    }

    @Test
    void rejectsUnboundedMalformedAndMissingCipherInputs() {
        EncryptedToken encrypted = codec.encrypt(USER_ID, active());
        for (byte[] nonce : new byte[][] {null, new byte[0], new byte[11], new byte[13]}) {
            assertInvalid(() -> codec.decrypt(USER_ID, CredentialKind.OAUTH, 2, nonce, encrypted.ciphertext()));
        }
        for (String ciphertext : new String[] {
            null,
            "",
            "%%%private-provider-data",
            "AA",
            "A".repeat(20_000),
            " ",
            "한글",
            encrypted.ciphertext() + "\n",
            Base64.getEncoder().encodeToString(new byte[16])
        }) {
            assertInvalid(() -> codec.decrypt(USER_ID, CredentialKind.OAUTH, 2, encrypted.nonce(), ciphertext));
        }
    }

    @Test
    void pendingAndRejectedDropBothTokensAndExpiriesAndKeepOnlyThePendingClaim() throws Exception {
        Envelope original = active();
        Envelope pending = original.pending(CLAIM);
        Envelope rejected = pending.rejected();
        assertThat(original.accessToken()).isEqualTo(ACCESS);
        for (Envelope state : new Envelope[] {pending, rejected}) {
            assertThat(state.clientId()).isEqualTo(CLIENT_ID);
            assertThat(state.githubId()).isEqualTo(42L);
            assertThat(state.accessToken()).isNull();
            assertThat(state.refreshToken()).isNull();
            assertThat(state.accessExpiresAt()).isNull();
            assertThat(state.refreshExpiresAt()).isNull();
            assertThat(state.toString()).isEqualTo("GithubDeviceCredentialEnvelope[redacted]");
            EncryptedToken encrypted = codec.encrypt(USER_ID, state);
            assertThat(decrypt(encrypted)).isEqualTo(state);
            byte[] plaintext = openFixture(encrypted);
            try {
                var body = JSON.readTree(plaintext);
                assertThat(body.size()).isEqualTo(10);
                for (String field :
                        new String[] {"accessToken", "refreshToken", "accessExpiresAt", "refreshExpiresAt"}) {
                    assertThat(body.get(field).isNull()).isTrue();
                }
                assertThat(new String(plaintext, StandardCharsets.UTF_8)).doesNotContain(ACCESS, REFRESH);
                assertThat(body.get("claimId").isNull()).isEqualTo(state.state() == State.REAUTH_REQUIRED);
            } finally {
                Arrays.fill(plaintext, (byte) 0);
            }
        }
        assertThat(pending.state()).isEqualTo(State.REFRESH_PENDING);
        assertThat(pending.claimId()).isEqualTo(CLAIM);
        assertThat(rejected.state()).isEqualTo(State.REAUTH_REQUIRED);
        assertThat(rejected.claimId()).isNull();
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"", "not-a-uuid", "1-1-1-1-1", "A3E1CBD2-829F-4357-9A60-5307F53E5B46"})
    void rejectsNonCanonicalPendingClaims(String claim) {
        assertInvalid(() -> active().pending(claim));
    }

    @Test
    void rejectsInvalidEnvelopeShapesAndStateCombinations() {
        assertInvalid(() -> new Envelope(null, CLIENT_ID, 42, ACCESS, ACCESS_EXPIRY, REFRESH, REFRESH_EXPIRY, null));
        assertInvalid(
                () -> new Envelope(State.ACTIVE, CLIENT_ID, 42, ACCESS, ACCESS_EXPIRY, REFRESH, REFRESH_EXPIRY, CLAIM));
        for (State state : new State[] {State.REFRESH_PENDING, State.REAUTH_REQUIRED}) {
            String claim = state == State.REFRESH_PENDING ? CLAIM : null;
            assertInvalid(() -> new Envelope(state, CLIENT_ID, 42, ACCESS, null, null, null, claim));
            assertInvalid(() -> new Envelope(state, CLIENT_ID, 42, null, null, REFRESH, null, claim));
            assertInvalid(() -> new Envelope(state, CLIENT_ID, 42, null, ACCESS_EXPIRY, null, null, claim));
            assertInvalid(() -> new Envelope(state, CLIENT_ID, 42, null, null, null, REFRESH_EXPIRY, claim));
        }
        assertInvalid(() -> new Envelope(State.REFRESH_PENDING, CLIENT_ID, 42, null, null, null, null, null));
        assertInvalid(() -> new Envelope(State.REAUTH_REQUIRED, CLIENT_ID, 42, null, null, null, null, CLAIM));
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(
            strings = {"", " ", "Iv client", "https://github.com", "client/other", "client\n", "한글", "client+value"})
    void rejectsUnsafeClientIds(String client) {
        assertInvalid(() -> Envelope.active(client, 42, ACCESS, ACCESS_EXPIRY, REFRESH, REFRESH_EXPIRY));
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(
            strings = {"", " ", "two tokens", "token\t", "token\n", "token\r", "token\u007f", "tökén", "token\u0000"})
    void rejectsMissingWhitespaceAndNonAsciiTokens(String token) {
        assertInvalid(() -> Envelope.active(CLIENT_ID, 42, token, ACCESS_EXPIRY, REFRESH, REFRESH_EXPIRY));
        assertInvalid(() -> Envelope.active(CLIENT_ID, 42, ACCESS, ACCESS_EXPIRY, token, REFRESH_EXPIRY));
    }

    @Test
    void boundsIdsDatesAndTokenSizesWithoutTreatingPastExpiriesAsCodecErrors() {
        Envelope maximum = Envelope.active(
                "x".repeat(200),
                Long.MAX_VALUE,
                "a".repeat(4096),
                Instant.ofEpochSecond(1),
                "r".repeat(4096),
                Instant.ofEpochSecond(253402300799L));
        assertThat(decrypt(codec.encrypt(USER_ID, maximum))).isEqualTo(maximum);
        assertInvalid(() -> Envelope.active("x".repeat(201), 42, ACCESS, ACCESS_EXPIRY, REFRESH, REFRESH_EXPIRY));
        for (long id : new long[] {0, -1}) {
            assertInvalid(() -> Envelope.active(CLIENT_ID, id, ACCESS, ACCESS_EXPIRY, REFRESH, REFRESH_EXPIRY));
        }
        assertInvalid(() -> Envelope.active(CLIENT_ID, 42, "a".repeat(4097), ACCESS_EXPIRY, REFRESH, REFRESH_EXPIRY));
        assertInvalid(() -> Envelope.active(CLIENT_ID, 42, ACCESS, ACCESS_EXPIRY, "r".repeat(4097), REFRESH_EXPIRY));
        for (Instant expiry : new Instant[] {
            null,
            Instant.EPOCH,
            Instant.ofEpochSecond(-1),
            Instant.MIN,
            Instant.MAX,
            Instant.ofEpochSecond(253402300800L)
        }) {
            assertInvalid(() -> Envelope.active(CLIENT_ID, 42, ACCESS, expiry, REFRESH, REFRESH_EXPIRY));
            assertInvalid(() -> Envelope.active(CLIENT_ID, 42, ACCESS, ACCESS_EXPIRY, REFRESH, expiry));
        }
        // Two legal tokens can still exceed the independent wire limit after JSON escaping.
        Envelope excessiveWireSize =
                Envelope.active(CLIENT_ID, 42, "\\".repeat(4096), ACCESS_EXPIRY, "\\".repeat(4096), REFRESH_EXPIRY);
        assertInvalid(() -> codec.encrypt(USER_ID, excessiveWireSize));
    }

    @Test
    void independentWireFixtureHasAPositiveControlAndAnExactByteBoundary() throws Exception {
        byte[] valid = validJson().getBytes(StandardCharsets.UTF_8);
        assertThat(decrypt(sealFixture(valid))).isEqualTo(active());
        String boundary = validJson() + " ".repeat(12 * 1024 - valid.length);
        byte[] exact = boundary.getBytes(StandardCharsets.UTF_8);
        assertThat(exact).hasSize(12 * 1024);
        assertThat(decrypt(sealFixture(exact))).isEqualTo(active());
        assertInvalid(() -> decrypt(sealFixture((boundary + " ").getBytes(StandardCharsets.UTF_8))));

        Envelope punctuation = Envelope.active(
                CLIENT_ID, 42, "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", ACCESS_EXPIRY, "refresh=+/_-", REFRESH_EXPIRY);
        assertThat(decrypt(codec.encrypt(USER_ID, punctuation))).isEqualTo(punctuation);
    }

    @ParameterizedTest
    @MethodSource("invalidBodies")
    void rejectsAuthenticatedButMalformedJsonAndExactFieldViolations(String plaintext) throws Exception {
        EncryptedToken malformed = sealFixture(plaintext.getBytes(StandardCharsets.UTF_8));
        assertInvalid(() -> decrypt(malformed));
    }

    static Stream<String> invalidBodies() {
        String json = validJson();
        String pending = json.replace("\"ACTIVE\"", "\"REFRESH_PENDING\"");
        return Stream.of(
                "",
                "null",
                "[]",
                "{}",
                "{private-provider-data",
                json + "{}",
                json + " true",
                json.replace("\"format\":2", "\"format\":1"),
                json.replace("\"format\":2", "\"format\":\"2\""),
                json.replace("\"format\":2", "\"format\":2.0"),
                json.replace("\"format\":2", "\"format\":2,\"format\":2"),
                json.replace("\"origin\":\"GITHUB_APP_DEVICE\"", "\"origin\":\"OAUTH_APP\""),
                json.replace("\"origin\":\"GITHUB_APP_DEVICE\"", "\"origin\":null"),
                json.replace("\"state\":\"ACTIVE\"", "\"state\":\"ACTIVE\",\"state\":\"REAUTH_REQUIRED\""),
                json.replace("\"state\":\"ACTIVE\"", "\"state\":\"private-provider-data\""),
                json.replace("\"claimId\":null", "\"claimId\":null,\"extra\":null"),
                json.replace("\"claimId\":null", "\"unknown\":null"),
                json.replace(",\n  \"claimId\":null", ""),
                json.replace("\"clientId\":\"" + CLIENT_ID + "\"", "\"clientId\":42"),
                json.replace(CLIENT_ID, "client with space"),
                json.replace("\"githubId\":42", "\"githubId\":0"),
                json.replace("\"githubId\":42", "\"githubId\":-1"),
                json.replace("\"githubId\":42", "\"githubId\":42.0"),
                json.replace("\"githubId\":42", "\"githubId\":\"42\""),
                json.replace("\"githubId\":42", "\"githubId\":9223372036854775808"),
                json.replace("\"accessToken\":\"" + ACCESS + "\"", "\"accessToken\":null"),
                json.replace(
                        "\"accessToken\":\"" + ACCESS + "\"", "\"accessToken\":{\"secret\":\"private-provider-data\"}"),
                json.replace(ACCESS, "a".repeat(4097)),
                json.replace(REFRESH, "r".repeat(4097)),
                json.replace(ACCESS, "token\\u0000"),
                json.replace(ACCESS, "token\\ud800"),
                json.replace("\"accessExpiresAt\":1800000000", "\"accessExpiresAt\":null"),
                json.replace("\"accessExpiresAt\":1800000000", "\"accessExpiresAt\":0"),
                json.replace("\"accessExpiresAt\":1800000000", "\"accessExpiresAt\":253402300800"),
                json.replace("\"accessExpiresAt\":1800000000", "\"accessExpiresAt\":1800000000.0"),
                json.replace("\"refreshExpiresAt\":1815552000", "\"refreshExpiresAt\":\"1815552000\""),
                json.replace("\"claimId\":null", "\"claimId\":\"" + CLAIM + "\""),
                pending.replace("\"claimId\":null", "\"claimId\":\"" + CLAIM + "\""),
                json.replace("\"ACTIVE\"", "\"REAUTH_REQUIRED\""),
                json.replace("\"origin\"", "/* comment */ \"origin\""),
                json.replace("\"format\":2", "\"format\":NaN"),
                json.replace("\"claimId\":null", "\"claimId\":[[[null]]]"));
    }

    @Test
    void rejectsInvalidEncodingOversizedPlaintextAndWrongAuthenticatedDomain() throws Exception {
        byte[] invalidUtf8 = validJson().getBytes(StandardCharsets.UTF_8);
        invalidUtf8[0] = (byte) 0xc0;
        assertInvalid(() -> decrypt(sealFixture(invalidUtf8)));
        assertInvalid(() -> decrypt(sealFixture(validJson().getBytes(StandardCharsets.UTF_16LE))));
        assertInvalid(() ->
                decrypt(sealFixture((" ".repeat(12 * 1024) + validJson()).getBytes(StandardCharsets.UTF_8))));
        byte[] plaintext = validJson().getBytes(StandardCharsets.UTF_8);
        for (String aad : new String[] {
            "code-intelligence/github-device-credential\0002\00017\000PAT",
            "code-intelligence/github-device-credential\0001\00017\000OAUTH",
            "other-domain\0002\00017\000OAUTH"
        }) {
            assertInvalid(() -> decrypt(sealFixture(plaintext, aad.getBytes(StandardCharsets.US_ASCII))));
        }
    }

    @Test
    void constructorValidatesOnlyThePublicFixtureShapeAndNeverEchoesAnInvalidKey() {
        for (String key : new String[] {null, "", " ", "private-provider-data%%%", "YQ==", "A".repeat(48)}) {
            assertThatThrownBy(() -> new GithubDeviceCredentialCodec(new TokenCryptoProperties(key)))
                    .isInstanceOfSatisfying(IllegalStateException.class, error -> {
                        assertThat(error.getCause()).isNull();
                        assertThat(error.getMessage())
                                .contains("TOKEN_ENC_KEY")
                                .doesNotContain("private-provider-data");
                    });
        }
        assertThatThrownBy(() -> new GithubDeviceCredentialCodec(null)).isInstanceOf(IllegalStateException.class);
        var whitespace = new GithubDeviceCredentialCodec(new TokenCryptoProperties(" \n" + KEY + "\t"));
        EncryptedToken encrypted = whitespace.encrypt(USER_ID, active());
        assertThat(decrypt(encrypted)).isEqualTo(active());
        var unpadded = new GithubDeviceCredentialCodec(new TokenCryptoProperties(KEY.replace("=", "")));
        assertThat(decrypt(unpadded.encrypt(USER_ID, active()))).isEqualTo(active());
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "TOKEN_EXPIRED",
                "EXPIRY_UNKNOWN",
                "TOKEN_REJECTED",
                "REFRESH_IN_PROGRESS",
                "REFRESH_UNCERTAIN",
                "CREDENTIAL_INVALID",
                "CONNECTION_CHANGED",
                "CLIENT_CHANGED",
                "REFRESH_EXPIRED"
            })
    void exceptionPreservesOnlyFiniteReasons(String reason) {
        var error = new GithubReauthenticationRequiredException(reason);
        assertThat(error.getStatusCode().value()).isEqualTo(401);
        assertThat(error.getBody().getProperties())
                .containsEntry("code", "GITHUB_REAUTHENTICATION_REQUIRED")
                .containsEntry("reason", reason);
        assertThat(error.getBody().getDetail())
                .isEqualTo("GitHub authentication must be renewed before this request can continue.");
        assertThat(error.getCause()).isNull();
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"", "token_expired", " TOKEN_EXPIRED", "private-provider-data", "fixture-access-secret"})
    void exceptionRedactsUnknownReasons(String reason) {
        assertInvalid(() -> {
            throw new GithubReauthenticationRequiredException(reason);
        });
    }

    private Envelope decrypt(EncryptedToken encrypted) {
        return codec.decrypt(
                USER_ID, CredentialKind.OAUTH, encrypted.keyVersion(), encrypted.nonce(), encrypted.ciphertext());
    }

    private static Envelope active() {
        return Envelope.active(CLIENT_ID, 42L, ACCESS, ACCESS_EXPIRY, REFRESH, REFRESH_EXPIRY);
    }

    private static void assertInvalid(ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOfSatisfying(GithubReauthenticationRequiredException.class, error -> {
            assertThat(error.getStatusCode().value()).isEqualTo(401);
            assertThat(error.getBody().getProperties())
                    .containsEntry("code", "GITHUB_REAUTHENTICATION_REQUIRED")
                    .containsEntry("reason", "CREDENTIAL_INVALID");
            assertThat(error.getCause()).isNull();
            assertThat(error.getSuppressed()).isEmpty();
            assertThat(error.toString()).doesNotContain(ACCESS, REFRESH, CLAIM, "private-provider-data");
            assertThat(error.getBody().toString()).doesNotContain(ACCESS, REFRESH, CLAIM, "private-provider-data");
        });
    }

    private static String validJson() {
        return """
                {
                  "format":2,
                  "origin":"GITHUB_APP_DEVICE",
                  "state":"ACTIVE",
                  "clientId":"Iv-fixture.client_2",
                  "githubId":42,
                  "accessToken":"fixture-access-secret",
                  "accessExpiresAt":1800000000,
                  "refreshToken":"fixture-refresh-secret",
                  "refreshExpiresAt":1815552000,
                  "claimId":null
                }
                """;
    }

    // Independent wire fixture: malformed JSON still receives a valid tag, reaching the parser.
    private static byte[] fixtureAad() {
        return "code-intelligence/github-device-credential\0002\00017\000OAUTH".getBytes(StandardCharsets.US_ASCII);
    }

    private static EncryptedToken sealFixture(byte[] plaintext) throws Exception {
        return sealFixture(plaintext, fixtureAad());
    }

    private static EncryptedToken sealFixture(byte[] plaintext, byte[] aad) throws Exception {
        byte[] key = Base64.getDecoder().decode(KEY);
        byte[] ciphertext = null;
        byte[] nonce = new byte[12];
        new SecureRandom().nextBytes(nonce);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(aad);
            ciphertext = cipher.doFinal(plaintext);
            return new EncryptedToken(2, nonce, Base64.getEncoder().encodeToString(ciphertext));
        } finally {
            Arrays.fill(key, (byte) 0);
            if (ciphertext != null) Arrays.fill(ciphertext, (byte) 0);
        }
    }

    private static byte[] openFixture(EncryptedToken encrypted) throws Exception {
        byte[] key = Base64.getDecoder().decode(KEY);
        byte[] ciphertext = Base64.getDecoder().decode(encrypted.ciphertext());
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                    Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, encrypted.nonce()));
            cipher.updateAAD(fixtureAad());
            return cipher.doFinal(ciphertext);
        } finally {
            Arrays.fill(key, (byte) 0);
            Arrays.fill(ciphertext, (byte) 0);
        }
    }
}
