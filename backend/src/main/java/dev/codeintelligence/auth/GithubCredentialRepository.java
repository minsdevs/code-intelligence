package dev.codeintelligence.auth;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface GithubCredentialRepository extends JpaRepository<GithubCredential, Long> {

    Optional<GithubCredential> findByUserIdAndKind(Long userId, CredentialKind kind);
}
