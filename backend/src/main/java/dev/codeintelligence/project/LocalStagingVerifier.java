package dev.codeintelligence.project;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.LongSupplier;

/** Strict staged-byte verification. No ignore policy is applied to this already selected tree. */
final class LocalStagingVerifier {
    private static final int BUFFER = 8192;
    private final Path root;
    private final Map<String, LocalSourcePolicy.SelectedFile> expected;
    private final Set<String> expectedDirectories = new HashSet<>();
    private final LocalSourcePolicy.Limits limits;
    private final LongSupplier clock;
    private final long started;
    private final Object rootKey;
    private final long device;
    private final Scan original;
    private Object generatedGitKey;
    private long bytesRead;

    LocalStagingVerifier(Path root, Map<String, LocalSourcePolicy.SelectedFile> expected, LocalSourcePolicy policy)
            throws IOException {
        this.root = root;
        this.expected = expected;
        this.limits = policy.limits();
        this.clock = policy.clock();
        this.started = clock.getAsLong();
        this.rootKey = directory(root).key();
        this.device = device(root);
        for (String name : expected.keySet()) {
            for (Path parent = Path.of(name).getParent(); parent != null; parent = parent.getParent()) {
                expectedDirectories.add(parent.toString());
            }
        }
        // Before generated metadata exists, every staged entry must belong to the selected tree.
        this.original = scan();
    }

    void allowGeneratedGitDirectory() throws IOException {
        if (generatedGitKey != null) throw new IllegalStateException("Git staging was already initialized.");
        Path git = root.resolve(".git");
        if (device(git) != device) throw changed();
        generatedGitKey = directory(git).key();
    }

    void verifyAndConsume(LocalSourceBinding binding, LocalSourcePolicy.AcceptedFile sink) throws IOException {
        LocalSourceManifest manifest = new LocalSourceManifest(binding.policyVersion(), binding.limitsSha256());
        for (var entry : original.files().entrySet()) {
            check();
            String name = entry.getKey();
            Path file = root.resolve(name);
            Stamp stamp = entry.getValue();
            byte[] bytes = read(file, stamp);
            manifest.add(name, bytes.length, LocalSourceManifest.sha256().digest(bytes));
            sink.accept(expected.get(name), bytes);
            requireSame(file, stamp);
        }
        if (manifest.count() != binding.selectedFiles()
                || manifest.bytes() != binding.selectedBytes()
                || !manifest.finish().equals(binding.manifestSha256())) throw changed();
        Scan after = scan();
        if (!original.files().equals(after.files()) || !original.directories().equals(after.directories()))
            throw changed();
        check();
    }

    private Scan scan() throws IOException {
        Map<String, Stamp> files = new TreeMap<>(LocalSourcePolicy::comparePaths);
        Map<String, Stamp> directories = new HashMap<>();
        int[] entries = {0};
        Files.walkFileTree(root, Set.of(), limits.depth() + 1, new SimpleFileVisitor<>() {
            private String visit(Path path) throws IOException {
                check();
                if (++entries[0] > limits.entries() || device(path) != device) throw changed();
                Path relative = root.relativize(path);
                String name = relative.toString();
                if (relative.getNameCount() > limits.depth()
                        || !root.resolve(name).equals(path)) throw changed();
                return name;
            }

            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                if (dir.equals(root.resolve(".git")) && generatedGitKey != null) {
                    check();
                    if (!generatedGitKey.equals(directory(dir).key()) || device(dir) != device) throw changed();
                    // Created only after the first strict scan. The importer alone builds this metadata.
                    return FileVisitResult.SKIP_SUBTREE;
                }
                String name = visit(dir);
                Stamp stamp = directory(dir);
                if (dir.equals(root)) {
                    if (!rootKey.equals(stamp.key())) throw changed();
                } else if (!expectedDirectories.contains(name) || directories.put(name, stamp) != null) {
                    throw changed();
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                String name = visit(file);
                LocalSourcePolicy.SelectedFile selected = expected.get(name);
                if (selected == null
                        || !attrs.isRegularFile()
                        || attrs.isSymbolicLink()
                        || attrs.size() != selected.size()
                        || attrs.size() > limits.fileBytes()
                        || files.size() >= limits.files()) throw changed();
                requireSingleLink(file);
                if (files.put(name, stamp(attrs)) != null) throw changed();
                return FileVisitResult.CONTINUE;
            }
        });
        if (!files.keySet().equals(expected.keySet()) || !directories.keySet().equals(expectedDirectories))
            throw changed();
        return new Scan(files, directories);
    }

    private byte[] read(Path file, Stamp expectedStamp) throws IOException {
        check();
        requireSame(file, expectedStamp);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream((int) Math.min(BUFFER, expectedStamp.size()));
        try (InputStream input = Files.newInputStream(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            byte[] buffer = new byte[BUFFER];
            int count;
            while ((count = input.read(buffer, 0, (int) Math.min(
                            BUFFER,
                            Math.min(expectedStamp.size() + 1 - bytes.size(), limits.totalBytes() + 1 - bytesRead))))
                    != -1) {
                check();
                bytesRead += count;
                if ((long) bytes.size() + count > expectedStamp.size() || bytesRead > limits.totalBytes())
                    throw changed();
                bytes.write(buffer, 0, count);
            }
        }
        requireSame(file, expectedStamp);
        if (bytes.size() != expectedStamp.size()) throw changed();
        return bytes.toByteArray();
    }

    private void requireSame(Path path, Stamp expectedStamp) throws IOException {
        BasicFileAttributes attrs = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attrs.isRegularFile()
                || attrs.isSymbolicLink()
                || device(path) != device
                || !expectedStamp.equals(stamp(attrs))) throw changed();
        requireSingleLink(path);
    }

    private void check() {
        if (Thread.currentThread().isInterrupted() || clock.getAsLong() - started > limits.nanos()) throw changed();
    }

    private static Stamp directory(Path path) throws IOException {
        BasicFileAttributes attrs = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attrs.isDirectory() || attrs.isSymbolicLink()) throw changed();
        return stamp(attrs);
    }

    private static Stamp stamp(BasicFileAttributes attrs) {
        if (attrs.fileKey() == null) throw changed();
        return new Stamp(attrs.fileKey(), attrs.size(), attrs.lastModifiedTime());
    }

    private static void requireSingleLink(Path file) throws IOException {
        if (((Number) Files.getAttribute(file, "unix:nlink", LinkOption.NOFOLLOW_LINKS)).longValue() != 1)
            throw changed();
    }

    private static long device(Path path) throws IOException {
        return ((Number) Files.getAttribute(path, "unix:dev", LinkOption.NOFOLLOW_LINKS)).longValue();
    }

    private static LocalSourceApprovalException changed() {
        return LocalSourceApprovalException.sourceChanged();
    }

    private record Stamp(Object key, long size, FileTime modified) {}

    private record Scan(Map<String, Stamp> files, Map<String, Stamp> directories) {}
}
