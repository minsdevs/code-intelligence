package dev.codeintelligence.backup;

import static dev.codeintelligence.backup.SourceProtocol.*;
import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.stream.Stream;
import org.eclipse.jgit.diff.DiffEntry;
import org.eclipse.jgit.diff.DiffFormatter;
import org.eclipse.jgit.dircache.DirCache;
import org.eclipse.jgit.dircache.DirCacheEntry;
import org.eclipse.jgit.internal.storage.file.ObjectDirectory;
import org.eclipse.jgit.lib.CommitBuilder;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.lib.TreeFormatter;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevSort;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.util.FS;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

/** Public synthetic bytes and disposable files only. No Spring, Git process, user repository or network. */
class BackupSourceWorkerTest {
    @TempDir
    Path temp;

    record Commit(String oid, String tree, Map<String, String> blobs) {}

    record Fixture(Path root, Path repo, Commit parent, Commit head, String hiddenOid) {}

    record Result(int status, List<JsonNode> frames, byte[] bytes) {
        JsonNode last() {
            return frames.getLast();
        }
    }

    private Path directory(String prefix) throws Exception {
        Path root =
                Files.createDirectory(temp.resolve(prefix + UUID.randomUUID())).toRealPath();
        Files.setPosixFilePermissions(root, PosixFilePermissions.fromString("rwx------"));
        return root;
    }

    private ObjectDirectory objects(Path repo) throws Exception {
        Path git = repo.resolve(".git");
        return new ObjectDirectory(
                new Config(),
                git.resolve("objects").toFile(),
                null,
                FS.DETECTED,
                git.resolve("shallow").toFile());
    }

    private Path repository(Path root) throws Exception {
        Path repo = Files.createDirectory(root.resolve("7"));
        Files.createDirectory(repo.resolve(".git"));
        // This is intentionally untrusted and malformed. ObjectDirectory must not load it.
        Files.writeString(
                repo.resolve(".git/config"), "[include]\npath = /synthetic/never-read\ninvalid-config-sentinel");
        try (ObjectDirectory db = objects(repo)) {
            db.create();
        }
        return repo;
    }

    private Commit commit(Path repo, Map<String, byte[]> files, List<String> parents, long second, String message)
            throws Exception {
        try (ObjectDirectory db = objects(repo);
                ObjectInserter inserter = db.newInserter()) {
            DirCache index = DirCache.newInCore();
            var builder = index.builder();
            Map<String, String> ids = new LinkedHashMap<>();
            for (String path :
                    files.keySet().stream().sorted(SourceSelection.PATH_ORDER).toList()) {
                ObjectId oid = inserter.insert(Constants.OBJ_BLOB, files.get(path));
                DirCacheEntry entry = new DirCacheEntry(path);
                entry.setFileMode(FileMode.REGULAR_FILE);
                entry.setObjectId(oid);
                entry.setLength(files.get(path).length);
                builder.add(entry);
                ids.put(path, oid.name());
            }
            builder.finish();
            ObjectId tree = index.writeTree(inserter);
            CommitBuilder commit = new CommitBuilder();
            commit.setTreeId(tree);
            commit.setParentIds(parents.stream().map(ObjectId::fromString).toList());
            PersonIdent author = new PersonIdent(
                    "Synthetic Author",
                    "synthetic@example.invalid",
                    Date.from(Instant.ofEpochSecond(second)),
                    TimeZone.getTimeZone("UTC"));
            commit.setAuthor(author);
            commit.setCommitter(author);
            commit.setMessage(message);
            String oid = inserter.insert(commit).name();
            inserter.flush();
            return new Commit(oid, tree.name(), ids);
        }
    }

    private Commit commit(Path repo, Map<String, byte[]> files, List<String> parents, long second) throws Exception {
        return commit(repo, files, parents, second, "Synthetic history " + second);
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private Fixture fixture() throws Exception {
        Path root = directory("repos-");
        Path repo = repository(root);
        Commit parent = commit(
                repo,
                Map.of(
                        ".gitattributes",
                        bytes("*.ts text\n"),
                        "src/old.ts",
                        bytes("export const answer = 42;\r\n"),
                        "unchanged.txt",
                        bytes("not selected by any source consumer\n")),
                List.of(),
                1_700_000_000L);
        Commit head = commit(
                repo,
                Map.of(
                        ".gitattributes",
                        bytes("*.ts text\n"),
                        "src/new.ts",
                        bytes("export const answer = 42;\r\n"),
                        "src/added.ts",
                        bytes("export const added = true;\n"),
                        "unchanged.txt",
                        bytes("not selected by any source consumer\n")),
                List.of(parent.oid()),
                1_700_000_001L);
        String hidden;
        try (ObjectDirectory db = objects(repo);
                ObjectInserter inserter = db.newInserter()) {
            hidden = inserter.insert(Constants.OBJ_BLOB, bytes("token=unselected-secret-sentinel"))
                    .name();
            inserter.flush();
        }
        // Working-tree content is unrelated, potentially sensitive and must never be examined.
        Files.writeString(repo.resolve("original-folder-sentinel"), "token=working-tree-secret-sentinel");
        return new Fixture(root, repo, parent, head, hidden);
    }

    private Map<String, Object> selection(Fixture f) {
        return map(
                "snapshots",
                List.of(map(
                        "snapshotId",
                        "31",
                        "commitOid",
                        f.head().oid(),
                        "files",
                        List.of(map(
                                "path",
                                "src/new.ts",
                                "gitOid",
                                f.head().blobs().get("src/new.ts"),
                                "byteSize",
                                bytes("export const answer = 42;\r\n").length)))),
                "commits",
                List.of(f.head().oid()),
                "branches",
                List.of(map("name", "main", "headOid", f.head().oid())),
                "headOid",
                f.head().oid());
    }

    private Map<String, Object> exportRequest(Fixture f) {
        return map(
                "version",
                1,
                "operation",
                "EXPORT",
                "reposRoot",
                f.root().toString(),
                "projectId",
                "7",
                "selection",
                selection(f));
    }

    private static byte[] wire(List<?> frames) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream output = new DataOutputStream(bytes);
        for (Object frame : frames) {
            byte[] json = JSON.writeValueAsBytes(frame);
            output.writeInt(json.length);
            output.write(json);
        }
        return bytes.toByteArray();
    }

    private static Result invokeBytes(byte[] input, String... args) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int status = BackupSourceWorker.run(
                args.length == 0 ? new String[] {BackupSourceWorker.FLAG} : args,
                new ByteArrayInputStream(input),
                bytes);
        List<JsonNode> result = new ArrayList<>();
        DataInputStream source = new DataInputStream(new ByteArrayInputStream(bytes.toByteArray()));
        while (source.available() > 0) result.add(SourceProtocol.read(source));
        return new Result(status, result, bytes.toByteArray());
    }

    private static Result invoke(List<?> frames) throws Exception {
        return invokeBytes(wire(frames));
    }

    private static Map<String, Object> mutable(JsonNode node) {
        return JSON.convertValue(node, Map.class);
    }

    private Map<String, Object> importRequest(Path root, Map<String, Object> selection, Result exported) {
        JsonNode begin = exported.frames().getFirst();
        return map(
                "version",
                1,
                "operation",
                "IMPORT",
                "stageRoot",
                root.toString(),
                "projectId",
                "7",
                "selection",
                selection,
                "expected",
                map(
                        "selectionSha256",
                        begin.get("selectionSha256").stringValue(),
                        "objectCount",
                        begin.get("objectCount").intValue(),
                        "totalObjectBytes",
                        begin.get("totalObjectBytes").longValue(),
                        "objectsSha256",
                        begin.get("objectsSha256").stringValue()));
    }

    private List<Object> importFrames(Path root, Map<String, Object> selection, Result exported) {
        List<Object> frames = new ArrayList<>();
        frames.add(importRequest(root, selection, exported));
        frames.addAll(exported.frames().subList(1, exported.frames().size()));
        return frames;
    }

    private static void failed(Result result, String code) {
        assertThat(result.status()).isEqualTo(2);
        assertThat(result.last().get("kind").stringValue()).isEqualTo("ERROR");
        if (code != null) assertThat(result.last().get("code").stringValue()).isEqualTo(code);
        assertThat(new String(result.bytes(), StandardCharsets.UTF_8))
                .doesNotContain("secret-sentinel", "never-read", "original-folder-sentinel", "Exception", "stackTrace");
    }

    private List<String> branchCommits(Path repo, String head) throws Exception {
        try (ObjectDirectory db = objects(repo);
                ObjectReader reader = db.newReader();
                RevWalk walk = new RevWalk(reader)) {
            walk.sort(RevSort.COMMIT_TIME_DESC, true);
            walk.markStart(walk.parseCommit(ObjectId.fromString(head)));
            List<String> ids = new ArrayList<>();
            for (RevCommit commit : walk) ids.add(commit.name());
            return ids;
        }
    }

    private List<String> diff(Path repo, String oldCommit, String newCommit) throws Exception {
        try (ObjectDirectory db = objects(repo);
                ObjectReader reader = db.newReader();
                RevWalk walk = new RevWalk(reader);
                DiffFormatter formatter = new DiffFormatter(OutputStreamNull.INSTANCE)) {
            formatter.setReader(reader, new Config());
            formatter.setDetectRenames(true);
            List<String> result = new ArrayList<>();
            for (DiffEntry entry : formatter.scan(
                    walk.parseCommit(ObjectId.fromString(oldCommit)).getTree(),
                    walk.parseCommit(ObjectId.fromString(newCommit)).getTree())) {
                result.add(entry.getChangeType() + ":" + entry.getOldPath() + ":" + entry.getNewPath() + ":"
                        + entry.getOldId().name() + ":" + entry.getNewId().name());
            }
            return result;
        }
    }

    private static final class OutputStreamNull extends java.io.OutputStream {
        static final OutputStreamNull INSTANCE = new OutputStreamNull();

        @Override
        public void write(int value) {}
    }

    @Test
    void exactSourceHistoryAndRenameSurviveWithoutCopyingConfigWorkingTreeOrUnselectedBlobs() throws Exception {
        Fixture f = fixture();
        Result exported = invoke(List.of(exportRequest(f)));
        assertThat(exported.status()).isZero();
        assertThat(exported.last().get("kind").stringValue()).isEqualTo("END");
        Set<String> exportedIds = exported.frames().stream()
                .filter(n -> "OBJECT".equals(n.get("kind").stringValue()))
                .map(n -> n.get("gitOid").stringValue())
                .collect(java.util.stream.Collectors.toSet());
        assertThat(exportedIds)
                .contains(
                        f.head().oid(),
                        f.parent().oid(),
                        f.head().tree(),
                        f.parent().tree(),
                        f.head().blobs().get("src/new.ts"),
                        f.head().blobs().get("src/added.ts"),
                        f.head().blobs().get(".gitattributes"));
        assertThat(exportedIds).doesNotContain(f.hiddenOid(), f.head().blobs().get("unchanged.txt"));
        Path stage = directory("stage-");
        Result restored = invoke(importFrames(stage, selection(f), exported));
        assertThat(restored.status()).isZero();
        assertThat(restored.frames()).hasSize(1);
        assertThat(restored.last().get("kind").stringValue()).isEqualTo("RESTORED");
        Path repo = stage.resolve("7");
        assertThat(Files.readString(repo.resolve(".git/HEAD")))
                .isEqualTo(f.head().oid() + "\n");
        assertThat(Files.readString(repo.resolve(".git/refs/heads/main")))
                .isEqualTo(f.head().oid() + "\n");
        assertThat(Files.readString(repo.resolve(".git/config")))
                .doesNotContain("include", "remote", "filter", "never-read");
        assertThat(Files.exists(repo.resolve("original-folder-sentinel"))).isFalse();
        assertThat(Files.exists(repo.resolve("src"))).isFalse();
        try (ObjectDirectory db = objects(repo);
                ObjectReader reader = db.newReader()) {
            assertThat(reader.open(ObjectId.fromString(f.head().blobs().get("src/new.ts")))
                            .getBytes())
                    .isEqualTo(bytes("export const answer = 42;\r\n"));
        }
        assertThat(diff(repo, f.parent().oid(), f.head().oid()))
                .isEqualTo(diff(f.repo(), f.parent().oid(), f.head().oid()))
                .anyMatch(value -> value.startsWith("RENAME:"));
        assertThat(branchCommits(repo, f.head().oid()))
                .isEqualTo(branchCommits(f.repo(), f.head().oid()));
        try (var paths = Files.walk(repo)) {
            for (Path path : paths.toList())
                assertThat(Files.getPosixFilePermissions(path))
                        .isEqualTo(
                                PosixFilePermissions.fromString(Files.isDirectory(path) ? "rwx------" : "rw-------"));
        }
    }

    @Test
    void exportIsDeterministicAcrossRepeatedReads() throws Exception {
        Fixture f = fixture();
        assertThat(invoke(List.of(exportRequest(f))).bytes())
                .isEqualTo(invoke(List.of(exportRequest(f))).bytes());
    }

    @Test
    void ancestorsPastTheFirstHistoryPageArePreservedWithoutTheirTrees() throws Exception {
        Path root = directory("repos-");
        Path repo = repository(root);
        Commit current = null;
        for (int i = 0; i < 55; i++)
            current = commit(
                    repo,
                    Map.of("index.ts", bytes("export const v = " + i + ";\n")),
                    current == null ? List.of() : List.of(current.oid()),
                    1_700_000_000L + i);
        Map<String, Object> selection = map(
                "snapshots",
                List.of(),
                "commits",
                List.of(),
                "branches",
                List.of(map("name", "topic/main", "headOid", current.oid())),
                "headOid",
                current.oid());
        Result exported = invoke(List.of(map(
                "version",
                1,
                "operation",
                "EXPORT",
                "reposRoot",
                root.toString(),
                "projectId",
                "7",
                "selection",
                selection)));
        assertThat(exported.status()).isZero();
        assertThat(exported.frames().getFirst().get("objectCount").intValue()).isEqualTo(55);
        Path stage = directory("stage-");
        assertThat(invoke(importFrames(stage, selection, exported)).status()).isZero();
        assertThat(branchCommits(stage.resolve("7"), current.oid()))
                .hasSize(55)
                .isEqualTo(branchCommits(repo, current.oid()));
    }

    @Test
    void everySnapshotIsPreservedEvenWhenItIsNotTheCurrentHead() throws Exception {
        Fixture f = fixture();
        Map<String, Object> selection = selection(f);
        selection.put(
                "snapshots",
                List.of(
                        map(
                                "snapshotId",
                                "30",
                                "commitOid",
                                f.parent().oid(),
                                "files",
                                List.of(map(
                                        "path",
                                        "src/old.ts",
                                        "gitOid",
                                        f.parent().blobs().get("src/old.ts"),
                                        "byteSize",
                                        bytes("export const answer = 42;\r\n").length))),
                        ((List<?>) selection.get("snapshots")).getFirst()));
        Map<String, Object> request = exportRequest(f);
        request.put("selection", selection);
        Result exported = invoke(List.of(request));
        assertThat(exported.status()).isZero();
        Path stage = directory("stage-");
        assertThat(invoke(importFrames(stage, selection, exported)).status()).isZero();
    }

    @Test
    void missingOldSnapshotFailsWholeExportBeforeAnyBeginReceipt() throws Exception {
        Fixture f = fixture();
        Map<String, Object> selection = selection(f);
        selection.put("snapshots", List.of(map("snapshotId", "30", "commitOid", "1".repeat(40), "files", List.of())));
        Map<String, Object> request = exportRequest(f);
        request.put("selection", selection);
        Result result = invoke(List.of(request));
        failed(result, "SOURCE_MISSING");
        assertThat(result.frames()).hasSize(1);
    }

    @Test
    void aMissingBranchAncestorCannotBecomeAnIncompleteSuccessfulArchive() throws Exception {
        Fixture f = fixture();
        Commit head = commit(f.repo(), Map.of("safe.txt", bytes("safe\n")), List.of("2".repeat(40)), 1_700_000_005L);
        Map<String, Object> selection = map(
                "snapshots",
                List.of(),
                "commits",
                List.of(),
                "branches",
                List.of(map("name", "main", "headOid", head.oid())),
                "headOid",
                head.oid());
        Map<String, Object> request = exportRequest(f);
        request.put("selection", selection);
        failed(invoke(List.of(request)), "SOURCE_MISSING");
    }

    @Test
    void inventoryOidAndSizeMustMatchTheSnapshotTree() throws Exception {
        Fixture f = fixture();
        Map<String, Object> request = exportRequest(f);
        for (Map<String, Object> file : List.of(
                map("path", "src/new.ts", "gitOid", f.head().blobs().get("src/added.ts"), "byteSize", 1),
                map("path", "src/new.ts", "gitOid", f.head().blobs().get("src/new.ts"), "byteSize", 1))) {
            Map<String, Object> selection = selection(f);
            selection.put(
                    "snapshots",
                    List.of(map("snapshotId", "31", "commitOid", f.head().oid(), "files", List.of(file))));
            request.put("selection", selection);
            failed(invoke(List.of(request)), null);
        }
    }

    @TestFactory
    Stream<DynamicTest> unsafePathsAreRejectedBeforeObjectReads() {
        return Stream.of(
                        "../outside",
                        "/absolute",
                        "a/.git/config",
                        "a\\outside",
                        "a//b",
                        "a/./b",
                        "C:drive",
                        "%2e%2e/x",
                        "a\0b")
                .map(path -> DynamicTest.dynamicTest("unsafe selected path " + path.replace('\0', '?'), () -> {
                    Fixture f = fixture();
                    Map<String, Object> selection = selection(f);
                    selection.put(
                            "snapshots",
                            List.of(map(
                                    "snapshotId",
                                    "31",
                                    "commitOid",
                                    f.head().oid(),
                                    "files",
                                    List.of(map(
                                            "path",
                                            path,
                                            "gitOid",
                                            f.head().blobs().get("src/new.ts"),
                                            "byteSize",
                                            1)))));
                    Map<String, Object> request = exportRequest(f);
                    request.put("selection", selection);
                    failed(invoke(List.of(request)), "SOURCE_UNSAFE_PATH");
                }));
    }

    @TestFactory
    Stream<DynamicTest> dangerousFilesystemEntriesFailClosed() {
        return Stream.of(
                        "repo-link",
                        "git-link",
                        "object-link",
                        "object-hardlink",
                        "alternates",
                        "http-alternates",
                        "shallow",
                        "grafts")
                .map(kind -> DynamicTest.dynamicTest(kind, () -> {
                    Fixture f = fixture();
                    Path git = f.repo().resolve(".git");
                    if (kind.equals("repo-link")) {
                        Path original = f.root().resolve("original");
                        Files.move(f.repo(), original);
                        Files.createSymbolicLink(f.repo(), original);
                    } else if (kind.equals("git-link")) {
                        Path original = f.root().resolve("git-original");
                        Files.move(git, original);
                        Files.createSymbolicLink(git, original);
                    } else if (kind.equals("object-link") || kind.equals("object-hardlink")) {
                        Path object = git.resolve("objects")
                                .resolve(f.hiddenOid().substring(0, 2))
                                .resolve(f.hiddenOid().substring(2));
                        Path alias = git.resolve("unexpected-object");
                        if (kind.equals("object-link")) Files.createSymbolicLink(alias, object);
                        else Files.createLink(alias, object);
                    } else {
                        Path file =
                                switch (kind) {
                                    case "alternates", "http-alternates" -> git.resolve("objects/info/" + kind);
                                    case "grafts" -> git.resolve("info/grafts");
                                    default -> git.resolve(kind);
                                };
                        Files.createDirectories(file.getParent());
                        Files.writeString(file, "outside-must-not-be-read");
                    }
                    failed(invoke(List.of(exportRequest(f))), "SOURCE_UNSAFE_PATH");
                }));
    }

    @TestFactory
    Stream<DynamicTest> selectedSecretAndUnsupportedBytesNeverProduceACompleteArchive() {
        return Stream.of(
                        "token=synthetic-secret-sentinel",
                        "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
                        "null\0byte")
                .map(content -> DynamicTest.dynamicTest("selected content policy " + content.length(), () -> {
                    Fixture f = fixture();
                    Commit commit = commit(f.repo(), Map.of("safe.txt", bytes(content)), List.of(), 1_700_000_100L);
                    Map<String, Object> selection = map(
                            "snapshots",
                            List.of(),
                            "commits",
                            List.of(commit.oid()),
                            "branches",
                            List.of(),
                            "headOid",
                            commit.oid());
                    Map<String, Object> request = exportRequest(f);
                    request.put("selection", selection);
                    Result result = invoke(List.of(request));
                    failed(result, content.contains("\0") ? "SOURCE_UNSUPPORTED_ENCODING" : "SOURCE_SECRET_DETECTED");
                    assertThat(result.frames()).hasSize(1);
                }));
    }

    @Test
    void invalidUtf8IsRejectedWithoutReplacementCharactersOrTranscoding() throws Exception {
        Fixture f = fixture();
        Commit commit = commit(f.repo(), Map.of("safe.txt", new byte[] {(byte) 0xc3, 0x28}), List.of(), 1_700_000_100L);
        Map<String, Object> request = exportRequest(f);
        request.put(
                "selection",
                map(
                        "snapshots",
                        List.of(),
                        "commits",
                        List.of(commit.oid()),
                        "branches",
                        List.of(),
                        "headOid",
                        commit.oid()));
        failed(invoke(List.of(request)), "SOURCE_UNSUPPORTED_ENCODING");
    }

    @Test
    void symlinkGitModeIsNotMaterializedOrSilentlyDropped() throws Exception {
        Fixture f = fixture();
        String oid;
        try (ObjectDirectory db = objects(f.repo());
                ObjectInserter inserter = db.newInserter()) {
            ObjectId blob = inserter.insert(Constants.OBJ_BLOB, bytes("../../outside"));
            TreeFormatter tree = new TreeFormatter();
            tree.append("link", FileMode.SYMLINK, blob);
            CommitBuilder c = new CommitBuilder();
            c.setTreeId(inserter.insert(tree));
            PersonIdent author = new PersonIdent(
                    "Synthetic", "synthetic@example.invalid", Date.from(Instant.EPOCH), TimeZone.getTimeZone("UTC"));
            c.setAuthor(author);
            c.setCommitter(author);
            c.setMessage("synthetic link");
            oid = inserter.insert(c).name();
            inserter.flush();
        }
        Map<String, Object> request = exportRequest(f);
        request.put(
                "selection",
                map("snapshots", List.of(), "commits", List.of(oid), "branches", List.of(), "headOid", oid));
        failed(invoke(List.of(request)), "SOURCE_UNSUPPORTED_MODE");
    }

    @Test
    void existingRestoreDestinationRemainsByteForByteUntouched() throws Exception {
        Fixture f = fixture();
        Result exported = invoke(List.of(exportRequest(f)));
        Path stage = directory("stage-");
        Path existing = Files.createDirectory(stage.resolve("7"));
        Path marker = Files.writeString(existing.resolve("keep"), "existing-original");
        failed(invoke(importFrames(stage, selection(f), exported)), null);
        assertThat(Files.readString(marker)).isEqualTo("existing-original");
        try (var entries = Files.list(existing)) {
            assertThat(entries.map(p -> p.getFileName().toString())).containsExactly("keep");
        }
    }

    @TestFactory
    Stream<DynamicTest> corruptImportFramesCleanOnlyTheirFreshDestination() {
        return Stream.of(
                        "sha",
                        "oid",
                        "size",
                        "base64",
                        "type",
                        "unknown-field",
                        "duplicate-object",
                        "missing-object",
                        "missing-end",
                        "trailing-frame",
                        "receipt")
                .map(kind -> DynamicTest.dynamicTest("import " + kind, () -> {
                    Fixture f = fixture();
                    Result exported = invoke(List.of(exportRequest(f)));
                    Path stage = directory("stage-");
                    Path unrelated = Files.writeString(stage.resolve("keep"), "unrelated");
                    List<Object> frames = importFrames(stage, selection(f), exported);
                    Map<String, Object> frame = mutable((JsonNode) frames.get(1));
                    frames.set(1, frame);
                    switch (kind) {
                        case "sha" -> frame.put("rawSha256", "0".repeat(64));
                        case "oid" -> frame.put("gitOid", "0".repeat(40));
                        case "size" -> frame.put("byteSize", 0);
                        case "base64" -> frame.put("bytesBase64", "!");
                        case "type" -> frame.put("objectType", "PACK");
                        case "unknown-field" -> frame.put("config", "must-not-execute");
                        case "duplicate-object" -> frames.set(2, frame);
                        case "missing-object" -> frames.remove(1);
                        case "missing-end" -> frames.removeLast();
                        case "trailing-frame" -> frames.add(map("extra", true));
                        case "receipt" -> {
                            Map<String, Object> end = mutable((JsonNode) frames.getLast());
                            end.put("objectsSha256", "0".repeat(64));
                            frames.set(frames.size() - 1, end);
                        }
                    }
                    failed(invoke(frames), null);
                    assertThat(Files.exists(stage.resolve("7"))).isFalse();
                    assertThat(Files.readString(unrelated)).isEqualTo("unrelated");
                }));
    }

    @Test
    void validExtraObjectWithRecomputedOuterDigestsIsStillRejected() throws Exception {
        Fixture f = fixture();
        Result exported = invoke(List.of(exportRequest(f)));
        Path stage = directory("stage-");
        List<Map<String, Object>> objects = exported.frames().stream()
                .filter(n -> "OBJECT".equals(n.get("kind").stringValue()))
                .map(BackupSourceWorkerTest::mutable)
                .collect(java.util.stream.Collectors.toCollection(ArrayList::new));
        byte[] extra = bytes("safe but not requested\n");
        String oid;
        try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
            oid = formatter.idFor(Constants.OBJ_BLOB, extra).name();
        }
        objects.add(map(
                "version",
                1,
                "kind",
                "OBJECT",
                "objectType",
                "BLOB",
                "gitOid",
                oid,
                "rawSha256",
                sha256(extra),
                "byteSize",
                extra.length,
                "bytesBase64",
                Base64.getEncoder().encodeToString(extra)));
        objects.sort(java.util.Comparator.comparing(o -> (String) o.get("gitOid")));
        Map<String, SourceGraph.Meta> meta = new java.util.TreeMap<>();
        long total = 0;
        for (Map<String, Object> object : objects) {
            int type =
                    switch ((String) object.get("objectType")) {
                        case "COMMIT" -> Constants.OBJ_COMMIT;
                        case "TREE" -> Constants.OBJ_TREE;
                        default -> Constants.OBJ_BLOB;
                    };
            int size = ((Number) object.get("byteSize")).intValue();
            total += size;
            meta.put(
                    (String) object.get("gitOid"),
                    new SourceGraph.Meta(type, (String) object.get("gitOid"), (String) object.get("rawSha256"), size));
        }
        Map<String, Object> request = importRequest(stage, selection(f), exported);
        Map<String, Object> expected = (Map<String, Object>) request.get("expected");
        expected.put("objectCount", objects.size());
        expected.put("totalObjectBytes", total);
        expected.put("objectsSha256", SourceGraph.digest(meta));
        Map<String, Object> end = mutable(exported.last());
        end.putAll(expected);
        List<Object> frames = new ArrayList<>();
        frames.add(request);
        frames.addAll(objects);
        frames.add(end);
        failed(invoke(frames), "SOURCE_SELECTION_INVALID");
        assertThat(Files.exists(stage.resolve("7"))).isFalse();
    }

    @Test
    void emptyUnanalyzedProjectNeedsNoCloneAndRestoresAnEmptyManagedRepository() throws Exception {
        Path root = directory("repos-");
        Map<String, Object> selection =
                map("snapshots", List.of(), "commits", List.of(), "branches", List.of(), "headOid", null);
        Result exported = invoke(List.of(map(
                "version",
                1,
                "operation",
                "EXPORT",
                "reposRoot",
                root.toString(),
                "projectId",
                "7",
                "selection",
                selection)));
        assertThat(exported.status()).isZero();
        assertThat(exported.frames()).hasSize(2);
        Path stage = directory("stage-");
        assertThat(invoke(importFrames(stage, selection, exported)).status()).isZero();
        assertThat(Files.readString(stage.resolve("7/.git/HEAD"))).isEqualTo("ref: refs/heads/backup-empty\n");
    }

    @Test
    void exactFlagAndSingleRequestAreRequired() throws Exception {
        Fixture f = fixture();
        byte[] request = wire(List.of(exportRequest(f)));
        assertThat(BackupSourceWorker.requested(new String[] {BackupSourceWorker.FLAG}))
                .isTrue();
        assertThat(BackupSourceWorker.requested(new String[] {"--spring.profiles.active=desktop"}))
                .isFalse();
        failed(invokeBytes(request, BackupSourceWorker.FLAG, "extra"), "SOURCE_ARGUMENT_INVALID");
        failed(invokeBytes(request, BackupSourceWorker.FLAG + "=EXPORT"), "SOURCE_ARGUMENT_INVALID");
        failed(invoke(List.of(exportRequest(f), exportRequest(f))), "SOURCE_PROTOCOL_INVALID");
    }

    @Test
    void duplicateJsonFieldsAndOversizedFramesAreRejected() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream output = new DataOutputStream(bytes);
        byte[] duplicate = bytes("{\"version\":1,\"version\":1}");
        output.writeInt(duplicate.length);
        output.write(duplicate);
        failed(invokeBytes(bytes.toByteArray()), null);
        bytes.reset();
        output.writeInt(MAX_FRAME + 1);
        failed(invokeBytes(bytes.toByteArray()), "SOURCE_LIMIT");
        bytes.reset();
        output.writeInt(100);
        output.writeByte('{');
        failed(invokeBytes(bytes.toByteArray()), "SOURCE_PROTOCOL_INVALID");
    }

    @Test
    void cooperativeCancellationDoesNotProduceASuccessfulArchive() throws Exception {
        Fixture f = fixture();
        Thread.currentThread().interrupt();
        try {
            failed(invoke(List.of(exportRequest(f))), "SOURCE_LIMIT");
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    void mergeUsesFirstParentDiffAndRetainsEveryBranchParentHeader() throws Exception {
        Fixture f = fixture();
        Commit side = commit(
                f.repo(),
                Map.of("side.txt", bytes("token=unselected-secret-sentinel")),
                List.of(f.parent().oid()),
                1_700_000_004L);
        Commit merge = commit(
                f.repo(),
                Map.of("merged.ts", bytes("export const merged = true;\n")),
                List.of(f.head().oid(), side.oid()),
                1_700_000_005L);
        Map<String, Object> selection = map(
                "snapshots",
                List.of(),
                "commits",
                List.of(merge.oid()),
                "branches",
                List.of(map("name", "main", "headOid", merge.oid())),
                "headOid",
                merge.oid());
        Map<String, Object> request = exportRequest(f);
        request.put("selection", selection);
        Result exported = invoke(List.of(request));
        assertThat(exported.status()).isZero();
        assertThat(exported.frames().stream()
                        .filter(n -> n.get("gitOid") != null)
                        .map(n -> n.get("gitOid").stringValue()))
                .contains(side.oid())
                .doesNotContain(side.blobs().get("side.txt"));
        Path stage = directory("stage-");
        assertThat(invoke(importFrames(stage, selection, exported)).status()).isZero();
        assertThat(diff(stage.resolve("7"), f.head().oid(), merge.oid()))
                .isEqualTo(diff(f.repo(), f.head().oid(), merge.oid()));
        assertThat(branchCommits(stage.resolve("7"), merge.oid())).isEqualTo(branchCommits(f.repo(), merge.oid()));
    }

    @Test
    void oversizedRequiredBlobFailsWithoutTruncatingIt() throws Exception {
        Fixture f = fixture();
        byte[] large = new byte[MAX_OBJECT + 1];
        Arrays.fill(large, (byte) 'a');
        Commit head = commit(f.repo(), Map.of("large.txt", large), List.of(), 1_700_000_100L);
        Map<String, Object> request = exportRequest(f);
        request.put(
                "selection",
                map(
                        "snapshots",
                        List.of(),
                        "commits",
                        List.of(head.oid()),
                        "branches",
                        List.of(),
                        "headOid",
                        head.oid()));
        failed(invoke(List.of(request)), "SOURCE_LIMIT");
    }

    @Test
    void changedLooseObjectIsVerifiedAgainstItsGitOid() throws Exception {
        Fixture f = fixture();
        String oid = f.head().blobs().get("src/new.ts");
        Path file =
                f.repo().resolve(".git/objects").resolve(oid.substring(0, 2)).resolve(oid.substring(2));
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        try (var zipped = new java.util.zip.DeflaterOutputStream(Files.newOutputStream(file))) {
            zipped.write(bytes("blob 4\0fake"));
        }
        failed(invoke(List.of(exportRequest(f))), "SOURCE_INTEGRITY");
    }

    @TestFactory
    Stream<DynamicTest> ambiguousOrUnsafeRefNamesAreRejected() {
        return Stream.of("../escape", "a.lock", "a..b", "a/.git/config", "topic/main/", "a@{b", "/absolute")
                .map(name -> DynamicTest.dynamicTest("branch " + name, () -> {
                    Fixture f = fixture();
                    Map<String, Object> selection = selection(f);
                    selection.put(
                            "branches",
                            List.of(map("name", name, "headOid", f.head().oid())));
                    Map<String, Object> request = exportRequest(f);
                    request.put("selection", selection);
                    failed(invoke(List.of(request)), null);
                }));
    }

    @Test
    void caseAliasedAndPrefixConflictingRefsNeverReachFilesystemCreation() throws Exception {
        Fixture f = fixture();
        for (List<String> names : List.of(List.of("Topic", "topic"), List.of("topic", "topic/main"))) {
            Map<String, Object> selection = selection(f);
            selection.put(
                    "branches",
                    names.stream()
                            .map(name -> map("name", name, "headOid", f.head().oid()))
                            .toList());
            Map<String, Object> request = exportRequest(f);
            request.put("selection", selection);
            failed(invoke(List.of(request)), "SOURCE_SELECTION_INVALID");
        }
    }

    @Test
    void restoreRootMustBeCanonicalPrivateAndExisting() throws Exception {
        Fixture f = fixture();
        Result exported = invoke(List.of(exportRequest(f)));
        Path stage = directory("stage-");
        Path alias = temp.resolve("stage-alias");
        Files.createSymbolicLink(alias, stage);
        failed(invoke(importFrames(alias, selection(f), exported)), "SOURCE_UNSAFE_PATH");
        Files.setPosixFilePermissions(stage, PosixFilePermissions.fromString("rwxr-xr-x"));
        failed(invoke(importFrames(stage, selection(f), exported)), "SOURCE_UNSAFE_PATH");
        assertThat(Files.exists(stage.resolve("7"))).isFalse();
    }

    record RetainedFixture(
            Path original,
            Path repos,
            Path scratch,
            Commit commit,
            Map<String, byte[]> contents,
            Map<String, Object> selection,
            List<Map<String, Object>> frames) {}

    private RetainedFixture retainedFixture(Map<String, byte[]> contents) throws Exception {
        Path original = repository(directory("retained-original-"));
        Commit template = commit(original, contents, List.of(), 1_700_000_000L, "Code Intelligence local snapshot");
        String retainedOid;
        // Independent expected raw commit: adjust the reference fixture's identity, not the worker builder.
        try (ObjectDirectory db = objects(original);
                ObjectReader reader = db.newReader();
                ObjectInserter inserter = db.newInserter()) {
            String raw = new String(
                            reader.open(ObjectId.fromString(template.oid())).getBytes(), StandardCharsets.UTF_8)
                    .replace(
                            "Synthetic Author <synthetic@example.invalid>",
                            "Code Intelligence <local@code-intelligence.invalid>");
            retainedOid = inserter.insert(Constants.OBJ_COMMIT, bytes(raw)).name();
            inserter.flush();
        }
        Commit commit = new Commit(retainedOid, template.tree(), template.blobs());
        List<Map<String, Object>> entries = contents.keySet().stream()
                .sorted(SourceSelection.PATH_ORDER)
                .map(p -> map(
                        "path",
                        p,
                        "gitOid",
                        commit.blobs().get(p),
                        "rawSha256",
                        sha256(contents.get(p)),
                        "byteSize",
                        contents.get(p).length))
                .toList();
        List<Map<String, Object>> files = entries.stream()
                .map(e -> map("path", e.get("path"), "gitOid", e.get("gitOid"), "byteSize", e.get("byteSize")))
                .toList();
        Map<String, Object> selection = map(
                "snapshots",
                List.of(map("snapshotId", "11", "commitOid", retainedOid, "files", files)),
                "commits",
                List.of(retainedOid),
                "branches",
                List.of(map("name", "snapshot", "headOid", retainedOid)),
                "headOid",
                retainedOid);
        long total = contents.values().stream().mapToLong(b -> b.length).sum();
        Map<String, Object> header = map(
                "version",
                1,
                "kind",
                "RETAINED_BEGIN",
                "snapshotId",
                "11",
                "commitOid",
                retainedOid,
                "commitEpochSecond",
                "1700000000",
                "policyVersion",
                "local-ingest-v1",
                "limitsSha256",
                "a".repeat(64),
                "manifestSha256",
                manifestDigest(entries),
                "fileCount",
                entries.size(),
                "totalBytes",
                total);
        Path repos = directory("retained-repos-"), scratch = directory("retained-scratch-");
        List<Map<String, Object>> frames = new ArrayList<>();
        frames.add(map(
                "version",
                1,
                "operation",
                "EXPORT_RETAINED",
                "reposRoot",
                repos.toString(),
                "scratchRoot",
                scratch.toString(),
                "projectId",
                "7",
                "selection",
                selection,
                "retainedCount",
                1));
        frames.add(header);
        for (Map<String, Object> entry : entries) {
            Map<String, Object> frame = map("version", 1, "kind", "RETAINED_ENTRY");
            frame.putAll(entry);
            frame.put("bytesBase64", Base64.getEncoder().encodeToString(contents.get(entry.get("path"))));
            frames.add(frame);
        }
        frames.add(map("version", 1, "kind", "RETAINED_END", "snapshotId", "11"));
        return new RetainedFixture(original, repos, scratch, commit, contents, selection, frames);
    }

    private static String manifestDigest(List<Map<String, Object>> entries) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream framed = new DataOutputStream(bytes);
        for (String value : List.of("code-intelligence-local-manifest-v1", "local-ingest-v1", "a".repeat(64))) {
            byte[] raw = bytes(value);
            framed.writeInt(raw.length);
            framed.write(raw);
        }
        long total = 0;
        for (Map<String, Object> entry : entries) {
            framed.writeByte(1);
            for (String value : List.of((String) entry.get("path"), "REGULAR_FILE")) {
                byte[] raw = bytes(value);
                framed.writeInt(raw.length);
                framed.write(raw);
            }
            long size = ((Number) entry.get("byteSize")).longValue();
            total += size;
            framed.writeLong(size);
            framed.write(java.util.HexFormat.of().parseHex((String) entry.get("rawSha256")));
        }
        framed.writeByte(0);
        framed.writeLong(entries.size());
        framed.writeLong(total);
        return sha256(bytes.toByteArray());
    }

    @TestFactory
    Stream<DynamicTest> commitEpochSecondReadsLazyIdentityBeforeClearingOwnedBytes() {
        return Stream.of(0L, 1700000000L, 2147483648L, 253402300799L)
                .map(second -> DynamicTest.dynamicTest("committer epoch " + second, () -> {
                    Path repo = repository(directory("committer-epoch-"));
                    Commit commit =
                            commit(repo, Map.of("public.ts", bytes("export const v = 1;\n")), List.of(), second);
                    try (ObjectDirectory database = objects(repo);
                            ObjectReader reader = database.newReader()) {
                        SourceGraph graph = new SourceGraph(reader, new Budget());
                        assertThat(graph.commitEpochSecond(commit.oid())).isEqualTo(second);
                        // A later read uses independently owned bytes, including times beyond the int epoch range.
                        assertThat(graph.commitEpochSecond(commit.oid())).isEqualTo(second);
                    }
                }));
    }

    @Test
    void retainedExportRecreatesExactCommitAndRawFilesAfterRunWorkspaceHasDisappeared() throws Exception {
        RetainedFixture f = retainedFixture(Map.of(
                "src/a.ts",
                bytes("export const a = 1;\r\n"),
                "src/nested/한글.ts",
                bytes("export const text = '안녕';\n"),
                "empty.txt",
                new byte[0]));
        Map<Path, SourceFiles.Stamp> original = SourceFiles.inspect(f.original().resolve(".git"), new Budget());
        Path unrelated = Files.writeString(f.scratch().resolve("keep"), "owned by coordinator");
        Result exported = invoke(f.frames());
        assertThat(exported.status()).isZero();
        assertThat(Files.exists(f.repos().resolve("7"))).isFalse();
        assertThat(Files.exists(f.scratch().resolve("7"))).isFalse();
        assertThat(Files.readString(unrelated)).isEqualTo("owned by coordinator");
        assertThat(SourceFiles.inspect(f.original().resolve(".git"), new Budget()))
                .isEqualTo(original);
        Path stage = directory("retained-stage-");
        assertThat(invoke(importFrames(stage, f.selection(), exported)).status())
                .isZero();
        assertThat(Files.readString(stage.resolve("7/.git/HEAD")))
                .isEqualTo(f.commit().oid() + "\n");
        try (ObjectDirectory db = objects(stage.resolve("7"));
                ObjectReader reader = db.newReader()) {
            for (var entry : f.contents().entrySet())
                assertThat(reader.open(ObjectId.fromString(f.commit().blobs().get(entry.getKey())))
                                .getBytes())
                        .isEqualTo(entry.getValue());
        }
        assertThat(branchCommits(stage.resolve("7"), f.commit().oid()))
                .containsExactly(f.commit().oid());
        // A restored exact commit can supply its timestamp after approval rows were intentionally excluded.
        f.frames().getFirst().put("reposRoot", stage.toString());
        f.frames().get(1).put("commitEpochSecond", null);
        Result reopened = invoke(f.frames());
        assertThat(reopened.status()).isZero();
        assertThat(reopened.frames()).isEqualTo(exported.frames());
    }

    @Test
    void mixedLegacyAndRetainedHistoryExportsBothWithoutWritingTheManagedClone() throws Exception {
        Fixture legacy = fixture();
        RetainedFixture f = retainedFixture(Map.of("safe.ts", bytes("export const v = 2;\n")));
        Map<Path, SourceFiles.Stamp> before = SourceFiles.inspect(legacy.repo().resolve(".git"), new Budget());
        f.frames().getFirst().put("reposRoot", legacy.root().toString());
        f.selection().put("commits", List.of(f.commit().oid(), legacy.head().oid()));
        f.selection()
                .put(
                        "branches",
                        List.of(
                                map("name", "snapshot", "headOid", f.commit().oid()),
                                map("name", "main", "headOid", legacy.head().oid())));
        Result exported = invoke(f.frames());
        assertThat(exported.status()).isZero();
        Path stage = directory("mixed-stage-");
        assertThat(invoke(importFrames(stage, f.selection(), exported)).status())
                .isZero();
        assertThat(diff(stage.resolve("7"), legacy.parent().oid(), legacy.head().oid()))
                .isEqualTo(
                        diff(legacy.repo(), legacy.parent().oid(), legacy.head().oid()));
        assertThat(SourceFiles.inspect(legacy.repo().resolve(".git"), new Budget()))
                .isEqualTo(before);
        try (ObjectDirectory db = objects(legacy.repo());
                ObjectReader reader = db.newReader()) {
            assertThat(reader.has(ObjectId.fromString(f.commit().oid()))).isFalse();
        }
    }

    @Test
    void multipleRetainedSnapshotsPreserveDistinctHistoricalCommits() throws Exception {
        RetainedFixture first = retainedFixture(Map.of("old.ts", bytes("export const v = 1;\n")));
        RetainedFixture second = retainedFixture(Map.of("new.ts", bytes("export const v = 2;\n")));
        List<Object> snapshots = new ArrayList<>((List<?>) first.selection().get("snapshots"));
        Map<String, Object> next =
                mutable(JSON.valueToTree(((List<?>) second.selection().get("snapshots")).getFirst()));
        next.put("snapshotId", "12");
        snapshots.add(next);
        first.selection().put("snapshots", snapshots);
        first.selection()
                .put("commits", List.of(first.commit().oid(), second.commit().oid()));
        first.frames().getFirst().put("retainedCount", 2);
        second.frames().get(1).put("snapshotId", "12");
        second.frames().getLast().put("snapshotId", "12");
        first.frames().addAll(second.frames().subList(1, second.frames().size()));
        Result exported = invoke(first.frames());
        assertThat(exported.status()).isZero();
        Path stage = directory("multiple-stage-");
        assertThat(invoke(importFrames(stage, first.selection(), exported)).status())
                .isZero();
        assertThat(diff(
                        stage.resolve("7"),
                        first.commit().oid(),
                        second.commit().oid()))
                .containsExactlyInAnyOrder(
                        "DELETE:old.ts:/dev/null:" + first.commit().blobs().get("old.ts") + ":" + "0".repeat(40),
                        "ADD:/dev/null:new.ts:" + "0".repeat(40) + ":"
                                + second.commit().blobs().get("new.ts"));
    }

    @TestFactory
    Stream<DynamicTest> retainedDescriptorAndStreamMutationsRejectAndCleanFreshScratch() {
        return Stream.of(
                        "missing-time",
                        "wrong-time",
                        "leading-time",
                        "negative-time",
                        "time-number",
                        "time-limit",
                        "policy",
                        "limits",
                        "manifest",
                        "count",
                        "total",
                        "snapshot",
                        "commit",
                        "begin-unknown",
                        "entry-unknown",
                        "raw-hash",
                        "git-oid",
                        "size",
                        "base64",
                        "missing-entry",
                        "missing-end",
                        "end-owner",
                        "extra-frame",
                        "unsorted",
                        "duplicate")
                .map(kind -> DynamicTest.dynamicTest("retained " + kind, () -> {
                    RetainedFixture f = retainedFixture(
                            Map.of("a.ts", bytes("export const a = 1;\n"), "b.ts", bytes("export const b = 2;\n")));
                    Map<String, Object> header = f.frames().get(1),
                            entry = f.frames().get(2);
                    switch (kind) {
                        case "missing-time" -> header.put("commitEpochSecond", null);
                        case "wrong-time" -> header.put("commitEpochSecond", "1700000001");
                        case "leading-time" -> header.put("commitEpochSecond", "01700000000");
                        case "negative-time" -> header.put("commitEpochSecond", "-1");
                        case "time-number" -> header.put("commitEpochSecond", 1700000000);
                        case "time-limit" -> header.put("commitEpochSecond", "253402300800");
                        case "policy" -> header.put("policyVersion", "local-ingest-v2");
                        case "limits" -> header.put("limitsSha256", "b".repeat(64));
                        case "manifest" -> header.put("manifestSha256", "0".repeat(64));
                        case "count" -> header.put("fileCount", 1);
                        case "total" -> header.put("totalBytes", 0);
                        case "snapshot" -> header.put("snapshotId", "12");
                        case "commit" -> header.put("commitOid", "0".repeat(40));
                        case "begin-unknown" -> header.put("keyId", "not allowed");
                        case "entry-unknown" -> entry.put("keyBytes", "not allowed");
                        case "raw-hash" -> entry.put("rawSha256", "0".repeat(64));
                        case "git-oid" -> entry.put("gitOid", "0".repeat(40));
                        case "size" -> entry.put("byteSize", 0);
                        case "base64" -> entry.put("bytesBase64", "!");
                        case "missing-entry" -> f.frames().remove(2);
                        case "missing-end" -> f.frames().removeLast();
                        case "end-owner" -> f.frames().getLast().put("snapshotId", "12");
                        case "extra-frame" -> f.frames().add(map("version", 1, "kind", "EXTRA"));
                        case "unsorted" -> java.util.Collections.swap(f.frames(), 2, 3);
                        case "duplicate" -> f.frames().set(3, entry);
                    }
                    failed(invoke(f.frames()), kind.equals("missing-time") ? "SOURCE_MISSING" : null);
                    assertThat(Files.exists(f.scratch().resolve("7"))).isFalse();
                    assertThat(Files.exists(f.repos().resolve("7"))).isFalse();
                }));
    }

    @TestFactory
    Stream<DynamicTest> retainedRawTextPolicyRemainsStrictWithValidManifestAndGitHashes() {
        return Stream.of("secret", "nul", "utf8", "too-large")
                .map(kind -> DynamicTest.dynamicTest(kind, () -> {
                    byte[] raw =
                            switch (kind) {
                                case "secret" -> bytes("token=retained-secret-sentinel");
                                case "nul" -> bytes("raw\0text");
                                case "utf8" -> new byte[] {(byte) 0xc3, 0x28};
                                default -> new byte[MAX_OBJECT + 1];
                            };
                    RetainedFixture f = retainedFixture(Map.of("safe.ts", raw));
                    Result result = invoke(f.frames());
                    failed(
                            result,
                            kind.equals("secret")
                                    ? "SOURCE_SECRET_DETECTED"
                                    : kind.equals("too-large") ? "SOURCE_LIMIT" : "SOURCE_UNSUPPORTED_ENCODING");
                    assertThat(result.frames()).hasSize(1);
                    assertThat(Files.exists(f.scratch().resolve("7"))).isFalse();
                }));
    }

    @TestFactory
    Stream<DynamicTest> retainedUnsafePathAndAliasesHaveValidManifestRatherThanDigestOnlyFailure() {
        return Stream.of(".git/config", "a/.GiT/data", "../escape", "a\\b", "a/%2e%2e/b", "x".repeat(256), "alias")
                .map(kind -> DynamicTest.dynamicTest(
                        "retained path " + kind.substring(0, Math.min(20, kind.length())), () -> {
                            RetainedFixture f =
                                    retainedFixture(Map.of("a/x.ts", bytes("public\n"), "b/y.ts", bytes("public2\n")));
                            List<Map<String, Object>> entries = new ArrayList<>();
                            for (int i = 2; i < 4; i++) entries.add(f.frames().get(i));
                            entries.getFirst().put("path", kind.equals("alias") ? "A/x.ts" : kind);
                            entries.getLast().put("path", kind.equals("alias") ? "a/y.ts" : "z.ts");
                            entries.sort(java.util.Comparator.comparing(
                                    e -> (String) e.get("path"), SourceSelection.PATH_ORDER));
                            f.frames().set(2, entries.get(0));
                            f.frames().set(3, entries.get(1));
                            f.frames().get(1).put("manifestSha256", manifestDigest(entries));
                            f.selection()
                                    .put(
                                            "snapshots",
                                            List.of(map(
                                                    "snapshotId",
                                                    "11",
                                                    "commitOid",
                                                    f.commit().oid(),
                                                    "files",
                                                    entries.stream()
                                                            .map(e -> map(
                                                                    "path",
                                                                    e.get("path"),
                                                                    "gitOid",
                                                                    e.get("gitOid"),
                                                                    "byteSize",
                                                                    e.get("byteSize")))
                                                            .toList())));
                            failed(invoke(f.frames()), "SOURCE_UNSAFE_PATH");
                            assertThat(Files.exists(f.scratch().resolve("7"))).isFalse();
                        }));
    }

    @TestFactory
    Stream<DynamicTest> retainedScratchNeverAdoptsExistingOrUnsafeRootsAndNeverBypassesUnsafeClone() {
        return Stream.of(
                        "orphan",
                        "child-symlink",
                        "scratch-symlink",
                        "public-mode",
                        "overlap",
                        "clone-symlink",
                        "clone-hardlink")
                .map(kind -> DynamicTest.dynamicTest(kind, () -> {
                    RetainedFixture f = retainedFixture(Map.of("safe.ts", bytes("public\n")));
                    Path marker = Files.writeString(f.scratch().resolve("keep"), "preserve");
                    if (kind.equals("orphan")) {
                        Files.createDirectory(f.scratch().resolve("7"));
                        Files.writeString(f.scratch().resolve("7/orphan"), "crash bytes");
                    }
                    if (kind.equals("child-symlink"))
                        Files.createSymbolicLink(f.scratch().resolve("7"), f.original());
                    if (kind.equals("scratch-symlink")) {
                        Path alias = temp.resolve("alias-" + UUID.randomUUID());
                        Files.createSymbolicLink(alias, f.scratch());
                        f.frames().getFirst().put("scratchRoot", alias.toString());
                    }
                    if (kind.equals("public-mode"))
                        Files.setPosixFilePermissions(f.scratch(), PosixFilePermissions.fromString("rwxr-xr-x"));
                    if (kind.equals("overlap"))
                        f.frames().getFirst().put("scratchRoot", f.repos().toString());
                    if (kind.equals("clone-symlink"))
                        Files.createSymbolicLink(f.repos().resolve("7"), f.original());
                    if (kind.equals("clone-hardlink")) {
                        Path repo = repository(f.repos());
                        Files.createLink(repo.resolve(".git/linked"), marker);
                    }
                    failed(invoke(f.frames()), null);
                    assertThat(Files.readString(marker)).isEqualTo("preserve");
                    if (kind.equals("orphan"))
                        assertThat(Files.readString(f.scratch().resolve("7/orphan")))
                                .isEqualTo("crash bytes");
                    if (kind.equals("child-symlink"))
                        assertThat(Files.isSymbolicLink(f.scratch().resolve("7")))
                                .isTrue();
                }));
    }

    @Test
    void retainedPartialReadFailureAndCancellationCleanOnlyFreshRootAndAllowNewInvocation() throws Exception {
        RetainedFixture f = retainedFixture(Map.of("a.ts", bytes("public\n"), "b.ts", bytes("second\n")));
        byte[] input = wire(f.frames());
        failed(invokeBytes(Arrays.copyOf(input, input.length - 8)), "SOURCE_PROTOCOL_INVALID");
        assertThat(Files.exists(f.scratch().resolve("7"))).isFalse();
        Thread.currentThread().interrupt();
        try {
            failed(invoke(f.frames()), "SOURCE_LIMIT");
        } finally {
            Thread.interrupted();
        }
        assertThat(Files.exists(f.scratch().resolve("7"))).isFalse();
        assertThat(invoke(f.frames()).status()).isZero();
    }

    @Test
    void retainedCancellationAfterAnInsertedBlobCleansScratchAndPreservesInterrupt() throws Exception {
        RetainedFixture f = retainedFixture(Map.of("a.ts", bytes("public\n"), "b.ts", bytes("second\n")));
        byte[] serialized = wire(f.frames());
        int boundary = wire(f.frames().subList(0, 3)).length;
        ByteArrayInputStream input = new ByteArrayInputStream(serialized) {
            @Override
            public synchronized int read(byte[] bytes, int offset, int length) {
                int read = super.read(bytes, offset, length);
                if (pos > boundary) Thread.currentThread().interrupt();
                return read;
            }
        };
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            assertThat(BackupSourceWorker.run(new String[] {BackupSourceWorker.FLAG}, input, output))
                    .isEqualTo(2);
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
        }
        assertThat(Files.exists(f.scratch().resolve("7"))).isFalse();
        JsonNode failure = read(new DataInputStream(new ByteArrayInputStream(output.toByteArray())));
        assertThat(failure.get("code").stringValue()).isEqualTo("SOURCE_LIMIT");
    }

    @Test
    void workerAndActualRetainedRunWorkspaceGenerateTheSameObjects() throws Exception {
        RetainedFixture f = retainedFixture(Map.of("src/raw.ts", bytes("export const raw = 7;\r\n")));
        var app = new dev.codeintelligence.common.AppProperties(
                directory("run-data-").toString(), 2);
        Map<String, Object> header = f.frames().get(1), file = f.frames().get(2);
        var manifest = new dev.codeintelligence.project.RetainedRunWorkspace.Manifest(
                f.commit().oid(),
                Instant.ofEpochSecond(1700000000L).plusMillis(789),
                "local-ingest-v1",
                "a".repeat(64),
                (String) header.get("manifestSha256"),
                1,
                f.contents().get("src/raw.ts").length,
                List.of(new dev.codeintelligence.project.RetainedRunWorkspace.Entry(
                        "src/raw.ts",
                        (String) file.get("gitOid"),
                        (String) file.get("rawSha256"),
                        ((Number) file.get("byteSize")).longValue())));
        Map<String, SourceGraph.Meta> expected;
        try (var workspace = new dev.codeintelligence.project.RetainedRunWorkspace(app);
                var lease = workspace.create(7, 19)) {
            assertThat(workspace.reconstruct(
                            lease,
                            manifest,
                            (hash, size) -> f.contents().get("src/raw.ts").clone()))
                    .isEqualTo(f.commit().oid());
            try (ObjectDirectory db = objects(lease.clonePath());
                    ObjectReader reader = db.newReader()) {
                SourceGraph graph = new SourceGraph(reader, new Budget());
                graph.select(SourceSelection.parse(JSON.valueToTree(f.selection())));
                expected = Map.copyOf(graph.objects);
            }
        }
        Result exported = invoke(f.frames());
        assertThat(exported.status()).isZero();
        assertThat(exported.frames().getFirst().get("objectsSha256").stringValue())
                .isEqualTo(SourceGraph.digest(expected));
        assertThat(exported.frames().getFirst().get("objectCount").intValue()).isEqualTo(expected.size());
    }
}
