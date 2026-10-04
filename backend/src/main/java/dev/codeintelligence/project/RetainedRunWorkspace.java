package dev.codeintelligence.project;

import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.common.SourceAccess;
import dev.codeintelligence.common.WindowsStorage;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.text.Normalizer;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;
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
 * Private, disposable plaintext for one retained analysis attempt. Ownership is held by an OS file
 * lock, not a PID file. This is not native confinement against hostile ancestor replacement or secure
 * erasure; a crashed attempt remains on disk until the next successful, verified startup cleanup.
 */
@Service
public final class RetainedRunWorkspace implements AutoCloseable {
    private static final Set<PosixFilePermission> DIRECTORY_MODE = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> FILE_MODE = PosixFilePermissions.fromString("rw-------");
    private static final Pattern RUN_NAME =
            Pattern.compile("run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    private static final int MAX_FILES = 50_000;
    private static final int MAX_FILE_BYTES = 2 * 1024 * 1024;
    private static final long MAX_TOTAL_BYTES = 512L * 1024 * 1024;
    private static final int MAX_METADATA_BYTES = 16 * 1024 * 1024;
    private static final int MAX_SOURCE_ENTRIES = 200_000;
    private static final int MAX_TREE_ENTRIES = 2 * MAX_SOURCE_ENTRIES + 1024;
    private static final int MAX_RUNS = 4;
    private static final long TIME_LIMIT_NANOS = Duration.ofSeconds(30).toNanos();
    private static final String MARKER_PREFIX = "code-intelligence-retained-run-v1\n";
    // POSIX record locks can be released when this JVM closes ANY descriptor for the same inode,
    // even if another FileLock object still reports valid. Reserve before opening a contender's
    // channel; the registry supplements the OS lock and never substitutes for cross-process locking.
    private record RootIdentity(String device, Object fileKey) {}

    private static final Map<RootIdentity, RetainedRunWorkspace> JVM_OWNERS = new HashMap<>();

    private final AppProperties properties;
    private final LongSupplier clock;
    private final Map<Path, Lease> leases = new HashMap<>();
    private Path root;
    private Object rootKey;
    private Object lockKey;
    private String device;
    private UserPrincipal owner;
    private FileChannel lockChannel;
    private FileLock lock;
    private Path reservedRoot;
    private RootIdentity reservedIdentity;
    private boolean closed;
    private WindowsStorage nativeStorage;
    private WindowsStorage.Lock nativeLock;
    private boolean cleanupBlocked;

    @Autowired
    public RetainedRunWorkspace(AppProperties properties) {
        this(properties, System::nanoTime);
    }

    RetainedRunWorkspace(AppProperties properties, LongSupplier clock) {
        this.properties = properties;
        this.clock = clock;
    }

    /** The caller supplies only immutable, already authorized snapshot metadata. */
    public record Manifest(
            String snapshotSha,
            Instant approvedAt,
            String policyVersion,
            String limitsSha256,
            String manifestSha256,
            int fileCount,
            long totalBytes,
            List<Entry> entries) {
        public Manifest {
            if (entries == null
                    || entries.size() > MAX_FILES
                    || entries.stream().anyMatch(entry -> entry == null)) throw failure("WORKSPACE_INVALID_MANIFEST");
            entries = List.copyOf(entries);
        }
    }

    public record Entry(String path, String gitOid, String rawSha256, long byteSize) {}

    /** Must return bounded source bytes for this lease's project; it must never read the live folder. */
    @FunctionalInterface
    public interface BlobReader {
        byte[] read(String sha256, long byteSize) throws IOException;
    }

    /** Lazily acquires exclusive storage ownership and cleans verified leftovers before creating a lease. */
    public synchronized Lease create(long projectId, long jobId) {
        if (projectId <= 0 || jobId <= 0) throw failure("WORKSPACE_INVALID_MANIFEST");
        if (closed || cleanupBlocked) throw failure("WORKSPACE_UNAVAILABLE");
        Budget budget = new Budget(true);
        try {
            initialize(budget);
            requireOwnership();
            if (leases.size() >= MAX_RUNS || leases.values().stream().anyMatch(lease -> lease.jobId == jobId))
                throw failure("WORKSPACE_BUSY");
            Path run = root.resolve("run-" + UUID.randomUUID());
            workspaceMkdir(run);
            Object key = directory(run, true).fileKey();
            try {
                writeFresh(run.resolve("owner.meta"), marker(run, projectId, jobId), true);
                workspaceMkdir(run.resolve("repo"));
                Lease lease = new Lease(projectId, jobId, run, key);
                leases.put(run, lease);
                return lease;
            } catch (IOException | RuntimeException error) {
                // A just-created directory is owned by its in-memory identity even if marker creation failed.
                try {
                    deleteVerified(run, key, scan(run, new Budget(false)));
                } catch (IOException | RuntimeException ignored) {
                    // A leftover with an incomplete marker will block the next startup rather than be guessed away.
                    cleanupBlocked = true;
                }
                throw error;
            }
        } catch (WorkspaceException error) {
            throw error;
        } catch (IOException | RuntimeException error) {
            throw failure("WORKSPACE_UNAVAILABLE");
        }
    }

    /**
     * Rebuilds the exact synthetic repository without Git.init/open, ambient Git configuration,
     * hooks, filters, subprocesses, or access to the original source. A failure closes this lease;
     * unsafe cleanup retains ownership and must be resolved before the service can close.
     */
    public String reconstruct(Lease lease, Manifest manifest, BlobReader reader) {
        if (lease == null || lease.workspace() != this) throw failure("WORKSPACE_LEASE_INVALID");
        synchronized (lease) {
            if (lease.released || lease.reconstructionStarted) throw failure("WORKSPACE_LEASE_INVALID");
            lease.reconstructionStarted = true;
            try {
                Budget budget = new Budget(true);
                budget.check();
                lease.requireOpen();
                synchronized (this) {
                    if (cleanupBlocked) throw failure("WORKSPACE_UNAVAILABLE");
                }
                validate(manifest, budget);
                if (reader == null) throw failure("WORKSPACE_INVALID_MANIFEST");
                Path repo = lease.run.resolve("repo");
                directory(repo, true);
                if (!workspaceEntries(repo).isEmpty()) throw failure("WORKSPACE_LEASE_INVALID");
                String sha = materialize(repo, manifest, reader, budget);
                requireOwnership();
                lease.requireIdentity();
                return sha;
            } catch (IOException | RuntimeException error) {
                WorkspaceException safe = error instanceof WorkspaceException workspaceError
                        ? workspaceError
                        : failure("WORKSPACE_UNAVAILABLE");
                try {
                    lease.close();
                } catch (RuntimeException ignored) {
                    // Do not suppress a path-bearing exception or falsely release a lease after unsafe cleanup.
                }
                throw safe;
            }
        }
    }

    public final class Lease implements AutoCloseable {
        private final long projectId;
        private final long jobId;
        private final Path run;
        private final Object key;
        private boolean reconstructionStarted;
        private boolean released;

        private Lease(long projectId, long jobId, Path run, Object key) {
            this.projectId = projectId;
            this.jobId = jobId;
            this.run = run;
            this.key = key;
        }

        public long projectId() {
            return projectId;
        }

        public long jobId() {
            return jobId;
        }

        public synchronized Path clonePath() {
            requireOpen();
            // Existing import authorization compares this path with the configured lexical repos
            // root before canonical checks. Preserve OS aliases such as /var for that caller.
            return properties
                    .reposRoot()
                    .resolve(".analysis-runs")
                    .resolve(run.getFileName())
                    .resolve("repo");
        }

        private RetainedRunWorkspace workspace() {
            return RetainedRunWorkspace.this;
        }

        private void requireOpen() {
            if (released) throw failure("WORKSPACE_LEASE_INVALID");
            try {
                requireOwnership();
                requireIdentity();
            } catch (WorkspaceException error) {
                throw error;
            } catch (IOException | RuntimeException error) {
                throw failure("WORKSPACE_UNAVAILABLE");
            }
        }

        private void requireIdentity() throws IOException {
            if (!key.equals(directory(run, true).fileKey())
                    || !java.util.Arrays.equals(readMarker(run), marker(run, projectId, jobId)))
                throw failure("WORKSPACE_UNAVAILABLE");
        }

        @Override
        public synchronized void close() {
            if (released) return;
            // Cancellation must not turn FileChannel marker reads into ClosedByInterruptException
            // before cleanup starts. Restore the caller's interrupt signal after bounded cleanup.
            boolean interrupted = Thread.interrupted();
            try {
                synchronized (RetainedRunWorkspace.this) {
                    try {
                        requireOpen();
                        deleteVerified(run, key, scan(run, new Budget(false)));
                        leases.remove(run);
                        released = true;
                    } catch (WorkspaceException error) {
                        cleanupBlocked = true;
                        throw error;
                    } catch (IOException | RuntimeException error) {
                        cleanupBlocked = true;
                        throw failure("WORKSPACE_UNAVAILABLE");
                    }
                }
            } finally {
                if (interrupted) Thread.currentThread().interrupt();
            }
        }
    }

    /** A live or uncleanable lease retains the lock; shutdown never silently transfers ownership. */
    @Override
    @PreDestroy
    public synchronized void close() {
        if (closed) return;
        if (!leases.isEmpty()) throw failure("WORKSPACE_ACTIVE_LEASES");
        try {
            releaseLock();
            closed = true;
        } catch (IOException error) {
            throw failure("WORKSPACE_UNAVAILABLE");
        }
    }

    private void initialize(Budget budget) throws IOException {
        budget.check();
        if (SourceAccess.windows()) {
            initializeWindows(budget);
            return;
        }
        if (lock != null) return;
        Path configuredData = properties.reposRoot().getParent();
        Path anchor = configuredData.getParent();
        if (anchor == null) throw failure("WORKSPACE_UNAVAILABLE");
        while (!Files.exists(anchor, LinkOption.NOFOLLOW_LINKS)) {
            anchor = anchor.getParent();
            if (anchor == null) throw failure("WORKSPACE_UNAVAILABLE");
        }
        // Canonicalize the pre-existing OS parent (e.g. /var -> /private/var); app-owned entries below
        // it are checked with NOFOLLOW. This deliberately does not claim descriptor-relative confinement.
        Path canonical = anchor.toRealPath();
        owner = canonical
                .getFileSystem()
                .getUserPrincipalLookupService()
                .lookupPrincipalByName(System.getProperty("user.name"));
        for (Path part : anchor.relativize(configuredData)) {
            canonical = canonical.resolve(part);
            createDirectoryIfAbsent(canonical, false);
        }
        Path repos = canonical.resolve("repos");
        createDirectoryIfAbsent(repos, false);
        root = repos.resolve(".analysis-runs");
        createDirectoryIfAbsent(root, true);
        rootKey = directory(root, true).fileKey();
        root = root.toRealPath();
        if (!rootKey.equals(directory(root, true).fileKey())) throw failure("WORKSPACE_UNAVAILABLE");
        device = device(root, true);
        Path ownerLock = root.resolve("owner.lock");
        reserveRoot();
        try {
            try {
                lockChannel = FileChannel.open(
                        ownerLock,
                        Set.of(
                                StandardOpenOption.CREATE_NEW,
                                StandardOpenOption.READ,
                                StandardOpenOption.WRITE,
                                LinkOption.NOFOLLOW_LINKS),
                        PosixFilePermissions.asFileAttribute(FILE_MODE));
            } catch (FileAlreadyExistsException existing) {
                regular(ownerLock, true);
                lockChannel = FileChannel.open(
                        ownerLock, StandardOpenOption.READ, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
            }
            BasicFileAttributes lockAttributes = regular(ownerLock, true);
            if (lockAttributes.size() != 0) throw failure("WORKSPACE_UNAVAILABLE");
            lockKey = lockAttributes.fileKey();
            try {
                lock = lockChannel.tryLock();
            } catch (OverlappingFileLockException error) {
                throw failure("WORKSPACE_BUSY");
            }
            if (lock == null) throw failure("WORKSPACE_BUSY");
            requireOwnership();
            cleanOrphans(budget);
        } catch (IOException | RuntimeException error) {
            try {
                releaseLock();
            } catch (IOException ignored) {
                // Do not abandon the JVM reservation when closure could not be confirmed.
                // A subsequent explicit close can retry; new work stays blocked.
                cleanupBlocked = true;
            }
            throw error;
        }
    }

    private void initializeWindows(Budget budget) throws IOException {
        if (nativeLock != null) return;
        Path repos = properties.reposRoot().toAbsolutePath().normalize();
        nativeStorage = new WindowsStorage(repos, "workspace");
        try {
            root = repos.resolve(".analysis-runs");
            if (nativeStorage.stat(root, true, true) == null) nativeStorage.mkdir(root);
            WindowsStorage.State rootState = nativeStorage.stat(root, true, false);
            rootKey = rootState.identity();
            device = rootState.volume();
            nativeLock = nativeStorage.lock(
                    root.resolve("owner.lock"),
                    "code-intelligence-retained-workspace-lock-v1\n".getBytes(StandardCharsets.US_ASCII));
            requireOwnership();
            cleanOrphans(budget);
        } catch (IOException | RuntimeException error) {
            try {
                releaseLock();
            } catch (IOException ignored) {
                cleanupBlocked = true;
            }
            throw error;
        }
    }

    private void cleanOrphans(Budget budget) throws IOException {
        Map<Path, List<TreeEntry>> verified = new LinkedHashMap<>();
        for (Path run : workspaceEntries(root)) {
            budget.check();
            if (run.getFileName().toString().equals("owner.lock")) continue;
            if (verified.size() >= MAX_RUNS
                    || !RUN_NAME.matcher(run.getFileName().toString()).matches())
                throw failure("WORKSPACE_UNAVAILABLE");
            directory(run, true);
            String marker = new String(readMarker(run), StandardCharsets.US_ASCII);
            String[] lines = marker.split("\n", -1);
            if (lines.length != 5
                    || !lines[0].equals(MARKER_PREFIX.stripTrailing())
                    || !lines[1].equals(run.getFileName().toString())
                    || !positiveDecimal(lines[2])
                    || !positiveDecimal(lines[3])
                    || !lines[4].isEmpty()) throw failure("WORKSPACE_UNAVAILABLE");
            verified.put(run, scan(run, budget));
        }
        for (var entry : verified.entrySet()) {
            budget.check();
            deleteVerified(entry.getKey(), entry.getValue().getFirst().key(), entry.getValue());
        }
    }

    private synchronized void requireOwnership() throws IOException {
        if (SourceAccess.windows()) {
            if (closed || nativeStorage == null || nativeLock == null) throw failure("WORKSPACE_UNAVAILABLE");
            WindowsStorage.State current = nativeLock.check();
            WindowsStorage.State rootState = nativeStorage.stat(root, true, false);
            if (!rootKey.equals(rootState.identity())
                    || !device.equals(rootState.volume())
                    || current.size() != "code-intelligence-retained-workspace-lock-v1\n".length())
                throw failure("WORKSPACE_UNAVAILABLE");
            return;
        }
        if (closed || lock == null || !lock.isValid() || lockChannel == null || !lockChannel.isOpen())
            throw failure("WORKSPACE_UNAVAILABLE");
        synchronized (JVM_OWNERS) {
            if (reservedRoot == null
                    || !reservedRoot.equals(root)
                    || !new RootIdentity(device, rootKey).equals(reservedIdentity)
                    || JVM_OWNERS.get(reservedIdentity) != this) throw failure("WORKSPACE_UNAVAILABLE");
        }
        BasicFileAttributes currentLock = regular(root.resolve("owner.lock"), true);
        if (!rootKey.equals(directory(root, true).fileKey())
                || !device(root, true).equals(device)
                || !lockKey.equals(currentLock.fileKey())
                || currentLock.size() != 0) throw failure("WORKSPACE_UNAVAILABLE");
    }

    private void releaseLock() throws IOException {
        if (SourceAccess.windows()) {
            IOException failure = null;
            try {
                if (nativeLock != null) nativeLock.close();
            } catch (IOException error) {
                failure = error;
            }
            try {
                if (nativeStorage != null) nativeStorage.close();
            } catch (IOException error) {
                if (failure == null) failure = error;
            }
            if (failure != null) {
                cleanupBlocked = true;
                throw failure;
            }
            nativeLock = null;
            nativeStorage = null;
            return;
        }
        IOException failure = null;
        try {
            if (lock != null && lock.isValid()) lock.release();
        } catch (IOException error) {
            failure = error;
        } finally {
            if (lockChannel != null) {
                try {
                    lockChannel.close();
                } catch (IOException error) {
                    if (failure == null) failure = error;
                }
            }
        }
        if (failure != null) {
            cleanupBlocked = true;
            throw failure;
        }
        lock = null;
        lockChannel = null;
        synchronized (JVM_OWNERS) {
            if (reservedRoot != null) {
                if (JVM_OWNERS.get(reservedIdentity) != this) throw failure("WORKSPACE_UNAVAILABLE");
                JVM_OWNERS.remove(reservedIdentity);
                reservedRoot = null;
                reservedIdentity = null;
            }
        }
    }

    private void reserveRoot() {
        synchronized (JVM_OWNERS) {
            RootIdentity identity = new RootIdentity(device, rootKey);
            if (reservedRoot != null || JVM_OWNERS.containsKey(identity)) throw failure("WORKSPACE_BUSY");
            JVM_OWNERS.put(identity, this);
            reservedRoot = root;
            reservedIdentity = identity;
        }
    }

    private void validate(Manifest manifest, Budget budget) {
        if (manifest == null
                || !hex(manifest.snapshotSha(), 40)
                || manifest.approvedAt() == null
                || manifest.approvedAt().getEpochSecond() < 0
                || manifest.approvedAt().getEpochSecond() > 253402300799L
                || !LocalSourcePolicy.VERSION.equals(manifest.policyVersion())
                || !hex(manifest.limitsSha256(), 64)
                || !hex(manifest.manifestSha256(), 64)
                || manifest.fileCount() != manifest.entries().size()
                || manifest.totalBytes() < 0
                || manifest.totalBytes() > MAX_TOTAL_BYTES) throw failure("WORKSPACE_INVALID_MANIFEST");
        LocalSourceManifest digest = new LocalSourceManifest(manifest.policyVersion(), manifest.limitsSha256());
        Set<String> files = new HashSet<>();
        Set<String> directories = new HashSet<>();
        Map<String, String> aliases = new HashMap<>();
        int metadata = 256;
        String previous = null;
        for (Entry entry : manifest.entries()) {
            budget.check();
            int pathBytes = pathBytes(entry.path());
            if (!hex(entry.gitOid(), 40)
                    || !hex(entry.rawSha256(), 64)
                    || entry.byteSize() < 0
                    || entry.byteSize() > MAX_FILE_BYTES
                    || previous != null && LocalSourcePolicy.comparePaths(previous, entry.path()) >= 0)
                throw failure("WORKSPACE_INVALID_MANIFEST");
            metadata = Math.addExact(metadata, pathBytes + 128);
            if (metadata > MAX_METADATA_BYTES) throw failure("WORKSPACE_INVALID_MANIFEST");
            files.add(entry.path());
            alias(aliases, entry.path());
            String parent = entry.path();
            while (parent.lastIndexOf('/') >= 0) {
                parent = parent.substring(0, parent.lastIndexOf('/'));
                if (files.contains(parent)) throw failure("WORKSPACE_INVALID_MANIFEST");
                directories.add(parent);
                alias(aliases, parent);
            }
            if (files.size() + directories.size() > MAX_SOURCE_ENTRIES) throw failure("WORKSPACE_INVALID_MANIFEST");
            digest.add(entry.path(), entry.byteSize(), HexFormat.of().parseHex(entry.rawSha256()));
            if (digest.bytes() > MAX_TOTAL_BYTES) throw failure("WORKSPACE_INVALID_MANIFEST");
            previous = entry.path();
        }
        if (digest.bytes() != manifest.totalBytes()
                || digest.count() != manifest.fileCount()
                || !digest.finish().equals(manifest.manifestSha256())) throw failure("WORKSPACE_INVALID_MANIFEST");
    }

    private static int pathBytes(String value) {
        if (value == null
                || value.isBlank()
                || value.length() > 8192
                || value.startsWith("/")
                || value.indexOf('\\') >= 0
                || value.matches("^[A-Za-z]:.*")
                || value.chars().anyMatch(Character::isISOControl)) throw failure("WORKSPACE_INVALID_MANIFEST");
        String lower = value.toLowerCase(Locale.ROOT);
        if (lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c"))
            throw failure("WORKSPACE_INVALID_MANIFEST");
        String[] parts = value.split("/", -1);
        if (parts.length > 64) throw failure("WORKSPACE_INVALID_MANIFEST");
        for (String part : parts) {
            if (part.isEmpty()
                    || part.equals(".")
                    || part.equals("..")
                    || part.equalsIgnoreCase(".git")
                    || utf8Length(part) > 255) throw failure("WORKSPACE_INVALID_MANIFEST");
        }
        int length = utf8Length(value);
        if (length > 8192) throw failure("WORKSPACE_INVALID_MANIFEST");
        return length;
    }

    private static int utf8Length(String value) {
        try {
            return StandardCharsets.UTF_8
                    .newEncoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .encode(java.nio.CharBuffer.wrap(value))
                    .remaining();
        } catch (CharacterCodingException error) {
            throw failure("WORKSPACE_INVALID_MANIFEST");
        }
    }

    private static void alias(Map<String, String> aliases, String path) {
        String normalized = Normalizer.normalize(path, Normalizer.Form.NFC).toLowerCase(Locale.ROOT);
        String previous = aliases.putIfAbsent(normalized, path);
        if (previous != null && !previous.equals(path)) throw failure("WORKSPACE_INVALID_MANIFEST");
    }

    private String materialize(Path repo, Manifest manifest, BlobReader reader, Budget budget) throws IOException {
        Map<Path, Object> directories = new HashMap<>();
        directories.put(repo, directory(repo, true).fileKey());
        Path git = repo.resolve(".git");
        privateParents(repo, git.resolve("refs/heads"), directories);
        writeFresh(
                git.resolve("config"),
                "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\n"
                        .getBytes(StandardCharsets.UTF_8),
                false);
        writeFresh(git.resolve("HEAD"), "ref: refs/heads/snapshot\n".getBytes(StandardCharsets.UTF_8), false);
        try (ObjectDatabase objects = new ObjectDirectory(
                new Config(),
                git.resolve("objects").toFile(),
                null,
                FS.DETECTED,
                git.resolve("shallow").toFile())) {
            objects.create();
            try (ObjectInserter inserter = objects.newInserter()) {
                List<DirCacheEntry> entries = new ArrayList<>(manifest.fileCount());
                for (Entry entry : manifest.entries()) {
                    budget.check();
                    byte[] bytes;
                    try {
                        bytes = reader.read(entry.rawSha256(), entry.byteSize());
                    } catch (IOException | RuntimeException error) {
                        budget.check();
                        throw failure("WORKSPACE_SOURCE_UNAVAILABLE");
                    }
                    budget.check();
                    if (bytes == null
                            || bytes.length != entry.byteSize()
                            || bytes.length > MAX_FILE_BYTES
                            || !HexFormat.of()
                                    .formatHex(LocalSourceManifest.sha256().digest(bytes))
                                    .equals(entry.rawSha256())) throw failure("WORKSPACE_SOURCE_INTEGRITY");
                    requireText(bytes);
                    Path destination = repo.resolve(entry.path());
                    privateParents(repo, destination.getParent(), directories);
                    writeFresh(destination, bytes, false);
                    ObjectId oid = inserter.insert(Constants.OBJ_BLOB, bytes);
                    if (!oid.name().equals(entry.gitOid())) throw failure("WORKSPACE_SOURCE_INTEGRITY");
                    DirCacheEntry cached = new DirCacheEntry(entry.path());
                    cached.setFileMode(FileMode.REGULAR_FILE);
                    cached.setObjectId(oid);
                    cached.setLength(bytes.length);
                    entries.add(cached);
                    budget.check();
                }
                DirCache index = DirCache.newInCore();
                DirCacheBuilder builder = index.builder();
                entries.forEach(builder::add);
                builder.finish();
                CommitBuilder commit = new CommitBuilder();
                commit.setTreeId(index.writeTree(inserter));
                PersonIdent author = new PersonIdent(
                        "Code Intelligence",
                        "local@code-intelligence.invalid",
                        Date.from(manifest.approvedAt()),
                        TimeZone.getTimeZone("UTC"));
                commit.setAuthor(author);
                commit.setCommitter(author);
                commit.setMessage("Code Intelligence local snapshot");
                ObjectId oid = inserter.insert(commit);
                if (!oid.name().equals(manifest.snapshotSha())) throw failure("WORKSPACE_SOURCE_INTEGRITY");
                inserter.flush();
                budget.check();
                writeFresh(
                        git.resolve("refs/heads/snapshot"),
                        (oid.name() + "\n").getBytes(StandardCharsets.UTF_8),
                        false);
            }
        }
        // JGit's fresh object directories/files can use broader defaults. The containing run has
        // always been private; narrow the generated entries before returning a usable clone path.
        List<TreeEntry> completed = scan(repo, budget);
        if (!SourceAccess.windows())
            for (TreeEntry entry : completed) {
                Files.setPosixFilePermissions(entry.path(), entry.directory() ? DIRECTORY_MODE : FILE_MODE);
            }
        return manifest.snapshotSha();
    }

    private static void requireText(byte[] bytes) {
        for (byte value : bytes) if (value == 0) throw failure("WORKSPACE_SOURCE_INTEGRITY");
        try {
            StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes));
        } catch (CharacterCodingException error) {
            throw failure("WORKSPACE_SOURCE_INTEGRITY");
        }
    }

    private void privateParents(Path repo, Path parent, Map<Path, Object> created) throws IOException {
        Path current = repo;
        if (!created.get(repo).equals(directory(repo, true).fileKey())) throw failure("WORKSPACE_UNAVAILABLE");
        for (Path part : repo.relativize(parent)) {
            if (part.toString().isEmpty()) continue;
            current = current.resolve(part);
            if (!created.containsKey(current)) {
                workspaceMkdir(current);
                created.put(current, directory(current, true).fileKey());
            } else if (!created.get(current).equals(directory(current, true).fileKey()))
                throw failure("WORKSPACE_UNAVAILABLE");
        }
    }

    private void workspaceMkdir(Path path) throws IOException {
        if (SourceAccess.windows()) nativeStorage.mkdir(path);
        else Files.createDirectory(path, PosixFilePermissions.asFileAttribute(DIRECTORY_MODE));
    }

    private List<Path> workspaceEntries(Path path) throws IOException {
        if (SourceAccess.windows())
            return nativeStorage.entries(path).stream()
                    .map(WindowsStorage.Entry::path)
                    .toList();
        try (var children = Files.newDirectoryStream(path)) {
            List<Path> result = new ArrayList<>();
            children.forEach(result::add);
            return result;
        }
    }

    private void createDirectoryIfAbsent(Path path, boolean privateMode) throws IOException {
        if (SourceAccess.windows()) {
            if (nativeStorage.stat(path, true, true) == null) nativeStorage.mkdir(path);
        } else {
            try {
                Files.createDirectory(path, PosixFilePermissions.asFileAttribute(DIRECTORY_MODE));
            } catch (FileAlreadyExistsException existing) {
                /* Validate rather than adopting. */
            }
        }
        directory(path, privateMode);
    }

    private BasicFileAttributes directory(Path path, boolean privateMode) throws IOException {
        BasicFileAttributes attributes = attributes(path, true);
        if (SourceAccess.windows()) return attributes;
        Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isDirectory()
                || permissions.contains(PosixFilePermission.GROUP_WRITE)
                || permissions.contains(PosixFilePermission.OTHERS_WRITE)
                || privateMode && !permissions.equals(DIRECTORY_MODE)) throw failure("WORKSPACE_UNAVAILABLE");
        return attributes;
    }

    private BasicFileAttributes regular(Path path, boolean privateMode) throws IOException {
        BasicFileAttributes attributes = attributes(path, false);
        if (SourceAccess.windows()) return attributes;
        if (!attributes.isRegularFile()
                || ((Number) Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS)).longValue() != 1
                || privateMode
                        && !Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS)
                                .equals(FILE_MODE)) throw failure("WORKSPACE_UNAVAILABLE");
        return attributes;
    }

    private BasicFileAttributes attributes(Path path, boolean directory) throws IOException {
        BasicFileAttributes attributes = SourceAccess.windows()
                ? nativeStorage.stat(path, directory, false)
                : Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink()
                || attributes.fileKey() == null
                || !SourceAccess.windows()
                        && !Files.getOwner(path, LinkOption.NOFOLLOW_LINKS).equals(owner))
            throw failure("WORKSPACE_UNAVAILABLE");
        return attributes;
    }

    private byte[] readMarker(Path run) throws IOException {
        Path marker = run.resolve("owner.meta");
        BasicFileAttributes before = regular(marker, true);
        if (before.size() > 160 || before.size() < MARKER_PREFIX.length()) throw failure("WORKSPACE_UNAVAILABLE");
        if (SourceAccess.windows()) return nativeStorage.read(marker, (WindowsStorage.State) before, 160);
        byte[] bytes = new byte[(int) before.size()];
        try (FileChannel channel = FileChannel.open(marker, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            ByteBuffer target = ByteBuffer.wrap(bytes);
            while (target.hasRemaining()) if (channel.read(target) <= 0) throw failure("WORKSPACE_UNAVAILABLE");
            if (channel.read(ByteBuffer.allocate(1)) != -1) throw failure("WORKSPACE_UNAVAILABLE");
        }
        BasicFileAttributes after = regular(marker, true);
        if (!before.fileKey().equals(after.fileKey())
                || before.size() != after.size()
                || !before.lastModifiedTime().equals(after.lastModifiedTime())) throw failure("WORKSPACE_UNAVAILABLE");
        return bytes;
    }

    private static byte[] marker(Path run, long projectId, long jobId) {
        return (MARKER_PREFIX + run.getFileName() + "\n" + projectId + "\n" + jobId + "\n")
                .getBytes(StandardCharsets.US_ASCII);
    }

    private void writeFresh(Path file, byte[] bytes, boolean durable) throws IOException {
        if (SourceAccess.windows()) nativeStorage.fresh(file, bytes);
        else
            try (FileChannel channel = FileChannel.open(
                    file,
                    Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                    PosixFilePermissions.asFileAttribute(FILE_MODE))) {
                ByteBuffer source = ByteBuffer.wrap(bytes);
                while (source.hasRemaining()) channel.write(source);
                if (durable) channel.force(true);
            }
        regular(file, true);
    }

    private record TreeEntry(Path path, Object key, boolean directory) {}

    private List<TreeEntry> scan(Path subtree, Budget budget) throws IOException {
        List<TreeEntry> entries = new ArrayList<>();
        try (SourceAccess.Scope ignored = SourceAccess.windows() ? SourceAccess.attach(root, nativeStorage) : null) {
            SourceAccess.walk(subtree, 70, new SimpleFileVisitor<>() {
                private void record(Path path, boolean isDirectory) throws IOException {
                    budget.check();
                    BasicFileAttributes attributes = isDirectory ? directory(path, false) : regular(path, false);
                    if (entries.size() >= MAX_TREE_ENTRIES
                            || !device(path, isDirectory).equals(device)) throw failure("WORKSPACE_UNAVAILABLE");
                    entries.add(new TreeEntry(path, SourceAccess.proof(attributes), isDirectory));
                }

                @Override
                public FileVisitResult preVisitDirectory(Path path, BasicFileAttributes attrs) throws IOException {
                    record(path, true);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path path, BasicFileAttributes attrs) throws IOException {
                    record(path, false);
                    return FileVisitResult.CONTINUE;
                }
            });
        }
        return entries;
    }

    private void deleteVerified(Path run, Object key, List<TreeEntry> entries) throws IOException {
        requireOwnership();
        if (!key.equals(directory(run, true).fileKey())) throw failure("WORKSPACE_UNAVAILABLE");
        Budget budget = new Budget(false);
        TreeEntry marker = null;
        for (int index = entries.size() - 1; index >= 0; index--) {
            TreeEntry entry = entries.get(index);
            if (entry.path().equals(run)) continue;
            if (entry.path().equals(run.resolve("owner.meta"))) {
                marker = entry;
                continue;
            }
            budget.check();
            deleteEntry(entry);
        }
        if (marker != null) deleteEntry(marker);
        deleteEntry(entries.getFirst());
    }

    private void deleteEntry(TreeEntry entry) throws IOException {
        BasicFileAttributes current = entry.directory() ? directory(entry.path(), false) : regular(entry.path(), false);
        if (!entry.key().equals(SourceAccess.proof(current))
                || !device(entry.path(), entry.directory()).equals(device)) throw failure("WORKSPACE_UNAVAILABLE");
        if (SourceAccess.windows())
            nativeStorage.removeExpected(
                    entry.path(), entry.directory(), entry.key().toString());
        else Files.delete(entry.path());
    }

    private String device(Path path, boolean directory) throws IOException {
        return SourceAccess.windows()
                ? nativeStorage.stat(path, directory, false).volume()
                : Files.getAttribute(path, "unix:dev", LinkOption.NOFOLLOW_LINKS)
                        .toString();
    }

    private static boolean positiveDecimal(String value) {
        if (!value.matches("[1-9][0-9]{0,18}")) return false;
        try {
            return Long.parseLong(value) > 0;
        } catch (NumberFormatException error) {
            return false;
        }
    }

    private static boolean hex(String value, int length) {
        return value != null && value.length() == length && value.matches("[0-9a-f]+");
    }

    private final class Budget {
        private final long started = clock.getAsLong();
        private final boolean interruptible;

        private Budget(boolean interruptible) {
            this.interruptible = interruptible;
        }

        private void check() {
            if (interruptible && Thread.currentThread().isInterrupted()) throw failure("WORKSPACE_CANCELLED");
            if (clock.getAsLong() - started > TIME_LIMIT_NANOS) throw failure("WORKSPACE_TIMEOUT");
        }
    }

    private static WorkspaceException failure(String code) {
        return new WorkspaceException(code);
    }

    /** Fixed codes only: source bytes, local paths, and provider errors never become exception text. */
    public static final class WorkspaceException extends RuntimeException {
        private final String code;

        private WorkspaceException(String code) {
            super(code, null, false, true);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }
}
