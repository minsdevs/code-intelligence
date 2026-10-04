package dev.codeintelligence.backup;

import static dev.codeintelligence.backup.SourceProtocol.*;

import dev.codeintelligence.common.SourceAccess;
import dev.codeintelligence.common.WindowsStorage;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/** Only trusted managed roots and a newly created destination; never resolves source working files. */
final class SourceFiles {
    static final Set<PosixFilePermission> DIRECTORY_MODE = PosixFilePermissions.fromString("rwx------");
    static final Set<PosixFilePermission> FILE_MODE = PosixFilePermissions.fromString("rw-------");

    record Stamp(Object key, long size, Object changed, boolean directory) {}

    private SourceFiles() {}

    static Path root(String value, boolean privateRoot) throws IOException {
        Path path;
        try {
            path = Path.of(value);
        } catch (RuntimeException error) {
            throw failure("SOURCE_UNSAFE_PATH");
        }
        if (!path.isAbsolute()
                || !path.normalize().equals(path)
                || !SourceAccess.windows() && !path.equals(path.toRealPath())) throw failure("SOURCE_UNSAFE_PATH");
        directory(path);
        if (!SourceAccess.windows()
                && privateRoot
                && !Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS)
                        .equals(DIRECTORY_MODE)) throw failure("SOURCE_UNSAFE_PATH");
        return path;
    }

    static BasicFileAttributes directory(Path path) throws IOException {
        BasicFileAttributes attrs = SourceAccess.attributes(path, true);
        if (!attrs.isDirectory() || attrs.isSymbolicLink() || attrs.fileKey() == null)
            throw failure("SOURCE_UNSAFE_PATH");
        return attrs;
    }

    static Map<Path, Stamp> inspect(Path git, Budget budget) throws IOException {
        directory(git);
        directory(git.resolve("objects"));
        for (String forbidden : new String[] {
            "objects/info/alternates", "objects/info/http-alternates", "commondir", "gitdir", "shallow", "info/grafts"
        }) {
            if (SourceAccess.exists(git.resolve(forbidden), false)) throw failure("SOURCE_UNSAFE_PATH");
        }
        Map<Path, Stamp> stamps = new HashMap<>();
        long[] bytes = {0};
        SourceAccess.walk(git, 65, new SimpleFileVisitor<>() {
            private void check(Path path, BasicFileAttributes attrs) throws IOException {
                budget.check();
                if (stamps.size() >= MAX_OBJECTS * 3
                        || git.relativize(path).getNameCount() > 64
                        || attrs.isSymbolicLink()
                        || (!attrs.isDirectory() && !attrs.isRegularFile())
                        || attrs.fileKey() == null) throw failure("SOURCE_UNSAFE_PATH");
                if (attrs.isRegularFile()) {
                    singleLink(path);
                    bytes[0] = Math.addExact(bytes[0], attrs.size());
                    if (bytes[0] > MAX_TOTAL) throw failure("SOURCE_LIMIT");
                }
                stamps.put(
                        git.relativize(path),
                        new Stamp(
                                attrs.fileKey(),
                                attrs.size(),
                                attrs instanceof WindowsStorage.State state ? state.token() : attrs.lastModifiedTime(),
                                attrs.isDirectory()));
            }

            @Override
            public FileVisitResult preVisitDirectory(Path path, BasicFileAttributes attrs) throws IOException {
                check(path, attrs);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path path, BasicFileAttributes attrs) throws IOException {
                if (attrs.isDirectory()) throw failure("SOURCE_LIMIT");
                check(path, attrs);
                return FileVisitResult.CONTINUE;
            }
        });
        return stamps;
    }

    static void singleLink(Path path) throws IOException {
        if (SourceAccess.links(path) != 1) throw failure("SOURCE_UNSAFE_PATH");
    }

    static void mkdir(Path path) throws IOException {
        SourceAccess.mkdir(path);
    }

    static void fresh(Path path, byte[] bytes) throws IOException {
        if (SourceAccess.windows()) SourceAccess.fresh(path, bytes);
        else
            try (FileChannel channel = FileChannel.open(
                    path,
                    Set.of(StandardOpenOption.WRITE, StandardOpenOption.CREATE_NEW, LinkOption.NOFOLLOW_LINKS),
                    PosixFilePermissions.asFileAttribute(FILE_MODE))) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) channel.write(buffer);
                channel.force(true);
            }
    }

    static void syncDirectory(Path path) throws IOException {
        directory(path);
        if (!SourceAccess.windows())
            try (FileChannel channel = FileChannel.open(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
                channel.force(true);
            }
    }

    static void finish(Path root, Object rootKey, Budget budget) throws IOException {
        if (!rootKey.equals(directory(root).fileKey())) throw failure("SOURCE_UNSAFE_PATH");
        SourceAccess.walk(root, 65, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path path, BasicFileAttributes attrs) throws IOException {
                budget.check();
                directory(path);
                if (!SourceAccess.windows()) Files.setPosixFilePermissions(path, DIRECTORY_MODE);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path path, BasicFileAttributes attrs) throws IOException {
                budget.check();
                if (!attrs.isRegularFile() || attrs.isSymbolicLink()) throw failure("SOURCE_UNSAFE_PATH");
                singleLink(path);
                if (SourceAccess.windows()) {
                    WindowsStorage storage = SourceAccess.storage(path);
                    storage.sync(path, storage.stat(path, false, false));
                } else {
                    Files.setPosixFilePermissions(path, FILE_MODE);
                    try (FileChannel channel =
                            FileChannel.open(path, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                        channel.force(true);
                    }
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path path, IOException error) throws IOException {
                if (error != null) throw error;
                syncDirectory(path);
                return FileVisitResult.CONTINUE;
            }
        });
        syncDirectory(root.getParent());
        if (!rootKey.equals(directory(root).fileKey())) throw failure("SOURCE_UNSAFE_PATH");
    }

    static void removeOwned(Path root, Object rootKey) throws IOException {
        if (!rootKey.equals(directory(root).fileKey())) throw failure("SOURCE_UNSAFE_PATH");
        Map<Path, Object> directoryProofs = new HashMap<>();
        SourceAccess.walk(root, 65, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path path, BasicFileAttributes attrs) {
                directoryProofs.put(path, SourceAccess.proof(attrs));
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path path, BasicFileAttributes attrs) throws IOException {
                SourceAccess.remove(path, false, SourceAccess.proof(attrs));
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path path, IOException error) throws IOException {
                if (error != null) throw error;
                SourceAccess.remove(path, true, directoryProofs.get(path));
                return FileVisitResult.CONTINUE;
            }
        });
        syncDirectory(root.getParent());
    }
}
