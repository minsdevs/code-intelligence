package dev.codeintelligence.auth;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;

@Entity
@Table(name = "users")
public class UserAccount {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "github_id", unique = true)
    private Long githubId;

    @Column(name = "local_key", unique = true)
    private String localKey;

    @Column(name = "identity_type", nullable = false)
    private String identityType;

    @Column(nullable = false)
    private String login;

    private String name;

    @Column(name = "avatar_url")
    private String avatarUrl;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected UserAccount() {}

    public UserAccount(long githubId, String login, String name, String avatarUrl) {
        this.githubId = githubId;
        this.login = login;
        this.name = name;
        this.avatarUrl = avatarUrl;
        this.identityType = "GITHUB";
    }

    public static UserAccount local(String localKey) {
        UserAccount account = new UserAccount();
        account.localKey = localKey;
        account.login = "local";
        account.name = "Local workspace";
        account.identityType = "LOCAL";
        return account;
    }

    public void updateProfile(String login, String name, String avatarUrl) {
        this.login = login;
        this.name = name;
        this.avatarUrl = avatarUrl;
    }

    public void linkGithub(long githubId, String login, String name, String avatarUrl) {
        this.githubId = githubId;
        updateProfile(login, name, avatarUrl);
        this.identityType = localKey == null ? "GITHUB" : "LOCAL_LINKED";
    }

    public void disconnectGithub() {
        if (localKey == null) {
            throw new IllegalStateException("A GitHub-only account cannot be disconnected without a local identity");
        }
        githubId = null;
        login = "local";
        name = "Local workspace";
        avatarUrl = null;
        identityType = "LOCAL";
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

    public Long getGithubId() {
        return githubId;
    }

    public String getLocalKey() {
        return localKey;
    }

    public String getIdentityType() {
        return identityType;
    }

    public String getLogin() {
        return login;
    }

    public String getName() {
        return name;
    }

    public String getAvatarUrl() {
        return avatarUrl;
    }
}
