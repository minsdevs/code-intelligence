package dev.codeintelligence.project;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.SourceAccess;
import dev.codeintelligence.job.JobCancellation;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.text.Normalizer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.Repository;

/** Shared selection for preview and local copy. Does not provide native ancestor-race confinement. */
final class LocalSourcePolicy {
    static final String VERSION = "local-ingest-v1";
    static final Set<String> GENERATED_DIRECTORIES = Set.of(
            ".git",
            "node_modules",
            ".gradle",
            "build",
            "dist",
            "target",
            ".idea",
            ".vscode",
            "__pycache__",
            ".venv",
            "venv",
            "vendor",
            "generated");
    private static final Set<String> SECRET_DIRECTORIES =
            Set.of(".ssh", ".aws", ".gnupg", ".config", ".azure", ".kube");
    private static final Set<String> SECRET_NAMES = Set.of(
            "credentials",
            "credentials.json",
            "credentials.xml",
            "id_rsa",
            "id_dsa",
            "id_ecdsa",
            "id_ed25519",
            ".netrc",
            ".npmrc",
            ".pypirc",
            "keychain",
            "keychain-db",
            "secrets.json",
            "secrets.yml",
            "secrets.yaml");
    private static final Set<String> SECRET_EXTENSIONS =
            Set.of("pem", "key", "p12", "pfx", "jks", "keystore", "keychain", "keychain-db");
    private static final Set<String> BINARY_EXTENSIONS = Set.of(
            "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "pdf", "zip", "jar", "war", "ear", "class", "woff",
            "woff2", "eot", "ttf", "otf", "mp3", "mp4", "webm", "mov", "avi", "wav", "ogg", "exe", "dll", "so", "dylib",
            "bin", "7z", "tar", "gz", "bz2", "rar", "xz", "sqlite", "db", "wasm", "pyc", "o", "a", "lib");
    private static final List<Pattern> SECRETS = List.of(
            Pattern.compile("-----BEGIN [A-Z ]*PRIVATE KEY-----"),
            Pattern.compile("(?i)(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}"),
            Pattern.compile("AKIA[0-9A-Z]{16}"),
            Pattern.compile("sk-[A-Za-z0-9_-]{20,}"),
            Pattern.compile("AIza[0-9A-Za-z_-]{20,}"),
            Pattern.compile("(?i)bearer[ \\t]+[A-Za-z0-9._+/-]{16,}={0,2}"));
    private static final Pattern ASSIGNMENT =
            Pattern.compile("(?im)(?:password|passwd|client_secret|secret|token|api[_-]?key)[\"']?\\s*[:=]\\s*"
                    + "(?:\"([^\"\\r\\n]{1,512})\"|'([^'\\r\\n]{1,512})'|([A-Za-z0-9_./+@=-]{4,512})(?=$|[,;\\s#}]))");
    private static final int BUFFER = 8192;
    private static final int IGNORE_FILE_BYTES = 64 * 1024;
    private static final long IGNORE_TOTAL_BYTES = 1024 * 1024;
    private static final int IGNORE_RULES = 4096;
    private static final int IGNORE_LINE_CHARACTERS = 4096;
    private static final int HEAD_BYTES = 4096;

    enum Reason {
        GENERATED_DIRECTORY,
        SECRET_PATH,
        IGNORED,
        BINARY,
        OVERSIZED,
        FILE_LIMIT,
        SYMLINK,
        HARD_LINK,
        SECRET_CONTENT
    }

    record Limits(int files, long fileBytes, long totalBytes, int discoveredFiles, int entries, int depth, long nanos) {
        Limits {
            if (files < 1
                    || files > 50_000
                    || fileBytes < 1
                    || fileBytes > 2 * 1024 * 1024L
                    || totalBytes < 1
                    || totalBytes > 512 * 1024 * 1024L
                    || discoveredFiles < 1
                    || discoveredFiles > 50_000
                    || entries < 1
                    || entries > 200_000
                    || depth < 1
                    || depth > 64
                    || nanos < 1) {
                throw new IllegalArgumentException("Invalid local source limits");
            }
        }

        static Limits defaults(AnalysisProperties properties) {
            return new Limits(
                    Math.min(properties.maxFiles(), 50_000),
                    Math.min(properties.maxFileSize(), 2 * 1024 * 1024L),
                    512 * 1024 * 1024L,
                    50_000,
                    200_000,
                    64,
                    Duration.ofSeconds(30).toNanos());
        }
    }

    record SelectedFile(String path, long size, String oid) {}

    record Selection(
            Map<String, SelectedFile> files,
            LocalImportService.ImportSummary summary,
            String branch,
            Boolean dirty,
            LocalSourceBinding binding) {}

    @FunctionalInterface
    interface AcceptedFile {
        void accept(SelectedFile file, byte[] bytes) throws IOException;
    }

    @FunctionalInterface
    interface ReadObserver {
        void beforeOpen(Path path) throws IOException;

        default void afterRead(Path path, long bytesRead) throws IOException {}
    }

    private final Limits limits;
    private final LongSupplier clock;
    private final ReadObserver observer;

    LocalSourcePolicy(AnalysisProperties properties) {
        this(Limits.defaults(properties), System::nanoTime, path -> {});
    }

    LocalSourcePolicy(Limits limits, LongSupplier clock, ReadObserver observer) {
        this.limits = limits;
        this.clock = clock;
        this.observer = observer;
    }

    Limits limits() {
        return limits;
    }

    LongSupplier clock() {
        return clock;
    }

    String limitsSha256() {
        var digest = LocalSourceManifest.sha256();
        LocalSourceManifest.string(digest, "code-intelligence-local-limits-v1");
        for (long value : new long[] {
            limits.files(),
            limits.fileBytes(),
            limits.totalBytes(),
            limits.discoveredFiles(),
            limits.entries(),
            limits.depth(),
            limits.nanos(),
            IGNORE_FILE_BYTES,
            IGNORE_TOTAL_BYTES,
            IGNORE_RULES,
            IGNORE_LINE_CHARACTERS,
            HEAD_BYTES
        }) {
            LocalSourceManifest.number(digest, value);
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    Selection select(Path root, AcceptedFile sink) throws IOException {
        if (secretAncestor(root)
                || root.getFileName() == null
                || pathReason(root.getFileName().toString(), true) != null) {
            throw rejected("Choose a project folder outside excluded directories.");
        }
        State state = new State(root);
        state.rootStamp = directory(root);
        SourceAccess.Identity rootIdentity = SourceAccess.identity(root);
        String limitsHash = limitsSha256();
        LocalSourceManifest manifest = new LocalSourceManifest(VERSION, limitsHash);
        String branch = readBranch(state);
        Boolean dirty = SourceAccess.exists(root.resolve(".git"), true) ? null : Boolean.FALSE;
        SourceAccess.walk(root, limits.depth() + 1, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                state.visit(dir, true);
                if (!dir.equals(root)) {
                    Reason excluded = pathReason(dir.getFileName().toString(), true);
                    if (excluded != null) return state.skip(excluded);
                    if (state.ignored(dir, true)) return state.skip(Reason.IGNORED);
                }
                state.directories.put(dir, stamp(attrs));
                readIgnore(dir, state);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                String relative = state.visit(file, false);
                if (++state.discovered > limits.discoveredFiles())
                    throw rejected("Local source exceeds the file safety limit.");
                if (attrs.isDirectory()) throw rejected("Local source exceeds the path depth limit.");
                if (attrs.isSymbolicLink()) {
                    state.exclude(Reason.SYMLINK);
                    return FileVisitResult.CONTINUE;
                }
                if (!attrs.isRegularFile()) throw rejected("Local source contains a special file.");
                Reason reason = pathReason(file.getFileName().toString(), false);
                if (reason != null) {
                    state.exclude(reason);
                    return FileVisitResult.CONTINUE;
                }
                if (links(file) != 1) {
                    state.exclude(Reason.HARD_LINK);
                    return FileVisitResult.CONTINUE;
                }
                if (state.ignored(file, false)) {
                    state.exclude(Reason.IGNORED);
                    return FileVisitResult.CONTINUE;
                }
                if (attrs.size() > limits.fileBytes()) {
                    state.exclude(Reason.OVERSIZED);
                    return FileVisitResult.CONTINUE;
                }
                if (BINARY_EXTENSIONS.contains(extension(file.getFileName().toString()))) {
                    state.exclude(Reason.BINARY);
                    return FileVisitResult.CONTINUE;
                }
                state.candidates.put(relative, new Candidate(file, stamp(attrs)));
                return FileVisitResult.CONTINUE;
            }
        });
        Map<String, SelectedFile> selected = new TreeMap<>(LocalSourcePolicy::comparePaths);
        try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
            for (Map.Entry<String, Candidate> entry : state.candidates.entrySet()) {
                state.check();
                if (selected.size() >= limits.files()) {
                    state.exclude(Reason.FILE_LIMIT);
                    continue;
                }
                Candidate candidate = entry.getValue();
                CachedIgnore cached = state.ignoreBytes.get(candidate.path());
                byte[] bytes;
                if (cached == null) bytes = read(candidate.path(), candidate.stamp(), limits.fileBytes(), state);
                else {
                    if (!cached.stamp().equals(candidate.stamp()))
                        throw rejected("Local ignore rules changed during selection.");
                    requireSame(candidate.path(), cached.stamp());
                    bytes = cached.bytes();
                }
                String text = text(bytes);
                if (text == null) {
                    state.exclude(Reason.BINARY);
                    continue;
                }
                if (containsSecret(text, allowsUnquotedCredentials(entry.getKey()))) {
                    state.exclude(Reason.SECRET_CONTENT);
                    continue;
                }
                SelectedFile accepted = new SelectedFile(
                        entry.getKey(),
                        bytes.length,
                        formatter.idFor(Constants.OBJ_BLOB, bytes).name());
                manifest.add(
                        entry.getKey(),
                        bytes.length,
                        LocalSourceManifest.sha256().digest(bytes));
                sink.accept(accepted, bytes);
                selected.put(entry.getKey(), accepted);
                state.check();
            }
        }
        for (Map.Entry<Path, Stamp> dir : state.directories.entrySet()) {
            state.check();
            if (!dir.getValue().equals(directory(dir.getKey())))
                throw rejected("Local source changed while it was inspected.");
        }
        if (!state.rootStamp.equals(directory(root)) || !rootIdentity.equals(SourceAccess.identity(root))) {
            throw rejected("Local source identity changed while it was inspected.");
        }
        Map<String, Integer> excluded = new TreeMap<>();
        state.excluded.forEach((reason, count) -> excluded.put(reason.name(), count));
        return new Selection(
                Map.copyOf(selected),
                new LocalImportService.ImportSummary(
                        1, VERSION, selected.size(), state.bytesRead, Map.copyOf(excluded)),
                branch,
                dirty,
                new LocalSourceBinding(
                        1,
                        root.toString(),
                        rootIdentity.platform(),
                        rootIdentity.identity(),
                        rootIdentity.owner(),
                        VERSION,
                        limitsHash,
                        manifest.finish(),
                        manifest.count(),
                        manifest.bytes()));
    }

    private String readBranch(State state) throws IOException {
        Path git = state.root.resolve(".git");
        if (!SourceAccess.exists(git, true)) return null;
        Path head = git.resolve("HEAD");
        if (!SourceAccess.exists(head, false)) return null;
        Stamp before = regular(head);
        if (links(head) != 1 || before.size() > HEAD_BYTES) return null;
        String headText = text(read(head, before, HEAD_BYTES, state));
        if (headText == null || containsSecret(headText) || !headText.startsWith("ref: refs/heads/")) return null;
        String ref = headText.substring(5).strip();
        return Repository.isValidRefName(ref) ? ref.substring("refs/heads/".length()) : null;
    }

    private void readIgnore(Path dir, State state) throws IOException {
        Path file = dir.resolve(".gitignore");
        if (!SourceAccess.exists(file, false)) return;
        if (links(file) != 1) throw rejected("A local ignore file cannot be safely read.");
        Stamp before = regular(file);
        if (before.size() > Math.min(limits.fileBytes(), IGNORE_FILE_BYTES)) {
            throw rejected("A local ignore file exceeds its safety limit.");
        }
        byte[] bytes = read(file, before, Math.min(limits.fileBytes(), IGNORE_FILE_BYTES), state);
        state.ignoreTotal += bytes.length;
        if (state.ignoreTotal > IGNORE_TOTAL_BYTES) throw rejected("Local ignore rules exceed their safety limit.");
        String text = text(bytes);
        if (text == null || containsSecret(text)) throw rejected("A local ignore file cannot be safely interpreted.");
        // Parse a documented subset without regex backtracking or raw-pattern logging.
        List<LocalIgnoreRules.Rule> rules = new ArrayList<>();
        for (String line : text.split("\\r\\n|\\r|\\n", -1)) {
            state.check();
            if (line.isEmpty()) continue;
            if (++state.ignoreRules > IGNORE_RULES || line.length() > IGNORE_LINE_CHARACTERS)
                throw rejected("Local ignore rules exceed their safety limit.");
            LocalIgnoreRules.Rule rule = LocalIgnoreRules.parse(line);
            if (rule != null) rules.add(rule);
        }
        state.ignores.put(dir, List.copyOf(rules));
        state.ignoreBytes.put(file, new CachedIgnore(before, bytes));
    }

    private byte[] read(Path file, Stamp expected, long maxBytes, State state) throws IOException {
        state.check();
        observer.beforeOpen(file);
        state.checkDevice(file, false);
        requireSame(file, expected);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream((int) Math.min(expected.size(), BUFFER));
        try (InputStream input = SourceAccess.input(file, maxBytes)) {
            byte[] buffer = new byte[BUFFER];
            int count;
            while ((count = input.read(buffer, 0, (int) Math.min(
                            BUFFER, Math.min(maxBytes + 1 - bytes.size(), limits.totalBytes() + 1 - state.bytesRead))))
                    != -1) {
                state.check();
                state.bytesRead += count;
                if ((long) bytes.size() + count > maxBytes || state.bytesRead > limits.totalBytes()) {
                    throw rejected("Local source exceeds its actual byte safety limit.");
                }
                bytes.write(buffer, 0, count);
                observer.afterRead(file, bytes.size());
            }
        }
        requireSame(file, expected);
        if (bytes.size() != expected.size()) throw rejected("Local source changed while it was read.");
        return bytes.toByteArray();
    }

    private static Reason pathReason(String filename, boolean directory) {
        String name = filename.toLowerCase(Locale.ROOT);
        if (containsSecret(filename)
                || SECRET_DIRECTORIES.contains(name)
                || SECRET_NAMES.contains(name)
                || name.startsWith(".env")
                || SECRET_EXTENSIONS.contains(extension(name))) return Reason.SECRET_PATH;
        if (name.equals(".git") || name.equals(".ds_store") || directory && GENERATED_DIRECTORIES.contains(name)) {
            return Reason.GENERATED_DIRECTORY;
        }
        return null;
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static String text(byte[] bytes) {
        for (byte value : bytes) if (value == 0) return null;
        try {
            return StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    private static boolean containsSecret(String text) {
        return containsSecret(text, false);
    }

    private static boolean containsSecret(String text, boolean unquotedCredentials) {
        if (SECRETS.stream().anyMatch(pattern -> pattern.matcher(text).find())) return true;
        Matcher assignments = ASSIGNMENT.matcher(text);
        while (assignments.find()) {
            if (assignments.group(3) != null && !unquotedCredentials) continue;
            String value = assignments.group(1) != null
                    ? assignments.group(1)
                    : assignments.group(2) != null ? assignments.group(2) : assignments.group(3);
            String normalized = value.toLowerCase(Locale.ROOT);
            if (normalized.startsWith("${")
                    || normalized.startsWith("{{")
                    || normalized.startsWith("<")
                    || Set.of("null", "true", "false", "undefined", "[redacted]")
                            .contains(normalized)) continue;
            return true;
        }
        return false;
    }

    private static boolean allowsUnquotedCredentials(String path) {
        return Set.of("yaml", "yml", "properties", "ini", "toml", "txt", "conf", "config")
                .contains(extension(path));
    }

    static boolean secretAncestor(Path path) {
        for (Path part : path) if (pathReason(part.toString(), true) == Reason.SECRET_PATH) return true;
        return false;
    }

    static int comparePaths(String first, String second) {
        return Arrays.compareUnsigned(first.getBytes(StandardCharsets.UTF_8), second.getBytes(StandardCharsets.UTF_8));
    }

    private static Stamp directory(Path path) throws IOException {
        BasicFileAttributes attrs = SourceAccess.attributes(path, true);
        if (!attrs.isDirectory() || attrs.isSymbolicLink()) throw rejected("Local source directory is unavailable.");
        return stamp(attrs);
    }

    private static Stamp regular(Path path) throws IOException {
        BasicFileAttributes attrs = SourceAccess.attributes(path, false);
        if (!attrs.isRegularFile() || attrs.isSymbolicLink())
            throw rejected("Local source entry is no longer a regular file.");
        return stamp(attrs);
    }

    private static long links(Path path) throws IOException {
        return SourceAccess.links(path);
    }

    private static Stamp stamp(BasicFileAttributes attrs) throws IOException {
        if (attrs.fileKey() == null) throw rejected("Local source identity cannot be verified.");
        return new Stamp(
                attrs.fileKey(),
                attrs.size(),
                attrs instanceof dev.codeintelligence.common.WindowsStorage.State state
                        ? state.token()
                        : attrs.lastModifiedTime());
    }

    private static void requireSame(Path file, Stamp expected) throws IOException {
        if (!expected.equals(regular(file)) || links(file) != 1)
            throw rejected("Local source changed while it was read.");
    }

    private static IOException rejected(String message) {
        return new IOException(message);
    }

    private record Stamp(Object key, long size, Object changed) {}

    private record Candidate(Path path, Stamp stamp) {}

    private record CachedIgnore(Stamp stamp, byte[] bytes) {}

    private final class State {
        final Path root;
        final Object device;
        final long started = clock.getAsLong();
        final Map<String, Candidate> candidates = new TreeMap<>(LocalSourcePolicy::comparePaths);
        final Map<Path, Stamp> directories = new HashMap<>();
        final Map<Path, List<LocalIgnoreRules.Rule>> ignores = new HashMap<>();
        final Map<Path, CachedIgnore> ignoreBytes = new HashMap<>();
        final Map<String, String> aliases = new HashMap<>();
        final Map<Reason, Integer> excluded = new EnumMap<>(Reason.class);
        Stamp rootStamp;
        int discovered;
        int visited;
        int ignoreRules;
        long ignoreTotal;
        long bytesRead;

        State(Path root) throws IOException {
            this.root = root;
            this.device = SourceAccess.volume(root, true);
        }

        void check() throws IOException {
            JobCancellation.checkpoint();
            if (Thread.currentThread().isInterrupted() || clock.getAsLong() - started > limits.nanos()) {
                throw rejected("Local source inspection was cancelled or exceeded its time limit.");
            }
        }

        String visit(Path path, boolean directory) throws IOException {
            check();
            checkDevice(path, directory);
            Path relative = root.relativize(path);
            String name = relative.toString().replace('\\', '/');
            if (++visited > limits.entries() || relative.getNameCount() > limits.depth()) {
                throw rejected("Local source exceeds its traversal safety limit.");
            }
            if (path.equals(root)) return name;
            if (!root.resolve(name).equals(path)) throw rejected("Local source contains an unsupported path encoding.");
            String leaf = path.getFileName().toString();
            if (leaf.indexOf('\\') >= 0 || leaf.chars().anyMatch(Character::isISOControl)) {
                throw rejected("Local source contains an unsupported path.");
            }
            String alias = Normalizer.normalize(name, Normalizer.Form.NFC).toLowerCase(Locale.ROOT);
            String previous = aliases.putIfAbsent(alias, name);
            if (previous != null) throw rejected("Local source contains colliding paths.");
            return name;
        }

        void checkDevice(Path path, boolean directory) throws IOException {
            if (!device.equals(SourceAccess.volume(path, directory))) {
                throw rejected("Local source crosses a filesystem boundary.");
            }
        }

        boolean ignored(Path path, boolean directory) throws IOException {
            for (Path parent = path.getParent();
                    parent != null && parent.startsWith(root);
                    parent = parent.getParent()) {
                check();
                List<LocalIgnoreRules.Rule> rules = ignores.get(parent);
                if (rules == null) continue;
                String relative = parent.relativize(path).toString().replace('\\', '/');
                for (int i = rules.size() - 1; i >= 0; i--) {
                    check();
                    if (rules.get(i).matches(relative, directory, this::check))
                        return rules.get(i).ignored();
                }
            }
            return false;
        }

        void exclude(Reason reason) {
            excluded.merge(reason, 1, Integer::sum);
        }

        FileVisitResult skip(Reason reason) {
            exclude(reason);
            return FileVisitResult.SKIP_SUBTREE;
        }
    }
}
