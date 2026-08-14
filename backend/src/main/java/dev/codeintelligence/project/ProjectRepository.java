package dev.codeintelligence.project;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProjectRepository extends JpaRepository<Project, Long> {

    Optional<Project> findByIdAndUserId(long id, long userId);

    List<Project> findAllByUserIdOrderByCreatedAtDesc(long userId);

    boolean existsByUserIdAndRepoOwnerAndRepoName(long userId, String repoOwner, String repoName);
}
