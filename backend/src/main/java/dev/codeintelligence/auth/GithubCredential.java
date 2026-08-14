package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.CredentialKind;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;

@Entity
@Table(name = "github_credentials")
public class GithubCredential {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private CredentialKind kind;

    @Column(name = "encrypted_token", nullable = false)
    private String encryptedToken;

    @Column(nullable = false)
    private byte[] nonce;

    @Column(name = "key_version", nullable = false)
    private int keyVersion;

    private String scopes;

    @Column(name = "expires_at")
    private Instant expiresAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected GithubCredential() {}

    public GithubCredential(Long userId, CredentialKind kind, EncryptedToken token, String scopes) {
        this.userId = userId;
        this.kind = kind;
        this.scopes = scopes;
        applyToken(token);
    }

    public void updateToken(EncryptedToken token, String scopes) {
        this.scopes = scopes;
        applyToken(token);
    }

    private void applyToken(EncryptedToken token) {
        this.encryptedToken = token.ciphertext();
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

    public CredentialKind getKind() {
        return kind;
    }

    public String getEncryptedToken() {
        return encryptedToken;
    }

    public byte[] getNonce() {
        return nonce;
    }

    public int getKeyVersion() {
        return keyVersion;
    }

    public String getScopes() {
        return scopes;
    }

    /** Deliberately excludes token material. */
    @Override
    public String toString() {
        return "GithubCredential{id=%s, userId=%s, kind=%s, keyVersion=%d}".formatted(id, userId, kind, keyVersion);
    }
}
