package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeout;

import dev.codeintelligence.analysis.core.FileInventoryScanner;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.ServerSocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class LocalIngestPolicyTest {
    @TempDir
    Path temp;

    private static final long SECOND = Duration.ofSeconds(1).toNanos();

    private LocalSourcePolicy.Limits limits(int files, long fileBytes, long totalBytes) {
        return new LocalSourcePolicy.Limits(files, fileBytes, totalBytes, 1000, 4000, 16, SECOND);
    }

    private LocalImportService service() throws IOException {
        return service(limits(100, 32 * 1024, 1024 * 1024), path -> {}, LocalImportService::moveDirectory);
    }

    private LocalImportService service(
            LocalSourcePolicy.Limits limits,
            LocalSourcePolicy.ReadObserver observer,
            LocalImportService.DirectoryMover mover)
            throws IOException {
        return new LocalImportService(
                new AppProperties(temp.resolve("data").toString(), 2),
                new LocalImportProperties(temp.toRealPath().toString()),
                new DesktopPathAuthorizationService(),
                new LocalSourcePolicy(limits, () -> 0, observer),
                mover);
    }

    private Path source(Map<String, byte[]> files) throws IOException {
        Path root = temp.resolve("source");
        Files.createDirectories(root);
        for (Map.Entry<String, byte[]> entry : files.entrySet()) write(root, entry.getKey(), entry.getValue());
        return root;
    }

    private Path source(String path, String text) throws IOException {
        return source(Map.of(path, text.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private void write(Path root, String relative, byte[] bytes) throws IOException {
        Path file = root.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.write(file, bytes);
    }

    private Path target() {
        return temp.resolve("data/repos/17");
    }

    @Test
    void previewCopyGitTreeAndInventoryHaveTheSameRawBytes() throws Exception {
        Path source = source("src/App.java", "class App {}\r\n");
        Files.writeString(source.resolve(".gitattributes"), "* text eol=lf\n*.java filter=must-not-run\n");
        Files.writeString(source.resolve("empty.txt"), "");
        Files.writeString(source.resolve("README.md"), "# local fixture\n");
        assertSameSelection(service(), source);
        assertThat(Files.readString(target().resolve("src/App.java"))).isEqualTo("class App {}\r\n");
    }

    @Test
    void onlyLocalIgnoreRulesApplyIncludingNegationNestingAndDirectoryPruning() throws Exception {
        Path source = source(".gitignore", "*.log\n!keep.log\nignored/\n");
        write(source, "keep.log", "kept".getBytes());
        write(source, "drop.log", "ignored log".getBytes());
        write(source, "nested/.gitignore", "*.tmp\n!keep.tmp\n".getBytes());
        write(source, "nested/drop.tmp", "ignored tmp".getBytes());
        write(source, "nested/keep.tmp", "kept nested".getBytes());
        write(source, "ignored/never.java", "ignored subtree".getBytes());
        write(source, ".git/HEAD", "ref: refs/heads/main\n".getBytes());
        write(
                source,
                ".git/config",
                ("[include]\npath = " + temp.resolve("never-read")
                                + "\n[core]\nworktree = /untrusted\nexcludesFile = /untrusted\n")
                        .getBytes());
        write(source, ".git/info/exclude", "keep.log\n".getBytes());
        List<Path> opened = new ArrayList<>();
        LocalImportService service =
                service(limits(100, 32 * 1024, 1024 * 1024), opened::add, LocalImportService::moveDirectory);

        LocalImportService.LocalImportResult result = assertSameSelection(service, source);

        assertThat(result.branch()).isEqualTo("main");
        assertThat(result.hasUncommittedChanges()).isNull();
        assertThat(result.summary().excludedEntriesByReason()).containsEntry("IGNORED", 3);
        assertThat(opened)
                .noneMatch(path -> path.endsWith("config")
                        || path.endsWith("exclude")
                        || path.toString().contains("ignored/never"));
        assertThat(service.fingerprint(source).keySet())
                .containsExactlyInAnyOrder(".gitignore", "keep.log", "nested/.gitignore", "nested/keep.tmp");
    }

    @Test
    void ignoreRulesSupportAnchorsEscapedMarkersAndParentNegation() throws Exception {
        Path source = source(".gitignore", "/root.tmp\n\\#literal\n\\!literal\nparent/*\n!parent/keep/\n");
        for (String path : List.of(
                "root.tmp", "nested/root.tmp", "#literal", "!literal", "parent/drop.txt", "parent/keep/App.java")) {
            write(source, path, "safe".getBytes());
        }
        assertSameSelection(service(), source);
        assertThat(service().fingerprint(source).keySet())
                .containsExactlyInAnyOrder(".gitignore", "nested/root.tmp", "parent/keep/App.java");
    }

    @Test
    void utf8ByteIgnoreRulesExcludeNonAsciiFilesFromEveryStoredRepresentation() throws Exception {
        Path source = source("Main.java", "class Main {}\n");
        Files.writeString(source.resolve(".gitignore"), "korean/???.txt\nemoji/????.txt\naccent/??.txt\n");
        Map<String, String> excluded = Map.of(
                "korean/한.txt", "ignored Korean fixture",
                "emoji/😀.txt", "ignored emoji fixture",
                "accent/é.txt", "ignored accented fixture");
        for (var entry : excluded.entrySet()) {
            write(source, entry.getKey(), entry.getValue().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }

        LocalImportService.LocalImportResult result = assertSameSelection(service(), source);

        assertThat(service().fingerprint(source).keySet()).containsExactlyInAnyOrder("Main.java", ".gitignore");
        assertThat(result.summary().excludedEntriesByReason()).containsEntry("IGNORED", 3);
        for (var entry : excluded.entrySet()) {
            assertThat(target().resolve(entry.getKey())).doesNotExist();
            assertBlobAbsent(entry.getValue());
            assertThat(Files.readString(source.resolve(entry.getKey()))).isEqualTo(entry.getValue());
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "nested/.aws/credentials",
                "nested/.ssh/data.txt",
                "nested/.config/private.txt",
                ".env",
                ".env.example",
                "keys/signing.pem",
                "credentials.json",
                ".pypirc",
                "config/tls.key",
                ".azure/tokens"
            })
    void excludedSecretPathsNeverReachWorkingFilesOrGitObjects(String secretPath) throws Exception {
        Path source = source("Main.java", "class Main {}\n");
        String sentinel = "private-fixture-" + secretPath;
        write(source, secretPath, sentinel.getBytes());
        Files.writeString(source.resolve(".gitignore"), "!.env\n!.aws/\n!*.pem\n");
        Map<String, String> before = service().fingerprint(source);

        LocalImportService.LocalImportResult result = service().importFolder(source, target());

        assertThat(before).doesNotContainKey(secretPath);
        assertThat(target().resolve(secretPath)).doesNotExist();
        assertThat(result.summary().excludedEntriesByReason()).containsEntry("SECRET_PATH", 1);
        assertBlobAbsent(sentinel);
        assertThat(Files.readString(source.resolve(secretPath))).isEqualTo(sentinel);
    }

    @ParameterizedTest
    @ValueSource(strings = {".aws", ".ssh", ".gnupg", ".config", ".kube", ".azure"})
    void selectingAChildOfACredentialDirectoryIsRejectedBeforeStaging(String directory) throws Exception {
        Path original = source("Main.java", "old");
        service().importFolder(original, target());
        Path source =
                source(directory + "/profile/settings.txt", "private fixture").resolve(directory + "/profile");
        LocalImportService service = service();
        assertThatThrownBy(() -> service.fingerprint(source)).isInstanceOf(LocalImportException.class);
        assertThatThrownBy(() -> service.importFolder(source, target())).isInstanceOf(LocalImportException.class);
        assertThat(Files.readString(target().resolve("Main.java"))).isEqualTo("old");
        assertThat(Files.readString(source.resolve("settings.txt"))).isEqualTo("private fixture");
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "gHo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "ghU_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "GHs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "gHR_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "AK" + "IA" + "AAAAAAAAAAAAAAAA",
                "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "AI" + "za" + "AAAAAAAAAAAAAAAAAAAA",
                "bEaReR\tAAAAAAAAAAAAAAAA==",
                "-----BEGIN RSA PRIVATE KEY-----",
                "-----BEGIN PRIVATE KEY-----",
                "password=literal-password",
                "passwd=literal-password",
                "client_secret=literal-client-secret",
                "ToKeN: 'literal-token'",
                "SECRET: literal-secret",
                "api_key=literal-api-key",
                "api-key: literal-api-key",
                "APIKEY: literal-api-key"
            })
    void theEntireBoundedFileIsCheckedForCredentialMaterial(String sentinel) throws Exception {
        Path source = source("Main.java", "class Main {}\n");
        String body = "ordinary text\n".repeat(800) + sentinel;
        Files.writeString(source.resolve("notes.txt"), body);
        LocalImportService.LocalImportResult result = service().importFolder(source, target());
        assertThat(result.summary().excludedEntriesByReason()).containsEntry("SECRET_CONTENT", 1);
        assertThat(service().fingerprint(source)).doesNotContainKey("notes.txt");
        assertThat(target().resolve("notes.txt")).doesNotExist();
        assertBlobAbsent(body);
    }

    @Test
    void environmentReferencesAreRetainedWithoutClaimingPerfectSecretDetection() throws Exception {
        Path source = source(
                "application.yml",
                "password: ${DB_PASSWORD}\napi_key: ${API_KEY_ENV}\nclient_secret: '${CLIENT_SECRET}'\n");
        assertSameSelection(service(), source);
        assertThat(target().resolve("application.yml")).exists();
    }

    @Test
    void sourceTypesAndEnvironmentExpressionsAreNotCredentials() throws Exception {
        Path source = source(
                "account.ts",
                "interface Account { password: string; token: string }\n"
                        + "const settings = { password: process.env.DB_PASSWORD, token: process.env.API_TOKEN };\n");
        assertSameSelection(service(), source);
        assertThat(target().resolve("account.ts")).exists();
    }

    @Test
    void upperCaseConfigLiteralsAreNotMistakenForEnvironmentReferences() throws Exception {
        Path source = source("application.yml", "password: PASSWORD123\n");
        LocalImportService.LocalImportResult result = service().importFolder(source, target());
        assertThat(result.summary().excludedEntriesByReason()).containsEntry("SECRET_CONTENT", 1);
        assertThat(target().resolve("application.yml")).doesNotExist();
    }

    @ParameterizedTest
    @ValueSource(strings = {"symlink", "hardlink"})
    void unsafeIgnoreFilesFailClosedAndPreserveTheOldRepository(String kind) throws Exception {
        Path source = source("a.txt", "old");
        service().importFolder(source, target());
        Path outside = temp.resolve("outside-ignore");
        Files.writeString(outside, "private.txt\n");
        Files.writeString(source.resolve("private.txt"), "must not copy this fixture");
        if (kind.equals("symlink")) Files.createSymbolicLink(source.resolve(".gitignore"), outside);
        else Files.createLink(source.resolve(".gitignore"), outside);
        assertThatThrownBy(() -> service().fingerprint(source)).isInstanceOf(LocalImportException.class);
        assertThatThrownBy(() -> service().importFolder(source, target())).isInstanceOf(LocalImportException.class);
        assertThat(Files.readString(target().resolve("a.txt"))).isEqualTo("old");
        assertThat(target().resolve("private.txt")).doesNotExist();
    }

    @Test
    void pathologicalGlobCompletesWithoutRegexBacktracking() throws Exception {
        Path source = source(".gitignore", "*a".repeat(20) + "b\n");
        Files.writeString(source.resolve("a".repeat(100)), "ordinary content");
        assertTimeout(Duration.ofSeconds(2), () -> {
            assertThat(service().fingerprint(source)).containsKey("a".repeat(100));
            assertThat(service().importFolder(source, target()).summary().acceptedFiles())
                    .isEqualTo(2);
        });
        assertThat(Files.readString(target().resolve("a".repeat(100)))).isEqualTo("ordinary content");
    }

    @ParameterizedTest
    @ValueSource(strings = {"file", "directory", "head"})
    void tokenShapedPathAndHeadMetadataAreNotRetained(String kind) throws Exception {
        String sentinel = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        Path source = source("Main.java", "class Main {}\n");
        switch (kind) {
            case "file" -> write(source, sentinel + ".java", "class Extra {}".getBytes());
            case "directory" -> write(source, sentinel + "/Extra.java", "class Extra {}".getBytes());
            case "head" -> write(source, ".git/HEAD", ("ref: refs/heads/" + sentinel + "\n").getBytes());
            default -> throw new AssertionError(kind);
        }
        LocalImportService.LocalImportResult result = assertSameSelection(service(), source);
        assertThat(result.branch()).isNull();
        assertThat(service().fingerprint(source).keySet()).noneMatch(path -> path.contains(sentinel));
        assertThat(result.summary().toString()).doesNotContain(sentinel);
        try (Git git = Git.open(target().toFile())) {
            String commit = new String(git.getRepository()
                    .open(git.getRepository().resolve("HEAD"))
                    .getBytes());
            assertThat(commit).doesNotContain(sentinel);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"extension", "late-nul", "invalid-utf8"})
    void binaryFilesAreExcludedBeforeWritingAnyBytes(String kind) throws Exception {
        Path source = source("Main.java", "class Main {}\n");
        String relative = kind.equals("extension") ? "document.pdf" : "document.txt";
        byte[] bytes =
                switch (kind) {
                    case "extension" -> "readable but binary extension".getBytes();
                    case "late-nul" -> ("x".repeat(9000) + '\0').getBytes();
                    default -> new byte[] {(byte) 0xc3, 0x28};
                };
        write(source, relative, bytes);
        LocalImportService.LocalImportResult result = service().importFolder(source, target());
        assertThat(result.summary().excludedEntriesByReason()).containsEntry("BINARY", 1);
        assertThat(target().resolve(relative)).doesNotExist();
        assertThat(service().fingerprint(source)).doesNotContainKey(relative);
    }

    @ParameterizedTest
    @ValueSource(ints = {7, 8, 9})
    void perFileActualBytesHaveAnExactBoundary(int size) throws Exception {
        Path source = source("a.txt", "x".repeat(size));
        LocalImportService service = service(limits(10, 8, 1024), path -> {}, LocalImportService::moveDirectory);
        LocalImportService.LocalImportResult result = assertSameSelection(service, source);
        assertThat(result.summary().acceptedFiles()).isEqualTo(size <= 8 ? 1 : 0);
        assertThat(result.summary().excludedEntriesByReason()).isEqualTo(size <= 8 ? Map.of() : Map.of("OVERSIZED", 1));
    }

    @ParameterizedTest
    @ValueSource(ints = {15, 16, 17})
    void aggregateReadBytesHaveAnExactBoundary(int budget) throws Exception {
        Path source = source("a.txt", "aaaaaaaa");
        Files.writeString(source.resolve("b.txt"), "bbbbbbbb");
        LocalImportService service = service(limits(10, 8, budget), path -> {}, LocalImportService::moveDirectory);
        if (budget >= 16) {
            assertThat(service.importFolder(source, target()).summary().bytesRead())
                    .isEqualTo(16);
        } else {
            assertThatThrownBy(() -> service.fingerprint(source)).isInstanceOf(LocalImportException.class);
            assertThatThrownBy(() -> service.importFolder(source, target())).isInstanceOf(LocalImportException.class);
            assertThat(target()).doesNotExist();
        }
    }

    @Test
    void configuredFileSelectionIsDeterministicAndExcludedFilesAreNotCopied() throws Exception {
        Path source = source("c.txt", "c");
        Files.writeString(source.resolve("a.txt"), "a");
        Files.writeString(source.resolve("b.txt"), "b");
        LocalImportService service = service(limits(2, 8, 1024), path -> {}, LocalImportService::moveDirectory);
        LocalImportService.LocalImportResult result = assertSameSelection(service, source);
        assertThat(service.fingerprint(source).keySet()).containsExactlyInAnyOrder("a.txt", "b.txt");
        assertThat(result.summary().excludedEntriesByReason()).containsEntry("FILE_LIMIT", 1);
        assertThat(target().resolve("c.txt")).doesNotExist();
    }

    // 05 §1 / F11: a nested repository (submodule gitlink file or nested clone) is a default exclusion.
    @ParameterizedTest
    @ValueSource(strings = {"gitlink-file", "nested-clone"})
    void submoduleWorkingTreesAreExcludedAndCountedOnce(String kind) throws Exception {
        Path source = source("src/Main.java", "class Main {}\n");
        write(source, ".gitmodules", "[submodule \"libs/sub\"]\n\tpath = libs/sub\n".getBytes());
        if (kind.equals("gitlink-file")) write(source, "libs/sub/.git", "gitdir: ../../.git/modules/sub\n".getBytes());
        else write(source, "libs/sub/.git/HEAD", "ref: refs/heads/main\n".getBytes());
        write(source, "libs/sub/lib.ts", "export const fromSubmodule = 1;\n".getBytes());
        write(source, "libs/sub/deep/more.ts", "export const deeper = 2;\n".getBytes());
        List<Path> opened = new ArrayList<>();
        LocalImportService service =
                service(limits(100, 32 * 1024, 1024 * 1024), opened::add, LocalImportService::moveDirectory);

        LocalImportService.LocalImportResult result = assertSameSelection(service, source);

        assertThat(service.fingerprint(source).keySet()).containsExactlyInAnyOrder(".gitmodules", "src/Main.java");
        assertThat(result.summary().excludedEntriesByReason()).isEqualTo(Map.of("SUBMODULE", 1));
        assertThat(target().resolve("libs")).doesNotExist();
        assertThat(opened).noneMatch(path -> path.toString().contains("libs/sub"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"symlink", "hardlink", "symlink-directory"})
    void linkedInputsAreExcludedWithoutReadingTheirTargets(String kind) throws Exception {
        Path source = source("Main.java", "class Main {}\n");
        Path outside = temp.resolve("outside.txt");
        Files.writeString(outside, "private outside fixture");
        if (kind.equals("hardlink")) Files.createLink(source.resolve("linked.txt"), outside);
        else if (kind.equals("symlink-directory")) Files.createSymbolicLink(source.resolve("linked"), temp);
        else Files.createSymbolicLink(source.resolve("linked.txt"), outside);
        LocalImportService.LocalImportResult result = assertSameSelection(service(), source);
        assertThat(result.summary().excludedEntriesByReason())
                .containsEntry(kind.equals("hardlink") ? "HARD_LINK" : "SYMLINK", 1);
        assertThat(Files.readString(outside)).isEqualTo("private outside fixture");
    }

    @Test
    void specialFilesAreRejectedAndTheOldRepositorySurvives() throws Exception {
        Path source = source("a.txt", "old");
        service().importFolder(source, target());
        Files.writeString(source.resolve("a.txt"), "new");
        try (ServerSocketChannel socket = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            Path socketPath = source.resolve("socket").toAbsolutePath();
            Path workingDirectory = Path.of("").toAbsolutePath();
            if (socketPath.getRoot().equals(workingDirectory.getRoot())) {
                Path relative = workingDirectory.relativize(socketPath);
                // Keep the same owned fixture, without spending the Unix socket limit on checkout prefixes.
                if (relative.toString().length() < socketPath.toString().length()) socketPath = relative;
            }
            socket.bind(UnixDomainSocketAddress.of(socketPath));
            assertThatThrownBy(() -> service().importFolder(source, target())).isInstanceOf(LocalImportException.class);
        }
        assertThat(Files.readString(target().resolve("a.txt"))).isEqualTo("old");
    }

    @Test
    void growthDuringReadingHitsTheActualByteLimitAndPreservesTheOldTarget() throws Exception {
        Path source = source("a.txt", "old");
        service().importFolder(source, target());
        Files.writeString(source.resolve("a.txt"), "x".repeat(8192));
        AtomicBoolean appended = new AtomicBoolean();
        LocalSourcePolicy.ReadObserver observer = new LocalSourcePolicy.ReadObserver() {
            @Override
            public void beforeOpen(Path path) {}

            @Override
            public void afterRead(Path path, long bytesRead) throws IOException {
                if (path.endsWith("a.txt") && appended.compareAndSet(false, true)) {
                    Files.writeString(path, "x", StandardOpenOption.APPEND);
                }
            }
        };
        LocalImportService service =
                service(limits(10, 8192, 1024 * 1024), observer, LocalImportService::moveDirectory);
        assertThatThrownBy(() -> service.importFolder(source, target())).isInstanceOf(LocalImportException.class);
        assertThat(appended).isTrue();
        assertThat(Files.readString(target().resolve("a.txt"))).isEqualTo("old");
    }

    @Test
    void replacementBetweenEnumerationAndOpenIsRejected() throws Exception {
        Path source = source("a.txt", "old");
        AtomicBoolean replaced = new AtomicBoolean();
        LocalImportService service = service(
                limits(10, 8192, 1024),
                path -> {
                    if (path.endsWith("a.txt") && replaced.compareAndSet(false, true)) {
                        Files.delete(path);
                        Files.writeString(path, "new");
                    }
                },
                LocalImportService::moveDirectory);
        assertThatThrownBy(() -> service.fingerprint(source)).isInstanceOf(LocalImportException.class);
        assertThat(replaced).isTrue();
    }

    @Test
    void publicationFailureRestoresTheOldRepositoryAndCleansStaging() throws Exception {
        Path source = source("a.txt", "old");
        service().importFolder(source, target());
        Files.writeString(source.resolve("a.txt"), "new");
        AtomicInteger moves = new AtomicInteger();
        LocalImportService service = service(limits(10, 8192, 1024), path -> {}, (from, to) -> {
            if (moves.incrementAndGet() == 2) throw new IOException("simulated publication failure");
            LocalImportService.moveDirectory(from, to);
        });
        assertThatThrownBy(() -> service.importFolder(source, target())).isInstanceOf(LocalImportException.class);
        assertThat(Files.readString(target().resolve("a.txt"))).isEqualTo("old");
        try (var siblings = Files.list(target().getParent())) {
            assertThat(siblings.toList()).containsExactly(target());
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "invalid-ignore",
                "cr-invalid-ignore",
                "escaped-invalid-ignore",
                "long-ignore",
                "too-many-rules",
                "cr-too-many-rules",
                "depth",
                "count",
                "entries"
            })
    void traversalAndIgnoreBudgetsFailBeforePublishing(String failure) throws Exception {
        Path source = source("a.txt", "old");
        service().importFolder(source, target());
        LocalSourcePolicy.Limits limits = limits(100, 128 * 1024, 1024 * 1024);
        switch (failure) {
            case "invalid-ignore" -> Files.writeString(source.resolve(".gitignore"), "[bad-pattern\n");
            case "cr-invalid-ignore" -> Files.writeString(source.resolve(".gitignore"), "# comment\r[bad-pattern\r");
            case "escaped-invalid-ignore" -> Files.writeString(source.resolve(".gitignore"), "\\#[bad-pattern\n");
            case "long-ignore" -> Files.writeString(source.resolve(".gitignore"), "x".repeat(65 * 1024));
            case "too-many-rules" -> Files.writeString(source.resolve(".gitignore"), "x\n".repeat(4097));
            case "cr-too-many-rules" -> Files.writeString(source.resolve(".gitignore"), "x\r".repeat(4097));
            case "depth" -> {
                write(source, "a/b/c/d/too-deep.txt", "x".getBytes());
                limits = new LocalSourcePolicy.Limits(100, 8192, 1024, 1000, 4000, 3, SECOND);
            }
            case "count" -> {
                Files.writeString(source.resolve("b.txt"), "b");
                limits = new LocalSourcePolicy.Limits(100, 8192, 1024, 1, 4000, 16, SECOND);
            }
            case "entries" -> {
                Files.createDirectories(source.resolve("a/b/c"));
                limits = new LocalSourcePolicy.Limits(100, 8192, 1024, 1000, 2, 16, SECOND);
            }
            default -> throw new AssertionError(failure);
        }
        LocalImportService service = service(limits, path -> {}, LocalImportService::moveDirectory);
        assertThatThrownBy(() -> service.importFolder(source, target())).isInstanceOf(LocalImportException.class);
        assertThat(Files.readString(target().resolve("a.txt"))).isEqualTo("old");
    }

    @Test
    void sourceAndManagedStorageCannotContainOneAnother() throws Exception {
        Files.createDirectories(temp.resolve("data/repos/inside"));
        assertThatThrownBy(() -> service().importFolder(temp, target())).isInstanceOf(LocalImportException.class);
        assertThatThrownBy(() -> service().fingerprint(temp.resolve("data/repos/inside")))
                .isInstanceOf(LocalImportException.class);
        assertThat(target()).doesNotExist();
    }

    @Test
    void hardCeilingsNeverExpandConfiguredLimits() {
        var defaults = LocalSourcePolicy.Limits.defaults(new AnalysisProperties(99_000, 9_000_000, 10, 0, 1, .5));
        assertThat(defaults.files()).isEqualTo(50_000);
        assertThat(defaults.fileBytes()).isEqualTo(2 * 1024 * 1024);
        var smaller = LocalSourcePolicy.Limits.defaults(new AnalysisProperties(10, 100, 10, 0, 1, .5));
        assertThat(smaller.files()).isEqualTo(10);
        assertThat(smaller.fileBytes()).isEqualTo(100);
    }

    @Test
    void oversizedSparseFilesAreNotRead() throws Exception {
        Path source = source("a.txt", "safe");
        Path sparse = source.resolve("sparse.txt");
        try (var channel =
                java.nio.channels.FileChannel.open(sparse, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            channel.position(2L * 1024 * 1024 * 1024);
            channel.write(java.nio.ByteBuffer.wrap(new byte[] {1}));
        }
        List<Path> opened = new ArrayList<>();
        var service = service(limits(10, 8192, 1024), opened::add, LocalImportService::moveDirectory);
        assertThat(service.importFolder(source, target()).summary().excludedEntriesByReason())
                .containsEntry("OVERSIZED", 1);
        assertThat(opened).doesNotContain(sparse);
        assertThat(target().resolve("sparse.txt")).doesNotExist();
    }

    @Test
    void cooperativeTimeBudgetStopsInspectionAndPreservesTheOldTarget() throws Exception {
        Path source = source("a.txt", "old");
        service().importFolder(source, target());
        AtomicLong clock = new AtomicLong();
        var policy = new LocalSourcePolicy(limits(10, 8192, 1024), () -> clock.addAndGet(SECOND), path -> {});
        var service = new LocalImportService(
                new AppProperties(temp.resolve("data").toString(), 2),
                new LocalImportProperties(temp.toRealPath().toString()),
                new DesktopPathAuthorizationService(),
                policy,
                LocalImportService::moveDirectory);
        assertThatThrownBy(() -> service.importFolder(source, target())).isInstanceOf(LocalImportException.class);
        assertThat(Files.readString(target().resolve("a.txt"))).isEqualTo("old");
    }

    @Test
    void anInterruptedInspectionDoesNotPublish() throws Exception {
        Path source = source("a.txt", "safe");
        Thread.currentThread().interrupt();
        try {
            assertThatThrownBy(() -> service().importFolder(source, target())).isInstanceOf(LocalImportException.class);
        } finally {
            Thread.interrupted();
        }
        assertThat(target()).doesNotExist();
    }

    @Test
    void volumeRootIsRejectedBeforeWalkingAnyEntries() throws Exception {
        assertThatThrownBy(() -> service().validateSource(Path.of("/")))
                .isInstanceOf(LocalImportException.class)
                .hasMessageContaining("volume root");
    }

    @Test
    void unsafeValidationMessagesDoNotRepeatUntrustedMetadata() throws Exception {
        String sentinel = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        Path missing = temp.resolve(sentinel);
        assertThatThrownBy(() -> service().fingerprint(missing))
                .isInstanceOf(LocalImportException.class)
                .hasMessageNotContaining(sentinel);
    }

    private LocalImportService.LocalImportResult assertSameSelection(LocalImportService service, Path source)
            throws Exception {
        Map<String, String> expected = service.fingerprint(source);
        LocalImportService.LocalImportResult result = service.importFolder(source, target());
        assertThat(service.fingerprint(source)).isEqualTo(expected);
        Map<String, String> inventory = new HashMap<>();
        for (InventoriedFile file : new FileInventoryScanner()
                .scan(target(), 50_000, 2 * 1024 * 1024)
                .files()) {
            inventory.put(file.path(), file.contentHash());
            assertThat(Files.readAllBytes(target().resolve(file.path())))
                    .isEqualTo(Files.readAllBytes(source.resolve(file.path())));
        }
        assertThat(inventory).isEqualTo(expected);
        Map<String, String> treeEntries = new HashMap<>();
        try (Git git = Git.open(target().toFile());
                RevWalk rev = new RevWalk(git.getRepository());
                TreeWalk tree = new TreeWalk(git.getRepository())) {
            tree.addTree(
                    rev.parseCommit(git.getRepository().resolve(Constants.HEAD)).getTree());
            tree.setRecursive(true);
            while (tree.next())
                treeEntries.put(tree.getPathString(), tree.getObjectId(0).name());
        }
        assertThat(treeEntries).isEqualTo(expected);
        try (var working = Files.walk(target())) {
            assertThat(working.filter(Files::isRegularFile)
                            .filter(path -> !path.startsWith(target().resolve(".git")))
                            .map(path -> target().relativize(path).toString())
                            .toList())
                    .containsExactlyInAnyOrderElementsOf(expected.keySet());
        }
        assertThat(result.summary().acceptedFiles()).isEqualTo(expected.size());
        assertThat(result.summary().schemaVersion()).isEqualTo(1);
        assertThat(result.summary().policyVersion()).isEqualTo("local-ingest-v1");
        return result;
    }

    private void assertBlobAbsent(String excluded) throws Exception {
        try (Git git = Git.open(target().toFile());
                var reader = git.getRepository().newObjectReader();
                ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
            assertThat(reader.has(formatter.idFor(Constants.OBJ_BLOB, excluded.getBytes())))
                    .isFalse();
        }
    }
}
