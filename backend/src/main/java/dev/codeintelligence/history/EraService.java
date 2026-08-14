package dev.codeintelligence.history;

import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class EraService {

    public record EraView(String label, String path, String sha, String committedAt, String changeType) {}

    private final ProjectRepository projectRepository;
    private final JdbcClient jdbc;

    public EraService(ProjectRepository projectRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<EraView> list(long projectId, long userId) {
        requireOwned(projectId, userId);
        return jdbc.sql("""
                        select c.sha, c.committed_at, cf.path, cf.change_type
                        from commit_files cf
                        join commits c on c.id = cf.commit_id
                        where c.project_id = :projectId
                          and (
                              cf.path in (
                                  'pom.xml', 'package.json', 'docker-compose.yml', 'docker-compose.yaml',
                                  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'go.mod',
                                  'requirements.txt', 'pyproject.toml')
                              or cf.path like '%.tf'
                              or cf.path like '%/package.json'
                              or cf.path like '%/pom.xml'
                              or cf.path like '%/docker-compose.yml'
                              or cf.path like '%/build.gradle'
                          )
                        order by c.committed_at nulls last, cf.path
                        """)
                .param("projectId", projectId)
                .query((rs, rowNum) -> {
                    String path = rs.getString("path");
                    String change = rs.getString("change_type");
                    String verb = "ADD".equals(change) ? "Introduced" : "MODIFY".equals(change) ? "Updated" : change;
                    return new EraView(
                            verb + " " + filename(path),
                            path,
                            rs.getString("sha"),
                            rs.getObject("committed_at") == null
                                    ? null
                                    : rs.getObject("committed_at").toString(),
                            change);
                })
                .list();
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private static String filename(String path) {
        if (path == null) {
            return "";
        }
        String normalized = path.replace('\\', '/');
        int slash = normalized.lastIndexOf('/');
        return slash < 0 ? normalized : normalized.substring(slash + 1);
    }
}
