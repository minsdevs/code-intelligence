package dev.codeintelligence.backup;

import static dev.codeintelligence.backup.SourceProtocol.*;

import dev.codeintelligence.evidence.SecretMask;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import tools.jackson.databind.JsonNode;

/** A main-supplied database selection, never a request to walk a working folder or arbitrary ref. */
record SourceSelection(List<Snapshot> snapshots, List<String> commits, List<Branch> branches, String headOid) {
    static final int MAX_FILES = 50_000;
    static final Comparator<String> PATH_ORDER = (a, b) ->
            java.util.Arrays.compareUnsigned(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));

    record File(String path, String gitOid, int byteSize) {
        Map<String, Object> wire() {
            return map("path", path, "gitOid", gitOid, "byteSize", byteSize);
        }
    }

    record Snapshot(String snapshotId, String commitOid, List<File> files) {
        Map<String, Object> wire() {
            return map(
                    "snapshotId",
                    snapshotId,
                    "commitOid",
                    commitOid,
                    "files",
                    files.stream().map(File::wire).toList());
        }
    }

    record Branch(String name, String headOid) {
        Map<String, Object> wire() {
            return map("name", name, "headOid", headOid);
        }
    }

    static SourceSelection parse(JsonNode value) {
        exact(value, "snapshots", "commits", "branches", "headOid");
        array(value.get("snapshots"), 10_000);
        array(value.get("commits"), 50_000);
        array(value.get("branches"), 10_000);
        List<Snapshot> snapshots = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        int fileCount = 0;
        for (JsonNode snapshot : value.get("snapshots")) {
            exact(snapshot, "snapshotId", "commitOid", "files");
            String id = id(snapshot.get("snapshotId"));
            if (!ids.add(id)) throw failure("SOURCE_SELECTION_INVALID");
            array(snapshot.get("files"), MAX_FILES);
            List<File> files = new ArrayList<>();
            Set<String> paths = new HashSet<>();
            for (JsonNode file : snapshot.get("files")) {
                exact(file, "path", "gitOid", "byteSize");
                String path = safePath(text(file.get("path")));
                if (!paths.add(path) || ++fileCount > MAX_FILES) throw failure("SOURCE_LIMIT");
                files.add(new File(path, hex(file.get("gitOid"), 40), (int) number(file.get("byteSize"), MAX_OBJECT)));
            }
            files.sort(Comparator.comparing(File::path, PATH_ORDER));
            for (File file : files) {
                String parent = file.path();
                while (parent.lastIndexOf('/') >= 0) {
                    parent = parent.substring(0, parent.lastIndexOf('/'));
                    if (paths.contains(parent)) throw failure("SOURCE_SELECTION_INVALID");
                }
            }
            snapshots.add(new Snapshot(id, hex(snapshot.get("commitOid"), 40), List.copyOf(files)));
        }
        snapshots.sort(Comparator.comparingLong(s -> Long.parseLong(s.snapshotId())));
        List<String> commits = new ArrayList<>();
        ids.clear();
        for (JsonNode commit : value.get("commits")) {
            String oid = hex(commit, 40);
            if (!ids.add(oid)) throw failure("SOURCE_SELECTION_INVALID");
            commits.add(oid);
        }
        commits.sort(String::compareTo);
        List<Branch> branches = new ArrayList<>();
        ids.clear();
        for (JsonNode branch : value.get("branches")) {
            exact(branch, "name", "headOid");
            String name = safePath(text(branch.get("name")));
            String folded = name.toLowerCase(Locale.ROOT);
            if (!ids.add(folded) || !org.eclipse.jgit.lib.Repository.isValidRefName("refs/heads/" + name))
                throw failure("SOURCE_SELECTION_INVALID");
            branches.add(new Branch(name, hex(branch.get("headOid"), 40)));
        }
        branches.sort(Comparator.comparing(Branch::name, PATH_ORDER));
        for (Branch branch : branches) {
            String parent = branch.name().toLowerCase(Locale.ROOT);
            while (parent.lastIndexOf('/') >= 0) {
                parent = parent.substring(0, parent.lastIndexOf('/'));
                if (ids.contains(parent)) throw failure("SOURCE_SELECTION_INVALID");
            }
        }
        String head = value.get("headOid").isNull() ? null : hex(value.get("headOid"), 40);
        // A detached, database-bound HEAD is enough for readers. Do not accept an unrelated Git tip.
        if (head != null
                && snapshots.stream().noneMatch(s -> s.commitOid().equals(head))
                && !commits.contains(head)
                && branches.stream().noneMatch(b -> b.headOid().equals(head)))
            throw failure("SOURCE_SELECTION_INVALID");
        return new SourceSelection(List.copyOf(snapshots), List.copyOf(commits), List.copyOf(branches), head);
    }

    private static void array(JsonNode value, int maximum) {
        if (value == null || !value.isArray() || value.size() > maximum) throw failure("SOURCE_LIMIT");
    }

    static String safePath(String path) {
        if (path.isEmpty()
                || path.getBytes(StandardCharsets.UTF_8).length > 8192
                || path.startsWith("/")
                || path.indexOf('\\') >= 0
                || path.indexOf('\0') >= 0
                || path.indexOf(':') >= 0
                || !Normalizer.isNormalized(path, Normalizer.Form.NFC)
                || !path.equals(utf8(path.getBytes(StandardCharsets.UTF_8)))) throw failure("SOURCE_UNSAFE_PATH");
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c"))
            throw failure("SOURCE_UNSAFE_PATH");
        String[] parts = path.split("/", -1);
        if (parts.length > 64) throw failure("SOURCE_LIMIT");
        for (String part : parts) {
            if (part.isEmpty()
                    || part.equals(".")
                    || part.equals("..")
                    || part.equalsIgnoreCase(".git")
                    || part.chars().anyMatch(c -> c < 32 || c == 127)) throw failure("SOURCE_UNSAFE_PATH");
        }
        if (!SecretMask.redact(path).equals(path)) throw failure("SOURCE_SECRET_DETECTED");
        return path;
    }

    Map<String, Object> wire() {
        return map(
                "snapshots",
                snapshots.stream().map(Snapshot::wire).toList(),
                "commits",
                commits,
                "branches",
                branches.stream().map(Branch::wire).toList(),
                "headOid",
                headOid);
    }

    String digest() {
        return sha256(JSON.writeValueAsBytes(wire()));
    }
}
