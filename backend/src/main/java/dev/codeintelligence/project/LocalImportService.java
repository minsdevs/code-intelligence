package dev.codeintelligence.project;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.revwalk.RevCommit;
import org.springframework.stereotype.Service;

/**
 * Imports a local folder for analysis. Sources are validated against configured allowed roots and
 * copied through a staging directory. The analysis clone is replaced only after the complete copy
 * has been materialized as a Git commit, so deleted source files cannot survive a refresh.
 */
@Service
public class LocalImportService {

    static final Set<String> BLOCKED_DIRS = Set.of(
            ".git",
            "node_modules",
            ".gradle",
            "build",
            "dist",
            "target",
            ".idea",
            ".vscode",
            "__pycache__",
            ".DS_Store");

    private static final Set<String> BLOCKED_ROOTS = Set.of("/etc", "/usr", "/bin", "/sbin", "/System");
    private static final Set<String> BINARY_EXTENSIONS = Set.of(
            "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "pdf", "zip", "jar", "war", "ear", "class", "woff",
            "woff2", "eot", "ttf", "otf", "mp3", "mp4", "webm", "mov", "avi", "wav", "ogg", "exe", "dll", "so", "dylib",
            "bin", "7z", "tar", "gz", "bz2", "rar", "xz", "sqlite", "db", "wasm", "pyc", "o", "a", "lib");
    private static final int MAX_COPY_FILES = 50_000;

    private final AppProperties appProperties;
    private final LocalImportProperties localImportProperties;
    private final AnalysisProperties analysisProperties;

    public LocalImportService(
            AppProperties appProperties,
            LocalImportProperties localImportProperties,
            AnalysisProperties analysisProperties) {
        this.appProperties = appProperties;
        this.localImportProperties = localImportProperties;
        this.analysisProperties = analysisProperties;
    }

    public record LocalImportResult(String headSha, String branch, boolean hasUncommittedChanges) {}

    public record SourceFile(String path, String contentHash) {}

    public LocalImportResult importFolder(Path localPath, Path targetDir) {
        Path source = validateSource(localPath);
        Path target = targetDir.toAbsolutePath().normalize();
        ensureUnderReposRoot(target);
        SourceGitInfo sourceGit = readSourceGitInfo(source);
        Path staging = target.resolveSibling(target.getFileName() + ".staging-" + UUID.randomUUID());
        ensureUnderReposRoot(staging);

        try {
            copyTree(source, staging);
            String snapshotSha = commitSnapshot(staging);
            replaceTarget(staging, target);
            return new LocalImportResult(snapshotSha, sourceGit.branch(), sourceGit.dirty());
        } catch (IOException e) {
            deleteTreeQuietly(staging);
            throw new LocalImportException("Failed to copy local folder: " + e.getMessage(), e);
        } catch (RuntimeException e) {
            deleteTreeQuietly(staging);
            throw e;
        }
    }

    /** Validates and resolves a local source. The returned path is the real path. */
    public Path validateSource(Path localPath) {
        Path resolved = localPath.toAbsolutePath().normalize();
        if (!Files.isDirectory(resolved)) {
            throw new LocalImportException("Path is not a directory: " + resolved, null);
        }
        if (!Files.isReadable(resolved)) {
            throw new LocalImportException("Path is not readable: " + resolved, null);
        }

        Path realPath;
        try {
            realPath = resolved.toRealPath();
        } catch (IOException e) {
            throw new LocalImportException("Failed to resolve path: " + e.getMessage(), e);
        }
        for (String blocked : BLOCKED_ROOTS) {
            if (isUnder(realPath, Path.of(blocked)) || isUnder(resolved, Path.of(blocked))) {
                throw new LocalImportException("System directory is not allowed: " + blocked, null);
            }
        }

        String home = System.getProperty("user.home");
        if (home != null) {
            Path homePath = Path.of(home).toAbsolutePath().normalize();
            for (String secret : List.of(".ssh", ".aws", ".gnupg", ".config")) {
                Path secretPath = homePath.resolve(secret);
                if (isUnder(realPath, secretPath) || isUnder(resolved, secretPath)) {
                    throw new LocalImportException("Secret directory is not allowed: " + secret, null);
                }
            }
        }

        List<Path> allowedRoots = localImportProperties.resolvedAllowedRoots();
        boolean underAllowedRoot = false;
        for (Path root : allowedRoots) {
            try {
                if (isUnder(realPath, root.toRealPath())) {
                    underAllowedRoot = true;
                    break;
                }
            } catch (IOException ignored) {
                // An unresolved configured root must not grant access.
            }
        }
        if (!allowedRoots.isEmpty() && !underAllowedRoot) {
            throw new LocalImportException("Path is not under any allowed root.", null);
        }
        return realPath;
    }

    /**
     * Computes Git-compatible blob hashes without retaining file contents. Symlinks, generated
     * directories and unreadable files are excluded exactly as they are during local copy.
     */
    public Map<String, String> fingerprint(Path localPath) {
        Path source = validateSource(localPath);
        Map<String, String> candidates = new TreeMap<>();
        try {
            walkSource(source, (file, relative) -> {
                long size = Files.size(file);
                if (size > analysisProperties.maxFileSize()) return;
                byte[] bytes = Files.readAllBytes(file);
                if (isBinary(relative, bytes)) return;
                candidates.put(
                        relative,
                        new ObjectInserter.Formatter()
                                .idFor(Constants.OBJ_BLOB, bytes)
                                .name());
            });
            Map<String, String> result = new LinkedHashMap<>();
            candidates.entrySet().stream()
                    .limit(analysisProperties.maxFiles())
                    .forEach(entry -> result.put(entry.getKey(), entry.getValue()));
            return Map.copyOf(result);
        } catch (IOException e) {
            throw new LocalImportException("Failed to inspect local folder: " + e.getMessage(), e);
        }
    }

    private void copyTree(Path source, Path target) throws IOException {
        Files.createDirectories(target);
        walkSource(source, (file, relative) -> {
            Path destination = target.resolve(relative).normalize();
            if (!destination.startsWith(target)) {
                throw new IOException("Source path escaped staging directory");
            }
            Files.createDirectories(destination.getParent());
            Files.copy(file, destination, StandardCopyOption.REPLACE_EXISTING);
        });
    }

    private void walkSource(Path source, SourceFileConsumer consumer) throws IOException {
        int[] fileCount = {0};
        Files.walkFileTree(source, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(source)
                        && (BLOCKED_DIRS.contains(dir.getFileName().toString()) || Files.isSymbolicLink(dir))) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                if (fileCount[0]++ >= MAX_COPY_FILES) {
                    throw new IOException("Local project exceeds the 50000 file safety limit");
                }
                if (!Files.isSymbolicLink(file) && Files.isReadable(file)) {
                    consumer.accept(file, source.relativize(file).toString().replace('\\', '/'));
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException exc) throws IOException {
                throw new IOException("Unreadable source entry: " + source.relativize(file), exc);
            }
        });
    }

    private String commitSnapshot(Path staging) {
        try (Git git = Git.init()
                .setDirectory(staging.toFile())
                .setInitialBranch("snapshot")
                .call()) {
            git.add().addFilepattern(".").call();
            RevCommit commit = git.commit()
                    .setMessage("Code Intelligence local snapshot")
                    .setAuthor("Code Intelligence", "local@code-intelligence.invalid")
                    .setCommitter("Code Intelligence", "local@code-intelligence.invalid")
                    .call();
            return commit.getId().name();
        } catch (Exception e) {
            throw new LocalImportException("Failed to create local analysis snapshot", e);
        }
    }

    private SourceGitInfo readSourceGitInfo(Path localPath) {
        if (!Files.isDirectory(localPath.resolve(Constants.DOT_GIT))) {
            return new SourceGitInfo(null, false);
        }
        try (Git git = Git.open(localPath.toFile())) {
            ObjectId head = git.getRepository().resolve(Constants.HEAD);
            String branch = head == null ? null : git.getRepository().getBranch();
            return new SourceGitInfo(branch, !git.status().call().isClean());
        } catch (Exception e) {
            return new SourceGitInfo(null, false);
        }
    }

    private void replaceTarget(Path staging, Path target) throws IOException {
        if (Files.exists(target)) {
            if (Files.isSymbolicLink(target)) {
                throw new IOException("Analysis target must not be a symbolic link");
            }
            deleteTree(target);
        }
        try {
            Files.move(staging, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(staging, target);
        }
    }

    private void ensureUnderReposRoot(Path target) {
        Path root = appProperties.reposRoot().toAbsolutePath().normalize();
        if (!target.startsWith(root) || target.equals(root)) {
            throw new LocalImportException("Target path escapes the repository storage root", null);
        }
        try {
            if (Files.exists(root)) {
                Path realRoot = root.toRealPath();
                Path existing = Files.exists(target) ? target : nearestExistingParent(target);
                Path realExisting = existing.toRealPath();
                if (!realExisting.startsWith(realRoot) || realExisting.equals(realRoot) && existing.equals(target)) {
                    throw new LocalImportException("Target path escapes the repository storage root", null);
                }
            }
        } catch (IOException e) {
            throw new LocalImportException("Failed to resolve repository storage path", e);
        }
    }

    private static Path nearestExistingParent(Path path) {
        Path current = path.getParent();
        while (current != null && !Files.exists(current)) current = current.getParent();
        if (current == null) throw new LocalImportException("Repository storage parent does not exist", null);
        return current;
    }

    private static boolean isBinary(String path, byte[] bytes) {
        int dot = path.lastIndexOf('.');
        if (dot >= 0
                && dot < path.length() - 1
                && BINARY_EXTENSIONS.contains(path.substring(dot + 1).toLowerCase(Locale.ROOT))) {
            return true;
        }
        for (int i = 0; i < Math.min(bytes.length, 8192); i++) {
            if (bytes[i] == 0) return true;
        }
        return false;
    }

    private static boolean isUnder(Path candidate, Path root) {
        Path normalizedRoot = root.toAbsolutePath().normalize();
        return candidate.equals(normalizedRoot) || candidate.startsWith(normalizedRoot);
    }

    private static void deleteTree(Path root) throws IOException {
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, IOException exc) throws IOException {
                if (exc != null) throw exc;
                Files.delete(dir);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void deleteTreeQuietly(Path root) {
        try {
            if (Files.exists(root)) deleteTree(root);
        } catch (IOException ignored) {
            // Best-effort staging cleanup. The source and current promoted snapshot remain untouched.
        }
    }

    @FunctionalInterface
    private interface SourceFileConsumer {
        void accept(Path file, String relative) throws IOException;
    }

    private record SourceGitInfo(String branch, boolean dirty) {}
}
