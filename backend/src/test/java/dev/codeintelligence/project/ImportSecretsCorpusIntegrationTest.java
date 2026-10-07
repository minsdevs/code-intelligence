package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import ch.qos.logback.core.read.ListAppender;
import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.ai.ContextRetrievalService;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.core.FileService;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.common.DesktopPrivateBootstrap;
import dev.codeintelligence.export.ExportService;
import dev.codeintelligence.job.FinalizeStep;
import dev.codeintelligence.job.JobProgressPublisher;
import dev.codeintelligence.job.JobRepository;
import dev.codeintelligence.job.JobStatus;
import dev.codeintelligence.job.JobWorker;
import dev.codeintelligence.job.JobWorkspaceProvider;
import dev.codeintelligence.job.Pipeline;
import dev.codeintelligence.source.SourceStoreClient;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.ServerSocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.json.JsonMapper;

/**
 * C05 import-secrets corpus (G-IMPORT). Every fixture is generated at test time on the real local
 * filesystem, so links, FIFOs, sockets, sparse files, Unicode names and (on a case-sensitive APFS
 * image) case-fold collisions are real. Each case asserts its exact preview outcome and its exact
 * copy outcome: the approved import through the real worker, real PostgreSQL and the production
 * Node vault/broker, or the same copy code without the vault for high-volume count boundaries.
 * Grants come from {@link DesktopPathAuthorizationService}, which main calls only after its
 * native picker; no configured allowed root exists. A final sweep proves that no forbidden sentinel
 * reached PostgreSQL, the encrypted store, managed storage, logs, export or AI preview bodies.
 */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url=",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.github.base-url=http://127.0.0.1:1"
        })
@Import(TestcontainersConfiguration.class)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ImportSecretsCorpusIntegrationTest {
    static final String SENTINEL = "C05SENTINEL";
    private static final int FILE_BYTES = 1024 * 1024; // Shipped app.analysis.max-file-size (below the 2 MiB ceiling).
    private static final long TOTAL_BYTES = 512L * 1024 * 1024;
    private static final int ACCEPTED_FILES = 20_000; // Shipped app.analysis.max-files (below 50,000).
    private static final int ENCOUNTERED_FILES = 50_000;
    private static final String CHANGED = "LOCAL_SOURCE_CHANGED";
    private static NodeBridge bridge;
    private static final Map<String, List<byte[]>> FORBIDDEN = new TreeMap<>();
    private static final List<Imported> IMPORTED = new ArrayList<>();
    private static final Map<String, Map<String, Object>> REPORT = new TreeMap<>();
    private static ListAppender<ILoggingEvent> logs;

    @TestBean(methodName = "privateBootstrap")
    DesktopPrivateBootstrap privateBootstrap;

    static DesktopPrivateBootstrap privateBootstrap() {
        var json = new JsonMapper();
        byte[] bytes = json.writeValueAsBytes(Map.of(
                "version",
                2,
                "ai",
                Map.of("socketPath", "/tmp/c05-ai.sock", "capability", "e".repeat(64), "epoch", "f".repeat(64)),
                "source",
                Map.of("socketPath", bridge.socket.toString(), "capability", NodeBridge.TOKEN)));
        return new DesktopPrivateBootstrap(new ByteArrayInputStream(bytes), json, Duration.ofSeconds(3));
    }

    @TempDir
    static Path root;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    LocalSourceApprovalService approvals;

    @Autowired
    ProjectService projects;

    @Autowired
    LocalImportService imports;

    @Autowired
    DesktopPathAuthorizationService desktopPaths;

    @Autowired
    SourceStoreClient sourceClient;

    @Autowired
    FileService files;

    @Autowired
    ContextRetrievalService retrieval;

    @Autowired
    ExportService exports;

    @Autowired
    ImportStep importStep;

    @Autowired
    FileInventoryStep inventoryStep;

    @Autowired
    FinalizeStep finalizeStep;

    @Autowired
    JobWorkspaceProvider workspaces;

    @Autowired
    JobRepository jobs;

    @Autowired
    AppProperties app;

    @MockitoBean
    JobWorker worker;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        try {
            if (bridge == null) bridge = new NodeBridge();
            bridge.start();
        } catch (Exception error) {
            throw new IllegalStateException("Disposable source bridge failed to start", error);
        }
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        // Deliberately no app.local-import.allowed-roots: only main-style picker grants authorize.
        registry.add("app.local-import.allowed-roots", () -> "");
    }

    @AfterAll
    static void closeBridge() throws Exception {
        if (logs != null) {
            ((Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME)).detachAppender(logs);
        }
        if (bridge != null) bridge.close();
    }

    enum Kind {
        ACCEPT,
        REJECT,
        CONFLICT,
        CONFIRM_CONFLICT,
        ACCEPT_LIGHT,
        CEILING,
        REJECT_UNWALKED
    }

    @FunctionalInterface
    interface Builder {
        void build(Tree tree) throws Exception;
    }

    record Case(
            String id,
            String attack,
            String title,
            Kind kind,
            Builder build,
            Builder race,
            List<String> selected,
            Map<String, Integer> excluded,
            String reason,
            Long bytesRead,
            String deviation) {
        Case(
                String id,
                String attack,
                String title,
                Kind kind,
                Builder build,
                Builder race,
                List<String> selected,
                Map<String, Integer> excluded,
                String reason) {
            this(id, attack, title, kind, build, race, selected, excluded, reason, null, null);
        }

        Case bytes(long value) {
            return new Case(id, attack, title, kind, build, race, selected, excluded, reason, value, deviation);
        }

        Case deviation(String value) {
            return new Case(id, attack, title, kind, build, race, selected, excluded, reason, bytesRead, value);
        }
    }

    record Imported(String id, long user, long project, long snapshot, List<String> paths) {}

    static Case accept(
            String id,
            String attack,
            String title,
            Builder build,
            List<String> selected,
            Map<String, Integer> excluded) {
        return new Case(id, attack, title, Kind.ACCEPT, build, null, selected, excluded, null);
    }

    static Case reject(String id, String attack, String title, Builder build, String reason) {
        return new Case(id, attack, title, Kind.REJECT, build, null, List.of(), Map.of(), reason);
    }

    static Case race(String id, String title, Builder build, Builder race, Kind kind, List<String> selected) {
        return new Case(id, "race", title, kind, build, race, selected, Map.of(), kind == Kind.ACCEPT ? null : CHANGED);
    }

    static Map<String, Integer> ex(Object... pairs) {
        Map<String, Integer> result = new TreeMap<>();
        for (int index = 0; index < pairs.length; index += 2)
            result.put((String) pairs[index], (Integer) pairs[index + 1]);
        return result;
    }

    static List<Case> corpus() {
        List<Case> cases = new ArrayList<>();
        String main = "src/main.ts";
        Builder base = t -> t.text(main, "export const value = 1;\n");
        // Nested keys, PEM and credential paths.
        cases.add(accept(
                "C05-01",
                "secret-path",
                ".env at the root",
                t -> {
                    base.build(t);
                    t.secret(".env", "API_TOKEN=%s\n");
                },
                List.of(main),
                ex("SECRET_PATH", 1)));
        cases.add(accept(
                "C05-02",
                "secret-path",
                "nested .env.local",
                t -> {
                    base.build(t);
                    t.secret("config/.env.local", "DB=%s\n");
                },
                List.of(main),
                ex("SECRET_PATH", 1)));
        cases.add(accept(
                "C05-03",
                "secret-path",
                ".env.example is also excluded (conservative)",
                t -> {
                    base.build(t);
                    t.secret(".env.example", "EXAMPLE=%s\n");
                },
                List.of(main),
                ex("SECRET_PATH", 1)));
        cases.add(accept(
                "C05-04",
                "nested-key",
                "deep .ssh/id_ed25519",
                t -> {
                    base.build(t);
                    t.secret("a/b/c/.ssh/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\n%s\n");
                },
                List.of(main),
                ex("SECRET_PATH", 1)));
        cases.add(accept(
                "C05-05",
                "nested-key",
                "nested .aws/credentials",
                t -> {
                    base.build(t);
                    t.secret("infra/.aws/credentials", "[default]\naws_secret_access_key=%s\n");
                },
                List.of(main),
                ex("SECRET_PATH", 1)));
        cases.add(accept(
                "C05-06",
                "nested-key",
                ".gnupg, .config, .azure and .kube directories",
                t -> {
                    base.build(t);
                    t.secret(".gnupg/private-keys-v1.d/key.txt", "%s\n");
                    t.secret("tools/.config/gh/hosts.yml", "oauth_token: %s\n");
                    t.secret(".azure/accessTokens.json", "{\"t\":\"%s\"}\n");
                    t.secret("ops/.kube/config", "token: %s\n");
                },
                List.of(main),
                ex("SECRET_PATH", 4)));
        cases.add(accept(
                "C05-07",
                "pem",
                "PEM/key/keystore extensions",
                t -> {
                    base.build(t);
                    t.secret("certs/server.pem", "-----BEGIN CERTIFICATE-----\n%s\n");
                    t.secret("keys/deploy.key", "%s\n");
                    t.secret("keys/client.p12", "%s\n");
                    t.secret("keys/release.jks", "%s\n");
                },
                List.of(main),
                ex("SECRET_PATH", 4)));
        cases.add(accept(
                "C05-08",
                "nested-key",
                "credential file names",
                t -> {
                    base.build(t);
                    t.secret("home/id_rsa", "%s\n");
                    t.secret("pkg/.npmrc", "//registry/:_authToken=%s\n");
                    t.secret(".netrc", "machine x password %s\n");
                    t.secret("conf/secrets.yml", "key: %s\n");
                    t.secret("conf/credentials.json", "{\"k\":\"%s\"}\n");
                },
                List.of(main),
                ex("SECRET_PATH", 5)));
        cases.add(accept(
                "C05-09",
                "secret-path",
                "token-shaped file name",
                t -> {
                    base.build(t);
                    t.forbiddenName("docs/ghp_" + SENTINEL + "0123456789abcdef.txt", "plain\n");
                },
                List.of(main),
                ex("SECRET_PATH", 1)));
        cases.add(accept(
                "C05-10",
                "secret-content",
                "PEM private key embedded in source",
                t -> {
                    base.build(t);
                    t.secret(
                            "src/util.ts",
                            "const k = `-----BEGIN RSA PRIVATE KEY-----\n%s\n-----END RSA PRIVATE KEY-----`;\n");
                },
                List.of(main),
                ex("SECRET_CONTENT", 1)));
        cases.add(accept(
                "C05-11",
                "secret-content",
                "GitHub, AWS, OpenAI, Google and bearer token signatures",
                t -> {
                    base.build(t);
                    t.secret("src/gh.ts", "const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; // %s\n");
                    t.secret("docs/aws.md", "AKIAABCDEFGHIJKLMNOP %s\n");
                    t.secret("src/ai.ts", "const k = 'sk-abcdefghijklmnopqrstuvwxyz'; // %s\n");
                    t.secret("src/g.ts", "const g = 'AIzaabcdefghijklmnopqrstuvwxyz'; // %s\n");
                    t.secret("src/h.ts", "headers.Authorization = 'Bearer abcdefghijklmnopqrstuvwx'; // %s\n");
                },
                List.of(main),
                ex("SECRET_CONTENT", 5)));
        cases.add(accept(
                "C05-12",
                "secret-content",
                "quoted and unquoted credential assignments",
                t -> {
                    base.build(t);
                    t.secret("src/db.ts", "const password = \"%s\";\n");
                    t.secret("app.properties", "client_secret=%s\n");
                    t.text("src/types.ts", "type C = { password: string };\nconst p = process.env.DB_PASSWORD;\n");
                },
                List.of(main, "src/types.ts"),
                ex("SECRET_CONTENT", 2)));
        cases.add(reject(
                "C05-13",
                "secret-content",
                "credential inside .gitignore fails the inspection",
                t -> {
                    base.build(t);
                    t.secret(".gitignore", "# ghp_abcdefghijklmnopqrstuvwxyz0123456789 %s\n");
                },
                "A local ignore file cannot be safely interpreted."));
        // Default exclusions, ignore rules and submodules.
        cases.add(accept(
                "C05-14",
                "default-exclusion",
                "generated/vendor/venv/build/dist/target directories",
                t -> {
                    base.build(t);
                    for (String dir : List.of(
                            "node_modules/pkg",
                            "vendor/lib",
                            "venv/lib",
                            ".venv/lib",
                            "build",
                            "dist",
                            "generated",
                            "target",
                            ".gradle",
                            ".idea",
                            ".vscode",
                            "__pycache__")) t.secret(dir + "/index.js", "module.exports = '%s';\n");
                },
                List.of(main),
                ex("GENERATED_DIRECTORY", 12)));
        cases.add(accept(
                "C05-15",
                "default-exclusion",
                ".git metadata and .DS_Store",
                t -> {
                    base.build(t);
                    t.text(".git/HEAD", "ref: refs/heads/main\n");
                    t.secret(".git/config", "[remote \"origin\"]\n\turl = https://x:%s@example.invalid/r.git\n");
                    t.secret(".DS_Store", "%s");
                },
                List.of(main),
                ex("GENERATED_DIRECTORY", 2)));
        cases.add(accept(
                "C05-16",
                "default-exclusion",
                "negation cannot re-include node_modules",
                t -> {
                    base.build(t);
                    t.text(".gitignore", "!node_modules/\n!node_modules/**\n");
                    t.secret("node_modules/pkg/index.js", "'%s';\n");
                },
                List.of(".gitignore", main),
                ex("GENERATED_DIRECTORY", 1)));
        cases.add(accept(
                "C05-17",
                "default-exclusion",
                "local .gitignore prunes a directory",
                t -> {
                    base.build(t);
                    t.text(".gitignore", "private/\n*.local.ts\n");
                    t.secret("private/notes.txt", "%s\n");
                    t.secret("src/override.local.ts", "export const k = '%s';\n");
                },
                List.of(".gitignore", main),
                ex("IGNORED", 2)));
        // F11/05: submodule content is a default exclusion; the nested repository is pruned whole.
        cases.add(accept(
                "C05-18",
                "submodule",
                "submodule working tree below a gitlink file",
                t -> {
                    base.build(t);
                    t.text(
                            ".gitmodules",
                            "[submodule \"libs/sub\"]\n\tpath = libs/sub\n\turl = https://example.invalid/sub.git\n");
                    t.text("libs/sub/.git", "gitdir: ../../.git/modules/sub\n");
                    t.text("libs/sub/lib.ts", "export const fromSubmodule = 1;\n");
                    t.secret("libs/sub/config.ts", "export const token = '%s';\n");
                },
                List.of(".gitmodules", main),
                ex("SUBMODULE", 1)));
        cases.add(accept(
                "C05-72",
                "submodule",
                "nested clone with its own .git directory",
                t -> {
                    base.build(t);
                    t.text("vendored/other/.git/HEAD", "ref: refs/heads/main\n");
                    t.secret("vendored/other/.git/config", "[remote \"origin\"]\n\turl = https://x:%s@example.invalid/o.git\n");
                    t.text("vendored/other/src/other.ts", "export const other = 1;\n");
                },
                List.of(main),
                ex("SUBMODULE", 1)));
        // Links and special files.
        cases.add(accept(
                "C05-19",
                "symlink",
                "file symlink to an outside secret is not followed",
                t -> {
                    base.build(t);
                    Path outside = t.outsideSecret("outside-secret.txt", "%s\n");
                    t.symlink("src/link.ts", outside);
                },
                List.of(main),
                ex("SYMLINK", 1)));
        cases.add(accept(
                "C05-20",
                "symlink",
                "directory symlink to an outside tree is not traversed",
                t -> {
                    base.build(t);
                    Path outside = t.outsideSecret("outside-dir/inner.ts", "export const s = '%s';\n")
                            .getParent();
                    t.symlink("linked", outside);
                },
                List.of(main),
                ex("SYMLINK", 1)));
        cases.add(accept(
                "C05-21",
                "hardlink",
                "hard-linked pair inside the tree",
                t -> {
                    base.build(t);
                    t.secret("src/a.ts", "export const a = '%s';\n");
                    t.hardlink("src/b.ts", "src/a.ts");
                },
                List.of(main),
                ex("HARD_LINK", 2)));
        cases.add(accept(
                "C05-22",
                "hardlink",
                "hard link to an outside secret",
                t -> {
                    base.build(t);
                    Path outside = t.outsideSecret("outside-hard.ts", "export const s = '%s';\n");
                    Files.createLink(t.path("src/hard.ts"), outside);
                },
                List.of(main),
                ex("HARD_LINK", 1)));
        cases.add(reject(
                "C05-23",
                "fifo",
                "FIFO fails the inspection without opening",
                t -> {
                    base.build(t);
                    t.fifo("src/pipe.ts");
                },
                "Local source contains a special file."));
        cases.add(reject(
                "C05-24",
                "socket",
                "Unix socket fails the inspection",
                t -> {
                    base.build(t);
                    t.socket("run/app.sock");
                },
                "Local source contains a special file."));
        cases.add(reject(
                "C05-25",
                "mount",
                "a mounted volume below the root is not traversed",
                t -> {
                    base.build(t);
                    t.mount(
                            "mounted",
                            false,
                            image -> Files.writeString(image.resolve("inside.ts"), "export const m = 1;\n"));
                },
                "Local source crosses a filesystem boundary."));
        cases.add(reject(
                "C05-26",
                "case-fold",
                "A.ts and a.ts on a case-sensitive APFS volume",
                t -> t.caseSensitiveRoot(),
                "Local source contains colliding paths."));
        // APFS is normalization-insensitive, so an NFC/NFD twin cannot exist on this platform; the NFD-created
        // name is retained byte-for-byte. Code points are spelled out to keep the two forms unambiguous.
        String nfd = "cafe" + Character.toString(0x0301) + ".ts";
        String nfc = "caf" + Character.toString(0x00E9) + ".ts";
        cases.add(accept(
                "C05-27",
                "unicode",
                "NFD-created name is retained once; its NFC twin is refused by the filesystem",
                t -> {
                    base.build(t);
                    t.text(nfd, "export const nfd = 1;\n");
                    assertThatThrownBy(() ->
                                    Files.writeString(t.path(nfc), "x", java.nio.file.StandardOpenOption.CREATE_NEW))
                            .isInstanceOf(FileAlreadyExistsException.class);
                },
                List.of(nfd, main),
                ex()));
        cases.add(reject(
                "C05-28",
                "path",
                "control character in a file name",
                t -> {
                    base.build(t);
                    t.text("src/bad\nname.ts", "x\n");
                },
                "Local source contains an unsupported path."));
        cases.add(reject(
                "C05-29",
                "path",
                "backslash in a file name",
                t -> {
                    base.build(t);
                    t.text("src/a\\b.ts", "x\n");
                },
                "Local source contains an unsupported path encoding."));
        cases.add(reject(
                "C05-30",
                "path",
                "directory depth above 64",
                t -> {
                    base.build(t);
                    t.text("d/".repeat(65) + "deep.ts", "x\n");
                },
                "Local source exceeds its traversal safety limit."));
        // Encoding and binary content.
        cases.add(accept(
                "C05-31",
                "utf8",
                "invalid UTF-8 content is excluded as binary",
                t -> {
                    base.build(t);
                    t.forbiddenBytes("src/bad.ts", concat(sentinel(t.id, "bad"), new byte[] {(byte) 0xC3, 0x28}));
                },
                List.of(main),
                ex("BINARY", 1)));
        cases.add(accept(
                "C05-32",
                "binary",
                "NUL byte anywhere excludes the file",
                t -> {
                    base.build(t);
                    t.forbiddenBytes("src/nul.ts", concat(sentinel(t.id, "nul"), new byte[] {0, 'x'}));
                },
                List.of(main),
                ex("BINARY", 1)));
        cases.add(accept(
                "C05-33",
                "binary",
                "binary extensions are not opened",
                t -> {
                    base.build(t);
                    t.secret("assets/logo.png", "%s");
                    t.secret("lib/native.dylib", "%s");
                },
                List.of(main),
                ex("BINARY", 2)));
        cases.add(accept(
                "C05-34",
                "archive",
                "stored ZIP entry is never expanded",
                t -> {
                    base.build(t);
                    t.forbiddenBytes("assets/bundle.zip", storedZip("inner.ts", sentinel(t.id, "zip")));
                },
                List.of(main),
                ex("BINARY", 1)));
        long mainBytes = "export const value = 1;\n".length();
        cases.add(accept(
                        "C05-35",
                        "sparse",
                        "1 GiB sparse file is excluded before opening",
                        t -> {
                            base.build(t);
                            t.sparse("logs/huge.log", 1024L * 1024 * 1024);
                        },
                        List.of(main),
                        ex("OVERSIZED", 1))
                .bytes(mainBytes));
        cases.add(accept(
                        "C05-36",
                        "sparse",
                        "in-limit sparse zeros are read, counted and excluded",
                        t -> {
                            base.build(t);
                            t.sparse("data/zeros.txt", FILE_BYTES);
                        },
                        List.of(main),
                        ex("BINARY", 1))
                .bytes(mainBytes + FILE_BYTES));
        // Per-file bytes +-1 at the shipped limit (1 MiB).
        cases.add(accept(
                        "C05-37",
                        "bytes",
                        "file of limit-1 bytes is copied",
                        t -> t.repeated("src/near.txt", FILE_BYTES - 1),
                        List.of("src/near.txt"),
                        ex())
                .bytes(FILE_BYTES - 1));
        cases.add(accept(
                        "C05-38",
                        "bytes",
                        "file of exactly limit bytes is copied",
                        t -> t.repeated("src/exact.txt", FILE_BYTES),
                        List.of("src/exact.txt"),
                        ex())
                .bytes(FILE_BYTES));
        cases.add(accept(
                        "C05-39",
                        "bytes",
                        "file of limit+1 bytes is excluded before opening",
                        t -> {
                            base.build(t);
                            t.forbiddenBytes("src/over.txt", oversized(t.id));
                        },
                        List.of(main),
                        ex("OVERSIZED", 1))
                .bytes(mainBytes));
        // Aggregate actual bytes +-1 at 512 MiB using sparse (unallocated) zeros.
        for (int delta : new int[] {-1, 0, 1}) {
            String id = "C05-4" + (delta + 1);
            Builder build = t -> totalBytes(t, delta);
            if (delta <= 0)
                cases.add(new Case(
                                id,
                                "bytes",
                                "aggregate read = 512 MiB" + (delta == 0 ? "" : " - 1"),
                                Kind.ACCEPT_LIGHT,
                                build,
                                null,
                                List.of("a.ts"),
                                ex("BINARY", 512),
                                null)
                        .bytes(TOTAL_BYTES + delta));
            else
                cases.add(new Case(
                        id,
                        "bytes",
                        "aggregate read = 512 MiB + 1",
                        Kind.REJECT,
                        build,
                        null,
                        List.of(),
                        Map.of(),
                        "Local source exceeds its actual byte safety limit."));
        }
        // File-count boundaries.
        cases.add(new Case(
                "C05-43",
                "count",
                "50,000 encountered entries are accepted",
                Kind.ACCEPT_LIGHT,
                t -> encountered(t, ENCOUNTERED_FILES),
                null,
                List.of("a.ts"),
                ex("BINARY", ENCOUNTERED_FILES - 1),
                null));
        cases.add(new Case(
                "C05-44",
                "count",
                "50,001 encountered entries fail",
                Kind.REJECT,
                t -> encountered(t, ENCOUNTERED_FILES + 1),
                null,
                List.of(),
                Map.of(),
                "Local source exceeds the file safety limit."));
        cases.add(new Case(
                "C05-45",
                "count",
                "20,000 eligible files are all accepted",
                Kind.ACCEPT_LIGHT,
                t -> eligible(t, ACCEPTED_FILES),
                null,
                null,
                ex(),
                null));
        cases.add(new Case(
                "C05-46",
                "count",
                "20,001 eligible files: one FILE_LIMIT exclusion",
                Kind.ACCEPT_LIGHT,
                t -> eligible(t, ACCEPTED_FILES + 1),
                null,
                null,
                ex("FILE_LIMIT", 1),
                null));
        // Root selection policy.
        cases.add(new Case(
                "C05-47",
                "root",
                "home directory",
                Kind.REJECT_UNWALKED,
                t -> t.at(Path.of(System.getProperty("user.home"))),
                null,
                List.of(),
                Map.of(),
                "Choose a project folder, not your home directory."));
        cases.add(new Case(
                "C05-48",
                "root",
                "filesystem root",
                Kind.REJECT_UNWALKED,
                t -> t.at(Path.of("/")),
                null,
                List.of(),
                Map.of(),
                "Choose a project folder, not a volume root."));
        cases.add(new Case(
                "C05-49",
                "root",
                "root of a mounted volume",
                Kind.REJECT_UNWALKED,
                t -> t.mount(null, false, volume -> t.at(volume)),
                null,
                List.of(),
                Map.of(),
                "Choose a project folder, not a volume root."));
        cases.add(new Case(
                "C05-50",
                "root",
                "system directory",
                Kind.REJECT_UNWALKED,
                t -> t.at(Path.of("/usr/share")),
                null,
                List.of(),
                Map.of(),
                "System directory is not allowed."));
        cases.add(new Case(
                "C05-51",
                "root",
                "project below a credential directory",
                Kind.REJECT,
                t -> {
                    t.at(t.path("..").normalize().resolve(t.id + "-cred/.aws/project"));
                    base.build(t);
                },
                null,
                List.of(),
                Map.of(),
                "Choose a project folder outside credential directories."));
        cases.add(new Case(
                "C05-52",
                "root",
                "generated directory as the root",
                Kind.REJECT,
                t -> {
                    t.at(t.path("..").normalize().resolve(t.id + "-gen/node_modules"));
                    base.build(t);
                },
                null,
                List.of(),
                Map.of(),
                "Choose a project folder outside excluded directories."));
        cases.add(new Case(
                "C05-53",
                "capability",
                "folder without a picker grant",
                Kind.REJECT,
                t -> {
                    base.build(t);
                    t.ungranted();
                },
                null,
                List.of(),
                Map.of(),
                "Path is not authorized. Choose it with the native folder picker or configure an allowed root."));
        cases.add(new Case(
                "C05-54",
                "capability",
                "traversal from a granted folder to an ungranted sibling",
                Kind.REJECT,
                t -> {
                    base.build(t);
                    t.ungrantedViaTraversal();
                },
                null,
                List.of(),
                Map.of(),
                "Path is not authorized. Choose it with the native folder picker or configure an allowed root."));
        cases.add(accept(
                "C05-55",
                "execution",
                "package/build scripts are inert input",
                t -> {
                    Path marker = t.outsidePath("executed-marker");
                    t.text(
                            "package.json",
                            "{\"name\":\"p\",\"scripts\":{\"preinstall\":\"touch " + marker
                                    + "\",\"postinstall\":\"touch " + marker + "\"}}\n");
                    t.text("build.gradle", "task x { doLast { new File('" + marker + "').text = 'x' } }\nx\n");
                    t.text(
                            "pom.xml",
                            "<project><build><plugins><plugin><artifactId>exec-maven-plugin</artifactId></plugin></plugins></build></project>\n");
                    t.text("setup.py", "open('" + marker + "','w').write('x')\n");
                    t.text("Makefile", "all:\n\ttouch " + marker + "\n");
                    t.expectAbsent(marker);
                },
                List.of("Makefile", "build.gradle", "package.json", "pom.xml", "setup.py"),
                ex()));
        // Races between preview and copy (refresh after a published snapshot, so the old pointer is observable).
        String a = "src/a.ts";
        Builder two = t -> {
            t.text(a, "export const a = 'AAAA';\n");
            t.text(main, "export const value = 1;\n");
        };
        cases.add(race(
                "C05-56",
                "same size and count, different content",
                two,
                t -> t.text(a, "export const a = 'BBBB';\n"),
                Kind.CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-57",
                "same size, same mtime, different content",
                two,
                t -> {
                    FileTime time = Files.getLastModifiedTime(t.path(a));
                    try (RandomAccessFile file = new RandomAccessFile(t.path(a).toFile(), "rw")) {
                        file.seek(20);
                        file.write('Z');
                    }
                    Files.setLastModifiedTime(t.path(a), time);
                },
                Kind.CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-58",
                "file swapped for a symlink",
                two,
                t -> {
                    Path outside = t.outsideSecret("swap-target.ts", "export const a = '%s';\n");
                    Files.delete(t.path(a));
                    t.symlink(a, outside);
                },
                Kind.CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-59",
                "rename with equal count",
                two,
                t -> Files.move(t.path(a), t.path("src/renamed.ts")),
                Kind.CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-60",
                "growth within the per-file limit",
                two,
                t -> Files.writeString(t.path(a), "// grown\n", java.nio.file.StandardOpenOption.APPEND),
                Kind.CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-61",
                "growth beyond the per-file limit",
                two,
                t -> Files.write(t.path(a), new byte[FILE_BYTES], java.nio.file.StandardOpenOption.APPEND),
                Kind.CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-62",
                "file replaced by a hard link",
                two,
                t -> {
                    Path outside = t.outsideSecret("hard-swap.ts", "export const a = '%s';\n");
                    Files.delete(t.path(a));
                    Files.createLink(t.path(a), outside);
                },
                Kind.CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-63",
                "file replaced by a FIFO",
                two,
                t -> {
                    Files.delete(t.path(a));
                    t.fifo(a);
                },
                Kind.CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-64",
                "delete one and add another of equal size",
                two,
                t -> {
                    Files.delete(t.path(a));
                    t.text("src/b.ts", "export const b = 'AAAA';\n");
                },
                Kind.CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-65",
                "ignore rule change re-includes a file",
                t -> {
                    two.build(t);
                    t.text(".gitignore", "notes.txt\n");
                    t.text("notes.txt", "public notes\n");
                },
                t -> Files.writeString(t.path(".gitignore"), "other.txt\n"),
                Kind.CONFLICT,
                List.of(".gitignore", a, main)));
        cases.add(race(
                "C05-66",
                "root replaced by an identical copy",
                two,
                Tree::replaceRoot,
                Kind.CONFIRM_CONFLICT,
                List.of(a, main)));
        cases.add(race(
                "C05-67",
                "excluded secret added after preview is not copied",
                two,
                t -> t.secret("config/.env", "TOKEN=%s\n"),
                Kind.ACCEPT,
                List.of(a, main)));
        // Hard 2 MiB per-file ceiling when the configured limit is larger (service-level, real filesystem).
        int ceiling = 2 * 1024 * 1024;
        cases.add(new Case(
                        "C05-68",
                        "bytes",
                        "configured 4 MiB is capped: 2 MiB - 1 accepted",
                        Kind.CEILING,
                        t -> t.repeated("src/ceiling.txt", ceiling - 1),
                        null,
                        List.of("src/ceiling.txt"),
                        ex(),
                        null)
                .bytes(ceiling - 1));
        cases.add(new Case(
                        "C05-69",
                        "bytes",
                        "configured 4 MiB is capped: exactly 2 MiB accepted",
                        Kind.CEILING,
                        t -> t.repeated("src/ceiling.txt", ceiling),
                        null,
                        List.of("src/ceiling.txt"),
                        ex(),
                        null)
                .bytes(ceiling));
        cases.add(new Case(
                        "C05-70",
                        "bytes",
                        "configured 4 MiB is capped: 2 MiB + 1 excluded",
                        Kind.CEILING,
                        t -> {
                            base.build(t);
                            t.repeated("src/ceiling.txt", ceiling + 1);
                        },
                        null,
                        List.of(main),
                        ex("OVERSIZED", 1),
                        null)
                .bytes(mainBytes));
        cases.add(new Case(
                "C05-71",
                "root",
                "picker result is a symlink into a credential directory",
                Kind.REJECT,
                t -> {
                    Path real = t.outsidePath(".ssh/project");
                    Files.createDirectories(real);
                    Files.writeString(real.resolve("x.ts"), "export const x = 1;\n");
                    Files.delete(t.root);
                    Files.createSymbolicLink(t.root, real);
                },
                null,
                List.of(),
                Map.of(),
                "Choose a project folder outside credential directories."));
        return cases;
    }

    @TestFactory
    @Order(1)
    Stream<DynamicTest> c05ImportSecretsCorpus() throws Exception {
        assertThat(sourceClient.enabled()).isTrue();
        attachLogCapture();
        Files.createDirectories(app.reposRoot());
        List<Case> cases = corpus();
        assertThat(cases).hasSizeGreaterThanOrEqualTo(40);
        assertThat(cases.stream().map(Case::id).distinct().count()).isEqualTo(cases.size());
        return cases.stream()
                .map(c -> DynamicTest.dynamicTest(
                        c.id() + " " + c.attack() + ": " + c.title()
                                + (c.deviation() == null ? "" : " [spec deviation]"),
                        () -> run(c)));
    }

    @Test
    @Order(2)
    void forbiddenSentinelsAreAbsentFromEveryPersistedOrEmittedSurface() throws Exception {
        assertThat(FORBIDDEN).isNotEmpty();
        assertThat(IMPORTED).isNotEmpty();
        byte[] marker = SENTINEL.getBytes(StandardCharsets.UTF_8);
        Map<String, Object> sweep = new LinkedHashMap<>();
        // PostgreSQL: every row of every application table, as text and as bytea hex.
        String hex = HexFormat.of().formatHex(marker);
        List<String> tables = jdbc.queryForList(
                "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1",
                String.class);
        int rows = 0;
        for (String table : tables) {
            assertThat(table).matches("[a-z0-9_]+");
            rows += jdbc.queryForObject("select count(*) from \"" + table + "\"", Integer.class);
            assertThat(jdbc.queryForObject(
                            "select count(*) from \"" + table + "\" x where strpos(row_to_json(x)::text, ?) > 0 "
                                    + "or strpos(lower(row_to_json(x)::text), ?) > 0",
                            Integer.class,
                            SENTINEL,
                            hex))
                    .as("sentinel rows in " + table)
                    .isZero();
        }
        sweep.put("postgresTables", tables.size());
        sweep.put("postgresRows", rows);
        // Encrypted store: no blob address exists for any forbidden plaintext, and blobs equal DB rows.
        Set<String> forbiddenHashes = new TreeSet<>();
        FORBIDDEN.values().forEach(list -> list.forEach(bytes -> forbiddenHashes.add(sha256(bytes))));
        Set<String> stored = new TreeSet<>();
        Path blobs = bridge.root.resolve("blobs");
        if (Files.isDirectory(blobs)) {
            try (var projectsDir = Files.list(blobs)) {
                for (Path project : projectsDir.toList()) {
                    try (var hashes = Files.list(project)) {
                        hashes.forEach(hash -> stored.add(project.getFileName() + "/" + hash.getFileName()));
                    }
                }
            }
        }
        Set<String> rowsInDb =
                new TreeSet<>(jdbc.queryForList("select project_id || '/' || sha256 from source_blobs", String.class));
        assertThat(stored).isEqualTo(rowsInDb);
        assertThat(stored.stream().map(entry -> entry.substring(entry.indexOf('/') + 1)))
                .doesNotContainAnyElementsOf(forbiddenHashes);
        try (var blobFiles = Files.walk(blobs)) {
            for (Path file : blobFiles.filter(Files::isRegularFile).toList())
                assertThat(indexOf(Files.readAllBytes(file), marker))
                        .as("ciphertext " + file.getFileName())
                        .isNegative();
        }
        sweep.put("vaultBlobAddresses", stored.size());
        sweep.put("forbiddenPlaintextHashes", forbiddenHashes.size());
        // Managed storage and disposable run workspaces: no plaintext residue at all.
        int managed = 0;
        try (var paths = Files.walk(app.reposRoot())) {
            for (Path file : paths.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                    .toList()) {
                managed++;
                assertThat(indexOf(Files.readAllBytes(file), marker))
                        .as("managed " + file)
                        .isNegative();
            }
        }
        sweep.put("managedFiles", managed);
        // Retained source, export and AI preview bodies of every imported project.
        var json = new JsonMapper();
        int retainedReads = 0, aiPreviews = 0;
        for (Imported imported : IMPORTED) {
            for (String path : imported.paths()) {
                var content = files.fileContent(imported.project(), imported.user(), path, imported.snapshot());
                assertThat(content.content()).doesNotContain(SENTINEL);
                retainedReads++;
            }
            var data = exports.buildExportData(imported.project(), imported.user());
            assertThat(exports.toMarkdown(data)).doesNotContain(SENTINEL);
            assertThat(json.writeValueAsString(exports.toJson(data))).doesNotContain(SENTINEL);
            List<String> focuses = new ArrayList<>(
                    imported.paths().subList(0, Math.min(3, imported.paths().size())));
            focuses.addAll(List.of(".env", "config/.env", "src/db.ts", "src/util.ts"));
            for (String focus : focuses) {
                try {
                    var preview = retrieval.retrievePreviewStructured(
                            imported.user(),
                            imported.project(),
                            imported.snapshot(),
                            app.reposRoot()
                                    .resolve(Long.toString(imported.project()))
                                    .toString(),
                            new ContextRetrievalService.AskContext(
                                    "code", focus, null, null, null, null, null, List.of()),
                            "Explain the configuration secrets and tokens in this project");
                    assertThat(json.writeValueAsString(preview)).doesNotContain(SENTINEL);
                    aiPreviews++;
                } catch (RuntimeException refused) {
                    // An excluded focus file may be refused; the refusal itself must not echo a sentinel.
                    assertThat(String.valueOf(refused.getMessage())).doesNotContain(SENTINEL);
                }
            }
        }
        sweep.put("retainedReads", retainedReads);
        sweep.put("exports", IMPORTED.size());
        sweep.put("aiPreviewBodies", aiPreviews);
        // Logs captured from the root logger during the whole corpus.
        assertThat(logs).isNotNull();
        int events = 0;
        for (ILoggingEvent event : List.copyOf(logs.list)) {
            events++;
            assertThat(event.getFormattedMessage()).doesNotContain(SENTINEL);
            if (event.getThrowableProxy() != null)
                assertThat(ThrowableProxyUtil.asString(event.getThrowableProxy()))
                        .doesNotContain(SENTINEL);
        }
        sweep.put("logEvents", events);
        REPORT.put("~sweep", sweep);
        writeReport();
    }

    private void run(Case c) throws Exception {
        Map<String, Object> outcome = new LinkedHashMap<>();
        outcome.put("attack", c.attack());
        outcome.put("title", c.title());
        outcome.put("kind", c.kind().name());
        REPORT.put(c.id(), outcome);
        Tree tree =
                new Tree(c.id(), Files.createDirectories(root.resolve("sources").resolve(c.id())));
        try {
            c.build().build(tree);
            if (tree.granted()) tree.grant = desktopPaths.authorize(tree.root).nonce();
            switch (c.kind()) {
                case ACCEPT -> {
                    if (c.race() == null) acceptFull(c, tree, outcome);
                    else raceAccepted(c, tree, outcome);
                }
                case ACCEPT_LIGHT -> acceptLight(c, tree, outcome);
                case CEILING -> ceiling(c, tree, outcome);
                case REJECT, REJECT_UNWALKED -> rejected(c, tree, outcome);
                case CONFLICT, CONFIRM_CONFLICT -> raceConflict(c, tree, outcome);
            }
            for (Path marker : tree.absent)
                assertThat(marker).as("execution sentinel").doesNotExist();
            if (c.deviation() != null) outcome.put("deviation", c.deviation());
            outcome.put("status", c.deviation() == null ? "PASS" : "FAIL_SPEC_DEVIATION");
        } catch (Throwable error) {
            outcome.put("status", error instanceof org.opentest4j.TestAbortedException ? "NOT_RUN" : "FAIL");
            throw error;
        } finally {
            tree.close();
            writeReport();
        }
    }

    private void acceptFull(Case c, Tree tree, Map<String, Object> outcome) throws Exception {
        TreeState before = TreeState.of(tree.root);
        long user = user(c.id());
        LocalSourcePreview preview = approvals.previewInitial(user, tree.root.toString(), "C05 " + c.id(), tree.grant);
        assertPreview(c, preview, outcome);
        var created = projects.createFromLocal(
                user,
                new ProjectController.CreateLocalProjectRequest(
                        tree.root.toString(), "C05 " + c.id(), preview.previewToken(), tree.grant));
        long project = created.project().id();
        runWorker(created.jobId());
        assertThat(jobs.findJob(created.jobId()).orElseThrow().status()).isEqualTo(JobStatus.DONE);
        long snapshot = jdbc.queryForObject("select current_snapshot_id from projects where id=?", Long.class, project);
        assertSnapshot(c.id(), tree, user, project, snapshot, c.selected(), outcome);
        assertThat(TreeState.of(tree.root)).as("original folder").isEqualTo(before);
        outcome.put("copy", "SNAPSHOT_PUBLISHED");
        outcome.put("originalUnchanged", true);
    }

    private void ceiling(Case c, Tree tree, Map<String, Object> outcome) throws Exception {
        TreeState before = TreeState.of(tree.root);
        var configured = new dev.codeintelligence.common.AnalysisProperties(
                ACCEPTED_FILES, 4L * 1024 * 1024, 10_000, 5, 1000, 0.5);
        LocalImportService service = new LocalImportService(
                app,
                new LocalImportProperties(""),
                desktopPaths,
                new LocalSourcePolicy(configured),
                LocalImportService::moveDirectory);
        var inspection = service.inspect(tree.root);
        assertThat(new TreeMap<>(inspection.summary().excludedEntriesByReason()))
                .isEqualTo(c.excluded());
        assertThat(inspection.summary().bytesRead()).isEqualTo(c.bytesRead());
        assertThat(inspection.gitFingerprints().keySet()).containsExactlyInAnyOrderElementsOf(c.selected());
        outcome.put(
                "preview",
                Map.of(
                        "service",
                        "LocalImportService.inspect with configured 4 MiB",
                        "acceptedFiles",
                        inspection.summary().acceptedFiles(),
                        "bytesRead",
                        inspection.summary().bytesRead(),
                        "excludedEntriesByReason",
                        new TreeMap<>(inspection.summary().excludedEntriesByReason())));
        Path target = app.reposRoot().resolve("c05-ceiling-" + c.id());
        var copied = service.importApproved(inspection.binding(), target);
        assertThat(copied.summary()).isEqualTo(inspection.summary());
        for (String path : c.selected())
            assertThat(Files.readAllBytes(target.resolve(path))).isEqualTo(Files.readAllBytes(tree.path(path)));
        outcome.put("copy", "COPIED_" + c.selected().size());
        deleteTree(target);
        assertThat(TreeState.of(tree.root)).as("original folder").isEqualTo(before);
        outcome.put("originalUnchanged", true);
    }

    private void acceptLight(Case c, Tree tree, Map<String, Object> outcome) throws Exception {
        TreeState before = TreeState.of(tree.root);
        long user = user(c.id());
        LocalSourcePreview preview = approvals.previewInitial(user, tree.root.toString(), "C05 " + c.id(), tree.grant);
        assertPreview(c, preview, outcome);
        // Same production copy (selection, staging verifier, synthetic Git); only the vault sink is omitted.
        LocalSourceBinding binding = imports.inspect(tree.root).binding();
        Path target = app.reposRoot().resolve("c05-light-" + c.id());
        var result = imports.importApproved(binding, target);
        assertThat(result.summary()).isEqualTo(preview.localImport());
        int expected = c.selected() == null ? ACCEPTED_FILES : c.selected().size();
        assertThat(preview.localImport().acceptedFiles()).isEqualTo(expected);
        int entries = 0;
        try (Git git = Git.open(target.toFile());
                RevWalk walk = new RevWalk(git.getRepository());
                TreeWalk files = new TreeWalk(git.getRepository())) {
            files.addTree(walk.parseCommit(git.getRepository().resolve(Constants.HEAD))
                    .getTree());
            files.setRecursive(true);
            while (files.next()) {
                entries++;
                if (c.selected() != null) assertThat(c.selected()).contains(files.getPathString());
            }
        }
        assertThat(entries).isEqualTo(expected);
        outcome.put("copy", "COPIED_" + entries);
        deleteTree(target);
        assertThat(TreeState.of(tree.root)).as("original folder").isEqualTo(before);
        outcome.put("originalUnchanged", true);
    }

    private void rejected(Case c, Tree tree, Map<String, Object> outcome) throws Exception {
        TreeState before = c.kind() == Kind.REJECT ? TreeState.of(tree.root) : null;
        long user = user(c.id());
        Throwable preview = catchFailure(
                () -> approvals.previewInitial(user, tree.submitted().toString(), "C05 " + c.id(), tree.grant));
        assertThat(reason(preview)).as("preview reason").isEqualTo(c.reason());
        outcome.put("preview", "REJECTED: " + c.reason());
        Path target = app.reposRoot().resolve("c05-reject-" + c.id());
        Throwable copy = catchFailure(() -> imports.importFolder(tree.submitted(), target));
        assertThat(reason(copy)).as("copy reason").isEqualTo(c.reason());
        assertThat(target).doesNotExist();
        try (var siblings = Files.list(app.reposRoot())) {
            assertThat(siblings.map(path -> path.getFileName().toString()))
                    .noneMatch(name -> name.startsWith("c05-reject-" + c.id()));
        }
        outcome.put("copy", "REJECTED: " + c.reason());
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where user_id=?", Integer.class, user))
                .isZero();
        assertThat(jdbc.queryForObject("select count(*) from projects where user_id=?", Integer.class, user))
                .isZero();
        if (before != null) {
            assertThat(TreeState.of(tree.root)).as("original folder").isEqualTo(before);
            outcome.put("originalUnchanged", true);
        }
    }

    private void raceConflict(Case c, Tree tree, Map<String, Object> outcome) throws Exception {
        Initial initial = initialImport(c, tree);
        LocalSourcePreview preview = approvals.previewRefresh(initial.project(), initial.user());
        assertThat(preview.changes().total()).isZero();
        if (c.kind() == Kind.CONFIRM_CONFLICT) {
            c.race().build(tree);
            TreeState raced = TreeState.of(tree.root);
            Throwable error =
                    catchFailure(() -> projects.reanalyze(initial.project(), initial.user(), preview.previewToken()));
            assertThat(error).isInstanceOf(LocalSourceApprovalException.class);
            assertThat(code(error)).isEqualTo(CHANGED);
            assertThat(((LocalSourceApprovalException) error).getStatusCode().value())
                    .isEqualTo(409);
            outcome.put("copy", "HTTP 409 " + CHANGED + " at confirmation");
            assertThat(jdbc.queryForObject(
                            "select count(*) from analysis_jobs where project_id=?", Integer.class, initial.project()))
                    .isEqualTo(1);
            assertThat(TreeState.of(tree.root)).isEqualTo(raced);
        } else {
            long job = projects.reanalyze(initial.project(), initial.user(), preview.previewToken());
            c.race().build(tree);
            TreeState raced = TreeState.of(tree.root);
            runWorker(job);
            var record = jobs.findJob(job).orElseThrow();
            assertThat(record.status()).isEqualTo(JobStatus.FAILED);
            assertThat(jdbc.queryForObject("select failure_code from analysis_jobs where id=?", String.class, job))
                    .isEqualTo(LocalSourceApprovalException.RECOVERY_CODE);
            assertThat(jdbc.queryForObject(
                            "select count(*) from snapshots where project_id=? and id<>?",
                            Integer.class,
                            initial.project(),
                            initial.snapshot()))
                    .isZero();
            outcome.put(
                    "copy",
                    "JOB_FAILED " + LocalSourceApprovalException.RECOVERY_CODE + " (" + CHANGED
                            + ", 409 problem type)");
            assertThat(TreeState.of(tree.root))
                    .as("raced folder unchanged by the failed copy")
                    .isEqualTo(raced);
        }
        assertThat(jdbc.queryForObject(
                        "select current_snapshot_id from projects where id=?", Long.class, initial.project()))
                .isEqualTo(initial.snapshot());
        for (String path : c.selected()) {
            assertThat(files.fileContent(initial.project(), initial.user(), path, initial.snapshot())
                            .content())
                    .isEqualTo(initial.contents().get(path));
        }
        outcome.put("oldPointerKept", true);
        outcome.put("originalUnchanged", true);
    }

    private void raceAccepted(Case c, Tree tree, Map<String, Object> outcome) throws Exception {
        Initial initial = initialImport(c, tree);
        LocalSourcePreview preview = approvals.previewRefresh(initial.project(), initial.user());
        long job = projects.reanalyze(initial.project(), initial.user(), preview.previewToken());
        c.race().build(tree);
        TreeState raced = TreeState.of(tree.root);
        runWorker(job);
        assertThat(jobs.findJob(job).orElseThrow().status()).isEqualTo(JobStatus.DONE);
        long snapshot = jdbc.queryForObject(
                "select current_snapshot_id from projects where id=?", Long.class, initial.project());
        assertThat(snapshot).isNotEqualTo(initial.snapshot());
        assertSnapshot(c.id(), tree, initial.user(), initial.project(), snapshot, c.selected(), outcome);
        assertThat(TreeState.of(tree.root)).isEqualTo(raced);
        outcome.put("copy", "SNAPSHOT_PUBLISHED; manifest-equal excluded addition not copied");
        outcome.put("originalUnchanged", true);
    }

    private record Initial(long user, long project, long snapshot, Map<String, String> contents) {}

    private Initial initialImport(Case c, Tree tree) throws Exception {
        long user = user(c.id());
        LocalSourcePreview preview = approvals.previewInitial(user, tree.root.toString(), "C05 " + c.id(), tree.grant);
        assertThat(preview.localImport().acceptedFiles()).isEqualTo(c.selected().size());
        var created = projects.createFromLocal(
                user,
                new ProjectController.CreateLocalProjectRequest(
                        tree.root.toString(), "C05 " + c.id(), preview.previewToken(), tree.grant));
        runWorker(created.jobId());
        assertThat(jobs.findJob(created.jobId()).orElseThrow().status()).isEqualTo(JobStatus.DONE);
        long project = created.project().id();
        long snapshot = jdbc.queryForObject("select current_snapshot_id from projects where id=?", Long.class, project);
        Map<String, String> contents = new TreeMap<>();
        for (String path : c.selected()) contents.put(path, Files.readString(tree.path(path)));
        return new Initial(user, project, snapshot, contents);
    }

    private void assertPreview(Case c, LocalSourcePreview preview, Map<String, Object> outcome) throws Exception {
        assertThat(preview.previewToken()).matches("[0-9a-f]{64}");
        assertThat(java.time.Duration.between(java.time.Instant.now(), preview.expiresAt()))
                .isBetween(Duration.ofMinutes(9), Duration.ofMinutes(10).plusSeconds(5));
        var summary = preview.localImport();
        assertThat(new TreeMap<>(summary.excludedEntriesByReason()))
                .as("excluded by reason")
                .isEqualTo(c.excluded());
        if (c.bytesRead() != null)
            assertThat(summary.bytesRead()).as("actual bytes read").isEqualTo(c.bytesRead());
        if (c.selected() != null) {
            assertThat(summary.acceptedFiles())
                    .as("accepted files")
                    .isEqualTo(c.selected().size());
            if (c.selected().size() <= 100)
                assertThat(preview.changedPaths())
                        .containsExactlyElementsOf(c.selected().stream()
                                .map(path -> "A " + path)
                                .sorted()
                                .toList());
        }
        assertThat(new JsonMapper().writeValueAsString(preview)).doesNotContain(SENTINEL);
        outcome.put(
                "preview",
                Map.of(
                        "acceptedFiles",
                        summary.acceptedFiles(),
                        "bytesRead",
                        summary.bytesRead(),
                        "excludedEntriesByReason",
                        new TreeMap<>(summary.excludedEntriesByReason())));
    }

    private void assertSnapshot(
            String id,
            Tree tree,
            long user,
            long project,
            long snapshot,
            List<String> selected,
            Map<String, Object> outcome)
            throws Exception {
        assertThat(files.listFiles(project, user, snapshot).stream()
                        .map(FileService.FileListItem::path)
                        .toList())
                .containsExactlyInAnyOrderElementsOf(selected);
        assertThat(jdbc.queryForList("""
                        select e.path from source_manifest_entries e join source_manifests m on m.id=e.manifest_id
                        where m.snapshot_id=? and m.sealed_at is not null order by e.path
                        """, String.class, snapshot)).containsExactlyInAnyOrderElementsOf(selected);
        for (String path : selected) {
            var content = files.fileContent(project, user, path, snapshot);
            assertThat(content.content().getBytes(StandardCharsets.UTF_8))
                    .isEqualTo(Files.readAllBytes(tree.path(path)));
            assertThat(content.sourceState()).isEqualTo("AVAILABLE");
        }
        try (var residue = Files.list(app.reposRoot().resolve(".analysis-runs"))) {
            assertThat(residue.map(path -> path.getFileName().toString()).toList())
                    .containsExactly("owner.lock");
        }
        IMPORTED.add(new Imported(id, user, project, snapshot, List.copyOf(selected)));
        outcome.put("snapshotFiles", selected.size());
    }

    private void runWorker(long jobId) {
        jdbc.update(
                "delete from analysis_job_steps where job_id=? and step_key not in (?,?,?)",
                jobId,
                ImportStep.KEY,
                FileInventoryStep.KEY,
                FinalizeStep.KEY);
        assertThat(jobs.findJob(jobId).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        JobWorker isolated = new JobWorker(
                jobs,
                new Pipeline(List.of(importStep, inventoryStep, finalizeStep)),
                mock(JobProgressPublisher.class),
                app,
                workspaces);
        try {
            ReflectionTestUtils.invokeMethod(isolated, "runJob", jobId);
        } finally {
            ReflectionTestUtils.invokeMethod(isolated, "shutdown");
        }
    }

    private long user(String id) {
        String unique = id + "-" + UUID.randomUUID();
        return jdbc.queryForObject(
                "insert into users(login,identity_type,local_key) values (?, 'LOCAL', ?) returning id",
                Long.class,
                "c05-" + unique,
                unique);
    }

    private static Throwable catchFailure(ThrowingRunnable action) {
        try {
            action.run();
        } catch (Throwable error) {
            return error;
        }
        throw new AssertionError("The operation was expected to be refused");
    }

    @FunctionalInterface
    interface ThrowingRunnable {
        void run() throws Exception;
    }

    private static String reason(Throwable error) {
        if (error instanceof LocalSourceApprovalException approval) return code(approval);
        assertThat(error).isInstanceOf(LocalImportException.class);
        Throwable cause = error.getCause();
        if (cause instanceof IOException io && io.getClass() == IOException.class) return io.getMessage();
        return error.getMessage();
    }

    private static String code(Throwable error) {
        return String.valueOf(
                ((LocalSourceApprovalException) error).getBody().getProperties().get("code"));
    }

    private void attachLogCapture() {
        if (logs != null) return;
        logs = new ListAppender<>();
        logs.start();
        ((Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME)).addAppender(logs);
    }

    private static synchronized void writeReport() {
        try {
            Path report = Path.of("build", "reports", "c05-import-secrets-corpus.json")
                    .toAbsolutePath();
            Files.createDirectories(report.getParent());
            Map<String, Object> document = new LinkedHashMap<>();
            document.put("format", 1);
            document.put("corpus", "C05 import-secrets");
            document.put("cases", REPORT);
            Files.writeString(
                    report, new JsonMapper().writerWithDefaultPrettyPrinter().writeValueAsString(document) + "\n");
        } catch (IOException error) {
            throw new IllegalStateException("C05 report could not be written", error);
        }
    }

    static void totalBytes(Tree t, int delta) throws Exception {
        String text = "export const a = 1;\n"; // 20 bytes
        t.text("a.ts", text);
        long remaining = TOTAL_BYTES + delta - text.length();
        for (int index = 0; remaining > 0; index++) {
            long size = Math.min(FILE_BYTES, remaining);
            t.sparse(String.format("z/%03d.txt", index), size);
            remaining -= size;
        }
    }

    static void encountered(Tree t, int total) throws Exception {
        t.text("a.ts", "export const a = 1;\n");
        for (int index = 1; index < total; index++) {
            Path file = t.path(String.format("img/%03d/%05d.png", index / 1000, index));
            Files.createDirectories(file.getParent());
            Files.createFile(file);
        }
    }

    static void eligible(Tree t, int total) throws Exception {
        for (int index = 0; index < total; index++) {
            Path file = t.path(String.format("e/%03d/%05d.ts", index / 1000, index));
            if (index % 1000 == 0) Files.createDirectories(file.getParent());
            Files.createFile(file);
        }
    }

    static byte[] sentinel(String id, String label) {
        return (SENTINEL + "-" + id + "-" + label + "-" + UUID.randomUUID()).getBytes(StandardCharsets.UTF_8);
    }

    static byte[] oversized(String id) {
        byte[] bytes = new byte[FILE_BYTES + 1];
        java.util.Arrays.fill(bytes, (byte) 'x');
        byte[] marker = sentinel(id, "oversized");
        System.arraycopy(marker, 0, bytes, 0, marker.length);
        return bytes;
    }

    static byte[] concat(byte[] first, byte[] second) {
        byte[] result = java.util.Arrays.copyOf(first, first.length + second.length);
        System.arraycopy(second, 0, result, first.length, second.length);
        return result;
    }

    static byte[] storedZip(String name, byte[] content) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            ZipEntry entry = new ZipEntry(name);
            entry.setMethod(ZipEntry.STORED);
            entry.setSize(content.length);
            CRC32 crc = new CRC32();
            crc.update(content);
            entry.setCrc(crc.getValue());
            zip.putNextEntry(entry);
            zip.write(content);
            zip.closeEntry();
        }
        return bytes.toByteArray();
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int index = 0; index <= haystack.length - needle.length; index++) {
            for (int offset = 0; offset < needle.length; offset++)
                if (haystack[index + offset] != needle[offset]) continue outer;
            return index;
        }
        return -1;
    }

    static void deleteTree(Path path) throws IOException {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
        try (var paths = Files.walk(path)) {
            for (Path entry : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(entry);
        }
    }

    /** Synthetic fixture tree. Every forbidden byte sequence is registered before it is written. */
    final class Tree implements AutoCloseable {
        final String id;
        Path root;
        Path submitted;
        boolean granted = true;
        String grant;
        final List<Path> absent = new ArrayList<>();
        final List<Path> cleanup = new ArrayList<>();
        final List<Path> mounts = new ArrayList<>();
        final Path outside;

        Tree(String id, Path root) throws IOException {
            this.id = id;
            this.root = root;
            this.outside =
                    Files.createDirectories(Path.of(ImportSecretsCorpusIntegrationTest.root.toString(), "outside", id));
        }

        Path path(String relative) {
            return root.resolve(relative);
        }

        boolean granted() {
            return granted && Files.isDirectory(root) && root.startsWith(ImportSecretsCorpusIntegrationTest.root);
        }

        Path submitted() {
            return submitted == null ? root : submitted;
        }

        void at(Path replacement) throws IOException {
            if (replacement.startsWith(ImportSecretsCorpusIntegrationTest.root)) {
                Files.createDirectories(replacement);
                cleanup.add(replacement);
            }
            root = replacement;
        }

        void ungranted() {
            granted = false;
        }

        void ungrantedViaTraversal() throws IOException {
            Path sibling = Files.createDirectories(root.resolveSibling(id + "-ungranted-sibling"));
            Files.writeString(sibling.resolve("x.ts"), "export const x = 1;\n");
            cleanup.add(sibling);
            submitted = Path.of(root.toString(), "..", id + "-ungranted-sibling");
        }

        void text(String relative, String content) throws IOException {
            Path file = path(relative);
            Files.createDirectories(file.getParent());
            Files.writeString(file, content);
        }

        void repeated(String relative, int size) throws IOException {
            byte[] bytes = new byte[size];
            for (int index = 0; index < size; index++) bytes[index] = (byte) (index % 64 == 63 ? '\n' : 'a');
            Path file = path(relative);
            Files.createDirectories(file.getParent());
            Files.write(file, bytes);
        }

        void secret(String relative, String template) throws IOException {
            forbiddenBytes(
                    relative,
                    template.formatted(new String(sentinel(id, relative), StandardCharsets.UTF_8))
                            .getBytes(StandardCharsets.UTF_8));
        }

        void forbiddenBytes(String relative, byte[] bytes) throws IOException {
            FORBIDDEN.computeIfAbsent(id, key -> new ArrayList<>()).add(bytes);
            Path file = path(relative);
            Files.createDirectories(file.getParent());
            Files.write(file, bytes);
        }

        void forbiddenName(String relative, String content) throws IOException {
            FORBIDDEN.computeIfAbsent(id, key -> new ArrayList<>()).add(content.getBytes(StandardCharsets.UTF_8));
            text(relative, content);
        }

        Path outsideSecret(String relative, String template) throws IOException {
            byte[] bytes = template.formatted(new String(sentinel(id, relative), StandardCharsets.UTF_8))
                    .getBytes(StandardCharsets.UTF_8);
            FORBIDDEN.computeIfAbsent(id, key -> new ArrayList<>()).add(bytes);
            Path file = outside.resolve(relative);
            Files.createDirectories(file.getParent());
            Files.write(file, bytes);
            return file;
        }

        Path outsidePath(String name) {
            return outside.resolve(name);
        }

        void expectAbsent(Path marker) {
            absent.add(marker);
        }

        void symlink(String relative, Path target) throws IOException {
            Path link = path(relative);
            Files.createDirectories(link.getParent());
            Files.createSymbolicLink(link, target);
        }

        void hardlink(String relative, String existing) throws IOException {
            Files.createLink(path(relative), path(existing));
        }

        void sparse(String relative, long size) throws IOException {
            Path file = path(relative);
            Files.createDirectories(file.getParent());
            try (RandomAccessFile handle = new RandomAccessFile(file.toFile(), "rw")) {
                handle.setLength(size);
            }
        }

        void fifo(String relative) throws Exception {
            Path file = path(relative);
            Files.createDirectories(file.getParent());
            Process process = new ProcessBuilder("/usr/bin/mkfifo", file.toString())
                    .redirectErrorStream(true)
                    .start();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).isZero();
            assertThat(Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)).isFalse();
        }

        void socket(String relative) throws Exception {
            // AF_UNIX paths are short; bind in /tmp, then rename the socket inode into the fixture.
            Path shortDir = Files.createTempDirectory(
                    Path.of("/tmp"),
                    "c05-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            Path bound = shortDir.resolve("s");
            try (ServerSocketChannel channel = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
                channel.bind(UnixDomainSocketAddress.of(bound));
            }
            Path file = path(relative);
            Files.createDirectories(file.getParent());
            Files.move(bound, file);
            Files.delete(shortDir);
            assertThat((Boolean) Files.getAttribute(file, "isOther", LinkOption.NOFOLLOW_LINKS))
                    .isTrue();
        }

        void mount(String relative, boolean caseSensitive, MountAction action) throws Exception {
            Assumptions.assumeTrue(
                    Files.isExecutable(Path.of("/usr/bin/hdiutil")), "hdiutil is required for a real volume");
            Path images = Files.createDirectories(outside.resolve("images"));
            Path image = images.resolve("volume.sparseimage");
            exec(
                    "/usr/bin/hdiutil",
                    "create",
                    "-quiet",
                    "-size",
                    "16m",
                    "-type",
                    "SPARSE",
                    "-fs",
                    caseSensitive ? "Case-sensitive APFS" : "APFS",
                    "-volname",
                    "c05" + id.replace("-", ""),
                    image.toString());
            Path mountpoint = Files.createDirectories(relative == null ? images.resolve("mnt") : path(relative));
            exec(
                    "/usr/bin/hdiutil",
                    "attach",
                    "-quiet",
                    "-nobrowse",
                    "-noautoopen",
                    "-owners",
                    "on",
                    "-mountpoint",
                    mountpoint.toString(),
                    image.toString());
            mounts.add(mountpoint);
            action.run(mountpoint);
        }

        void caseSensitiveRoot() throws Exception {
            mount(null, true, volume -> {
                Path project = Files.createDirectories(volume.resolve("project"));
                Files.writeString(project.resolve("A.ts"), "export const upper = 1;\n");
                Files.writeString(project.resolve("a.ts"), "export const lower = 1;\n");
                try (var names = Files.list(project)) {
                    assertThat(names.map(path -> path.getFileName().toString())
                                    .sorted()
                                    .toList())
                            .containsExactly("A.ts", "a.ts");
                }
                root = project;
            });
        }

        void replaceRoot() throws IOException {
            Path original = root.resolveSibling(root.getFileName() + "-replaced-original");
            Files.move(root, original);
            cleanup.add(original);
            Files.createDirectories(root.resolve("src"));
            try (var paths = Files.walk(original)) {
                for (Path source : paths.filter(Files::isRegularFile).toList())
                    Files.copy(source, root.resolve(original.relativize(source).toString()));
            }
        }

        @Override
        public void close() throws Exception {
            for (Path mount : mounts) exec("/usr/bin/hdiutil", "detach", "-quiet", "-force", mount.toString());
            // Bulk fixtures are removed after their result is recorded to keep the disk budget.
            Path fixtures =
                    ImportSecretsCorpusIntegrationTest.root.resolve("sources").resolve(id);
            if (Files.exists(fixtures.resolve("z"))
                    || Files.exists(fixtures.resolve("img"))
                    || Files.exists(fixtures.resolve("e"))) {
                deleteTree(fixtures);
            }
            Path images = outside.resolve("images");
            if (Files.exists(images)) deleteTree(images);
        }
    }

    @FunctionalInterface
    interface MountAction {
        void run(Path mountpoint) throws Exception;
    }

    static void exec(String... command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        byte[] output = process.getInputStream().readAllBytes();
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue())
                .as(command[0] + " " + command[1] + ": " + new String(output, StandardCharsets.UTF_8))
                .isZero();
    }

    /** lstat-level state of a tree: names, types, sizes, modes, times, link targets and content hashes. */
    record TreeState(Map<String, String> entries) {
        static TreeState of(Path root) throws IOException {
            Map<String, String> entries = new TreeMap<>();
            Object device = Files.getAttribute(root, "unix:dev", LinkOption.NOFOLLOW_LINKS);
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                    if (!device.equals(Files.getAttribute(dir, "unix:dev", LinkOption.NOFOLLOW_LINKS))) {
                        entries.put(root.relativize(dir).toString(), "mountpoint");
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    entries.put(
                            root.relativize(dir).toString(),
                            "dir " + Files.getAttribute(dir, "unix:mode", LinkOption.NOFOLLOW_LINKS) + " "
                                    + attrs.lastModifiedTime());
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    Map<String, Object> unix = Files.readAttributes(
                            file, "unix:mode,ino,nlink,size,lastModifiedTime", LinkOption.NOFOLLOW_LINKS);
                    String common = unix.get("mode") + " " + unix.get("ino") + " " + unix.get("nlink") + " "
                            + unix.get("size") + " " + unix.get("lastModifiedTime");
                    String value;
                    if (attrs.isSymbolicLink()) value = "link " + common + " -> " + Files.readSymbolicLink(file);
                    else if (attrs.isRegularFile()) value = "file " + common + " " + hash(file);
                    else value = "other " + common; // FIFO/socket: never opened.
                    entries.put(root.relativize(file).toString(), value);
                    return FileVisitResult.CONTINUE;
                }
            });
            return new TreeState(entries);
        }

        private static String hash(Path file) throws IOException {
            try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] buffer = new byte[1 << 16];
                int count;
                while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
                return HexFormat.of().formatHex(digest.digest());
            } catch (java.security.NoSuchAlgorithmException error) {
                throw new IllegalStateException(error);
            }
        }
    }

    private static final class NodeBridge implements AutoCloseable {
        private static final String TOKEN = "d".repeat(64); // Public fixture capability, never a source root key.
        private final Path root;
        private final Path socket;
        private final Path config;
        private final Path stderr;
        private Process process;
        private BufferedReader stdout;

        NodeBridge() throws Exception {
            root = Files.createTempDirectory(
                            Path.of("/tmp"),
                            "ci-c05-",
                            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
                    .toRealPath();
            socket = root.resolve("broker.sock");
            config = Files.createFile(
                    root.resolve("config.json"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            stderr = Files.createFile(
                    root.resolve("stderr.log"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            Files.writeString(
                    config,
                    JsonMapper.builder()
                            .build()
                            .writeValueAsString(Map.of(
                                    "root", root.toString(), "socketPath", socket.toString(), "authToken", TOKEN)));
        }

        synchronized void start() throws Exception {
            if (process != null && process.isAlive()) return;
            Path fixture = Path.of("../desktop/test/fixtures/source-store-server.cjs")
                    .toAbsolutePath()
                    .normalize();
            assertThat(fixture).isRegularFile();
            process = new ProcessBuilder("node", fixture.toString(), config.toString())
                    .redirectError(stderr.toFile())
                    .start();
            stdout = process.inputReader(StandardCharsets.UTF_8);
            var readers = Executors.newVirtualThreadPerTaskExecutor();
            var ready = readers.submit(stdout::readLine);
            try {
                assertThat(ready.get(10, TimeUnit.SECONDS)).isEqualTo("READY");
            } catch (Throwable error) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
                throw error;
            } finally {
                readers.shutdownNow();
                assertThat(readers.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
            }
            assertThat(Files.readString(stderr)).isEmpty();
        }

        synchronized void stop() throws Exception {
            if (process == null) return;
            if (process.isAlive()) {
                process.getOutputStream().write("stop\n".getBytes(StandardCharsets.UTF_8));
                process.getOutputStream().flush();
                if (!process.waitFor(15, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    throw new AssertionError("Disposable source bridge did not stop");
                }
            }
            assertThat(process.exitValue()).isZero();
            assertThat(stdout.readLine()).isNull();
            assertThat(Files.readString(stderr)).isEmpty();
            stdout.close();
            process = null;
        }

        @Override
        public void close() throws Exception {
            stop();
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }
}
