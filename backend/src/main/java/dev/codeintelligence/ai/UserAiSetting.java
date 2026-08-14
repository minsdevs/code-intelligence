package dev.codeintelligence.ai;

import dev.codeintelligence.auth.EncryptedToken;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;

/** One AI provider key per user, encrypted at rest (AES-256-GCM). */
@Entity
@Table(name = "user_ai_settings")
public class UserAiSetting {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(nullable = false)
    private String provider;

    @Column(name = "encrypted_key", nullable = false)
    private String encryptedKey;

    @Column(nullable = false)
    private byte[] nonce;

    @Column(name = "key_version", nullable = false)
    private int keyVersion;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected UserAiSetting() {}

    public UserAiSetting(Long userId, String provider, EncryptedToken token) {
        this.userId = userId;
        setProviderAndToken(provider, token);
    }

    public void update(String provider, EncryptedToken token) {
        setProviderAndToken(provider, token);
    }

    private void setProviderAndToken(String provider, EncryptedToken token) {
        this.provider = provider;
        this.encryptedKey = token.ciphertext();
        this.nonce = token.nonce();
        this.keyVersion = token.keyVersion();
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
        updatedAt = createdAt;
    }

    @PreUpdate
    void onUpdate() {
        updatedAt = Instant.now();
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public String getProvider() {
        return provider;
    }

    public String getEncryptedKey() {
        return encryptedKey;
    }

    public byte[] getNonce() {
        return nonce;
    }

    public int getKeyVersion() {
        return keyVersion;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    /** Deliberately excludes key material. */
    @Override
    public String toString() {
        return "UserAiSetting{id=%s, userId=%s, provider=%s, keyVersion=%d}"
                .formatted(id, userId, provider, keyVersion);
    }
}
