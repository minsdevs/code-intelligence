package dev.codeintelligence.analysis.core;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FileService {

    public record FileListItem(String path, String language, long size, Integer lineCount) {}

    public record FileContent(String path, String language, String content) {}

    public record LanguageCount(String language, long count) {}

    public record ProjectStats(long fileCount, List<LanguageCount> languages) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;
    private final AppProperties appProperties;
    private final AnalysisProperties analysisProperties;

    public FileService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            JdbcClient jdbc,
            AppProperties appProperties,
            AnalysisProperties analysisProperties) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
        this.appProperties = appProperties;
        this.analysisProperties = analysisProperties;
    }

    @Transactional(readOnly = true)
    public List<FileListItem> listFiles(long projectId, long userId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        return jdbc.sql("""
                        select path, language, size, line_count
                        from files where snapshot_id = :snapshotId order by path
                        """)
                .param("snapshotId", resolved)
                .query((rs, rowNum) ->
                        new FileListItem(rs.getString("path"), rs.getString("language"), rs.getLong("size"), (Integer)
                                rs.getObject("line_count")))
                .list();
    }

    @Transactional(readOnly = true)
    public FileContent fileContent(long projectId, long userId, String path, Long snapshotId) {
        String normalized = SafeRelativePath.normalize(path);
        Project project = requireOwned(projectId, userId);
        long resolved = requireSnapshot(project, snapshotId);
        FileListItem meta = jdbc.sql("""
                        select path, language, size, line_count
                        from files where snapshot_id = :snapshotId and path = :path
                        """)
                .param("snapshotId", resolved)
                .param("path", normalized)
                .query((rs, rowNum) ->
                        new FileListItem(rs.getString("path"), rs.getString("language"), rs.getLong("size"), (Integer)
                                rs.getObject("line_count")))
                .optional()
                .orElseThrow(ProjectFileNotFoundException::new);
        if (project.getClonePath() == null) {
            throw new ProjectFileNotFoundException();
        }
        Path cloneRoot = Path.of(project.getClonePath()).toAbsolutePath().normalize();
        Path reposRoot = appProperties.reposRoot();
        if (!cloneRoot.startsWith(reposRoot) || cloneRoot.equals(reposRoot)) {
            throw new InvalidFilePathException();
        }
        Path file = SafeRelativePath.resolve(cloneRoot, meta.path());
        if (!Files.isRegularFile(file)) {
            throw new ProjectFileNotFoundException();
        }
        try {
            if (Files.size(file) > analysisProperties.maxFileSize()) {
                throw new FileTooLargeException();
            }
            byte[] bytes = Files.readAllBytes(file);
            if (BinaryFiles.isBinary(meta.path(), bytes)) {
                throw new BinaryFileException();
            }
            return new FileContent(meta.path(), meta.language(), new String(bytes, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new ProjectFileNotFoundException();
        }
    }

    @Transactional(readOnly = true)
    public ProjectStats stats(long projectId, long userId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        Long fileCount = jdbc.sql("select count(*) from files where snapshot_id = :snapshotId")
                .param("snapshotId", resolved)
                .query(Long.class)
                .single();
        List<LanguageCount> languages = jdbc.sql("""
                        select language, count(*) as cnt
                        from files where snapshot_id = :snapshotId
                        group by language
                        order by cnt desc, language nulls last
                        """)
                .param("snapshotId", resolved)
                .query((rs, rowNum) -> new LanguageCount(rs.getString("language"), rs.getLong("cnt")))
                .list();
        return new ProjectStats(fileCount, languages);
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
