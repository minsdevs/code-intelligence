package dev.codeintelligence.common;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;

/** Explicit operation scopes retain native roots; source scopes never confer private-workspace authority. */
public final class SourceAccess {
    private static final ThreadLocal<Deque<Scope>> SCOPES = ThreadLocal.withInitial(ArrayDeque::new);
    private static final Set<PosixFilePermission> DIRECTORY_MODE = PosixFilePermissions.fromString("rwx------");

    private SourceAccess() {}

    public record Identity(String platform, String identity, String owner) {}

    public static final class Scope implements AutoCloseable {
        private final Path root;
        private final WindowsStorage storage;
        private final boolean ownsStorage;
        private boolean closed;

        private Scope(Path root, String mode) throws IOException {
            this.root = root.toAbsolutePath().normalize();
            storage = WindowsStorage.enabled() ? new WindowsStorage(this.root, mode) : null;
            ownsStorage = storage != null;
            SCOPES.get().push(this);
        }

        private Scope(Path root, WindowsStorage storage) {
            this.root = root.toAbsolutePath().normalize();
            this.storage = Objects.requireNonNull(storage);
            ownsStorage = false;
            SCOPES.get().push(this);
        }

        @Override
        public void close() throws IOException {
            if (closed) return;
            if (SCOPES.get().peek() != this) throw new IOException("Source scope closure out of order");
            SCOPES.get().pop();
            if (SCOPES.get().isEmpty()) SCOPES.remove();
            closed = true;
            if (ownsStorage) storage.close();
        }
    }

    public static Scope open(Path root, String mode) throws IOException {
        return new Scope(root, mode);
    }

    public static Scope attach(Path root, WindowsStorage storage) {
        return new Scope(root, storage);
    }

    public static boolean windows() {
        return WindowsStorage.enabled();
    }

    private static Scope scope(Path path) throws IOException {
        Path absolute = path.toAbsolutePath().normalize();
        for (Scope scope : SCOPES.get()) if (scope.storage != null && absolute.startsWith(scope.root)) return scope;
        throw new IOException("No retained native source scope");
    }

    public static WindowsStorage storage(Path path) throws IOException {
        return scope(path).storage;
    }

    public static Identity identity(Path root) throws IOException {
        if (windows()) {
            WindowsStorage.State state = storage(root).stat(root, true, false);
            return new Identity("win32", state.identity(), state.owner());
        }
        Map<String, Object> attributes = Files.readAttributes(root, "unix:dev,ino", LinkOption.NOFOLLOW_LINKS);
        // V22 approvals did not bind ownership. Preserve those approvals rather than inventing an owner.
        return new Identity("posix", "PI1:" + attributes.get("dev") + ":" + attributes.get("ino"), null);
    }

    public static String volume(Path path, boolean directory) throws IOException {
        if (windows()) return storage(path).stat(path, directory, false).volume();
        return Files.getAttribute(path, "unix:dev", LinkOption.NOFOLLOW_LINKS).toString();
    }

    public static BasicFileAttributes attributes(Path path, boolean directory) throws IOException {
        return windows()
                ? storage(path).stat(path, directory, false)
                : Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    }

    public static Object proof(BasicFileAttributes attributes) {
        return attributes instanceof WindowsStorage.State state
                ? (state.directory() ? state.identity() : state.token())
                : attributes.fileKey();
    }

    public static long links(Path path) throws IOException {
        if (windows()) {
            storage(path).stat(path, false, false);
            return 1;
        } // Native stat refuses multiple links.
        return ((Number) Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS)).longValue();
    }

    public static boolean exists(Path path, boolean directory) throws IOException {
        if (!windows()) return Files.exists(path, LinkOption.NOFOLLOW_LINKS);
        Scope scope = scope(path);
        Path parent = path.getParent();
        if (!path.equals(scope.root) && parent != null && !exists(parent, true)) return false;
        return scope.storage.stat(path, directory, true) != null;
    }

    public static InputStream input(Path path, long maximum) throws IOException {
        return windows()
                ? new ByteArrayInputStream(storage(path).read(path, null, maximum))
                : Files.newInputStream(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
    }

    public static void mkdir(Path path) throws IOException {
        if (windows()) storage(path).mkdir(path);
        else Files.createDirectory(path, PosixFilePermissions.asFileAttribute(DIRECTORY_MODE));
    }

    public static void directories(Path path) throws IOException {
        if (!windows()) {
            Files.createDirectories(path);
            return;
        }
        List<Path> missing = new ArrayList<>();
        Path current = path;
        while (!exists(current, true)) {
            missing.add(current);
            current = current.getParent();
            if (current == null) throw new IOException("Source root missing");
        }
        for (int i = missing.size() - 1; i >= 0; i--) mkdir(missing.get(i));
    }

    public static void fresh(Path path, byte[] bytes) throws IOException {
        if (windows()) storage(path).fresh(path, bytes);
        else Files.write(path, bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
    }

    public static List<Path> entries(Path path) throws IOException {
        if (windows())
            return storage(path).entries(path).stream()
                    .map(WindowsStorage.Entry::path)
                    .toList();
        try (var children = Files.newDirectoryStream(path)) {
            List<Path> result = new ArrayList<>();
            children.forEach(result::add);
            return result;
        }
    }

    public static void remove(Path path, boolean directory, Object expected) throws IOException {
        if (windows()) storage(path).removeExpected(path, directory, expected.toString());
        else Files.delete(path);
    }

    public static void move(Path from, Path to) throws IOException {
        WindowsStorage session = storage(from);
        session.rename(from, to, session.stat(from, true, false));
    }

    public static void walk(Path root, int depth, FileVisitor<Path> visitor) throws IOException {
        if (!windows()) {
            Files.walkFileTree(root, Set.of(), depth, visitor);
            return;
        }
        walkNative(root, depth, visitor, storage(root));
    }

    private static FileVisitResult walkNative(Path path, int depth, FileVisitor<Path> visitor, WindowsStorage session)
            throws IOException {
        WindowsStorage.State state = session.stat(path, true, false);
        if (depth == 0) return visitor.visitFile(path, state);
        FileVisitResult before = visitor.preVisitDirectory(path, state);
        if (before == FileVisitResult.TERMINATE || before == FileVisitResult.SKIP_SIBLINGS) return before;
        if (before == FileVisitResult.SKIP_SUBTREE) return FileVisitResult.CONTINUE;
        for (WindowsStorage.Entry child : session.entries(path)) {
            FileVisitResult result = child.directory()
                    ? walkNative(child.path(), depth - 1, visitor, session)
                    : visitor.visitFile(child.path(), session.stat(child.path(), false, false));
            if (result == FileVisitResult.TERMINATE) return result;
            if (result == FileVisitResult.SKIP_SIBLINGS) break;
        }
        return visitor.postVisitDirectory(path, null);
    }
}
