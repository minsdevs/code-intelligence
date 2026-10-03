package dev.codeintelligence.desktop;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Main-only child owner. EOF closes the lifetime lease; a STOP never means killing this helper.
 * ProcessHandle observations cover ordinary managed-service trees, not hostile double-fork
 * daemonization between observations. Killing this helper with SIGKILL bypasses its cleanup.
 */
public final class ManagedProcessWorker {
    public static final String FLAG = "--ci-managed-process";
    private static final int MAX_FRAME = 256 * 1024;
    private static final int MAX_BOOTSTRAP = 16 * 1024;
    private static final int MAX_HANDLES = 4096;
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .streamReadConstraints(StreamReadConstraints.builder()
                            .maxDocumentLength(MAX_FRAME)
                            .maxNestingDepth(4)
                            .maxTokenCount(4096)
                            .maxNameLength(128)
                            .maxStringLength(64 * 1024)
                            .maxNumberLength(20)
                            .build())
                    .build())
            .build();

    private ManagedProcessWorker() {}

    public static boolean requested(String[] args) {
        return Arrays.stream(args).anyMatch(value -> value.startsWith(FLAG));
    }

    /** Also permits an isolated synthetic JVM probe without starting Spring. */
    public static void main(String[] args) {
        System.exit(run(args, System.in, System.out));
    }

    public static int run(String[] args, InputStream input, OutputStream output) {
        Guardian guardian = null;
        try {
            if (args.length != 1 || !FLAG.equals(args[0])) throw new Invalid();
            Spec spec = spec(read(new DataInputStream(input), MAX_FRAME));
            guardian = new Guardian(spec, input, output);
            return guardian.run();
        } catch (Exception error) {
            if (guardian != null && guardian.child != null) {
                guardian.stop.accumulateAndGet(2, Math::max);
                guardian.cleanup();
            }
            safeWrite(output, Map.of("version", 1, "kind", "ERROR", "code", "START_FAILED"));
            return 2;
        }
    }

    private record Spec(
            String command, List<String> args, Path cwd, Map<String, String> env, Path log, byte[] bootstrap) {}

    private static Spec spec(JsonNode value) throws Exception {
        exact(value, Set.of("version", "kind", "command", "args", "cwd", "env", "logPath", "bootstrap"));
        if (!integer(value.get("version"), 1) || !"START".equals(text(value.get("kind"), 16))) throw new Invalid();
        String command = absolute(value.get("command")).toString();
        Path cwd = absolute(value.get("cwd"));
        Path log = absolute(value.get("logPath"));
        if (!Files.isExecutable(Path.of(command))
                || !Files.isRegularFile(Path.of(command))
                || !Files.isDirectory(cwd)
                || !Files.isDirectory(log.getParent(), LinkOption.NOFOLLOW_LINKS)
                || Files.isSymbolicLink(log)) throw new Invalid();
        JsonNode arguments = value.get("args");
        if (!arguments.isArray() || arguments.size() > 128) throw new Invalid();
        List<String> args = new ArrayList<>();
        for (JsonNode arg : arguments) args.add(text(arg, 8192));
        JsonNode environment = value.get("env");
        if (!environment.isObject() || environment.size() > 128) throw new Invalid();
        Map<String, String> env = new LinkedHashMap<>();
        for (var entry : environment.properties()) {
            if (!entry.getKey().matches("[A-Za-z_][A-Za-z0-9_]{0,127}")) throw new Invalid();
            env.put(entry.getKey(), text(entry.getValue(), 32 * 1024));
        }
        String encoded = text(value.get("bootstrap"), 4 * ((MAX_BOOTSTRAP + 2) / 3));
        byte[] bootstrap;
        try {
            bootstrap = Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException error) {
            throw new Invalid();
        }
        if (bootstrap.length > MAX_BOOTSTRAP
                || !Base64.getEncoder().encodeToString(bootstrap).equals(encoded)) throw new Invalid();
        return new Spec(command, List.copyOf(args), cwd, Map.copyOf(env), log, bootstrap);
    }

    private static final class Guardian {
        private final Spec spec;
        private final InputStream input;
        private final OutputStream output;
        private final AtomicInteger stop = new AtomicInteger();
        private final Map<Long, ProcessHandle> owned = new LinkedHashMap<>();
        private final CountDownLatch finished = new CountDownLatch(1);
        private final CountDownLatch drained = new CountDownLatch(2);
        private Process child;
        private OutputStream log;
        private boolean unverified;
        private boolean warned;
        private long stoppingAt;

        Guardian(Spec spec, InputStream input, OutputStream output) {
            this.spec = spec;
            this.input = input;
            this.output = output;
        }

        int run() throws Exception {
            try {
                var channel = FileChannel.open(
                        spec.log(),
                        Set.of(
                                StandardOpenOption.CREATE,
                                StandardOpenOption.WRITE,
                                StandardOpenOption.APPEND,
                                LinkOption.NOFOLLOW_LINKS),
                        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                log = Channels.newOutputStream(channel);
                List<String> command = new ArrayList<>();
                command.add(spec.command());
                command.addAll(spec.args());
                ProcessBuilder builder =
                        new ProcessBuilder(command).directory(spec.cwd().toFile());
                builder.environment().clear();
                builder.environment().putAll(spec.env());
                child = builder.start();
                owned.put(child.pid(), child.toHandle());
                Runtime.getRuntime().addShutdownHook(Thread.ofPlatform().unstarted(() -> {
                    stop.accumulateAndGet(1, Math::max);
                    boolean interrupted = false;
                    while (true) {
                        try {
                            finished.await();
                            break;
                        } catch (InterruptedException error) {
                            interrupted = true;
                        }
                    }
                    if (interrupted) Thread.currentThread().interrupt();
                }));
                Thread.ofVirtual().start(this::control);
                Thread.ofVirtual().start(this::bootstrap);
                Thread.ofVirtual().start(() -> drain(child.getInputStream()));
                Thread.ofVirtual().start(() -> drain(child.getErrorStream()));
                Map<String, Object> started = new LinkedHashMap<>();
                started.put("version", 1);
                started.put("kind", "STARTED");
                started.put("pid", Long.toString(child.pid()));
                started.put(
                        "startedAt",
                        child.info().startInstant().map(Instant::toString).orElse(null));
                if (!safeWrite(output, started)) stop.accumulateAndGet(1, Math::max);
                cleanup();
                int code = child.waitFor();
                drained.await(2, TimeUnit.SECONDS);
                closeStreams();
                safeWrite(
                        output,
                        Map.of(
                                "version",
                                1,
                                "kind",
                                "EXIT",
                                "pid",
                                Long.toString(child.pid()),
                                "exitCode",
                                code,
                                "stopped",
                                true));
                return 0;
            } finally {
                Arrays.fill(spec.bootstrap(), (byte) 0);
                if (child != null && (child.isAlive() || owned.values().stream().anyMatch(ProcessHandle::isAlive))) {
                    stop.accumulateAndGet(2, Math::max);
                    cleanup();
                }
                closeStreams();
                if (log != null)
                    try {
                        log.close();
                    } catch (Exception ignored) {
                        /* Fixed control output only. */
                    }
                finished.countDown();
            }
        }

        private void control() {
            try {
                DataInputStream source = new DataInputStream(input);
                int frames = 0;
                while (true) {
                    JsonNode command = read(source, 1024);
                    if (command == null) {
                        stop.accumulateAndGet(1, Math::max);
                        return;
                    }
                    if (++frames > 8) throw new Invalid();
                    exact(command, Set.of("version", "kind", "signal"));
                    String signal = text(command.get("signal"), 16);
                    if (!integer(command.get("version"), 1)
                            || !"STOP".equals(text(command.get("kind"), 16))
                            || !Set.of("SIGTERM", "SIGKILL").contains(signal)) throw new Invalid();
                    stop.accumulateAndGet(signal.equals("SIGKILL") ? 2 : 1, Math::max);
                }
            } catch (Exception error) {
                stop.accumulateAndGet(1, Math::max);
                safeWrite(output, Map.of("version", 1, "kind", "ERROR", "code", "CONTROL_INVALID"));
            }
        }

        private void bootstrap() {
            try (OutputStream target = child.getOutputStream()) {
                target.write(spec.bootstrap());
                target.flush();
            } catch (Exception error) {
                stop.accumulateAndGet(1, Math::max);
                safeWrite(output, Map.of("version", 1, "kind", "ERROR", "code", "BOOTSTRAP_FAILED"));
            } finally {
                Arrays.fill(spec.bootstrap(), (byte) 0);
            }
        }

        private void drain(InputStream source) {
            try (source) {
                byte[] bytes = new byte[8192];
                for (int count; (count = source.read(bytes)) >= 0; ) {
                    if (count > 0)
                        synchronized (log) {
                            log.write(bytes, 0, count);
                        }
                }
            } catch (Exception error) {
                if (child.isAlive()) stop.accumulateAndGet(1, Math::max);
            } finally {
                drained.countDown();
            }
        }

        /** No elapsed timeout is treated as exit proof; unsuccessful termination keeps ownership. */
        private void cleanup() {
            boolean interrupted = false;
            while (true) {
                observe();
                if (!child.isAlive()) stop.accumulateAndGet(1, Math::max);
                boolean alive = owned.values().stream().anyMatch(ProcessHandle::isAlive);
                if (!alive && !unverified) break;
                if (stop.get() != 0) {
                    if (stoppingAt == 0) stoppingAt = System.nanoTime();
                    boolean force = stop.get() == 2 || System.nanoTime() - stoppingAt >= TimeUnit.SECONDS.toNanos(2);
                    List<ProcessHandle> order = new ArrayList<>(owned.values());
                    java.util.Collections.reverse(order);
                    for (ProcessHandle process : order) {
                        if (!process.isAlive()) continue;
                        try {
                            if (force) process.destroyForcibly();
                            else process.destroy();
                        } catch (RuntimeException error) {
                            unverified = true;
                        }
                    }
                    if ((unverified || System.nanoTime() - stoppingAt >= TimeUnit.SECONDS.toNanos(10)) && !warned) {
                        warned = true;
                        safeWrite(output, Map.of("version", 1, "kind", "ERROR", "code", "STOP_UNVERIFIED"));
                    }
                }
                try {
                    Thread.sleep(20);
                } catch (InterruptedException error) {
                    interrupted = true;
                    stop.accumulateAndGet(2, Math::max);
                }
            }
            if (interrupted) Thread.currentThread().interrupt();
        }

        private void observe() {
            owned.entrySet()
                    .removeIf(entry ->
                            entry.getKey() != child.pid() && !entry.getValue().isAlive());
            for (ProcessHandle ancestor : new ArrayList<>(owned.values())) {
                try (var descendants = ancestor.descendants()) {
                    var iterator = descendants.iterator();
                    while (iterator.hasNext()) {
                        ProcessHandle descendant = iterator.next();
                        if (owned.containsKey(descendant.pid())) continue;
                        if (owned.size() >= MAX_HANDLES) {
                            unverified = true;
                            stop.accumulateAndGet(2, Math::max);
                            break;
                        }
                        owned.put(descendant.pid(), descendant);
                    }
                } catch (RuntimeException error) {
                    unverified = true;
                    stop.accumulateAndGet(2, Math::max);
                }
            }
        }

        private void closeStreams() {
            if (child == null) return;
            try {
                child.getOutputStream().close();
            } catch (Exception ignored) {
            }
            try {
                child.getInputStream().close();
            } catch (Exception ignored) {
            }
            try {
                child.getErrorStream().close();
            } catch (Exception ignored) {
            }
        }
    }

    private static JsonNode read(DataInputStream input, int limit) throws Exception {
        int first = input.read();
        if (first < 0) return null;
        int size = (first << 24)
                | (input.readUnsignedByte() << 16)
                | (input.readUnsignedByte() << 8)
                | input.readUnsignedByte();
        if (size < 2 || size > limit) throw new Invalid();
        byte[] bytes = input.readNBytes(size);
        try {
            if (bytes.length != size) throw new EOFException();
            String json = StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
            try (var parser = JSON.createParser(json)) {
                JsonNode value = JSON.readTree(parser);
                if (parser.nextToken() != null) throw new Invalid();
                return value;
            }
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    private static boolean safeWrite(OutputStream stream, Map<String, Object> value) {
        try {
            byte[] bytes = JSON.writeValueAsBytes(value);
            synchronized (stream) {
                DataOutputStream output = new DataOutputStream(stream);
                output.writeInt(bytes.length);
                output.write(bytes);
                output.flush();
            }
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void exact(JsonNode value, Set<String> fields) throws Invalid {
        if (value == null
                || !value.isObject()
                || value.size() != fields.size()
                || !Set.copyOf(value.propertyNames()).equals(fields)) throw new Invalid();
    }

    private static String text(JsonNode value, int max) throws Invalid {
        if (value == null || !value.isTextual()) throw new Invalid();
        String result = value.stringValue();
        if (result.indexOf('\0') >= 0 || result.getBytes(StandardCharsets.UTF_8).length > max) throw new Invalid();
        return result;
    }

    private static Path absolute(JsonNode value) throws Invalid {
        String raw = text(value, 4096);
        Path path = Path.of(raw);
        if (!path.isAbsolute() || !path.normalize().toString().equals(raw)) throw new Invalid();
        return path;
    }

    private static boolean integer(JsonNode value, int expected) {
        return value != null && value.isIntegralNumber() && value.canConvertToInt() && value.intValue() == expected;
    }

    private static final class Invalid extends Exception {}
}
