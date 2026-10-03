package dev.codeintelligence.analysis.core;

import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.Snapshot;
import dev.codeintelligence.project.SnapshotRepository;
import java.time.Instant;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FileService {

    public record FileListItem(String path, String language, long size, Integer lineCount, long resolvedSnapshotId) {}

    public record FileContent(
            String path,
            String language,
            String content,
            long resolvedSnapshotId,
            String contentOid,
            String sourceState,
            Instant snapshotTime,
            boolean currentSnapshot,
            String evidenceState) {}

    private record SourceRow(String path, String language, long size, String oid) {}

    private record EvidenceSource(String path) {}

    public record LanguageCount(String language, long count) {}

    public record ProjectStats(long fileCount, List<LanguageCount> languages) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;
    private final SnapshotBlobReader blobs;
    private final RetainedSnapshotReader retainedSource;

    public FileService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            JdbcClient jdbc,
            SnapshotBlobReader blobs,
            RetainedSnapshotReader retainedSource) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
        this.blobs = blobs;
        this.retainedSource = retainedSource;
    }

    @Transactional(readOnly = true)
    public List<FileListItem> listFiles(long projectId, long userId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        return jdbc.sql("""
                        select path, language, size, line_count
                        from files where snapshot_id = :snapshotId order by path
                        """)
                .param("snapshotId", resolved)
                .query((rs, rowNum) -> new FileListItem(
                        rs.getString("path"),
                        rs.getString("language"),
                        rs.getLong("size"),
                        (Integer) rs.getObject("line_count"),
                        resolved))
                .list();
    }

    @Transactional(readOnly = true)
    public FileContent fileContent(long projectId, long userId, String path, Long snapshotId) {
        return fileContent(projectId, userId, path, snapshotId, null);
    }

    @Transactional(readOnly = true)
    public FileContent fileContent(long projectId, long userId, String path, Long snapshotId, Long evidenceId) {
        Project project = requireOwned(projectId, userId);
        String normalized = SafeRelativePath.normalize(path);
        long resolved = requireSnapshot(project, snapshotId);
        if (evidenceId != null) {
            if (snapshotId == null) throw SnapshotSourceException.unknown();
            requireEvidence(projectId, resolved, normalized, evidenceId);
        }
        SourceRow meta = jdbc.sql("""
                        select path, language, size, content_hash from files
                        where snapshot_id = :snapshotId and path = :path
                        """)
                .param("snapshotId", resolved)
                .param("path", normalized)
                .query((rs, rowNum) -> new SourceRow(
                        rs.getString("path"),
                        rs.getString("language"),
                        rs.getLong("size"),
                        rs.getString("content_hash")))
                .optional()
                .orElseThrow(ProjectFileNotFoundException::new);
        String content = retainedSource
                .read(projectId, resolved, meta.path(), meta.oid(), meta.size())
                .orElseGet(() -> blobs.read(project.getClonePath(), meta.path(), meta.oid(), meta.size()));
        Snapshot snapshot = snapshotRepository
                .findByIdAndProjectId(resolved, projectId)
                .orElseThrow(SnapshotNotFoundException::new);
        return new FileContent(
                meta.path(),
                meta.language(),
                content,
                resolved,
                meta.oid(),
                "AVAILABLE",
                snapshot.getAnalyzedAt() != null ? snapshot.getAnalyzedAt() : snapshot.getCreatedAt(),
                Long.valueOf(resolved).equals(project.getCurrentSnapshotId()),
                evidenceId == null ? null : "LEGACY_SOURCE_UNVERIFIED");
    }

    private void requireEvidence(long projectId, long snapshotId, String path, long evidenceId) {
        // A client-supplied snapshot cannot retarget an evidence row to another snapshot's source.
        EvidenceSource evidence = jdbc.sql("select file_path from evidences where id=:id and project_id=:p")
                .param("id", evidenceId)
                .param("p", projectId)
                .query((rs, rowNum) -> new EvidenceSource(rs.getString("file_path")))
                .optional()
                .orElseThrow(ProjectFileNotFoundException::new);
        List<Long> contexts = jdbc.sql("""
                  select distinct s.id from evidence_links l join snapshots s on s.project_id=:p
                  where l.evidence_id=:id and (
                    (l.subject_type='GRAPH_NODE' and exists(select 1 from graph_nodes n
                      where n.id=l.subject_id and n.snapshot_id=s.id)) or
                    (l.subject_type='FEATURE' and exists(select 1 from features f
                      where f.id=l.subject_id and f.snapshot_id=s.id)) or
                    (l.subject_type='FLOW' and exists(select 1 from flows f
                      where f.id=l.subject_id and f.snapshot_id=s.id)) or
                    (l.subject_type='FINDING' and exists(select 1 from analysis_findings f
                      where f.id=l.subject_id and f.snapshot_id=s.id)) or
                    (l.subject_type='SNAPSHOT' and l.subject_id=s.id)
                  )
                """)
                .param("id", evidenceId)
                .param("p", projectId)
                .query(Long.class)
                .list();
        if (contexts.isEmpty()) throw SnapshotSourceException.unknown();
        if (!path.equals(evidence.path()) || !contexts.contains(snapshotId)) throw SnapshotSourceException.stale();
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
