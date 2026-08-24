package dev.codeintelligence.project;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.ErrorResponseException;

/**
 * Generates IDE-launch URIs for local-import projects.
 * Only LOCAL source-type projects are supported since the user must have the files on disk.
 * File paths are validated to never escape the project root.
 */
@Service
public class IdeOpenService {

    public enum Ide {
        VSCODE,
        CURSOR,
        INTELLIJ,
        WEBSTORM
    }

    public record IdeOpenRequest(String filePath, int line, String ide) {}

    public record IdeOpenResponse(String uri, boolean commitMismatch, String snapshotCommit, String currentCommit) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;

    public IdeOpenService(ProjectRepository projectRepository, SnapshotRepository snapshotRepository) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
    }

    public IdeOpenResponse open(long projectId, long userId, IdeOpenRequest request) {
        Project project =
                projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);

        if (!"LOCAL".equals(project.getSourceType())) {
            throw new IdeOpenNotSupportedException("IDE open is only supported for local projects");
        }

        String localPath = project.getLocalPath();
        if (localPath == null || localPath.isBlank()) {
            throw new IdeOpenNotSupportedException("Project has no local path configured");
        }

        // Validate and normalize the relative file path (blocks traversal)
        String normalized = normalizeRelativePath(request.filePath());

        // Build absolute path and verify it exists
        Path projectRoot = Path.of(localPath).toAbsolutePath().normalize();
        Path absoluteFile = projectRoot.resolve(normalized).normalize();

        // Double-check the resolved path is still under the project root
        if (!absoluteFile.startsWith(projectRoot)) {
            throw new IdeOpenNotSupportedException("File path escapes project root");
        }

        int line = Math.max(1, request.line());
        Ide ide = parseIde(request.ide());
        String uri = buildUri(ide, absoluteFile.toString(), line);

        // Check commit mismatch
        String snapshotCommit = getSnapshotCommit(project);
        String currentCommit = getCurrentHeadCommit(projectRoot);
        boolean mismatch = snapshotCommit != null && currentCommit != null && !snapshotCommit.equals(currentCommit);

        return new IdeOpenResponse(uri, mismatch, snapshotCommit, currentCommit);
    }

    /**
     * Validates and normalizes a relative path. Rejects absolute paths, traversal, and encoded attacks.
     * Same logic as SafeRelativePath.normalize() but inlined to avoid package cycle.
     */
    static String normalizeRelativePath(String requested) {
        if (requested == null || requested.isBlank()) {
            throw new InvalidPathException();
        }
        if (requested.indexOf('\0') >= 0) {
            throw new InvalidPathException();
        }
        String path = requested.replace('\\', '/');
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c")) {
            throw new InvalidPathException();
        }
        if (path.startsWith("/") || path.matches("^[A-Za-z]:.*")) {
            throw new InvalidPathException();
        }
        Path relative;
        try {
            relative = Path.of(path);
        } catch (RuntimeException e) {
            throw new InvalidPathException();
        }
        if (relative.isAbsolute()) {
            throw new InvalidPathException();
        }
        for (Path part : relative) {
            if ("..".equals(part.toString())) {
                throw new InvalidPathException();
            }
        }
        Path normalized = relative.normalize();
        if (normalized.isAbsolute() || normalized.startsWith("..")) {
            throw new InvalidPathException();
        }
        String rendered = normalized.toString().replace('\\', '/');
        if (rendered.isBlank() || rendered.equals(".")) {
            throw new InvalidPathException();
        }
        return rendered;
    }

    private Ide parseIde(String ide) {
        if (ide == null || ide.isBlank()) {
            return Ide.VSCODE;
        }
        return switch (ide.strip().toLowerCase()) {
            case "cursor" -> Ide.CURSOR;
            case "intellij" -> Ide.INTELLIJ;
            case "webstorm" -> Ide.WEBSTORM;
            default -> Ide.VSCODE;
        };
    }

    String buildUri(Ide ide, String absolutePath, int line) {
        return switch (ide) {
            case VSCODE -> "vscode://file/" + absolutePath + ":" + line;
            case CURSOR -> "cursor://file/" + absolutePath + ":" + line;
            case INTELLIJ ->
                "jetbrains://idea/open?file=" + URLEncoder.encode(absolutePath, StandardCharsets.UTF_8) + "&line="
                        + line;
            case WEBSTORM ->
                "jetbrains://webstorm/open?file=" + URLEncoder.encode(absolutePath, StandardCharsets.UTF_8) + "&line="
                        + line;
        };
    }

    private String getSnapshotCommit(Project project) {
        Long snapshotId = project.getCurrentSnapshotId();
        if (snapshotId == null) {
            return null;
        }
        return snapshotRepository
                .findByIdAndProjectId(snapshotId, project.getId())
                .map(Snapshot::getCommitSha)
                .orElse(null);
    }

    private String getCurrentHeadCommit(Path projectRoot) {
        Path gitDir = projectRoot.resolve(Constants.DOT_GIT);
        if (!Files.isDirectory(gitDir)) {
            return null;
        }
        try (Git git = Git.open(projectRoot.toFile())) {
            ObjectId head = git.getRepository().resolve(Constants.HEAD);
            return head != null ? head.name() : null;
        } catch (IOException e) {
            return null;
        }
    }

    /** Thrown when the file path is invalid (traversal, absolute, etc.). */
    public static class InvalidPathException extends ErrorResponseException {
        public InvalidPathException() {
            super(HttpStatus.BAD_REQUEST);
        }
    }
}
