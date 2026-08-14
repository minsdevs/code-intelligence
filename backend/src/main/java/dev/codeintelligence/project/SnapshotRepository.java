package dev.codeintelligence.project;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SnapshotRepository extends JpaRepository<Snapshot, Long> {

    Optional<Snapshot> findByIdAndProjectId(long id, long projectId);
}
