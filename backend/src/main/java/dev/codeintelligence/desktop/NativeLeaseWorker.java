package dev.codeintelligence.desktop;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Set;

/** Main-only OS lease. It never opens keys, the journal, PG, or application data. */
public final class NativeLeaseWorker {
    private static final String FLAG = "--ci-desktop-lease";
    private static final LinkOption NOFOLLOW = LinkOption.NOFOLLOW_LINKS;

    private NativeLeaseWorker() {}

    public static boolean requested(String[] args) {
        return Arrays.stream(args).anyMatch(arg -> arg.startsWith(FLAG));
    }

    // Also permits a tiny standalone synthetic test JAR, without Spring or Gradle.
    public static void main(String[] args) {
        int result = run(args, System.in, System.out);
        if (result != 0) System.exit(result);
    }

    public static int run(String[] args, InputStream input, OutputStream output) {
        if (args.length != 1 || !FLAG.equals(args[0])) return 2;
        try {
            String first = line(input);
            if (first == null) return 2;
            String[] parts = first.split("\t", -1);
            if (parts.length != 5
                    || !parts[0].equals("ACQUIRE")
                    || !parts[1].matches("[A-Za-z0-9_-]{1,5462}")
                    || !parts[2].matches("[A-Za-z0-9_-]{1,128}")
                    || !Set.of("purpose-keyring", "ai-journal", "source-vault").contains(parts[3])
                    || !parts[4].matches("[a-f0-9]{32}")) return 2;
            byte[] rootBytes = Base64.getUrlDecoder().decode(parts[1]);
            String rootText = new String(rootBytes, StandardCharsets.UTF_8);
            if (!Arrays.equals(rootBytes, rootText.getBytes(StandardCharsets.UTF_8))
                    || !Base64.getUrlEncoder()
                            .withoutPadding()
                            .encodeToString(rootBytes)
                            .equals(parts[1])) return 2;
            Path root = Path.of(rootText);
            if (!root.isAbsolute() || !root.normalize().equals(root) || root.getParent() == null) return 2;
            BasicFileAttributes rootStat = directory(root);
            Path directory = root.resolve(parts[3]);
            BasicFileAttributes directoryStat = directory(directory);
            Path file = directory.resolve(parts[3].equals("ai-journal") ? "writer.lock" : "owner.lock");
            String identity = HexFormat.of()
                    .formatHex(
                            MessageDigest.getInstance("SHA-256").digest(parts[2].getBytes(StandardCharsets.US_ASCII)));
            byte[] marker =
                    ("CI-NATIVE-OWNER-2\n" + identity + "\n" + parts[3] + "\n").getBytes(StandardCharsets.US_ASCII);
            boolean created = false;
            FileChannel opened;
            try {
                opened = FileChannel.open(
                        file,
                        Set.of(
                                StandardOpenOption.CREATE_NEW,
                                StandardOpenOption.READ,
                                StandardOpenOption.WRITE,
                                NOFOLLOW),
                        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                created = true;
            } catch (FileAlreadyExistsException existing) {
                regular(file);
                opened = FileChannel.open(file, StandardOpenOption.READ, StandardOpenOption.WRITE, NOFOLLOW);
            }
            // Never truncate, unlink, replace, or repair an existing marker, even after a crash.
            try (FileChannel channel = opened) {
                BasicFileAttributes fileStat = regular(file);
                FileLock acquired = channel.tryLock();
                if (acquired == null) return 3;
                try (FileLock lock = acquired) {
                    if (created) {
                        ByteBuffer bytes = ByteBuffer.wrap(marker);
                        while (bytes.hasRemaining()) channel.write(bytes);
                        channel.force(true);
                    }
                    // Also completes directory durability after a creator died following file fsync.
                    try (FileChannel parent = FileChannel.open(directory, StandardOpenOption.READ, NOFOLLOW)) {
                        parent.force(true);
                    }
                    held(root, rootStat, directory, directoryStat, file, fileStat, channel, lock, marker);
                    send(output, "READY\t" + parts[4]);
                    long previous = 0;
                    for (; ; ) {
                        String command = line(input);
                        // The pipe is the parent lifeline. Main SIGKILL closes it even without cleanup.
                        if (command == null) return 0;
                        String[] request = command.split("\t", -1);
                        if (request.length != 2 || !request[1].matches("[1-9][0-9]{0,14}")) return 2;
                        long sequence = Long.parseLong(request[1]);
                        if (sequence != previous + 1) return 2;
                        previous = sequence;
                        held(root, rootStat, directory, directoryStat, file, fileStat, channel, lock, marker);
                        if (request[0].equals("CHECK")) send(output, "HELD\t" + sequence);
                        else if (request[0].equals("RELEASE")) {
                            lock.release();
                            send(output, "RELEASED\t" + sequence);
                            return 0;
                        } else return 2;
                    }
                }
            }
        } catch (Exception failure) {
            // No paths, credentials, marker material, or exception text on either channel.
            return 3;
        }
    }

    private static String line(InputStream input) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (; ; ) {
            int value = input.read();
            if (value == -1) {
                if (bytes.size() == 0) return null;
                throw new IllegalStateException();
            }
            if (value == '\n') return bytes.toString(StandardCharsets.US_ASCII);
            if (value < 0x20 && value != '\t' || value > 0x7e || bytes.size() >= 8192)
                throw new IllegalStateException();
            bytes.write(value);
        }
    }

    private static void send(OutputStream output, String value) throws Exception {
        output.write((value + "\n").getBytes(StandardCharsets.US_ASCII));
        output.flush();
    }

    private static BasicFileAttributes directory(Path directory) throws Exception {
        if (!directory.equals(directory.toRealPath())) throw new IllegalStateException();
        Path part = directory.getRoot();
        for (Path component : directory) {
            part = part.resolve(component);
            if (!Files.isDirectory(part, NOFOLLOW)) throw new IllegalStateException();
        }
        BasicFileAttributes attributes = Files.readAttributes(directory, BasicFileAttributes.class, NOFOLLOW);
        privateMode(directory, "rwx------");
        if (!attributes.isDirectory() || attributes.fileKey() == null) throw new IllegalStateException();
        return attributes;
    }

    private static void privateMode(Path file, String expected) throws Exception {
        if (!Files.getPosixFilePermissions(file, NOFOLLOW).equals(PosixFilePermissions.fromString(expected))
                || (((Number) Files.getAttribute(file, "unix:mode", NOFOLLOW)).intValue() & 07000) != 0
                || !Files.getOwner(file, NOFOLLOW)
                        .equals(file.getFileSystem()
                                .getUserPrincipalLookupService()
                                .lookupPrincipalByName(System.getProperty("user.name"))))
            throw new IllegalStateException();
    }

    private static BasicFileAttributes regular(Path file) throws Exception {
        BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, NOFOLLOW);
        privateMode(file, "rw-------");
        if (!attributes.isRegularFile()
                || attributes.fileKey() == null
                || ((Number) Files.getAttribute(file, "unix:nlink", NOFOLLOW)).longValue() != 1
                || attributes.size() > 256) throw new IllegalStateException();
        return attributes;
    }

    private static void held(
            Path root,
            BasicFileAttributes rootStat,
            Path directory,
            BasicFileAttributes directoryStat,
            Path file,
            BasicFileAttributes fileStat,
            FileChannel channel,
            FileLock lock,
            byte[] marker)
            throws Exception {
        if (!lock.isValid()
                || !channel.isOpen()
                || !rootStat.fileKey().equals(directory(root).fileKey())
                || !directoryStat.fileKey().equals(directory(directory).fileKey())
                || !fileStat.fileKey().equals(regular(file).fileKey())
                || channel.size() != marker.length) throw new IllegalStateException();
        ByteBuffer bytes = ByteBuffer.allocate(marker.length + 1);
        long offset = 0;
        for (; ; ) {
            int count = channel.read(bytes, offset);
            if (count < 0 || !bytes.hasRemaining()) break;
            if (count == 0) throw new IllegalStateException();
            offset += count;
        }
        if (bytes.position() != marker.length
                || !Arrays.equals(Arrays.copyOf(bytes.array(), marker.length), marker)
                || !fileStat.fileKey().equals(regular(file).fileKey())) throw new IllegalStateException();
    }
}
