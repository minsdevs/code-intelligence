package dev.codeintelligence.common;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;
import java.util.concurrent.*;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Retained-root client of the runtime-verified Windows boundary. No Java ACL emulation. */
public final class WindowsStorage implements AutoCloseable {
    private static final int CHUNK = 1024 * 1024;
    private static final JsonFactory FACTORY = JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build();
    private static final JsonMapper JSON = JsonMapper.builder(FACTORY).build();
    private static final ScheduledExecutorService DEADLINES = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "windows-storage-deadlines");
        thread.setDaemon(true);
        return thread;
    });
    private final Path root;
    private final boolean inheritChildren;
    private final Process process;
    private final DataInputStream input;
    private final DataOutputStream output;
    private volatile boolean failed;
    private boolean closed;
    private int sequence;
    public final State rootState;

    public static boolean enabled() {
        return System.getProperty("os.name", "").startsWith("Windows");
    }

    public WindowsStorage(Path root, String mode) throws IOException {
        if (!enabled()
                || !Set.of("source", "private", "workspace").contains(mode)
                || !root.isAbsolute()
                || !root.normalize().equals(root)) throw refused();
        String configured = System.getProperty("codeintelligence.windows.runtimeRoot");
        if (configured == null || configured.isBlank()) throw refused();
        Path runtime = Path.of(configured);
        if (!runtime.isAbsolute() || !runtime.normalize().equals(runtime)) throw refused();
        this.root = root;
        inheritChildren = mode.equals("workspace");
        ProcessBuilder builder = new ProcessBuilder(
                runtime.resolve("native")
                        .resolve("windows")
                        .resolve("codeintel-boundary.exe")
                        .toString(),
                "storage");
        builder.environment().remove("NODE_OPTIONS");
        process = builder.start();
        input = new DataInputStream(process.getInputStream());
        output = new DataOutputStream(process.getOutputStream());
        Thread.ofVirtual().start(() -> {
            try {
                if (process.getErrorStream().read() != -1) poison();
            } catch (IOException error) {
                if (!closed) poison();
            }
        });
        try {
            rootState = state(exchange(null, out -> {
                        field(out, root.toString());
                        field(out, mode);
                    })
                    .get("state"));
        } catch (IOException | RuntimeException error) {
            poison();
            throw refused();
        }
        if (rootState == null || !rootState.directory()) {
            poison();
            throw refused();
        }
    }

    public record State(
            String volume,
            String fileId,
            String owner,
            long size,
            long allocationSize,
            String modified,
            String changed,
            String identity,
            String token,
            boolean directory)
            implements BasicFileAttributes {
        public FileTime lastModifiedTime() {
            return FileTime.from((Long.parseLong(modified) - 116444736000000000L) / 10, TimeUnit.MICROSECONDS);
        }

        public FileTime lastAccessTime() {
            throw new UnsupportedOperationException("Native protocol does not expose access time");
        }

        public FileTime creationTime() {
            throw new UnsupportedOperationException("Native protocol does not expose creation time");
        }

        public boolean isRegularFile() {
            return !directory;
        }

        public boolean isDirectory() {
            return directory;
        }

        public boolean isSymbolicLink() {
            return false;
        }

        public boolean isOther() {
            return false;
        }

        public Object fileKey() {
            return identity;
        }
    }

    private static State state(JsonNode value) throws IOException {
        if (value != null && value.isNull()) return null;
        if (value == null
                || !value.isObject()
                || value.size() != 12
                || value.path("format").asInt() != 1
                || !"win32".equals(value.path("platform").asString())) throw refused();
        String volume = text(value, "volume"), fileId = text(value, "fileId"), owner = text(value, "owner");
        String size = text(value, "size"), allocation = text(value, "allocationSize");
        String modified = text(value, "modified"), changed = text(value, "changed");
        String identity = text(value, "identity"), token = text(value, "token"), kind = text(value, "kind");
        if (!volume.matches("[0-9]+")
                || !fileId.matches("[0-9]+:[0-9]+")
                || !owner.matches("S-1-(?:[0-9]+-)*[0-9]+")
                || !size.matches("0|[1-9][0-9]*")
                || !allocation.matches("0|[1-9][0-9]*")
                || !modified.matches("0|[1-9][0-9]*")
                || !changed.matches("0|[1-9][0-9]*")
                || !identity.equals("WI1:" + volume + ":" + fileId)
                || !token.equals(
                        "WS1:" + volume + ":" + fileId + ":" + size + ":" + allocation + ":" + modified + ":" + changed)
                || !Set.of("file", "directory").contains(kind)) throw refused();
        try {
            long length = Long.parseLong(size), allocated = Long.parseLong(allocation);
            Long.parseLong(modified);
            Long.parseLong(changed);
            if (length > 9007199254740991L || allocated > 9007199254740991L) throw refused();
            return new State(
                    volume,
                    fileId,
                    owner,
                    length,
                    allocated,
                    modified,
                    changed,
                    identity,
                    token,
                    kind.equals("directory"));
        } catch (NumberFormatException error) {
            throw refused();
        }
    }

    private static String text(JsonNode node, String field) throws IOException {
        JsonNode value = node.get(field);
        if (value == null || !value.isTextual()) throw refused();
        return value.stringValue();
    }

    private String relative(Path path) throws IOException {
        if (!path.isAbsolute() || !path.normalize().equals(path) || !path.startsWith(root)) throw refused();
        return root.relativize(path).toString().replace('\\', '/');
    }

    public synchronized State stat(Path path, boolean directory, boolean missing) throws IOException {
        return state(exchange("stat", out -> {
                    field(out, relative(path));
                    out.writeInt(directory ? 1 : 0);
                    out.writeInt(missing ? 1 : 0);
                })
                .get("state"));
    }

    public synchronized State mkdir(Path path) throws IOException {
        return state(exchange("mkdir", out -> {
                    field(out, relative(path));
                    out.writeInt(inheritChildren ? 1 : 0);
                })
                .get("state"));
    }

    public synchronized byte[] read(Path path, State expected, long maximum) throws IOException {
        JsonNode opened = open(path, "read", expected == null ? "" : expected.token(), maximum);
        int handle = handle(opened);
        State before = state(opened.get("state"));
        if (before == null || before.size() > Integer.MAX_VALUE || before.size() > maximum) {
            poison();
            throw refused();
        }
        byte[] bytes = new byte[(int) before.size()];
        try {
            int offset = 0;
            while (offset < bytes.length) {
                final int position = offset, length = Math.min(CHUNK, bytes.length - offset);
                JsonNode reply = exchange(
                        "read",
                        out -> {
                            out.writeInt(handle);
                            field(out, Integer.toString(position));
                            out.writeInt(length);
                        },
                        bytes,
                        position);
                int count = reply.get("bytes").intValue();
                if (count == 0 || count > length) throw refused();
                offset += count;
            }
            JsonNode eof = exchange(
                    "read",
                    out -> {
                        out.writeInt(handle);
                        field(out, Integer.toString(bytes.length));
                        out.writeInt(1);
                    },
                    bytes,
                    bytes.length);
            if (eof.get("bytes").intValue() != 0) throw refused();
            release(handle);
            return bytes;
        } catch (IOException | RuntimeException error) {
            Arrays.fill(bytes, (byte) 0);
            poison();
            throw refused();
        }
    }

    public synchronized void fresh(Path path, byte[] bytes) throws IOException {
        int handle = handle(open(path, "create", "", bytes.length));
        for (int offset = 0; offset < bytes.length; offset += CHUNK) {
            final int start = offset, length = Math.min(CHUNK, bytes.length - offset);
            exchange("write", out -> {
                out.writeInt(handle);
                out.writeInt(length);
                out.write(bytes, start, length);
            });
        }
        State committed = state(exchange("commit", out -> out.writeInt(handle)).get("state"));
        if (committed == null || committed.size() != bytes.length) {
            poison();
            throw refused();
        }
    }

    public record Entry(Path path, boolean directory) {}

    public synchronized State sync(Path path, State expected) throws IOException {
        JsonNode opened = open(path, "append", expected.token(), expected.size());
        int handle = handle(opened);
        State result = state(exchange("commit", out -> out.writeInt(handle)).get("state"));
        if (result == null
                || result.size() != expected.size()
                || !result.identity().equals(expected.identity())) throw refused();
        return result;
    }

    public synchronized List<Entry> entries(Path path) throws IOException {
        int handle = handle(open(path, "directory", "", 9007199254740991L));
        List<Entry> result = new ArrayList<>();
        try {
            for (; ; ) {
                JsonNode reply = exchange("next", out -> out.writeInt(handle));
                JsonNode entries = reply.get("entries");
                if (entries == null
                        || !entries.isArray()
                        || entries.size() > 1024
                        || !reply.path("end").isBoolean()) throw refused();
                for (JsonNode item : entries) {
                    String name = text(item, "name");
                    if (item.size() != 2
                            || name.isEmpty()
                            || name.equals(".")
                            || name.equals("..")
                            || name.indexOf('/') >= 0
                            || name.indexOf('\\') >= 0
                            || name.indexOf('\0') >= 0
                            || !item.path("directory").isBoolean()
                            || result.size() >= 400_000) throw refused();
                    result.add(
                            new Entry(path.resolve(name), item.get("directory").booleanValue()));
                }
                if (reply.get("end").booleanValue()) break;
            }
            release(handle);
            return result;
        } catch (IOException | RuntimeException error) {
            poison();
            throw refused();
        }
    }

    public synchronized void removeExpected(Path path, boolean directory, String expected) throws IOException {
        exchange("remove", out -> {
            field(out, relative(path));
            out.writeInt(directory ? 1 : 0);
            field(out, expected);
        });
    }

    public synchronized void rename(Path from, Path to, State expected) throws IOException {
        exchange("rename", out -> {
            field(out, relative(from));
            out.writeInt(expected.directory() ? 1 : 0);
            field(out, expected.directory() ? expected.identity() : expected.token());
            field(out, relative(to));
        });
    }

    private JsonNode open(Path path, String mode, String expected, long maximum) throws IOException {
        return exchange("open", out -> {
            field(out, relative(path));
            field(out, mode);
            field(out, expected);
            field(out, Long.toString(maximum));
        });
    }

    public final class Lock implements AutoCloseable {
        private final int handle;
        private State state;
        private boolean released;

        private Lock(int handle, State state) {
            this.handle = handle;
            this.state = state;
        }

        public State state() {
            return state;
        }

        public synchronized State check() throws IOException {
            if (released) throw refused();
            state = WindowsStorage.state(
                    exchange("check-lock", out -> out.writeInt(handle)).get("state"));
            return state;
        }

        @Override
        public synchronized void close() throws IOException {
            if (!released) {
                release(handle);
                released = true;
            }
        }
    }

    public synchronized Lock lock(Path path, byte[] stableMarker) throws IOException {
        if (stableMarker == null || stableMarker.length < 1 || stableMarker.length > 4096) throw refused();
        JsonNode reply = exchange("lock", out -> {
            field(out, relative(path));
            out.writeInt(stableMarker.length);
            out.write(stableMarker);
        });
        return new Lock(handle(reply), state(reply.get("state")));
    }

    private static int handle(JsonNode reply) throws IOException {
        JsonNode value = reply.get("handle");
        if (value == null
                || !value.isIntegralNumber()
                || value.longValue() < 1
                || value.longValue() > Integer.MAX_VALUE) throw refused();
        return value.intValue();
    }

    private void release(int handle) throws IOException {
        exchange("release", out -> out.writeInt(handle));
    }

    @FunctionalInterface
    private interface Request {
        void write(DataOutputStream output) throws IOException;
    }

    private JsonNode exchange(String operation, Request request) throws IOException {
        return exchange(operation, request, null, 0);
    }

    private JsonNode exchange(String operation, Request request, byte[] destination, int destinationOffset)
            throws IOException {
        if (failed || closed || Thread.currentThread().isInterrupted()) throw refused();
        ScheduledFuture<?> timer = DEADLINES.schedule(this::poison, 15, TimeUnit.SECONDS);
        try {
            if (operation != null) {
                if (sequence == Integer.MAX_VALUE) throw refused();
                field(output, operation);
                output.writeInt(++sequence);
            }
            request.write(output);
            output.flush();
            int length = input.readInt();
            if (length < 1 || length > 256 * 1024) throw refused();
            byte[] bytes = input.readNBytes(length);
            if (bytes.length != length) throw refused();
            String json = StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
            JsonNode reply;
            try (var parser = FACTORY.createParser(json)) {
                reply = JSON.readTree(parser);
                if (parser.nextToken() != null) throw refused();
            }
            if (reply == null
                    || !reply.isObject()
                    || !reply.path("seq").isIntegralNumber()
                    || reply.get("seq").longValue() != sequence) throw refused();
            int count = 0;
            if (reply.has("bytes")) {
                if (!reply.get("bytes").isIntegralNumber()
                        || reply.get("bytes").longValue() < 0
                        || reply.get("bytes").longValue() > CHUNK) throw refused();
                count = reply.get("bytes").intValue();
            }
            if (count != 0
                    && (destination == null || destinationOffset < 0 || count > destination.length - destinationOffset))
                throw refused();
            if (count != 0) input.readFully(destination, destinationOffset, count);
            if (failed) throw refused();
            return reply;
        } catch (IOException | RuntimeException error) {
            poison();
            throw refused();
        } finally {
            timer.cancel(false);
        }
    }

    private static void field(DataOutputStream out, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 16384 || !new String(bytes, StandardCharsets.UTF_8).equals(value)) throw refused();
        out.writeInt(bytes.length);
        out.write(bytes);
    }

    private void poison() {
        failed = true;
        process.destroyForcibly();
    }

    @Override
    public synchronized void close() throws IOException {
        if (closed) {
            if (failed) throw refused();
            return;
        }
        try {
            exchange("close", out -> {});
            output.close();
            if (!process.waitFor(15, TimeUnit.SECONDS) || process.exitValue() != 0 || input.read() != -1 || failed)
                throw refused();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            poison();
            throw refused();
        } catch (IOException | RuntimeException error) {
            poison();
            throw refused();
        } finally {
            closed = true;
            input.close();
        }
    }

    private static IOException refused() {
        return new IOException("Windows protected source storage refused the operation.");
    }
}
