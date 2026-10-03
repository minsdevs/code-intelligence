package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.java.JavaAnalyzer;
import dev.codeintelligence.common.AppProperties;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.dircache.DirCache;
import org.eclipse.jgit.lib.ObjectId;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class RetrySourceGuardTest {
    private static final long PROJECT = 17;
    private static final long SECOND = Duration.ofSeconds(1).toNanos();

    @TempDir
    Path temp;

    private AppProperties app() {
        return new AppProperties(temp.resolve("data").toString(), 2);
    }

    private RetrySourceGuard guard() {
        return guard(100, 8192, 1024 * 1024, 16, () -> 0);
    }

    private RetrySourceGuard guard(int files, long perFile, long total, int depth, LongSupplier clock) {
        return new RetrySourceGuard(
                mock(JobRepository.class),
                app(),
                new RetrySourceGuard.Limits(files, perFile, total, depth, 1024 * 1024, SECOND),
                clock);
    }

    @Test
    void unchangedCommittedBytesAreVerifiableWithANewGuardInstance() throws Exception {
        Fixture fixture = repository(Map.of("src/App.java", "class App {}\n", "empty.txt", ""));
        guard().verifySource(PROJECT, fixture.commit());
        guard().verifySource(PROJECT, fixture.commit());
    }

    @ParameterizedTest
    @ValueSource(strings = {"changed", "missing", "untracked", "ignored", "extra-directory"})
    void changedOrAdditionalWorkingBytesAreRejected(String change) throws Exception {
        Fixture fixture = repository(Map.of("App.java", "AAAA", ".gitignore", "ignored/\n"));
        switch (change) {
            case "changed" -> Files.writeString(fixture.root().resolve("App.java"), "BBBB");
            case "missing" -> Files.delete(fixture.root().resolve("App.java"));
            case "untracked" -> Files.writeString(fixture.root().resolve("extra.java"), "unexpected");
            case "extra-directory" -> Files.createDirectory(fixture.root().resolve("extra"));
            case "ignored" -> {
                Files.createDirectory(fixture.root().resolve("ignored"));
                Files.writeString(fixture.root().resolve("ignored/Extra.java"), "unexpected");
            }
            default -> throw new AssertionError(change);
        }
        rejected(guard(), fixture.commit());
    }

    @Test
    void contentHashDoesNotTrustAssumeUnchangedOrMatchingStatMetadata() throws Exception {
        Fixture fixture = repository(Map.of("App.java", "AAAA"));
        Path file = fixture.root().resolve("App.java");
        FileTime time = Files.getLastModifiedTime(file);
        try (Git git = Git.open(fixture.root().toFile())) {
            DirCache index = git.getRepository().lockDirCache();
            try {
                index.getEntry("App.java").setAssumeValid(true);
                index.write();
                assertThat(index.commit()).isTrue();
            } finally {
                index.unlock();
            }
        }
        Files.writeString(file, "BBBB");
        Files.setLastModifiedTime(file, time);
        rejected(guard(), fixture.commit());
    }

    @Test
    void indexOnlyChangesDoNotChangeTheSourceConsumedByResumedAnalysis() throws Exception {
        Fixture fixture = repository(Map.of("App.java", "AAAA"));
        try (Git git = Git.open(fixture.root().toFile())) {
            Files.writeString(fixture.root().resolve("App.java"), "BBBB");
            git.add().addFilepattern(".").call();
        }
        Files.writeString(fixture.root().resolve("App.java"), "AAAA");
        guard().verifySource(PROJECT, fixture.commit());
    }

    @ParameterizedTest
    @ValueSource(strings = {"Helper.java", "Helper.JAVA"})
    void gitMetadataCannotSupplyExtraJavaResolverInputs(String filename) throws Exception {
        Fixture fixture = repository(Map.of("src/main/java/demo/App.java", "package demo; class App {}"));
        Path extra = fixture.root().resolve(".git/injected/src/main/java/demo/" + filename);
        Files.createDirectories(extra.getParent());
        Files.writeString(extra, "package demo; public class Helper { public void injected() {} }");
        rejected(guard(), fixture.commit());
    }

    @Test
    void sourceHiddenInGitMetadataWouldChangeResolvedCallsAndIsRejected() throws Exception {
        String path = "src/main/java/demo/App.java";
        String source = "package demo; public class App { public void run() { Helper.work(); } }\n";
        Fixture fixture = repository(Map.of(path, source));
        FileInventory inventory = FileInventory.of(
                new InventoriedFile(path, "java", Files.size(fixture.root().resolve(path)), 1, "a".repeat(40)));
        AnalysisContext context = new AnalysisContext(PROJECT, 1, fixture.root(), inventory);
        assertThat(new JavaAnalyzer().analyze(context).edges())
                .noneMatch(edge -> edge.edgeType().equals("CALLS"));
        Path extra = fixture.root().resolve(".git/injected/src/main/java/demo/Helper.java");
        Files.createDirectories(extra.getParent());
        Files.writeString(extra, "package demo; public class Helper { public static void work() {} }\n");

        assertThat(new JavaAnalyzer().analyze(context).edges()).anySatisfy(edge -> {
            assertThat(edge.edgeType()).isEqualTo("CALLS");
            assertThat(edge.confidence()).isEqualTo("CONFIRMED");
            assertThat(edge.sourceNaturalKey()).isEqualTo("java:demo.App#run()");
            assertThat(edge.targetNaturalKey()).isEqualTo("java:demo.Helper#work()");
        });
        assertThat(Files.readString(fixture.root().resolve(path))).isEqualTo(source);
        assertThat(inventory.files()).extracting(InventoriedFile::path).containsExactly(path);
        rejected(guard(), fixture.commit());
    }

    @Test
    void anotherCommitCannotStandInForTheCheckpoint() throws Exception {
        Fixture fixture = repository(Map.of("App.java", "AAAA"));
        try (Git git = Git.open(fixture.root().toFile())) {
            Files.writeString(fixture.root().resolve("App.java"), "BBBB");
            commit(git);
        }
        rejected(guard(), fixture.commit());
    }

    @ParameterizedTest
    @ValueSource(strings = {"file", "directory", "repository", "git", "objects", "hardlink", "alternates", "include"})
    void indirectionAndUnverifiableFilesAreRejected(String kind) throws Exception {
        Fixture fixture = repository(Map.of("src/App.java", "AAAA"));
        Path file = fixture.root().resolve("src/App.java");
        switch (kind) {
            case "file" -> {
                Path outside = temp.resolve("external.java");
                Files.writeString(outside, "AAAA");
                Files.delete(file);
                Files.createSymbolicLink(file, outside);
            }
            case "directory" -> replaceWithSymlink(fixture.root().resolve("src"));
            case "repository" -> replaceWithSymlink(fixture.root());
            case "git" -> replaceWithSymlink(fixture.root().resolve(".git"));
            case "objects" -> replaceWithSymlink(fixture.root().resolve(".git/objects"));
            case "hardlink" -> Files.createLink(temp.resolve("hardlink.java"), file);
            case "alternates" ->
                Files.writeString(
                        fixture.root().resolve(".git/objects/info/alternates"),
                        temp.resolve("other-objects").toString());
            case "include" ->
                Files.writeString(
                        fixture.root().resolve(".git/config"),
                        "[include]\npath = " + temp.resolve("never-read-config") + "\n");
            default -> throw new AssertionError(kind);
        }
        rejected(guard(), fixture.commit());
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing-commit", "missing-blob", "corrupt-blob"})
    void missingOrCorruptObjectsCannotBeVerified(String failure) throws Exception {
        Fixture fixture = repository(Map.of("App.java", "AAAA"));
        ObjectId oid;
        try (Git git = Git.open(fixture.root().toFile())) {
            oid = failure.equals("missing-commit")
                    ? ObjectId.fromString(fixture.commit())
                    : git.getRepository().resolve("HEAD:App.java");
        }
        Path object = fixture.root()
                .resolve(".git/objects/" + oid.name().substring(0, 2) + "/"
                        + oid.name().substring(2));
        // JGit loose objects can be read-only; replace this disposable fixture object.
        Files.delete(object);
        if (failure.equals("corrupt-blob")) Files.write(object, new byte[] {1, 2, 3});
        rejected(guard(), fixture.commit());
    }

    @ParameterizedTest
    @ValueSource(ints = {7, 8, 9})
    void perFileLimitHasAnExactBoundary(int bytes) throws Exception {
        Fixture fixture = repository(Map.of("file.txt", "x".repeat(bytes)));
        RetrySourceGuard guard = guard(10, 8, 1024 * 1024, 16, () -> 0);
        if (bytes <= 8) guard.verifySource(PROJECT, fixture.commit());
        else rejected(guard, fixture.commit());
    }

    @Test
    void aggregateActualBytesIncludeBothTheStoredAndWorkingCopies() throws Exception {
        Fixture fixture = repository(Map.of("a.txt", "a".repeat(2048), "b.txt", "b".repeat(2048)));
        guard(10, 2048, 8192, 16, () -> 0).verifySource(PROJECT, fixture.commit());
        rejected(guard(10, 2048, 8191, 16, () -> 0), fixture.commit());
    }

    @Test
    void fileCountAndPathDepthAreBounded() throws Exception {
        Fixture fixture = repository(Map.of("a/b/c/d/file.txt", "AAAA", "other.txt", "BBBB"));
        rejected(guard(1, 8192, 1024 * 1024, 16, () -> 0), fixture.commit());
        rejected(guard(10, 8192, 1024 * 1024, 4, () -> 0), fixture.commit());
        guard(10, 8192, 1024 * 1024, 5, () -> 0).verifySource(PROJECT, fixture.commit());
    }

    @Test
    void timeAndInterruptionStopVerification() throws Exception {
        Fixture fixture = repository(Map.of("App.java", "AAAA"));
        AtomicLong clock = new AtomicLong();
        rejected(guard(10, 8192, 1024 * 1024, 16, () -> clock.getAndAdd(SECOND)), fixture.commit());
        try {
            Thread.currentThread().interrupt();
            rejected(guard(), fixture.commit());
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    void anInvalidCommitIsRejectedBeforeAnyDatabaseAccess() {
        JobRepository jobs = mock(JobRepository.class);
        RetrySourceGuard guard = new RetrySourceGuard(
                jobs, app(), new RetrySourceGuard.Limits(10, 8192, 1024 * 1024, 16, 1024 * 1024, SECOND), () -> 0);
        rejected(guard, "legacy-unknown");
        verifyNoInteractions(jobs);
    }

    private void rejected(RetrySourceGuard guard, String commit) {
        assertThatThrownBy(() -> guard.verifySource(PROJECT, commit))
                .isInstanceOfSatisfying(JobConflictException.class, exception -> {
                    assertThat(exception.getStatusCode().value()).isEqualTo(409);
                    assertThat(exception.getBody().getProperties()).containsEntry("code", "RETRY_SOURCE_UNVERIFIED");
                    assertThat(exception.getBody().getDetail())
                            .contains("Preview")
                            .doesNotContain(temp.toString());
                });
    }

    private void replaceWithSymlink(Path original) throws Exception {
        Path moved = temp.resolve("moved-" + original.getFileName());
        Files.move(original, moved);
        Files.createSymbolicLink(original, moved);
    }

    private Fixture repository(Map<String, String> files) throws Exception {
        Path root = app().reposRoot().resolve(Long.toString(PROJECT));
        Files.createDirectories(root);
        try (Git git = Git.init().setDirectory(root.toFile()).call()) {
            for (Map.Entry<String, String> file : files.entrySet()) {
                Path destination = root.resolve(file.getKey());
                Files.createDirectories(destination.getParent());
                Files.writeString(destination, file.getValue());
            }
            return new Fixture(root, commit(git));
        }
    }

    private String commit(Git git) throws Exception {
        git.add().addFilepattern(".").call();
        return git.commit()
                .setMessage("retry fixture")
                .setAuthor("Fixture", "fixture@example.invalid")
                .setCommitter("Fixture", "fixture@example.invalid")
                .call()
                .getName();
    }

    private record Fixture(Path root, String commit) {}
}
