package dev.codeintelligence.project;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.common.SourceAccess;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Predicate;
import org.eclipse.jgit.dircache.DirCache;
import org.eclipse.jgit.dircache.DirCacheBuilder;
import org.eclipse.jgit.dircache.DirCacheEntry;
import org.eclipse.jgit.internal.storage.file.ObjectDirectory;
import org.eclipse.jgit.lib.CommitBuilder;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.ObjectId;
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
    private static final Set<String> BLOCKED_WINDOWS_ROOT_CHILDREN = Set.of(
            "windows",
            "program files",
            "program files (x86)",
            "programdata",
            "system volume information",
            "$recycle.bin");

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
            try (SourceAccess.Scope ignored = SourceAccess.open(source, "source")) {
                requireRootIdentity(expected, source);
            }
        } catch (LocalImportException | IOException e) {
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
        try (SourceAccess.Scope workspace = SourceAccess.open(
                        appProperties.reposRoot().toAbsolutePath().normalize(), "workspace");
                SourceAccess.Scope liveSource = SourceAccess.open(source, "source")) {
            SourceAccess.directories(staging.getParent());
            SourceAccess.mkdir(staging);
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
        return validateSource(localPath, desktopPaths::isAuthorized);
    }

    /**
     * Validates a new selection: a configured server root, or a live native-dialog grant for exactly
     * this root (not spent here, so the preview can be repeated until the confirmation spends it).
     */
    public Path validateGranted(Path localPath, String grant) {
        return validateSource(localPath, real -> desktopPaths.isGranted(grant, real));
    }

    /** Spends the selection grant of a confirmed initial import or relink; server roots need none. */
    public void consumeGrant(Path realPath, String grant) {
        if (!underAllowedRoot(realPath)) desktopPaths.consume(grant, realPath);
    }

    private Path validateSource(Path localPath, Predicate<Path> desktopAccess) {
        Path resolved = localPath.toAbsolutePath().normalize();
        Path realPath;
        if (SourceAccess.windows()) {
            try (SourceAccess.Scope ignored = SourceAccess.open(resolved, "source")) {
                BasicFileAttributes attrs = SourceAccess.attributes(resolved, true);
                if (!attrs.isDirectory() || attrs.isSymbolicLink()) throw new IOException("not a directory");
                realPath = resolved;
            } catch (IOException e) {
                throw new LocalImportException("Path is not an accessible directory.", e);
            }
        } else {
            if (!Files.isDirectory(resolved) || !Files.isReadable(resolved))
                throw new LocalImportException("Path is not an accessible directory.", null);
            try {
                realPath = resolved.toRealPath();
            } catch (IOException e) {
                throw new LocalImportException("Failed to resolve local path.", e);
            }
        }
        if (LocalSourcePolicy.secretAncestor(realPath) || LocalSourcePolicy.secretAncestor(resolved)) {
            throw new LocalImportException("Choose a project folder outside credential directories.", null);
        }
        if (!SourceAccess.windows()) {
            for (String blocked : BLOCKED_ROOTS) {
                Path blockedPath = Path.of(blocked);
                try {
                    if (Files.exists(blockedPath)) blockedPath = blockedPath.toRealPath();
                } catch (IOException e) {
                    throw new LocalImportException("System directory policy could not be verified.", null);
                }
                if (isUnder(realPath, blockedPath) || isUnder(resolved, Path.of(blocked)))
                    throw new LocalImportException("System directory is not allowed.", null);
            }
        }
        if (SourceAccess.windows()) {
            Path relative = realPath.getRoot().relativize(realPath);
            if (relative.getNameCount() > 0
                    && BLOCKED_WINDOWS_ROOT_CHILDREN.contains(
                            relative.getName(0).toString().toLowerCase(java.util.Locale.ROOT)))
                throw new LocalImportException("System directory is not allowed.", null);
        }

        if (realPath.getParent() == null)
            throw new LocalImportException("Choose a project folder, not a volume root.", null);
        if (!SourceAccess.windows()) {
            try {
                if (!Files.getFileStore(realPath).equals(Files.getFileStore(realPath.getParent())))
                    throw new LocalImportException("Choose a project folder, not a volume root.", null);
            } catch (IOException e) {
                throw new LocalImportException("Local source volume could not be verified.", null);
            }
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

        if (!underAllowedRoot(realPath) && !desktopAccess.test(realPath)) {
            throw new LocalImportException(
                    "Path is not authorized. Choose it with the native folder picker or configure an allowed root.",
                    null);
        }
        return realPath;
    }

    private boolean underAllowedRoot(Path realPath) {
        for (Path root : localImportProperties.resolvedAllowedRoots()) {
            try {
                if (isUnder(realPath, root.toRealPath())) return true;
            } catch (IOException ignored) {
                // An unresolved configured root must not grant access.
            }
        }
        return false;
    }

    /** Computes exactly the selected source hashes used by local copy, without retaining source bytes. */
    public Map<String, String> fingerprint(Path localPath) {
        return fingerprint(localPath, null);
    }

    public Map<String, String> fingerprint(Path localPath, LocalImportScope scope) {
        return inspect(localPath, scope).gitFingerprints();
    }

    public LocalSourceInspection inspect(Path localPath) {
        return inspect(localPath, null);
    }

    public LocalSourceInspection inspect(Path localPath, LocalImportScope scope) {
        return inspectValidated(validateSource(localPath), scope);
    }

    /** Inspects a new selection under its native-dialog grant (see {@link #validateGranted}). */
    public LocalSourceInspection inspectGranted(Path localPath, String grant, LocalImportScope scope) {
        return inspectValidated(validateGranted(localPath, grant), scope);
    }

    private LocalSourceInspection inspectValidated(Path source, LocalImportScope scope) {
        ensureDisjointSource(source);
        try (SourceAccess.Scope ignored = SourceAccess.open(source, "source")) {
            LocalSourcePolicy.Selection selection = policy.select(source, scope, (file, bytes) -> {});
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
            LocalImportScope scope = expected == null ? null : LocalImportScope.parse(expected.scope());
            selection = policy.select(source, scope, (file, bytes) -> {
                Path destination = staging.resolve(file.path()).normalize();
                if (!destination.startsWith(staging) || destination.startsWith(git)) {
                    throw LocalSourceApprovalException.sourceChanged();
                }
                try {
                    SourceAccess.directories(destination.getParent());
                    SourceAccess.fresh(destination, bytes);
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
        SourceAccess.mkdir(git);
        verifier.allowGeneratedGitDirectory();
        SourceAccess.directories(git.resolve("refs/heads"));
        SourceAccess.fresh(
                git.resolve("config"),
                "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\n"
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        SourceAccess.fresh(
                git.resolve("HEAD"), "ref: refs/heads/snapshot\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        // ObjectDirectory accepts a plain, parentless Config. Unlike Git.init/open/add/commit,
        // it does not load ambient user/system config or execute hooks, clean filters or attributes.
        try (ObjectDirectory objects = new ObjectDirectory(
                new Config(),
                git.resolve("objects").toFile(),
                null,
                FS.DETECTED,
                git.resolve("shallow").toFile())) {
            objects.create();
            // A fresh database has no earlier objects to probe; flush one pack before publishing HEAD.
            try (var inserter = objects.newPackInserter()) {
                inserter.checkExisting(false);
                inserter.setCompressionLevel(java.util.zip.Deflater.DEFAULT_COMPRESSION);
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
                SourceAccess.fresh(
                        git.resolve("refs/heads/snapshot"),
                        (oid.name() + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                return new SnapshotCopy(oid.name(), selection);
            }
        }
    }

    private void validateBinding(LocalSourceBinding expected) {
        if (expected == null
                || expected.schemaVersion() != 1
                || expected.canonicalRoot() == null
                || expected.canonicalRoot().isEmpty()
                || expected.canonicalRoot().length() > 16384
                || !Set.of("posix", "win32").contains(expected.rootPlatform())
                || expected.rootIdentity() == null
                || expected.rootIdentity().length() > 256
                || expected.rootOwner() != null && expected.rootOwner().length() > 256
                || expected.rootPlatform().equals("posix") && expected.rootOwner() != null
                || !LocalSourcePolicy.VERSION.equals(expected.policyVersion())
                || !policy.limitsSha256().equals(expected.limitsSha256())
                || expected.manifestSha256() == null
                || !expected.manifestSha256().matches("[0-9a-f]{64}")
                || expected.selectedFiles() < 0
                || expected.selectedFiles() > policy.limits().files()
                || expected.selectedBytes() < 0
                || expected.selectedBytes() > policy.limits().totalBytes()
                || expected.rootPlatform().equals("posix")
                        && !expected.rootIdentity().matches("PI1:-?[0-9]+:-?[0-9]+")
                || expected.rootPlatform().equals("win32")
                        && (!expected.rootIdentity().matches("WI1:[0-9]+:[0-9]+:[0-9]+")
                                || expected.rootOwner() == null
                                || !expected.rootOwner().matches("S-1-(?:[0-9]+-)*[0-9]+"))) {
            throw LocalSourceApprovalException.sourceChanged();
        }
        try {
            Path root = Path.of(expected.canonicalRoot());
            if (!root.isAbsolute() || !root.normalize().toString().equals(expected.canonicalRoot()))
                throw LocalSourceApprovalException.sourceChanged();
        } catch (java.nio.file.InvalidPathException e) {
            throw LocalSourceApprovalException.sourceChanged();
        }
        try {
            LocalImportScope.parse(expected.scope());
        } catch (LocalImportException e) {
            throw LocalSourceApprovalException.sourceChanged();
        }
    }

    private static void requireRootIdentity(LocalSourceBinding expected, Path source) throws IOException {
        SourceAccess.Identity identity = SourceAccess.identity(source);
        if (!source.toString().equals(expected.canonicalRoot())
                || !expected.rootPlatform().equals(identity.platform())
                || !expected.rootIdentity().equals(identity.identity())
                || !java.util.Objects.equals(expected.rootOwner(), identity.owner()))
            throw LocalSourceApprovalException.sourceChanged();
    }

    private void replaceTarget(Path staging, Path target) throws IOException {
        Path previous = target.resolveSibling(target.getFileName() + ".previous-" + UUID.randomUUID());
        boolean movedPrevious = false;
        try {
            if (SourceAccess.exists(target, true)) {
                if (!SourceAccess.attributes(target, true).isDirectory()) {
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
        if (SourceAccess.windows()) SourceAccess.move(source, target);
        else {
            try {
                Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(source, target);
            }
        }
    }

    private void ensureDisjointSource(Path source) {
        Path root = appProperties.reposRoot().toAbsolutePath().normalize();
        if (SourceAccess.windows()) {
            if (source.startsWith(root) || root.startsWith(source))
                throw new LocalImportException("Local source and managed repository storage must be separate.", null);
            return;
        }
        try {
            Path parent = Files.exists(root) ? root : nearestExistingParent(root);
            Path canonical = parent.toRealPath().resolve(parent.relativize(root));
            if (source.startsWith(canonical) || canonical.startsWith(source))
                throw new LocalImportException("Local source and managed repository storage must be separate.", null);
        } catch (IOException e) {
            throw new LocalImportException("Repository storage could not be verified.", null);
        }
    }

    private void ensureUnderReposRoot(Path target) {
        Path root = appProperties.reposRoot().toAbsolutePath().normalize();
        if (!target.startsWith(root) || target.equals(root)) {
            throw new LocalImportException("Target path escapes the repository storage root", null);
        }
        if (SourceAccess.windows()) return;
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
        List<Path> entries = new ArrayList<>();
        Map<Path, Object> keys = new java.util.HashMap<>();
        Set<Path> directories = new java.util.HashSet<>();
        SourceAccess.walk(root, 70, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path path, BasicFileAttributes attributes) {
                entries.add(path);
                keys.put(path, SourceAccess.proof(attributes));
                directories.add(path);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path path, BasicFileAttributes attributes) {
                entries.add(path);
                keys.put(path, SourceAccess.proof(attributes));
                return FileVisitResult.CONTINUE;
            }
        });
        for (int index = entries.size() - 1; index >= 0; index--) {
            Path path = entries.get(index);
            SourceAccess.remove(path, directories.contains(path), keys.get(path));
        }
    }

    private void deleteTreeQuietly(Path root) {
        try {
            if (SourceAccess.windows()) {
                try (SourceAccess.Scope ignored = SourceAccess.open(
                        appProperties.reposRoot().toAbsolutePath().normalize(), "workspace")) {
                    if (SourceAccess.exists(root, true)) deleteTree(root);
                }
            } else if (Files.exists(root)) deleteTree(root);
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
