package dev.codeintelligence.backup;

import static dev.codeintelligence.backup.SourceProtocol.*;

import dev.codeintelligence.common.SourceAccess;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.TreeMap;
import org.eclipse.jgit.dircache.DirCache;
import org.eclipse.jgit.dircache.DirCacheEntry;
import org.eclipse.jgit.errors.MissingObjectException;
import org.eclipse.jgit.internal.storage.file.ObjectDirectory;
import org.eclipse.jgit.lib.CommitBuilder;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.ObjectDatabase;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.util.FS;
import tools.jackson.databind.JsonNode;

/**
 * Fixed offline entry point for the bundled JRE. Main owns maintenance authorization, trusted paths,
 * database selection and archive publication. This helper starts no Spring context, process or network.
 */
public final class BackupSourceWorker {
    public static final String FLAG = "--ci-backup-source-worker";

    private BackupSourceWorker() {}

    public static boolean requested(String[] args) {
        return Arrays.stream(args).anyMatch(value -> value.startsWith(FLAG));
    }

    /** Static framed errors only; never print an exception, path, source text or submitted JSON. */
    public static int run(String[] args, InputStream input, OutputStream output) {
        DataOutputStream target = new DataOutputStream(output);
        try {
            if (args.length != 1 || !FLAG.equals(args[0])) throw failure("SOURCE_ARGUMENT_INVALID");
            DataInputStream source = new DataInputStream(input);
            JsonNode request = read(source);
            if (number(request.get("version"), 1) != 1) throw failure("SOURCE_PROTOCOL_INVALID");
            String operation = text(request.get("operation"));
            if (!operation.equals("EXPORT") && !operation.equals("IMPORT") && !operation.equals("EXPORT_RETAINED"))
                throw failure("SOURCE_PROTOCOL_INVALID");
            exact(
                    request,
                    operation.equals("EXPORT")
                            ? new String[] {"version", "operation", "reposRoot", "projectId", "selection"}
                            : operation.equals("EXPORT_RETAINED")
                                    ? new String[] {
                                        "version",
                                        "operation",
                                        "reposRoot",
                                        "scratchRoot",
                                        "projectId",
                                        "selection",
                                        "retainedCount"
                                    }
                                    : new String[] {
                                        "version", "operation", "stageRoot", "projectId", "selection", "expected"
                                    });
            String project = id(request.get("projectId"));
            SourceSelection selection = SourceSelection.parse(request.get("selection"));
            Budget budget = new Budget();
            java.util.ArrayList<SourceAccess.Scope> scopes = new java.util.ArrayList<>();
            try {
                if (operation.equals("EXPORT") || operation.equals("EXPORT_RETAINED"))
                    scopes.add(SourceAccess.open(
                            Path.of(text(request.get("reposRoot")))
                                    .toAbsolutePath()
                                    .normalize(),
                            "workspace"));
                if (operation.equals("EXPORT_RETAINED"))
                    scopes.add(SourceAccess.open(
                            Path.of(text(request.get("scratchRoot")))
                                    .toAbsolutePath()
                                    .normalize(),
                            "private"));
                if (operation.equals("IMPORT"))
                    scopes.add(SourceAccess.open(
                            Path.of(text(request.get("stageRoot")))
                                    .toAbsolutePath()
                                    .normalize(),
                            "private"));
                if (operation.equals("EXPORT")) {
                    eof(source);
                    exportSource(text(request.get("reposRoot")), project, selection, target, budget);
                } else if (operation.equals("EXPORT_RETAINED")) {
                    int count = (int) number(
                            request.get("retainedCount"), selection.snapshots().size());
                    if (count == 0) throw failure("SOURCE_SELECTION_INVALID");
                    exportRetained(
                            text(request.get("reposRoot")),
                            text(request.get("scratchRoot")),
                            project,
                            selection,
                            count,
                            source,
                            target,
                            budget);
                } else {
                    importSource(
                            text(request.get("stageRoot")),
                            project,
                            selection,
                            Receipt.parse(request.get("expected")),
                            source,
                            target,
                            budget);
                }
            } finally {
                for (int index = scopes.size() - 1; index >= 0; index--)
                    scopes.get(index).close();
            }
            return 0;
        } catch (Exception error) {
            String code = error instanceof Failure failure
                    ? failure.code
                    : error instanceof MissingObjectException || error instanceof java.nio.file.NoSuchFileException
                            ? "SOURCE_MISSING"
                            : "SOURCE_FAILURE";
            try {
                write(target, map("version", 1, "kind", "ERROR", "code", code));
            } catch (Exception ignored) {
                /* Broken private pipe: exit failure, never an alternate output. */
            }
            return 2;
        }
    }

    private static void exportSource(
            String root, String project, SourceSelection selection, DataOutputStream output, Budget budget)
            throws IOException {
        budget.check();
        Path repos = SourceFiles.root(root, false);
        if (selection.snapshots().isEmpty()
                && selection.commits().isEmpty()
                && selection.branches().isEmpty()) {
            Receipt receipt = new Receipt(selection.digest(), 0, 0, SourceGraph.digest(Map.of()));
            write(output, receipt.wire("BEGIN", project));
            write(output, receipt.wire("END", project));
            return;
        }
        Path repo = repos.resolve(project);
        Object repoKey = SourceFiles.directory(repo).fileKey();
        Path git = repo.resolve(".git");
        Map<Path, SourceFiles.Stamp> before = SourceFiles.inspect(git, budget);
        try (ObjectDatabase objects = objectDatabase(git);
                ObjectReader reader = objects.newReader()) {
            SourceGraph graph = new SourceGraph(reader, budget);
            graph.select(selection);
            Receipt receipt = new Receipt(selection.digest(), graph.objects.size(), graph.totalBytes, graph.digest());
            unchanged(repo, repoKey, git, before, budget);
            write(output, receipt.wire("BEGIN", project));
            for (SourceGraph.Meta meta : graph.objects.values()) {
                byte[] bytes = graph.read(meta);
                try {
                    write(
                            output,
                            map(
                                    "version",
                                    1,
                                    "kind",
                                    "OBJECT",
                                    "objectType",
                                    meta.name(),
                                    "gitOid",
                                    meta.gitOid(),
                                    "rawSha256",
                                    meta.rawSha256(),
                                    "byteSize",
                                    meta.byteSize(),
                                    "bytesBase64",
                                    Base64.getEncoder().encodeToString(bytes)));
                } finally {
                    Arrays.fill(bytes, (byte) 0);
                }
            }
            unchanged(repo, repoKey, git, before, budget);
            write(output, receipt.wire("END", project));
        }
    }

    private static void unchanged(Path repo, Object key, Path git, Map<Path, SourceFiles.Stamp> before, Budget budget)
            throws IOException {
        if (!key.equals(SourceFiles.directory(repo).fileKey()) || !before.equals(SourceFiles.inspect(git, budget)))
            throw failure("SOURCE_CHANGED");
    }

    /** A read-only optional clone. Existing unsafe metadata is never bypassed by retained bytes. */
    private static final class ExistingSource implements AutoCloseable {
        final Path root;
        final Object rootKey;
        final Path repo;
        final Object repoKey;
        final Path git;
        final Map<Path, SourceFiles.Stamp> before;
        final ObjectDatabase database;
        final ObjectReader reader;

        ExistingSource(Path root, String project, Budget budget) throws IOException {
            this.root = root;
            rootKey = SourceFiles.directory(root).fileKey();
            repo = root.resolve(project);
            repoKey = SourceAccess.exists(repo, true)
                    ? SourceFiles.directory(repo).fileKey()
                    : null;
            git = repo.resolve(".git");
            before = repoKey != null && SourceAccess.exists(git, true) ? SourceFiles.inspect(git, budget) : null;
            database = before == null ? null : objectDatabase(git);
            reader = database == null ? null : database.newReader();
        }

        void unchanged(Budget budget) throws IOException {
            if (!rootKey.equals(SourceFiles.directory(root).fileKey())) throw failure("SOURCE_CHANGED");
            if (repoKey == null) {
                if (SourceAccess.exists(repo, true)) throw failure("SOURCE_CHANGED");
            } else if (before == null) {
                if (!repoKey.equals(SourceFiles.directory(repo).fileKey()) || SourceAccess.exists(git, true))
                    throw failure("SOURCE_CHANGED");
            } else BackupSourceWorker.unchanged(repo, repoKey, git, before, budget);
        }

        @Override
        public void close() {
            if (reader != null) reader.close();
            if (database != null) database.close();
        }
    }

    private static void exportRetained(
            String root,
            String scratchRoot,
            String project,
            SourceSelection selection,
            int count,
            DataInputStream input,
            DataOutputStream output,
            Budget budget)
            throws IOException {
        budget.check();
        Path repos = SourceFiles.root(root, false);
        Path scratch = SourceFiles.root(scratchRoot, true);
        if (scratch.startsWith(repos) || repos.startsWith(scratch)) throw failure("SOURCE_UNSAFE_PATH");
        Object scratchKey = SourceFiles.directory(scratch).fileKey();
        // No adoption or cleanup of any preceding invocation's child, including after a crash.
        Path temporary = scratch.resolve(project);
        try (ExistingSource existing = new ExistingSource(repos, project, budget)) {
            SourceFiles.mkdir(temporary);
            Object key = SourceFiles.directory(temporary).fileKey();
            try {
                Path git = temporary.resolve(".git");
                SourceFiles.mkdir(git);
                try (ObjectDatabase generated = objectDatabase(git)) {
                    generated.create();
                    long previousId = 0;
                    long[] generatedBytes = {0, 0};
                    for (int i = 0; i < count; i++) {
                        budget.check();
                        JsonNode header = read(input);
                        exact(
                                header,
                                "version",
                                "kind",
                                "snapshotId",
                                "commitOid",
                                "commitEpochSecond",
                                "policyVersion",
                                "limitsSha256",
                                "manifestSha256",
                                "fileCount",
                                "totalBytes");
                        retainedKind(header, "RETAINED_BEGIN");
                        String snapshotId = id(header.get("snapshotId"));
                        long currentId = Long.parseLong(snapshotId);
                        if (currentId <= previousId) throw failure("SOURCE_SELECTION_INVALID");
                        previousId = currentId;
                        SourceSelection.Snapshot snapshot = selection.snapshots().stream()
                                .filter(s -> s.snapshotId().equals(snapshotId))
                                .findFirst()
                                .orElseThrow(() -> failure("SOURCE_SELECTION_INVALID"));
                        if (!hex(header.get("commitOid"), 40).equals(snapshot.commitOid()))
                            throw failure("SOURCE_SELECTION_INVALID");
                        reconstruct(header, snapshot, generated, existing.reader, generatedBytes, input, budget);
                    }
                    eof(input);
                    SourceFiles.finish(temporary, key, budget);
                    try (ObjectReader reader = generated.newReader()) {
                        SourceGraph graph = new SourceGraph(reader, existing.reader, budget);
                        graph.select(selection);
                        Receipt receipt =
                                new Receipt(selection.digest(), graph.objects.size(), graph.totalBytes, graph.digest());
                        existing.unchanged(budget);
                        write(output, receipt.wire("BEGIN", project));
                        for (SourceGraph.Meta meta : graph.objects.values()) {
                            byte[] bytes = graph.read(meta);
                            try {
                                write(
                                        output,
                                        map(
                                                "version",
                                                1,
                                                "kind",
                                                "OBJECT",
                                                "objectType",
                                                meta.name(),
                                                "gitOid",
                                                meta.gitOid(),
                                                "rawSha256",
                                                meta.rawSha256(),
                                                "byteSize",
                                                meta.byteSize(),
                                                "bytesBase64",
                                                Base64.getEncoder().encodeToString(bytes)));
                            } finally {
                                Arrays.fill(bytes, (byte) 0);
                            }
                        }
                        existing.unchanged(budget);
                        write(output, receipt.wire("END", project));
                    }
                }
            } finally {
                // Preserve cancellation while allowing the owned-root cleanup fsync to finish.
                boolean interrupted = Thread.interrupted();
                try {
                    if (!scratchKey.equals(SourceFiles.directory(scratch).fileKey()))
                        throw failure("SOURCE_UNSAFE_PATH");
                    SourceFiles.removeOwned(temporary, key);
                } finally {
                    if (interrupted) Thread.currentThread().interrupt();
                }
            }
        }
    }

    private static void retainedKind(JsonNode frame, String kind) {
        if (number(frame.get("version"), 1) != 1 || !text(frame.get("kind")).equals(kind))
            throw failure("SOURCE_PROTOCOL_INVALID");
    }

    private static void manifestString(MessageDigest digest, String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        digest.update(ByteBuffer.allocate(4).putInt(bytes.length).array());
        digest.update(bytes);
    }

    private static void manifestNumber(MessageDigest digest, long value) {
        digest.update(ByteBuffer.allocate(8).putLong(value).array());
    }

    private static void reconstruct(
            JsonNode header,
            SourceSelection.Snapshot snapshot,
            ObjectDatabase generated,
            ObjectReader existing,
            long[] generatedBytes,
            DataInputStream input,
            Budget budget)
            throws IOException {
        String policy = text(header.get("policyVersion"));
        if (!policy.equals("local-ingest-v1")) throw failure("SOURCE_SELECTION_INVALID");
        String limits = hex(header.get("limitsSha256"), 64), manifest = hex(header.get("manifestSha256"), 64);
        int count = (int) number(header.get("fileCount"), SourceSelection.MAX_FILES);
        long total = number(header.get("totalBytes"), 512L * 1024 * 1024);
        if (count != snapshot.files().size()) throw failure("SOURCE_SELECTION_INVALID");
        long second;
        if (header.get("commitEpochSecond").isNull()) {
            if (existing == null) throw failure("SOURCE_MISSING");
            second = new SourceGraph(existing, budget).commitEpochSecond(snapshot.commitOid());
            if (second < 0 || second > 253402300799L) throw failure("SOURCE_INTEGRITY");
        } else second = epochSecond(header.get("commitEpochSecond"));
        MessageDigest digest = digest();
        manifestString(digest, "code-intelligence-local-manifest-v1");
        manifestString(digest, policy);
        manifestString(digest, limits);
        long consumed = 0, metadata = 256;
        Set<String> files = new HashSet<>(), directories = new HashSet<>();
        Map<String, String> aliases = new HashMap<>();
        DirCache index = DirCache.newInCore();
        var builder = index.builder();
        try (ObjectInserter inserter = generated.newInserter()) {
            for (int i = 0; i < count; i++) {
                budget.check();
                JsonNode frame = read(input);
                budget.check();
                exact(frame, "version", "kind", "path", "gitOid", "rawSha256", "byteSize", "bytesBase64");
                retainedKind(frame, "RETAINED_ENTRY");
                String path = SourceSelection.safePath(text(frame.get("path")));
                String oid = hex(frame.get("gitOid"), 40), rawSha = hex(frame.get("rawSha256"), 64);
                int size = (int) number(frame.get("byteSize"), MAX_OBJECT);
                if (!snapshot.files().get(i).equals(new SourceSelection.File(path, oid, size)))
                    throw failure("SOURCE_SELECTION_INVALID");
                metadata += path.getBytes(StandardCharsets.UTF_8).length + 128L;
                if (metadata > MAX_FRAME) throw failure("SOURCE_LIMIT");
                if (!files.add(path) || directories.contains(path)) throw failure("SOURCE_UNSAFE_PATH");
                String parent = path;
                for (; ; ) {
                    String previous = aliases.putIfAbsent(parent.toLowerCase(Locale.ROOT), parent);
                    if (previous != null && !previous.equals(parent)) throw failure("SOURCE_UNSAFE_PATH");
                    int slash = parent.lastIndexOf('/');
                    if (slash < 0) break;
                    parent = parent.substring(0, slash);
                    if (files.contains(parent)) throw failure("SOURCE_UNSAFE_PATH");
                    directories.add(parent);
                }
                if (files.size() + directories.size() > MAX_OBJECTS) throw failure("SOURCE_LIMIT");
                for (String part : path.split("/"))
                    if (part.getBytes(StandardCharsets.UTF_8).length > 255) throw failure("SOURCE_UNSAFE_PATH");
                consumed = Math.addExact(consumed, size);
                generatedBytes[0] = Math.addExact(generatedBytes[0], size);
                if (consumed > total || generatedBytes[0] > MAX_TOTAL) throw failure("SOURCE_LIMIT");
                String encoded = text(frame.get("bytesBase64"));
                if (encoded.length() != 4 * ((size + 2) / 3)) throw failure("SOURCE_INTEGRITY");
                byte[] bytes;
                try {
                    bytes = Base64.getDecoder().decode(encoded);
                } catch (IllegalArgumentException error) {
                    throw failure("SOURCE_INTEGRITY");
                }
                try {
                    if (bytes.length != size
                            || !Base64.getEncoder().encodeToString(bytes).equals(encoded)
                            || !sha256(bytes).equals(rawSha)) throw failure("SOURCE_INTEGRITY");
                    SourceGraph.validate(Constants.OBJ_BLOB, oid, bytes);
                    if (!inserter.insert(Constants.OBJ_BLOB, bytes).name().equals(oid))
                        throw failure("SOURCE_INTEGRITY");
                    DirCacheEntry entry = new DirCacheEntry(path);
                    entry.setFileMode(FileMode.REGULAR_FILE);
                    entry.setObjectId(org.eclipse.jgit.lib.ObjectId.fromString(oid));
                    entry.setLength(size);
                    builder.add(entry);
                } finally {
                    Arrays.fill(bytes, (byte) 0);
                }
                digest.update((byte) 1);
                manifestString(digest, path);
                manifestString(digest, "REGULAR_FILE");
                manifestNumber(digest, size);
                digest.update(HexFormat.of().parseHex(rawSha));
            }
            JsonNode end = read(input);
            exact(end, "version", "kind", "snapshotId");
            retainedKind(end, "RETAINED_END");
            if (!id(end.get("snapshotId")).equals(snapshot.snapshotId()) || consumed != total)
                throw failure("SOURCE_INTEGRITY");
            digest.update((byte) 0);
            manifestNumber(digest, count);
            manifestNumber(digest, total);
            if (!HexFormat.of().formatHex(digest.digest()).equals(manifest)) throw failure("SOURCE_INTEGRITY");
            generatedBytes[1] += files.size() + directories.size() + 2L;
            if (generatedBytes[1] > MAX_OBJECTS) throw failure("SOURCE_LIMIT");
            builder.finish();
            CommitBuilder commit = new CommitBuilder();
            commit.setTreeId(index.writeTree(inserter));
            PersonIdent author = new PersonIdent(
                    "Code Intelligence",
                    "local@code-intelligence.invalid",
                    Date.from(Instant.ofEpochSecond(second)),
                    TimeZone.getTimeZone("UTC"));
            commit.setAuthor(author);
            commit.setCommitter(author);
            commit.setMessage("Code Intelligence local snapshot");
            if (!inserter.insert(commit).name().equals(snapshot.commitOid())) throw failure("SOURCE_INTEGRITY");
            inserter.flush();
        }
    }

    private static void importSource(
            String root,
            String project,
            SourceSelection selection,
            Receipt expected,
            DataInputStream input,
            DataOutputStream output,
            Budget budget)
            throws IOException {
        budget.check();
        if (!selection.digest().equals(expected.selectionSha256())) throw failure("SOURCE_SELECTION_INVALID");
        Path staging = SourceFiles.root(root, true);
        Path repo = staging.resolve(project);
        // Exclusive creation is the authorization to clean this one child on failure. Existing data is never adopted.
        SourceFiles.mkdir(repo);
        Object key = SourceFiles.directory(repo).fileKey();
        boolean completed = false;
        try {
            Path git = repo.resolve(".git");
            SourceFiles.mkdir(git);
            SourceFiles.fresh(
                    git.resolve("config"),
                    "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\n"
                            .getBytes(StandardCharsets.UTF_8));
            SourceFiles.mkdir(git.resolve("refs"));
            SourceFiles.mkdir(git.resolve("refs/heads"));
            TreeMap<String, SourceGraph.Meta> received = new TreeMap<>();
            long bytes = 0;
            try (ObjectDatabase objects = objectDatabase(git)) {
                objects.create();
                try (ObjectInserter inserter = objects.newInserter()) {
                    String previous = "";
                    for (int i = 0; i < expected.objectCount(); i++) {
                        budget.check();
                        JsonNode frame = read(input);
                        exact(frame, "version", "kind", "objectType", "gitOid", "rawSha256", "byteSize", "bytesBase64");
                        if (number(frame.get("version"), 1) != 1
                                || !text(frame.get("kind")).equals("OBJECT")) throw failure("SOURCE_PROTOCOL_INVALID");
                        int type =
                                switch (text(frame.get("objectType"))) {
                                    case "COMMIT" -> Constants.OBJ_COMMIT;
                                    case "TREE" -> Constants.OBJ_TREE;
                                    case "BLOB" -> Constants.OBJ_BLOB;
                                    default -> throw failure("SOURCE_PROTOCOL_INVALID");
                                };
                        String oid = hex(frame.get("gitOid"), 40);
                        String hash = hex(frame.get("rawSha256"), 64);
                        int size = (int) number(frame.get("byteSize"), MAX_OBJECT);
                        if (previous.compareTo(oid) >= 0) throw failure("SOURCE_PROTOCOL_INVALID");
                        previous = oid;
                        bytes = Math.addExact(bytes, size);
                        if (bytes > expected.totalObjectBytes()) throw failure("SOURCE_LIMIT");
                        String encoded = text(frame.get("bytesBase64"));
                        if (encoded.length() != 4 * ((size + 2) / 3)) throw failure("SOURCE_INTEGRITY");
                        byte[] raw;
                        try {
                            raw = Base64.getDecoder().decode(encoded);
                        } catch (IllegalArgumentException error) {
                            throw failure("SOURCE_INTEGRITY");
                        }
                        try {
                            if (raw.length != size
                                    || !Base64.getEncoder().encodeToString(raw).equals(encoded)
                                    || !sha256(raw).equals(hash)) throw failure("SOURCE_INTEGRITY");
                            SourceGraph.validate(type, oid, raw);
                            if (!inserter.insert(type, raw).name().equals(oid)) throw failure("SOURCE_INTEGRITY");
                            received.put(oid, new SourceGraph.Meta(type, oid, hash, size));
                        } finally {
                            Arrays.fill(raw, (byte) 0);
                        }
                    }
                    inserter.flush();
                }
                JsonNode end = read(input);
                exact(
                        end,
                        "version",
                        "kind",
                        "projectId",
                        "selectionSha256",
                        "objectCount",
                        "totalObjectBytes",
                        "objectsSha256");
                if (number(end.get("version"), 1) != 1
                        || !text(end.get("kind")).equals("END")
                        || !id(end.get("projectId")).equals(project)
                        || !expected.equals(Receipt.values(end))) throw failure("SOURCE_INTEGRITY");
                eof(input);
                if (bytes != expected.totalObjectBytes()
                        || !SourceGraph.digest(received).equals(expected.objectsSha256()))
                    throw failure("SOURCE_INTEGRITY");
                try (ObjectReader reader = objects.newReader()) {
                    SourceGraph graph = new SourceGraph(reader, budget);
                    graph.select(selection);
                    if (!graph.objects.equals(received)) throw failure("SOURCE_SELECTION_INVALID");
                }
            }
            SourceFiles.fresh(
                    git.resolve("HEAD"),
                    (selection.headOid() == null ? "ref: refs/heads/backup-empty\n" : selection.headOid() + "\n")
                            .getBytes(StandardCharsets.US_ASCII));
            for (SourceSelection.Branch branch : selection.branches()) {
                Path ref = git.resolve("refs/heads").resolve(branch.name());
                Path current = git.resolve("refs/heads");
                Path relative = current.relativize(ref.getParent());
                for (Path part : relative) {
                    if (part.toString().isEmpty()) continue;
                    current = current.resolve(part);
                    if (!Files.exists(current, LinkOption.NOFOLLOW_LINKS)) SourceFiles.mkdir(current);
                    else SourceFiles.directory(current);
                }
                SourceFiles.fresh(ref, (branch.headOid() + "\n").getBytes(StandardCharsets.US_ASCII));
            }
            SourceFiles.finish(repo, key, budget);
            completed = true;
            write(output, expected.wire("RESTORED", project));
        } finally {
            if (!completed) SourceFiles.removeOwned(repo, key);
        }
    }

    private static ObjectDatabase objectDatabase(Path git) throws IOException {
        Config config = new Config();
        config.setBoolean("core", null, "fsyncObjectFiles", true);
        return new ObjectDirectory(
                config,
                git.resolve("objects").toFile(),
                null,
                FS.DETECTED,
                git.resolve("shallow").toFile());
    }

    record Receipt(String selectionSha256, int objectCount, long totalObjectBytes, String objectsSha256) {
        static Receipt parse(JsonNode value) {
            exact(value, "selectionSha256", "objectCount", "totalObjectBytes", "objectsSha256");
            return values(value);
        }

        static Receipt values(JsonNode value) {
            return new Receipt(
                    hex(value.get("selectionSha256"), 64),
                    (int) number(value.get("objectCount"), MAX_OBJECTS),
                    number(value.get("totalObjectBytes"), MAX_TOTAL),
                    hex(value.get("objectsSha256"), 64));
        }

        Map<String, Object> wire(String kind, String project) {
            return map(
                    "version",
                    1,
                    "kind",
                    kind,
                    "projectId",
                    project,
                    "selectionSha256",
                    selectionSha256,
                    "objectCount",
                    objectCount,
                    "totalObjectBytes",
                    totalObjectBytes,
                    "objectsSha256",
                    objectsSha256);
        }
    }
}
