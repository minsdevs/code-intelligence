package dev.codeintelligence.analysis.config;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class InfraService {

    public record InfraResourceView(String kind, String name, String sourcePath, long nodeId) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;

    public InfraService(ProjectRepository projectRepository, SnapshotRepository snapshotRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<InfraResourceView> list(long projectId, long userId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        return jdbc.sql("""
                        select kind, name, source_path, node_id
                        from infra_resources
                        where snapshot_id = :snapshotId
                        order by kind, name
                        """)
                .param("snapshotId", resolved)
                .query((rs, rowNum) -> new InfraResourceView(
                        rs.getString("kind"), rs.getString("name"), rs.getString("source_path"), rs.getLong("node_id")))
                .list();
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private long requireSnapshot(Project project, Long snapshotId) {
        Long id = snapshotId != null ? snapshotId : project.getCurrentSnapshotId();
        if (id == null) {
            throw new SnapshotNotFoundException();
        }
        snapshotRepository.findByIdAndProjectId(id, project.getId()).orElseThrow(SnapshotNotFoundException::new);
        return id;
    }
}
