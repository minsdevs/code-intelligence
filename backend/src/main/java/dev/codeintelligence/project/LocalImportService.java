package dev.codeintelligence.project;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.TreeMap;
import java.util.UUID;
import org.eclipse.jgit.dircache.DirCache;
import org.eclipse.jgit.dircache.DirCacheBuilder;
import org.eclipse.jgit.dircache.DirCacheEntry;
import org.eclipse.jgit.internal.storage.file.ObjectDirectory;
import org.eclipse.jgit.lib.CommitBuilder;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.ObjectDatabase;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.util.FS;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Imports a local folder for analysis. Sources are validated against configured allowed roots and
 * copied through a staging directory. The analysis clone is replaced only after the complete copy
 * has been materialized as a Git commit, so deleted source files cannot survive a refresh.
 */
@Service
public class LocalImportService {

    private static final Set<String> BLOCKED_ROOTS = Set.of("/etc", "/usr", "/bin", "/sbin", "/System");

    private final AppProperties appProperties;
    private final LocalImportProperties localImportProperties;
    private final DesktopPathAuthorizationService desktopPaths;
    private final LocalSourcePolicy policy;
    private final DirectoryMover mover;
    private final StagingObserver stagingObserver;

    @Autowired
    public LocalImportService(
            AppProperties appProperties,
            LocalImportProperties localImportProperties,
            AnalysisProperties analysisProperties,
            DesktopPathAuthorizationService desktopPaths) {
        this(
                appProperties,
                localImportProperties,
                desktopPaths,
                new LocalSourcePolicy(analysisProperties),
                LocalImportService::moveDirectory);
    }

    LocalImportService(
            AppProperties appProperties,
            LocalImportProperties localImportProperties,
            DesktopPathAuthorizationService desktopPaths,
            LocalSourcePolicy policy,
            DirectoryMover mover) {
        this(appProperties, localImportProperties, desktopPaths, policy, mover, staging -> {});
    }

    LocalImportService(
            AppProperties appProperties,
            LocalImportProperties localImportProperties,
            DesktopPathAuthorizationService desktopPaths,
            LocalSourcePolicy policy,
            DirectoryMover mover,
            StagingObserver stagingObserver) {
        this.appProperties = appProperties;
        this.localImportProperties = localImportProperties;
        this.desktopPaths = desktopPaths;
        this.policy = policy;
        this.mover = mover;
        this.stagingObserver = stagingObserver;
    }

    /** Count-only local ingest observation; excluded subtrees count once, not their hidden descendants. */
    public record ImportSummary(
            int schemaVersion,
            String policyVersion,
            int acceptedFiles,
            long bytesRead,
            Map<String, Integer> excludedEntriesByReason) {
        public ImportSummary {
            excludedEntriesByReason = Map.copyOf(excludedEntriesByReason);
        }
    }

    /** Dirty status is unknown for Git sources; ingest never runs source Git status/config/filter logic. */
    public record LocalImportResult(
            String headSha, String branch, Boolean hasUncommittedChanges, ImportSummary summary) {}

    public record SourceFile(String path, String contentHash) {}

    public LocalImportResult importFolder(Path localPath, Path targetDir) {
        Path source = validateSource(localPath);
        return importSource(source, targetDir, null, () -> {}, null);
    }

    /** Low-level test/internal overload. Production callers must supply a publication guard. */
    public LocalImportResult importApproved(LocalSourceBinding expected, Path targetDir) {
        return importApproved(expected, targetDir, () -> {});
    }

    /** Imports only the privately persisted approved input, rechecking authorization on every attempt. */
    public LocalImportResult importApproved(LocalSourceBinding expected, Path targetDir, Runnable beforePublish) {
        return importApproved(expected, targetDir, beforePublish, null);
    }

    public LocalImportResult importApproved(
            LocalSourceBinding expected, Path targetDir, Runnable beforePublish, VerifiedFileSink retainedSource) {
        validateBinding(expected);
        Path source;
        try {
            source = validateSource(Path.of(expected.canonicalRoot()));
            requireRootIdentity(expected, source);
        } catch (LocalImportException e) {
            throw LocalSourceApprovalException.sourceChanged();
        } catch (IOException e) {
            throw LocalSourceApprovalException.sourceChanged();
        }
        return importSource(
                source, targetDir, expected, java.util.Objects.requireNonNull(beforePublish), retainedSource);
    }

    private LocalImportResult importSource(
            Path source,
            Path targetDir,
            LocalSourceBinding expected,
            Runnable beforePublish,
            VerifiedFileSink retainedSource) {
        Path target = targetDir.toAbsolutePath().normalize();
        ensureUnderReposRoot(target);
        ensureDisjointSource(source);
        Path staging = target.resolveSibling(target.getFileName() + ".staging-" + UUID.randomUUID());
        ensureUnderReposRoot(staging);

        try {
            Files.createDirectories(staging.getParent());
            Files.createDirectory(
                    staging, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            SnapshotCopy copied = copySnapshot(source, staging, expected, retainedSource);
            beforePublish.run();
            replaceTarget(staging, target);
            return new LocalImportResult(
                    copied.commit(),
                    copied.selection().branch(),
                    copied.selection().dirty(),
                    copied.selection().summary());
        } catch (IOException e) {
            deleteTreeQuietly(staging);
            throw new LocalImportException(
                    "Local source could not be imported safely. Review the source limits and exclusions.", e);
        } catch (RuntimeException e) {
            deleteTreeQuietly(staging);
            throw e;
        }
    }

    /** Validates and resolves a local source. The returned path is the real path. */
    public Path validateSource(Path localPath) {
        Path resolved = localPath.toAbsolutePath().normalize();
        if (!Files.isDirectory(resolved)) {
            throw new LocalImportException("Path is not a directory.", null);
        }
        if (!Files.isReadable(resolved)) {
            throw new LocalImportException("Path is not readable.", null);
        }

        Path realPath;
        try {
            realPath = resolved.toRealPath();
        } catch (IOException e) {
            throw new LocalImportException("Failed to resolve local path.", e);
        }
        if (LocalSourcePolicy.secretAncestor(realPath) || LocalSourcePolicy.secretAncestor(resolved)) {
            throw new LocalImportException("Choose a project folder outside credential directories.", null);
        }
        for (String blocked : BLOCKED_ROOTS) {
            Path blockedPath = Path.of(blocked);
            try {
                if (Files.exists(blockedPath)) blockedPath = blockedPath.toRealPath();
            } catch (IOException e) {
                throw new LocalImportException("System directory policy could not be verified.", null);
            }
            if (isUnder(realPath, blockedPath) || isUnder(resolved, Path.of(blocked))) {
                throw new LocalImportException("System directory is not allowed.", null);
            }
        }

        if (realPath.getParent() == null)
            throw new LocalImportException("Choose a project folder, not a volume root.", null);
        try {
            if (!Files.getFileStore(realPath).equals(Files.getFileStore(realPath.getParent()))) {
                throw new LocalImportException("Choose a project folder, not a volume root.", null);
            }
        } catch (IOException e) {
            throw new LocalImportException("Local source volume could not be verified.", null);
        }

        String home = System.getProperty("user.home");
        if (home != null) {
            Path homePath = Path.of(home).toAbsolutePath().normalize();
            try {
                if (Files.exists(homePath)) homePath = homePath.toRealPath();
            } catch (IOException e) {
                throw new LocalImportException("Home directory policy could not be verified.", null);
            }
            if (realPath.equals(homePath))
                throw new LocalImportException("Choose a project folder, not your home directory.", null);
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
        if (!underAllowedRoot && !desktopPaths.isAuthorized(realPath)) {
            throw new LocalImportException(
                    "Path is not authorized. Choose it with the native folder picker or configure an allowed root.",
                    null);
        }
        return realPath;
    }

    /** Computes exactly the selected source hashes used by local copy, without retaining source bytes. */
    public Map<String, String> fingerprint(Path localPath) {
        return inspect(localPath).gitFingerprints();
    }

    /** One bounded preview; the returned binding is for private server-side persistence only. */
    public LocalSourceInspection inspect(Path localPath) {
        Path source = validateSource(localPath);
        ensureDisjointSource(source);
        try {
            LocalSourcePolicy.Selection selection = policy.select(source, (file, bytes) -> {});
            Map<String, String> result = new TreeMap<>();
            selection.files().forEach((path, file) -> result.put(path, file.oid()));
            return new LocalSourceInspection(selection.binding(), result, selection.summary());
        } catch (IOException e) {
            throw new LocalImportException(
                    "Local source could not be inspected safely. Review the source limits and exclusions.", e);
        }
    }

    private SnapshotCopy copySnapshot(
            Path source, Path staging, LocalSourceBinding expected, VerifiedFileSink retainedSource)
            throws IOException {
        Path git = staging.resolve(Constants.DOT_GIT);
        LocalSourcePolicy.Selection selection;
        try {
            selection = policy.select(source, (file, bytes) -> {
                Path destination = staging.resolve(file.path()).normalize();
                if (!destination.startsWith(staging) || destination.startsWith(git)) {
                    throw LocalSourceApprovalException.sourceChanged();
                }
                try {
                    Files.createDirectories(destination.getParent());
                    Files.write(destination, bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
                } catch (IOException e) {
                    throw new StagingWriteException(e);
                }
            });
        } catch (StagingWriteException e) {
            throw e;
        } catch (IOException e) {
            if (expected != null) throw LocalSourceApprovalException.sourceChanged();
            throw e;
        }
        if (expected != null && !expected.equals(selection.binding()))
            throw LocalSourceApprovalException.sourceChanged();
        stagingObserver.afterStaged(staging);
        LocalStagingVerifier verifier;
        try {
            verifier = new LocalStagingVerifier(staging, selection.files(), policy);
        } catch (IOException e) {
            if (expected != null) throw LocalSourceApprovalException.sourceChanged();
            throw e;
        }
        // The first verifier scan rejects even an injected .git subtree. Metadata starts here.
        Files.createDirectory(git);
        verifier.allowGeneratedGitDirectory();
        Files.createDirectories(git.resolve("refs/heads"));
        Files.writeString(
                git.resolve("config"),
                "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\n",
                StandardOpenOption.CREATE_NEW);
        Files.writeString(git.resolve("HEAD"), "ref: refs/heads/snapshot\n", StandardOpenOption.CREATE_NEW);
        // ObjectDirectory accepts a plain, parentless Config. Unlike Git.init/open/add/commit,
        // it does not load ambient user/system config or execute hooks, clean filters or attributes.
        try (ObjectDatabase objects = new ObjectDirectory(
                new Config(),
                git.resolve("objects").toFile(),
                null,
                FS.DETECTED,
                git.resolve("shallow").toFile())) {
            objects.create();
            try (ObjectInserter inserter = objects.newInserter()) {
                List<DirCacheEntry> entries = new ArrayList<>();
                try {
                    verifier.verifyAndConsume(selection.binding(), (file, bytes) -> {
                        ObjectId oid;
                        try {
                            oid = inserter.insert(Constants.OBJ_BLOB, bytes);
                        } catch (IOException e) {
                            throw new StagingWriteException(e);
                        }
                        if (!oid.name().equals(file.oid())) throw LocalSourceApprovalException.sourceChanged();
                        if (retainedSource != null) retainedSource.accept(file.path(), file.oid(), bytes);
                        DirCacheEntry entry = new DirCacheEntry(file.path());
                        entry.setFileMode(FileMode.REGULAR_FILE);
                        entry.setObjectId(oid);
                        entry.setLength(bytes.length);
                        entries.add(entry);
                    });
                } catch (StagingWriteException e) {
                    throw e;
                } catch (IOException e) {
                    if (expected != null) throw LocalSourceApprovalException.sourceChanged();
                    throw e;
                }
                entries.sort((first, second) ->
                        LocalSourcePolicy.comparePaths(first.getPathString(), second.getPathString()));
                DirCache index = DirCache.newInCore();
                DirCacheBuilder builder = index.builder();
                entries.forEach(builder::add);
                builder.finish();
                CommitBuilder commit = new CommitBuilder();
                commit.setTreeId(index.writeTree(inserter));
                PersonIdent author = retainedSource == null || retainedSource.commitTime() == null
                        ? new PersonIdent("Code Intelligence", "local@code-intelligence.invalid")
                        : new PersonIdent(
                                "Code Intelligence",
                                "local@code-intelligence.invalid",
                                Date.from(retainedSource.commitTime()),
                                TimeZone.getTimeZone("UTC"));
                commit.setAuthor(author);
                commit.setCommitter(author);
                commit.setMessage("Code Intelligence local snapshot");
                ObjectId oid = inserter.insert(commit);
                inserter.flush();
                Files.writeString(git.resolve("refs/heads/snapshot"), oid.name() + "\n", StandardOpenOption.CREATE_NEW);
                return new SnapshotCopy(oid.name(), selection);
            }
        }
    }

    private void validateBinding(LocalSourceBinding expected) {
        if (expected == null
                || expected.schemaVersion() != 1
                || expected.canonicalRoot() == null
                || expected.canonicalRoot().isEmpty()
                || expected.canonicalRoot().length() > 4096
                || !LocalSourcePolicy.VERSION.equals(expected.policyVersion())
                || !policy.limitsSha256().equals(expected.limitsSha256())
                || expected.manifestSha256() == null
                || !expected.manifestSha256().matches("[0-9a-f]{64}")
                || expected.selectedFiles() < 0
                || expected.selectedFiles() > policy.limits().files()
                || expected.selectedBytes() < 0
                || expected.selectedBytes() > policy.limits().totalBytes()) {
            throw LocalSourceApprovalException.sourceChanged();
        }
        try {
            Path root = Path.of(expected.canonicalRoot());
            if (!root.isAbsolute() || !root.normalize().toString().equals(expected.canonicalRoot())) {
                throw LocalSourceApprovalException.sourceChanged();
            }
        } catch (java.nio.file.InvalidPathException e) {
            throw LocalSourceApprovalException.sourceChanged();
        }
    }

    private static void requireRootIdentity(LocalSourceBinding expected, Path source) throws IOException {
        if (!source.toString().equals(expected.canonicalRoot())
                || expected.rootDevice()
                        != ((Number) Files.getAttribute(source, "unix:dev", LinkOption.NOFOLLOW_LINKS)).longValue()
                || expected.rootInode()
                        != ((Number) Files.getAttribute(source, "unix:ino", LinkOption.NOFOLLOW_LINKS)).longValue()) {
            throw LocalSourceApprovalException.sourceChanged();
        }
    }

    private void replaceTarget(Path staging, Path target) throws IOException {
        Path previous = target.resolveSibling(target.getFileName() + ".previous-" + UUID.randomUUID());
        boolean movedPrevious = false;
        try {
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(target)) {
                    throw new IOException("Analysis target must be a regular directory.");
                }
                mover.move(target, previous);
                movedPrevious = true;
            }
            mover.move(staging, target);
        } catch (IOException | RuntimeException failure) {
            if (movedPrevious) {
                try {
                    mover.move(previous, target);
                } catch (IOException | RuntimeException restoreFailure) {
                    failure.addSuppressed(restoreFailure);
                }
            }
            throw failure;
        }
        // The new repository is already published. Cleanup failure must not turn it into a failed job.
        if (movedPrevious) deleteTreeQuietly(previous);
    }

    static void moveDirectory(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(source, target);
        }
    }

    private void ensureDisjointSource(Path source) {
        Path root = appProperties.reposRoot();
        try {
            Path parent = Files.exists(root) ? root : nearestExistingParent(root);
            Path canonical = parent.toRealPath().resolve(parent.relativize(root));
            if (source.startsWith(canonical) || canonical.startsWith(source)) {
                throw new LocalImportException("Local source and managed repository storage must be separate.", null);
            }
        } catch (IOException e) {
            throw new LocalImportException("Repository storage could not be verified.", null);
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
    interface DirectoryMover {
        void move(Path source, Path target) throws IOException;
    }

    /** Receives only bytes already verified against the approved staging manifest. */
    @FunctionalInterface
    public interface VerifiedFileSink {
        void accept(String path, String gitOid, byte[] bytes);

        /** A retained job reuses its approval time so its synthetic Git commit is reproducible. */
        default Instant commitTime() {
            return null;
        }
    }

    @FunctionalInterface
    interface StagingObserver {
        void afterStaged(Path staging) throws IOException;
    }

    private static final class StagingWriteException extends IOException {
        StagingWriteException(IOException cause) {
            super("Local staging could not be written.", cause);
        }
    }

    private record SnapshotCopy(String commit, LocalSourcePolicy.Selection selection) {}
}
