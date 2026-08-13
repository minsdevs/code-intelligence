package dev.codeintelligence.auth;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

/**
 * AES-256-GCM for GitHub tokens (§18 carry-over ①). Fails fast at startup when TOKEN_ENC_KEY is
 * missing or not exactly 32 bytes; the key material itself is never included in any message.
 */
@Service
public class TokenCryptoService {

    static final int CURRENT_KEY_VERSION = 1;
    private static final int KEY_LENGTH_BYTES = 32;
    private static final int NONCE_LENGTH_BYTES = 12;
    private static final int GCM_TAG_LENGTH_BITS = 128;
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private final SecretKey key;
    private final SecureRandom secureRandom = new SecureRandom();

    public TokenCryptoService(TokenCryptoProperties properties) {
        if (!StringUtils.hasText(properties.tokenEncKey())) {
            throw new IllegalStateException(
                    "TOKEN_ENC_KEY is required to start the backend. Generate one with: openssl rand -base64 32");
        }
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(properties.tokenEncKey().strip());
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException(
                    "TOKEN_ENC_KEY must be valid base64. Generate one with: openssl rand -base64 32");
        }
        if (decoded.length != KEY_LENGTH_BYTES) {
            throw new IllegalStateException("TOKEN_ENC_KEY must decode to exactly 32 bytes for AES-256, but decoded to "
                    + decoded.length + " bytes. Generate one with: openssl rand -base64 32");
        }
        this.key = new SecretKeySpec(decoded, "AES");
    }

    public EncryptedToken encrypt(String plaintext) {
        byte[] nonce = new byte[NONCE_LENGTH_BYTES];
        secureRandom.nextBytes(nonce);
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, nonce));
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return new EncryptedToken(
                    CURRENT_KEY_VERSION, nonce, Base64.getEncoder().encodeToString(ciphertext));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Token encryption failed", e);
        }
    }

    public String decrypt(int keyVersion, byte[] nonce, String ciphertextBase64) {
        if (keyVersion != CURRENT_KEY_VERSION) {
            throw new IllegalStateException("Unsupported token key version: " + keyVersion);
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, nonce));
            byte[] plaintext = cipher.doFinal(Base64.getDecoder().decode(ciphertextBase64));
            return new String(plaintext, StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IllegalStateException("Token decryption failed", e);
        }
    }
}
