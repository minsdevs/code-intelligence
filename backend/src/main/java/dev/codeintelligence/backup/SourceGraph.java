package dev.codeintelligence.backup;

import static dev.codeintelligence.backup.SourceProtocol.*;

import dev.codeintelligence.evidence.SecretMask;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.ObjectChecker;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.ObjectLoader;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.treewalk.CanonicalTreeParser;

/** Selected Git objects, not a reachability dump of every blob in the clone. */
final class SourceGraph {
    record Meta(int type, String gitOid, String rawSha256, int byteSize) {
        String name() {
            return Constants.typeString(type).toUpperCase(java.util.Locale.ROOT);
        }

        String digestLine() {
            return name() + "\0" + gitOid + "\0" + rawSha256 + "\0" + byteSize + "\n";
        }
    }

    record Entry(String oid, int mode) {}

    record Tree(String prefix, String oid, int depth) {}

    private final ObjectReader reader;
    private final ObjectReader fallback;
    private final Budget budget;
    final TreeMap<String, Meta> objects = new TreeMap<>();
    long totalBytes;

    SourceGraph(ObjectReader reader, Budget budget) {
        this(reader, null, budget);
    }

    SourceGraph(ObjectReader reader, ObjectReader fallback, Budget budget) {
        this.reader = reader;
        this.fallback = fallback;
        this.budget = budget;
        reader.setStreamFileThreshold(0);
        if (fallback != null) fallback.setStreamFileThreshold(0);
    }

    long commitEpochSecond(String oid) throws IOException {
        Meta meta = add(oid, Constants.OBJ_COMMIT);
        byte[] bytes = read(meta);
        try {
            // JGit retains this raw array and parses identities lazily. Extract the scalar
            // before clearing our bytes; the header-only commit() result cannot supply it.
            var committer = RevCommit.parse(bytes).getCommitterIdent();
            if (committer == null) throw failure("SOURCE_INTEGRITY");
            return committer.getWhenAsInstant().getEpochSecond();
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    void select(SourceSelection selection) throws IOException {
        for (SourceSelection.Snapshot snapshot : selection.snapshots()) {
            Map<String, Entry> tree =
                    tree(commit(snapshot.commitOid()).getTree().name());
            for (SourceSelection.File file : snapshot.files()) {
                Entry actual = tree.get(file.path());
                if (actual == null || !actual.oid().equals(file.gitOid())) throw failure("SOURCE_SELECTION_INVALID");
                Meta blob = add(actual.oid(), Constants.OBJ_BLOB);
                if (blob.byteSize() != file.byteSize()) throw failure("SOURCE_INTEGRITY");
            }
        }
        for (String oid : selection.commits()) {
            RevCommit commit = commit(oid);
            Map<String, Entry> next = tree(commit.getTree().name());
            Map<String, Entry> previous = commit.getParentCount() == 0
                    ? Map.of()
                    : tree(commit(commit.getParent(0).name()).getTree().name());
            // Every changed old/new blob covers rename candidates too. No JGit filter, driver,
            // worktree, attributes or configured diff command is consulted by this selection.
            for (Map.Entry<String, Entry> entry : previous.entrySet()) {
                if (!entry.getValue().equals(next.get(entry.getKey())))
                    add(entry.getValue().oid(), Constants.OBJ_BLOB);
            }
            for (Map.Entry<String, Entry> entry : next.entrySet()) {
                if (!entry.getValue().equals(previous.get(entry.getKey())))
                    add(entry.getValue().oid(), Constants.OBJ_BLOB);
            }
        }
        Set<String> visited = new HashSet<>();
        ArrayDeque<String> ancestors = new ArrayDeque<>();
        for (SourceSelection.Branch branch : selection.branches()) ancestors.add(branch.headOid());
        while (!ancestors.isEmpty()) {
            budget.check();
            String oid = ancestors.removeFirst();
            if (!visited.add(oid)) continue;
            RevCommit commit = commit(oid);
            for (RevCommit parent : commit.getParents()) {
                if (ancestors.size() >= MAX_OBJECTS) throw failure("SOURCE_LIMIT");
                ancestors.addLast(parent.name());
            }
        }
        if (selection.headOid() != null) commit(selection.headOid());
    }

    private RevCommit commit(String oid) throws IOException {
        Meta meta = add(oid, Constants.OBJ_COMMIT);
        byte[] bytes = read(meta);
        try {
            // Only eager tree/parent/header fields may be read after this method returns.
            return RevCommit.parse(bytes);
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    private Map<String, Entry> tree(String oid) throws IOException {
        ArrayDeque<Tree> pending = new ArrayDeque<>();
        pending.add(new Tree("", oid, 0));
        Map<String, Entry> files = new HashMap<>();
        Set<String> paths = new HashSet<>();
        long pathBytes = 0;
        while (!pending.isEmpty()) {
            budget.check();
            Tree tree = pending.removeFirst();
            byte[] bytes = read(add(tree.oid(), Constants.OBJ_TREE));
            try {
                CanonicalTreeParser parser = new CanonicalTreeParser();
                parser.reset(bytes);
                while (!parser.eof()) {
                    budget.check();
                    String name = parser.getEntryPathString();
                    if (name.indexOf('/') >= 0 || name.indexOf('\ufffd') >= 0) throw failure("SOURCE_UNSAFE_PATH");
                    String path = SourceSelection.safePath(tree.prefix() + name);
                    pathBytes += path.getBytes(StandardCharsets.UTF_8).length + 64L;
                    if (!paths.add(path) || paths.size() > SourceSelection.MAX_FILES || pathBytes > MAX_FRAME)
                        throw failure("SOURCE_LIMIT");
                    FileMode mode = parser.getEntryFileMode();
                    String child = parser.getEntryObjectId().name();
                    if (FileMode.TREE.equals(mode)) {
                        if (tree.depth() >= 63) throw failure("SOURCE_LIMIT");
                        pending.addLast(new Tree(path + "/", child, tree.depth() + 1));
                    } else {
                        if (!FileMode.REGULAR_FILE.equals(mode) && !FileMode.EXECUTABLE_FILE.equals(mode))
                            throw failure("SOURCE_UNSUPPORTED_MODE");
                        files.put(path, new Entry(child, mode.getBits()));
                    }
                    parser.next(1);
                }
            } finally {
                Arrays.fill(bytes, (byte) 0);
            }
        }
        // DiffEntry/TreeWalk consult per-tree attributes even when that file did not change.
        // Preserve the bounded raw metadata blob, without loading config or executing a driver.
        for (Map.Entry<String, Entry> entry : files.entrySet()) {
            if (entry.getKey().equals(".gitattributes") || entry.getKey().endsWith("/.gitattributes"))
                add(entry.getValue().oid(), Constants.OBJ_BLOB);
        }
        return files;
    }

    private Meta add(String oid, int type) throws IOException {
        budget.check();
        Meta existing = objects.get(oid);
        if (existing != null) {
            if (existing.type() != type) throw failure("SOURCE_INTEGRITY");
            return existing;
        }
        if (objects.size() >= MAX_OBJECTS) throw failure("SOURCE_LIMIT");
        byte[] bytes = readRaw(oid, type);
        try {
            validate(type, oid, bytes);
            Meta meta = new Meta(type, oid, sha256(bytes), bytes.length);
            totalBytes = Math.addExact(totalBytes, bytes.length);
            if (totalBytes > MAX_TOTAL) throw failure("SOURCE_LIMIT");
            objects.put(oid, meta);
            return meta;
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    byte[] read(Meta meta) throws IOException {
        byte[] bytes = readRaw(meta.gitOid(), meta.type());
        try {
            validate(meta.type(), meta.gitOid(), bytes);
            if (bytes.length != meta.byteSize() || !sha256(bytes).equals(meta.rawSha256()))
                throw failure("SOURCE_INTEGRITY");
            return bytes;
        } catch (RuntimeException | IOException error) {
            Arrays.fill(bytes, (byte) 0);
            throw error;
        }
    }

    private byte[] readRaw(String oid, int type) throws IOException {
        budget.check();
        ObjectId id = ObjectId.fromString(oid);
        // Absence alone permits the optional managed-clone reader. Corruption never falls back.
        ObjectReader selected = fallback != null && !reader.has(id) ? fallback : reader;
        long size = selected.getObjectSize(id, type);
        if (size < 0 || size > MAX_OBJECT) throw failure("SOURCE_LIMIT");
        ObjectLoader loader = selected.open(id, type);
        if (loader.getSize() != size || loader.getType() != type) throw failure("SOURCE_INTEGRITY");
        try (InputStream input = loader.openStream()) {
            byte[] bytes = input.readNBytes((int) size + 1);
            if (bytes.length != size || input.read() != -1) {
                Arrays.fill(bytes, (byte) 0);
                throw failure("SOURCE_INTEGRITY");
            }
            budget.check();
            return bytes;
        }
    }

    static void validate(int type, String oid, byte[] bytes) throws IOException {
        if (bytes.length > MAX_OBJECT) throw failure("SOURCE_LIMIT");
        if (type != Constants.OBJ_BLOB && type != Constants.OBJ_TREE && type != Constants.OBJ_COMMIT)
            throw failure("SOURCE_PROTOCOL_INVALID");
        try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
            if (!formatter.idFor(type, bytes).name().equals(oid)) throw failure("SOURCE_INTEGRITY");
        }
        new ObjectChecker().check(type, bytes);
        if (type != Constants.OBJ_TREE) {
            // Fail rather than transcode or redact. Binary/non-UTF8 history requires a separate
            // explicit contract and cannot silently disappear from a complete installation backup.
            String text = utf8(bytes);
            if (text.indexOf('\0') >= 0) throw failure("SOURCE_UNSUPPORTED_ENCODING");
            if (!SecretMask.redact(text).equals(text)) throw failure("SOURCE_SECRET_DETECTED");
        }
    }

    String digest() {
        return digest(objects);
    }

    static String digest(Map<String, Meta> objects) {
        MessageDigest digest = SourceProtocol.digest();
        digest.update("CI_BACKUP_OBJECTS_V1\n".getBytes(StandardCharsets.US_ASCII));
        for (Meta meta : new TreeMap<>(objects).values())
            digest.update(meta.digestLine().getBytes(StandardCharsets.US_ASCII));
        return HexFormat.of().formatHex(digest.digest());
    }
}
