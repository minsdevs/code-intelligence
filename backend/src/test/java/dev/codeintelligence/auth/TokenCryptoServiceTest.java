package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class TokenCryptoServiceTest {

    private static final String VALID_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    private static final String SHORT_KEY = "MDEyMzQ1Njc4OWFiY2RlZg==";

    private final TokenCryptoService service = new TokenCryptoService(new TokenCryptoProperties(VALID_KEY));

    @Test
    void encryptDecryptRoundtrip() {
        EncryptedToken encrypted = service.encrypt("ghp_super-secret-token");

        assertThat(encrypted.ciphertext()).isNotEqualTo("ghp_super-secret-token");
        assertThat(service.decrypt(encrypted.keyVersion(), encrypted.nonce(), encrypted.ciphertext()))
                .isEqualTo("ghp_super-secret-token");
    }

    @Test
    void everyEncryptionUsesAFreshNonce() {
        EncryptedToken first = service.encrypt("same-plaintext");
        EncryptedToken second = service.encrypt("same-plaintext");

        assertThat(first.nonce()).hasSize(12).isNotEqualTo(second.nonce());
        assertThat(first.ciphertext()).isNotEqualTo(second.ciphertext());
    }

    @Test
    void recordsCurrentKeyVersion() {
        assertThat(service.encrypt("token").keyVersion()).isEqualTo(1);
    }

    @Test
    void missingKeyFailsFast() {
        assertThatThrownBy(() -> new TokenCryptoService(new TokenCryptoProperties("")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TOKEN_ENC_KEY is required");
        assertThatThrownBy(() -> new TokenCryptoService(new TokenCryptoProperties(null)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TOKEN_ENC_KEY is required");
    }

    @Test
    void non32ByteKeyFailsFastWithoutLeakingKeyMaterial() {
        assertThatThrownBy(() -> new TokenCryptoService(new TokenCryptoProperties(SHORT_KEY)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("32 bytes")
                .hasMessageContaining("decoded to 16")
                .satisfies(e -> assertThat(e.getMessage()).doesNotContain(SHORT_KEY));
    }

    @Test
    void invalidBase64KeyFailsFast() {
        assertThatThrownBy(() -> new TokenCryptoService(new TokenCryptoProperties("%%%not-base64%%%")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("valid base64");
    }

    @Test
    void decryptRejectsUnknownKeyVersion() {
        EncryptedToken encrypted = service.encrypt("token");

        assertThatThrownBy(() -> service.decrypt(2, encrypted.nonce(), encrypted.ciphertext()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("key version");
    }

    @Test
    void decryptRejectsTamperedCiphertext() {
        EncryptedToken encrypted = service.encrypt("token");
        EncryptedToken other = service.encrypt("other");

        assertThatThrownBy(() -> service.decrypt(encrypted.keyVersion(), other.nonce(), encrypted.ciphertext()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("decryption failed");
    }
}
