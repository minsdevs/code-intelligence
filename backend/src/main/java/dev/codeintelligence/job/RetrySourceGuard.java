package dev.codeintelligence.job;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.LongSupplier;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.ObjectLoader;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;
import org.eclipse.jgit.treewalk.CanonicalTreeParser;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Refuses to resume an imported checkpoint against another source. The caller serializes app
 * writers with the project lock and active-job check. This is an application-level check, not
 * filesystem confinement against a hostile process changing ancestors after verification.
 */
@Component
public class RetrySourceGuard {
    private static final String CONFLICT = "The source for this checkpoint has changed or cannot be verified. "
            + "Preview the current source and start a new analysis.";
    private static final Set<String> IMPORT_STEPS = Set.of("IMPORT", "LOCAL_IMPORT");
    private static final int BUFFER_SIZE = 8192;

    // These are retry-verification ceilings, not expanded import/analysis support. Time checks
    // are cooperative; JGit pack decoding and OS calls are not a worker isolation boundary.
    record Limits(int files, long fileBytes, long totalBytes, int depth, long metadataBytes, long nanos) {
        Limits {
            if (files < 1
                    || files > 50_000
                    || fileBytes < 1
                    || fileBytes > 2 * 1024 * 1024L
                    || totalBytes < 1
                    || depth < 1
                    || depth > 64
                    || metadataBytes < 1
                    || metadataBytes > 16 * 1024 * 1024L
                    || nanos < 1) {
                throw new IllegalArgumentException("Invalid retry verification limits");
            }
        }
    }

    private final JobRepository jobs;
    private final AppProperties app;
    private final Limits limits;
    private final LongSupplier nanoTime;
    private final JobWorkspaceProvider workspaces;

    @Autowired
    public RetrySourceGuard(
            JobRepository jobs, AppProperties app, AnalysisProperties analysis, JobWorkspaceProvider workspaces) {
        this(
                jobs,
                app,
                new Limits(
                        Math.min(analysis.maxFiles(), 50_000),
                        Math.min(analysis.maxFileSize(), 2 * 1024 * 1024L),
                        512 * 1024 * 1024L,
                        64,
                        16 * 1024 * 1024L,
                        Duration.ofSeconds(10).toNanos()),
                System::nanoTime,
                workspaces);
    }

    /** Legacy-only construction retained for focused filesystem verification. */
    public RetrySourceGuard(JobRepository jobs, AppProperties app, AnalysisProperties analysis) {
        this(jobs, app, analysis, null);
    }

    RetrySourceGuard(JobRepository jobs, AppProperties app, Limits limits, LongSupplier nanoTime) {
        this(jobs, app, limits, nanoTime, null);
    }

    private RetrySourceGuard(
            JobRepository jobs,
            AppProperties app,
            Limits limits,
            LongSupplier nanoTime,
            JobWorkspaceProvider workspaces) {
        this.jobs = jobs;
        this.app = app;
        this.limits = limits;
        this.nanoTime = nanoTime;
        this.workspaces = workspaces;
    }

    public void verify(JobRecord job) {
        boolean retained = false;
        if (job.snapshotId() != null && workspaces != null) {
            try {
                retained = workspaces.verifyRetainedCheckpoint(job.projectId(), job.id(), job.snapshotId());
            } catch (RuntimeException invalidInput) {
                throw conflict();
            }
        }
        List<JobStepRecord> imports = jobs.findSteps(job.id()).stream()
                .filter(step -> IMPORT_STEPS.contains(step.stepKey()) && step.status() == StepStatus.DONE)
                .toList();
        // Generic pipelines and failures before a completed import retain their existing retry semantics.
        if (imports.isEmpty()) return;
        if (imports.size() != 1
                || job.snapshotId() == null
                || imports.getFirst().finishedAt() == null) {
            throw conflict();
        }
        if (jobs.hasLaterImportAttempt(
                job.projectId(), job.id(), imports.getFirst().finishedAt())) {
            throw conflict();
        }
        String commit = jobs.findRetrySnapshotCommit(job.id(), job.projectId(), job.snapshotId())
                .orElseThrow(RetrySourceGuard::conflict);
        if (retained) return;
        verifySource(job.projectId(), commit);
    }

    void verifySource(long projectId, String commit) {
        if (commit == null || !ObjectId.isId(commit)) throw conflict();
        Budget budget = new Budget();
        try {
            if (Files.isSymbolicLink(app.reposRoot())) throw conflict();
            Path repos = app.reposRoot().toRealPath();
            Path clone = repos.resolve(Long.toString(projectId));
            Stamp root = directory(clone);
            Path git = clone.resolve(Constants.DOT_GIT);
            Map<Path, Stamp> metadata = inspectGitDirectory(git, budget);
            validateConfig(git, budget);
            ObjectId expected = ObjectId.fromString(commit);
            try (Repository repository = new FileRepositoryBuilder()
                            .setGitDir(git.toFile())
                            .setWorkTree(clone.toFile())
                            .setMustExist(true)
                            .build();
                    ObjectReader reader = repository.newObjectReader()) {
                reader.setStreamFileThreshold(0);
                if (!expected.equals(repository.resolve(Constants.HEAD))) throw conflict();
                SourceTree source = readTree(reader, expected, budget);
                // Resumed analysis consumes HEAD and raw files, not the index. Do not use Git
                // status/stat-cache flags or parse an index to decide which bytes are safe.
                verifyWorkingTree(clone, git, reader, source, budget);
                if (!expected.equals(repository.resolve(Constants.HEAD))) throw conflict();
                if (!root.equals(directory(clone)) || !metadata.equals(inspectGitDirectory(git, budget))) {
                    throw conflict();
                }
                budget.check();
            }
        } catch (JobConflictException e) {
            throw e;
        } catch (IOException | RuntimeException e) {
            // Never expose local paths, object data, or a parser exception in the conflict response.
            throw conflict();
        }
    }

    private Map<Path, Stamp> inspectGitDirectory(Path git, Budget budget) throws IOException {
        directory(git);
        for (String forbidden : List.of("commondir", "objects/info/alternates", "worktrees")) {
            if (Files.exists(git.resolve(forbidden), LinkOption.NOFOLLOW_LINKS)) throw conflict();
        }
        Map<Path, Stamp> stamps = new HashMap<>();
        long[] bytes = {0};
        Files.walkFileTree(git, Set.of(), limits.depth() + 1, new SimpleFileVisitor<>() {
            private void record(Path path, BasicFileAttributes attrs) throws IOException {
                budget.check();
                if (git.relativize(path).getNameCount() > limits.depth()
                        || stamps.size() >= maxEntries()
                        || attrs.isSymbolicLink()
                        || (!attrs.isDirectory() && !attrs.isRegularFile())) throw conflict();
                if (attrs.isRegularFile()) {
                    // JavaSourceRoots currently scans the whole clone, including .git. Such
                    // sources have no checkpoint tree entry and must not influence resolution.
                    if (path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".java")) {
                        throw conflict();
                    }
                    requireSingleLink(path);
                    bytes[0] = Math.addExact(bytes[0], attrs.size());
                    if (bytes[0] > limits.totalBytes()) throw conflict();
                    if (!path.startsWith(git.resolve("objects")) && attrs.size() > limits.metadataBytes()) {
                        throw conflict();
                    }
                }
                stamps.put(git.relativize(path), stamp(attrs));
            }

            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                record(dir, attrs);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                if (attrs.isDirectory()) throw conflict(); // max-depth boundary
                record(file, attrs);
                return FileVisitResult.CONTINUE;
            }
        });
        return stamps;
    }

    private void validateConfig(Path git, Budget budget) throws IOException {
        Path path = git.resolve("config");
        BasicFileAttributes attrs = regularFile(path);
        if (attrs.size() > limits.metadataBytes()) throw conflict();
        byte[] bytes;
        try (InputStream input = Files.newInputStream(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            bytes = readMetadata(input, attrs.size(), budget);
        }
        Config config = new Config();
        try {
            config.fromText(StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString());
        } catch (org.eclipse.jgit.errors.ConfigInvalidException e) {
            throw conflict();
        }
        if (config.getSections().stream()
                        .anyMatch(
                                section -> section.equalsIgnoreCase("include") || section.equalsIgnoreCase("includeIf"))
                || config.getString("core", null, "worktree") != null
                || config.getBoolean("core", null, "bare", false)) throw conflict();
    }

    private SourceTree readTree(ObjectReader reader, ObjectId commit, Budget budget) throws IOException {
        RevCommit parsed = RevCommit.parse(readObject(reader, commit, Constants.OBJ_COMMIT, budget));
        ArrayDeque<Tree> pending = new ArrayDeque<>();
        pending.push(new Tree("", parsed.getTree().getId(), 0));
        Map<String, Entry> entries = new HashMap<>();
        Set<String> directories = new HashSet<>();
        Set<String> paths = new HashSet<>();
        while (!pending.isEmpty()) {
            budget.check();
            Tree tree = pending.pop();
            CanonicalTreeParser parser = new CanonicalTreeParser();
            parser.reset(readObject(reader, tree.oid(), Constants.OBJ_TREE, budget));
            while (!parser.eof()) {
                budget.check();
                String name = parser.getEntryPathString();
                if (name.isEmpty()
                        || name.equals(".")
                        || name.equals("..")
                        || name.equalsIgnoreCase(".git")
                        || name.indexOf('/') >= 0
                        || name.indexOf('\\') >= 0
                        || name.indexOf('\0') >= 0
                        || name.indexOf('\ufffd') >= 0) throw conflict();
                String path = tree.prefix() + name;
                if (tree.depth() + 1 > limits.depth() || !paths.add(path) || paths.size() > maxEntries()) {
                    throw conflict();
                }
                FileMode mode = parser.getEntryFileMode();
                ObjectId oid = parser.getEntryObjectId();
                if (FileMode.TREE.equals(mode)) {
                    directories.add(path);
                    pending.push(new Tree(path + "/", oid, tree.depth() + 1));
                } else {
                    if ((!FileMode.REGULAR_FILE.equals(mode) && !FileMode.EXECUTABLE_FILE.equals(mode))
                            || entries.size() >= limits.files()) throw conflict();
                    entries.put(path, new Entry(oid));
                }
                parser.next(1);
            }
        }
        return new SourceTree(entries, directories);
    }

    private byte[] readObject(ObjectReader reader, ObjectId oid, int type, Budget budget) throws IOException {
        budget.check();
        long size = reader.getObjectSize(oid, type);
        if (size < 0 || size > limits.metadataBytes()) throw conflict();
        ObjectLoader loader = reader.open(oid, type);
        if (loader.getSize() != size) throw conflict();
        byte[] bytes;
        try (InputStream input = loader.openStream()) {
            bytes = readMetadata(input, size, budget);
        }
        try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
            if (!formatter.idFor(type, bytes).equals(oid)) throw conflict();
        }
        return bytes;
    }

    private byte[] readMetadata(InputStream input, long size, Budget budget) throws IOException {
        if (size < 0 || size > limits.metadataBytes() - budget.metadataBytes) throw conflict();
        ByteArrayOutputStream output = new ByteArrayOutputStream((int) Math.min(size, BUFFER_SIZE));
        byte[] buffer = new byte[BUFFER_SIZE];
        long count = 0;
        int read;
        while ((read = input.read(buffer, 0, (int) Math.min(buffer.length, size + 1 - count))) != -1) {
            budget.check();
            count += read;
            if (count > size) throw conflict();
            output.write(buffer, 0, read);
        }
        if (count != size) throw conflict();
        budget.metadataBytes += count;
        return output.toByteArray();
    }

    private void verifyWorkingTree(Path clone, Path git, ObjectReader reader, SourceTree source, Budget budget)
            throws IOException {
        Map<String, Entry> entries = source.files();
        Set<String> remaining = new HashSet<>(entries.keySet());
        Map<Path, Stamp> directories = new HashMap<>();
        int[] visited = {0};
        Files.walkFileTree(clone, Set.of(), limits.depth() + 1, new SimpleFileVisitor<>() {
            private void visit(Path path) {
                budget.check();
                if (++visited[0] > maxEntries() || clone.relativize(path).getNameCount() > limits.depth()) {
                    throw conflict();
                }
            }

            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (dir.equals(git)) return FileVisitResult.SKIP_SUBTREE;
                visit(dir);
                if (!dir.equals(clone)
                        && !source.directories()
                                .contains(clone.relativize(dir).toString().replace('\\', '/'))) {
                    throw conflict();
                }
                directories.put(dir, stamp(attrs));
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                visit(file);
                String relative = clone.relativize(file).toString().replace('\\', '/');
                Entry expected = entries.get(relative);
                if (expected == null || !remaining.remove(relative)) throw conflict();
                BasicFileAttributes before = regularFile(file);
                if (before.size() > limits.fileBytes()) throw conflict();
                long size = reader.getObjectSize(expected.oid(), Constants.OBJ_BLOB);
                if (size < 0 || size != before.size() || size > limits.fileBytes()) throw conflict();
                ObjectLoader loader = reader.open(expected.oid(), Constants.OBJ_BLOB);
                if (loader.getSize() != size) throw conflict();
                try (InputStream input = loader.openStream()) {
                    verifyBlob(input, size, expected.oid(), budget);
                }
                try (InputStream input =
                        Files.newInputStream(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
                    verifyBlob(input, size, expected.oid(), budget);
                }
                if (!stamp(before).equals(stamp(regularFile(file)))) throw conflict();
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, IOException error) throws IOException {
                if (error != null) throw error;
                if (!directories.get(dir).equals(directory(dir))) throw conflict();
                return FileVisitResult.CONTINUE;
            }
        });
        if (!remaining.isEmpty()) throw conflict();
    }

    private void verifyBlob(InputStream input, long size, ObjectId expected, Budget budget) throws IOException {
        MessageDigest digest = sha1();
        digest.update(("blob " + size + '\0').getBytes(StandardCharsets.US_ASCII));
        byte[] buffer = new byte[BUFFER_SIZE];
        long count = 0;
        int read;
        while ((read = input.read(buffer, 0, (int) Math.min(buffer.length, size + 1 - count))) != -1) {
            budget.check();
            count += read;
            budget.sourceBytes += read;
            if (count > size || budget.sourceBytes > limits.totalBytes()) throw conflict();
            digest.update(buffer, 0, read);
        }
        if (count != size || !ObjectId.fromRaw(digest.digest()).equals(expected)) throw conflict();
    }

    private BasicFileAttributes regularFile(Path path) throws IOException {
        BasicFileAttributes attrs = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attrs.isRegularFile() || attrs.isSymbolicLink()) throw conflict();
        requireSingleLink(path);
        return attrs;
    }

    private void requireSingleLink(Path path) throws IOException {
        if (((Number) Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS)).longValue() != 1) {
            throw conflict();
        }
    }

    private Stamp directory(Path path) throws IOException {
        BasicFileAttributes attrs = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attrs.isDirectory() || attrs.isSymbolicLink()) throw conflict();
        return stamp(attrs);
    }

    private Stamp stamp(BasicFileAttributes attrs) {
        if (attrs.fileKey() == null) throw conflict();
        return new Stamp(attrs.fileKey(), attrs.size(), attrs.lastModifiedTime(), attrs.isDirectory());
    }

    private int maxEntries() {
        return limits.files() * 4 + 1024;
    }

    private static MessageDigest sha1() {
        try {
            return MessageDigest.getInstance("SHA-1");
        } catch (NoSuchAlgorithmException e) {
            throw conflict();
        }
    }

    private static JobConflictException conflict() {
        JobConflictException exception = new JobConflictException(CONFLICT);
        exception.getBody().setProperty("code", "RETRY_SOURCE_UNVERIFIED");
        return exception;
    }

    private record Stamp(Object key, long size, FileTime modified, boolean directory) {}

    private record Tree(String prefix, ObjectId oid, int depth) {}

    private record Entry(ObjectId oid) {}

    private record SourceTree(Map<String, Entry> files, Set<String> directories) {}

    private final class Budget {
        private final long started = nanoTime.getAsLong();
        private long sourceBytes;
        private long metadataBytes;

        void check() {
            if (Thread.currentThread().isInterrupted() || nanoTime.getAsLong() - started > limits.nanos()) {
                throw conflict();
            }
        }
    }
}
