package dev.codeintelligence.project;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class LocalSourceStatusService {

    public enum State {
        UP_TO_DATE,
        CHANGED,
        PATH_MISSING,
        REAUTHORIZATION_REQUIRED,
        INSPECTION_FAILED,
        NOT_LOCAL,
        NO_SNAPSHOT
    }

    public record ChangeCounts(int added, int modified, int deleted) {
        @JsonProperty("total")
        public int total() {
            return added + modified + deleted;
        }
    }

    public record LocalSourceStatus(
            State state,
            Long snapshotId,
            ChangeCounts changes,
            List<String> changedPaths,
            boolean fullAnalysisRequired,
            String message) {}

    public record RefreshConfirmation(long snapshotId, int added, int modified, int deleted) {}

    private static final int MAX_VISIBLE_PATHS = 100;

    private final ProjectRepository projectRepository;
    private final LocalImportService localImportService;
    private final JdbcClient jdbc;

    public LocalSourceStatusService(
            ProjectRepository projectRepository, LocalImportService localImportService, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.localImportService = localImportService;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public LocalSourceStatus get(long projectId, long userId) {
        return inspect(requireOwned(projectId, userId));
    }

    @Transactional(readOnly = true)
    public void verifyRefresh(long projectId, long userId, RefreshConfirmation confirmation) {
        Project project = requireOwned(projectId, userId);
        if (!"LOCAL".equals(project.getSourceType())) return;
        if (confirmation == null) {
            throw new LocalRefreshConflictException("Preview local changes and confirm them before reanalysis.");
        }
        LocalSourceStatus current = inspect(project);
        if (current.state() != State.CHANGED) {
            throw new LocalRefreshConflictException(
                    current.state() == State.UP_TO_DATE
                            ? "The local source has no changes to analyze."
                            : "The local source is not currently safe to refresh: " + current.state());
        }
        ChangeCounts changes = current.changes();
        if (!current.snapshotId().equals(confirmation.snapshotId())
                || changes.added() != confirmation.added()
                || changes.modified() != confirmation.modified()
                || changes.deleted() != confirmation.deleted()) {
            throw new LocalRefreshConflictException(
                    "The local source changed after preview. Review the latest change counts before continuing.");
        }
    }

    private LocalSourceStatus inspect(Project project) {
        if (!"LOCAL".equals(project.getSourceType())) {
            return status(State.NOT_LOCAL, project.getCurrentSnapshotId(), new ChangeCounts(0, 0, 0), List.of(), null);
        }
        if (project.getLocalPath() == null || project.getLocalPath().isBlank()) {
            return status(
                    State.REAUTHORIZATION_REQUIRED,
                    project.getCurrentSnapshotId(),
                    new ChangeCounts(0, 0, 0),
                    List.of(),
                    "Choose the local project folder again before checking or analyzing changes.");
        }
        if (project.getCurrentSnapshotId() == null) {
            return status(
                    State.NO_SNAPSHOT,
                    null,
                    new ChangeCounts(0, 0, 0),
                    List.of(),
                    "The first analysis has not produced a snapshot yet.");
        }
        Path source = Path.of(project.getLocalPath());
        if (!Files.isDirectory(source)) {
            return status(
                    State.PATH_MISSING,
                    project.getCurrentSnapshotId(),
                    new ChangeCounts(0, 0, 0),
                    List.of(),
                    "The local project path is missing. Reconnect it before accessing files.");
        }

        try {
            localImportService.validateSource(source);
        } catch (LocalImportException e) {
            return status(
                    State.REAUTHORIZATION_REQUIRED,
                    project.getCurrentSnapshotId(),
                    new ChangeCounts(0, 0, 0),
                    List.of(),
                    "Local path access must be rechecked. Choose an allowed project folder.");
        }
        Map<String, String> current;
        try {
            // Compare under the scope the project was approved with, so out-of-scope files are not "added".
            current = localImportService.fingerprint(source, LocalImportScope.ofProject(jdbc, project.getId()));
        } catch (LocalImportException e) {
            return status(
                    State.INSPECTION_FAILED,
                    project.getCurrentSnapshotId(),
                    new ChangeCounts(0, 0, 0),
                    List.of(),
                    "Files could not be inspected safely. Check file permissions, file types and size limits, "
                            + "then preview again.");
        }
        Map<String, String> snapshot = snapshotFingerprint(project.getCurrentSnapshotId());
        List<String> paths = new ArrayList<>();
        int added = 0;
        int modified = 0;
        int deleted = 0;
        for (Map.Entry<String, String> entry : current.entrySet()) {
            String previous = snapshot.get(entry.getKey());
            if (previous == null) {
                added++;
                paths.add("A " + entry.getKey());
            } else if (!previous.equals(entry.getValue())) {
                modified++;
                paths.add("M " + entry.getKey());
            }
        }
        for (String path : snapshot.keySet()) {
            if (!current.containsKey(path)) {
                deleted++;
                paths.add("D " + path);
            }
        }
        paths.sort(String::compareTo);
        ChangeCounts counts = new ChangeCounts(added, modified, deleted);
        State state = counts.total() == 0 ? State.UP_TO_DATE : State.CHANGED;
        String message = state == State.UP_TO_DATE
                ? "The current source matches the last analyzed snapshot."
                : "A full analysis will run after you confirm these changes.";
        return status(
                state,
                project.getCurrentSnapshotId(),
                counts,
                paths.stream().limit(MAX_VISIBLE_PATHS).toList(),
                message);
    }

    private Map<String, String> snapshotFingerprint(long snapshotId) {
        Map<String, String> result = new LinkedHashMap<>();
        jdbc.sql("select path, content_hash from files where snapshot_id = :snapshotId order by path")
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> {
                    result.put(rs.getString("path"), rs.getString("content_hash"));
                    return 0;
                })
                .list();
        return result;
    }

    private static LocalSourceStatus status(
            State state, Long snapshotId, ChangeCounts counts, List<String> paths, String message) {
        return new LocalSourceStatus(state, snapshotId, counts, paths, state == State.CHANGED, message);
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }
}
