package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.analysis.core.FileInventoryScanner;
import dev.codeintelligence.common.AppProperties;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.json.JsonMapper;

class LocalSourceBindingTest {
    @TempDir
    Path temp;

    private LocalSourcePolicy.Limits limits() {
        return new LocalSourcePolicy.Limits(
                100,
                32 * 1024,
                1024 * 1024,
                1000,
                4000,
                16,
                Duration.ofSeconds(1).toNanos());
    }

    private LocalImportService service() throws IOException {
        return service(limits(), staging -> {});
    }

    private LocalImportService service(LocalSourcePolicy.Limits limits, LocalImportService.StagingObserver observer)
            throws IOException {
        return new LocalImportService(
                new AppProperties(temp.resolve("data").toString(), 2),
                new LocalImportProperties(temp.toRealPath().toString()),
                new DesktopPathAuthorizationService(),
                new LocalSourcePolicy(limits, () -> 0, path -> {}),
                LocalImportService::moveDirectory,
                observer);
    }

    private Path source() throws IOException {
        Path source = Files.createDirectories(temp.resolve("source"));
        Files.writeString(source.resolve("a.txt"), "AAAA");
        return source;
    }

    private Path target() {
        return temp.resolve("data/repos/17");
    }

    private Path oldTargetAndNewSource() throws Exception {
        Path source = source();
        Files.writeString(source.resolve("a.txt"), "OLD!");
        service().importFolder(source, target());
        Files.writeString(source.resolve("a.txt"), "AAAA");
        return source;
    }

    private void oldTargetIsIntact() throws Exception {
        assertThat(Files.readString(target().resolve("a.txt"))).isEqualTo("OLD!");
        try (Git git = Git.open(target().toFile());
                RevWalk rev = new RevWalk(git.getRepository());
                TreeWalk tree = new TreeWalk(git.getRepository())) {
            tree.addTree(
                    rev.parseCommit(git.getRepository().resolve(Constants.HEAD)).getTree());
            tree.setRecursive(true);
            assertThat(tree.next()).isTrue();
            assertThat(new String(git.getRepository().open(tree.getObjectId(0)).getBytes(), StandardCharsets.UTF_8))
                    .isEqualTo("OLD!");
            assertThat(tree.next()).isFalse();
        }
        try (var entries = Files.list(target().getParent())) {
            assertThat(entries.toList()).containsExactly(target());
        }
    }

    @Test
    void inspectionIsStableSerializableAndDoesNotRetainSourceBytes() throws Exception {
        Path source = source();
        Files.writeString(source.resolve("unicode-한.txt"), "line one\r\nline two\n");
        var first = service().inspect(source);
        var second = service().inspect(source);
        assertThat(first).isEqualTo(second);
        assertThat(first.binding().canonicalRoot())
                .isEqualTo(source.toRealPath().toString());
        assertThat(first.binding().rootDevice())
                .isEqualTo(((Number) Files.getAttribute(source, "unix:dev")).longValue());
        assertThat(first.binding().rootInode())
                .isEqualTo(((Number) Files.getAttribute(source, "unix:ino")).longValue());
        assertThat(first.binding().schemaVersion()).isEqualTo(1);
        assertThat(first.binding().manifestSha256()).matches("[0-9a-f]{64}");
        assertThat(first.binding().limitsSha256()).matches("[0-9a-f]{64}");
        assertThat(first.binding().selectedFiles()).isEqualTo(2);
        assertThat(first.binding().selectedBytes()).isEqualTo(4 + Files.size(source.resolve("unicode-한.txt")));
        assertThat(first.gitFingerprints().values()).allMatch(value -> value.matches("[0-9a-f]{40}"));
        assertThatThrownBy(() -> first.gitFingerprints().put("injected", "value"))
                .isInstanceOf(UnsupportedOperationException.class);
        assertThat(temp.resolve("data")).doesNotExist();

        var json = JsonMapper.builder().build();
        String receipt = json.writeValueAsString(first.binding());
        assertThat(receipt).doesNotContain("line one", "line two", "AAAA");
        var restored = json.readValue(receipt, LocalSourceBinding.class);
        assertThat(restored).isEqualTo(first.binding());
        service().importApproved(restored, target());
        assertThat(new FileInventoryScanner().scan(target(), 100, 32 * 1024).files())
                .hasSize(2);
        assertThat(Files.readAllBytes(target().resolve("unicode-한.txt")))
                .isEqualTo(Files.readAllBytes(source.resolve("unicode-한.txt")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"same-size-bytes", "rename", "new-file", "delete", "ignore-change"})
    void changedInputCannotPublishUnderThePreviousApproval(String change) throws Exception {
        Path source = oldTargetAndNewSource();
        var approved = service().inspect(source).binding();
        switch (change) {
            case "same-size-bytes" -> Files.writeString(source.resolve("a.txt"), "BBBB");
            case "rename" -> Files.move(source.resolve("a.txt"), source.resolve("b.txt"));
            case "new-file" -> Files.writeString(source.resolve("b.txt"), "BBBB");
            case "delete" -> Files.delete(source.resolve("a.txt"));
            case "ignore-change" -> Files.writeString(source.resolve(".gitignore"), "a.txt\n");
            default -> throw new AssertionError(change);
        }
        AtomicBoolean published = new AtomicBoolean();
        assertThatThrownBy(() -> service().importApproved(approved, target(), () -> published.set(true)))
                .isInstanceOf(LocalSourceApprovalException.class);
        assertThat(published).isFalse();
        oldTargetIsIntact();
    }

    @Test
    void rootReplacementRejectsIdenticalBytesAtTheSameCanonicalPath() throws Exception {
        Path source = oldTargetAndNewSource();
        var approved = service().inspect(source).binding();
        Files.move(source, temp.resolve("original-source"));
        Files.createDirectory(source);
        Files.writeString(source.resolve("a.txt"), "AAAA");
        assertThat(service().inspect(source).binding().manifestSha256()).isEqualTo(approved.manifestSha256());
        assertThatThrownBy(() -> service().importApproved(approved, target()))
                .isInstanceOf(LocalSourceApprovalException.class);
        oldTargetIsIntact();
    }

    @Test
    void authorizationIsRecheckedForAnOtherwiseMatchingBinding() throws Exception {
        Path source = oldTargetAndNewSource();
        var approved = service().inspect(source).binding();
        var unauthorized = new LocalImportService(
                new AppProperties(temp.resolve("data").toString(), 2),
                new LocalImportProperties(""),
                new DesktopPathAuthorizationService(),
                new LocalSourcePolicy(limits(), () -> 0, path -> {}),
                LocalImportService::moveDirectory);
        assertThatThrownBy(() -> unauthorized.importApproved(approved, target()))
                .isInstanceOf(LocalSourceApprovalException.class);
        oldTargetIsIntact();
    }

    @ParameterizedTest
    @ValueSource(strings = {"unsupported-ignore", "symlink-ignore", "hardlink-ignore"})
    void unsafeSourcePolicyAfterApprovalRequiresANewPreview(String change) throws Exception {
        Path source = oldTargetAndNewSource();
        var approved = service().inspect(source).binding();
        Path ignore = source.resolve(".gitignore");
        if (change.equals("unsupported-ignore")) Files.writeString(ignore, "[unsupported-pattern]\n");
        else {
            Path outside = temp.resolve("outside-ignore");
            Files.writeString(outside, "a.txt\n");
            if (change.equals("symlink-ignore")) Files.createSymbolicLink(ignore, outside);
            else Files.createLink(ignore, outside);
        }
        assertThatThrownBy(() -> service().importApproved(approved, target()))
                .isInstanceOf(LocalSourceApprovalException.class)
                .satisfies(error -> assertThat(((LocalSourceApprovalException) error).failureCode())
                        .isEqualTo("LOCAL_PREVIEW_REQUIRED"));
        oldTargetIsIntact();
    }

    @ParameterizedTest
    @ValueSource(strings = {"files", "file-bytes", "total-bytes", "discovered", "entries", "depth", "time"})
    void everyEffectiveLimitIsBoundEvenWhenTheFilesStillFit(String changed) throws Exception {
        Path source = oldTargetAndNewSource();
        var approved = service().inspect(source).binding();
        var base = limits();
        var other = new LocalSourcePolicy.Limits(
                changed.equals("files") ? 99 : base.files(),
                changed.equals("file-bytes") ? 31 * 1024 : base.fileBytes(),
                changed.equals("total-bytes") ? 1023 * 1024 : base.totalBytes(),
                changed.equals("discovered") ? 999 : base.discoveredFiles(),
                changed.equals("entries") ? 3999 : base.entries(),
                changed.equals("depth") ? 15 : base.depth(),
                changed.equals("time") ? base.nanos() - 1 : base.nanos());
        LocalImportService changedService = service(other, staging -> {});
        assertThat(changedService.inspect(source).binding().limitsSha256()).isNotEqualTo(approved.limitsSha256());
        assertThatThrownBy(() -> changedService.importApproved(approved, target()))
                .isInstanceOf(LocalSourceApprovalException.class);
        oldTargetIsIntact();
    }

    @ParameterizedTest
    @ValueSource(strings = {"schema", "policy", "manifest", "count", "bytes", "canonical-root"})
    void malformedOrIncompatibleReceiptFieldsFailClosed(String field) throws Exception {
        Path source = oldTargetAndNewSource();
        var original = service().inspect(source).binding();
        var altered = new LocalSourceBinding(
                field.equals("schema") ? 2 : original.schemaVersion(),
                field.equals("canonical-root") ? original.canonicalRoot() + "/." : original.canonicalRoot(),
                original.rootDevice(),
                original.rootInode(),
                field.equals("policy") ? "future-policy" : original.policyVersion(),
                original.limitsSha256(),
                field.equals("manifest") ? "0".repeat(64) : original.manifestSha256(),
                field.equals("count") ? original.selectedFiles() + 1 : original.selectedFiles(),
                field.equals("bytes") ? original.selectedBytes() + 1 : original.selectedBytes());
        assertThatThrownBy(() -> service().importApproved(altered, target()))
                .isInstanceOf(LocalSourceApprovalException.class);
        oldTargetIsIntact();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "same-size-same-mtime",
                "missing",
                "extra-ignored",
                "extra-empty-dir",
                "metadata-java",
                "symlink",
                "hardlink",
                "oversized"
            })
    void actualStagingMustMatchAndCannotUseExclusionsToHideExtras(String change) throws Exception {
        Path source = oldTargetAndNewSource();
        Files.writeString(source.resolve(".gitignore"), "ignored/\n*.ignored\n");
        var approved = service().inspect(source).binding();
        LocalImportService altered = service(limits(), staging -> {
            Path file = staging.resolve("a.txt");
            switch (change) {
                case "same-size-same-mtime" -> {
                    var modified = Files.getLastModifiedTime(file);
                    Files.writeString(file, "BBBB");
                    Files.setLastModifiedTime(file, modified);
                }
                case "missing" -> Files.delete(file);
                case "extra-ignored" -> {
                    Files.createDirectory(staging.resolve("ignored"));
                    Files.writeString(staging.resolve("ignored/Extra.java"), "class Extra {}\n");
                }
                case "extra-empty-dir" -> Files.createDirectory(staging.resolve("extra"));
                case "metadata-java" -> {
                    Files.createDirectories(staging.resolve(".git/injected/src/main/java"));
                    Files.writeString(staging.resolve(".git/injected/src/main/java/Extra.java"), "class Extra {}\n");
                }
                case "symlink" -> {
                    Files.delete(file);
                    Files.createSymbolicLink(file, source.resolve("a.txt"));
                }
                case "hardlink" -> {
                    Files.delete(file);
                    Files.createLink(file, source.resolve("a.txt"));
                }
                case "oversized" -> Files.writeString(file, "X".repeat(33 * 1024), StandardOpenOption.APPEND);
                default -> throw new AssertionError(change);
            }
        });
        AtomicBoolean published = new AtomicBoolean();
        assertThatThrownBy(() -> altered.importApproved(approved, target(), () -> published.set(true)))
                .isInstanceOf(LocalSourceApprovalException.class);
        assertThat(published).isFalse();
        oldTargetIsIntact();
        assertThat(Files.readString(source.resolve("a.txt"))).isEqualTo("AAAA");
    }

    @Test
    void finalPublicationGuardRunsAfterVerificationAndCanRejectWithoutReplacingTheTarget() throws Exception {
        Path source = oldTargetAndNewSource();
        var approved = service().inspect(source).binding();
        AtomicReference<Path> staging = new AtomicReference<>();
        AtomicBoolean guarded = new AtomicBoolean();
        LocalImportService importer = service(limits(), staging::set);
        assertThatThrownBy(() -> importer.importApproved(approved, target(), () -> {
                    guarded.set(true);
                    assertThat(staging.get().resolve(".git/refs/heads/snapshot"))
                            .exists();
                    assertThat(target().resolve("a.txt")).hasContent("OLD!");
                    throw LocalSourceApprovalException.sourceChanged();
                }))
                .isInstanceOf(LocalSourceApprovalException.class);
        assertThat(guarded).isTrue();
        oldTargetIsIntact();
    }

    @Test
    void aVerifiedReceiptCanPublishThroughItsGuardAndGitUsesTheVerifiedBytes() throws Exception {
        Path source = oldTargetAndNewSource();
        var inspection = service().inspect(source);
        AtomicBoolean guarded = new AtomicBoolean();
        var result = service().importApproved(inspection.binding(), target(), () -> guarded.set(true));
        assertThat(guarded).isTrue();
        assertThat(Files.readString(target().resolve("a.txt"))).isEqualTo("AAAA");
        var files = new FileInventoryScanner().scan(target(), 100, 32 * 1024).files();
        assertThat(files).hasSize(1);
        assertThat(files.getFirst().contentHash())
                .isEqualTo(inspection.gitFingerprints().get("a.txt"));
        assertThat(result.summary().acceptedFiles())
                .isEqualTo(inspection.binding().selectedFiles());
    }

    @Test
    void pathAndByteBoundariesCannotProduceAnAmbiguousManifest() throws Exception {
        Path source = source();
        var first = service().inspect(source).binding();
        Files.move(source.resolve("a.txt"), source.resolve("b.txt"));
        var renamed = service().inspect(source).binding();
        assertThat(renamed.selectedFiles()).isEqualTo(first.selectedFiles());
        assertThat(renamed.selectedBytes()).isEqualTo(first.selectedBytes());
        assertThat(renamed.manifestSha256()).isNotEqualTo(first.manifestSha256());
        Files.writeString(source.resolve("b.txt"), "AAA");
        Files.writeString(source.resolve("empty.txt"), "A");
        var repartitioned = service().inspect(source).binding();
        assertThat(repartitioned.selectedBytes()).isEqualTo(first.selectedBytes());
        assertThat(repartitioned.manifestSha256()).isNotEqualTo(first.manifestSha256());
    }
}
