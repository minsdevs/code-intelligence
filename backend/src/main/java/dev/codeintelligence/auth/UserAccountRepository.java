package dev.codeintelligence.auth;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserAccountRepository extends JpaRepository<UserAccount, Long> {

    Optional<UserAccount> findByGithubId(long githubId);

    Optional<UserAccount> findByLocalKey(String localKey);
}
