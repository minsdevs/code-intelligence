package dev.codeintelligence.project;

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
@Table(name = "projects")
public class Project {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(nullable = false)
    private String name;

    @Column(name = "repo_owner", nullable = false)
    private String repoOwner;

    @Column(name = "repo_name", nullable = false)
    private String repoName;

    @Column(name = "default_branch")
    private String defaultBranch;

    @Column(name = "clone_path")
    private String clonePath;

    @Column(name = "current_snapshot_id")
    private Long currentSnapshotId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Project() {}

    public Project(long userId, String name, String repoOwner, String repoName) {
        this.userId = userId;
        this.name = name;
        this.repoOwner = repoOwner;
        this.repoName = repoName;
    }

    public void assignClonePath(String clonePath) {
        this.clonePath = clonePath;
    }

    public void updateDefaultBranch(String defaultBranch) {
        this.defaultBranch = defaultBranch;
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

    public String getName() {
        return name;
    }

    public String getRepoOwner() {
        return repoOwner;
    }

    public String getRepoName() {
        return repoName;
    }

    public String getDefaultBranch() {
        return defaultBranch;
    }

    public String getClonePath() {
        return clonePath;
    }

    public Long getCurrentSnapshotId() {
        return currentSnapshotId;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
