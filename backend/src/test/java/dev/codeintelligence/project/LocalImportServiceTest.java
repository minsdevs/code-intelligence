package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.analysis.core.FileInventoryScanner;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

class LocalImportServiceTest {

    @TempDir
    Path tempDir;

    private LocalImportService service;
    private AppProperties appProperties;
    private DesktopPathAuthorizationService desktopPaths;

    @BeforeEach
    void setUp() throws IOException {
        appProperties = new AppProperties(tempDir.resolve("data").toString(), 2);
        desktopPaths = new DesktopPathAuthorizationService();
        // Allow the tempDir as the configured server root — use toRealPath() because on macOS
        // /var is a symlink to /private/var.
        var localImportProps = new LocalImportProperties(tempDir.toRealPath().toString());
        service = new LocalImportService(appProperties, localImportProps, analysisProperties(), desktopPaths);
    }

    @Test
    void validateSource_rejectsNonExistentPath() {
        Path nonExistent = tempDir.resolve("does-not-exist");
        assertThatThrownBy(() -> service.validateSource(nonExistent))
                .isInstanceOf(LocalImportException.class)
                .hasMessageContaining("not a directory");
    }

    @Test
    void validateSource_rejectsFile() throws IOException {
        Path file = tempDir.resolve("file.txt");
        Files.writeString(file, "content");
        assertThatThrownBy(() -> service.validateSource(file))
                .isInstanceOf(LocalImportException.class)
                .hasMessageContaining("not a directory");
    }

    @Test
    void validateSource_rejectsSystemDirectory() {
        // /usr is a system directory on macOS/Linux
        Path sysDir = Path.of("/usr");
        if (Files.isDirectory(sysDir)) {
            assertThatThrownBy(() -> service.validateSource(sysDir)).isInstanceOf(LocalImportException.class);
            // It can be caught by either "System directory" or "not under any allowed root"
        }
    }

    @Test
    void validateSource_rejectsPathOutsideAllowedRoot() throws IOException {
        // Create a service with a restricted allowed root
        Path allowedRoot = tempDir.resolve("allowed");
        Files.createDirectories(allowedRoot);
        var restrictedProps = new LocalImportProperties(allowedRoot.toRealPath().toString());
        var restrictedService =
                new LocalImportService(appProperties, restrictedProps, analysisProperties(), desktopPaths);

        // Create a directory outside the allowed root
        Path outsideDir = tempDir.resolve("outside");
        Files.createDirectories(outsideDir);
        Files.writeString(outsideDir.resolve("file.txt"), "content");

        assertThatThrownBy(() -> restrictedService.validateSource(outsideDir)).isInstanceOf(LocalImportException.class);
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void validateSource_acceptsConfiguredSymlinkRoot() throws IOException {
        Path realRoot = tempDir.resolve("real-allowed");
        Path project = realRoot.resolve("project");
        Files.createDirectories(project);
        Files.writeString(project.resolve("Main.java"), "class Main {}");
        Path alias = tempDir.resolve("allowed-alias");
        Files.createSymbolicLink(alias, realRoot);

        var symlinkRootProps = new LocalImportProperties(alias.toString());
        var symlinkRootService =
                new LocalImportService(appProperties, symlinkRootProps, analysisProperties(), desktopPaths);

        assertThat(symlinkRootService.validateSource(alias.resolve("project"))).isEqualTo(project.toRealPath());
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void validateSource_rejectsSymlinkEscapingAllowedRoot() throws IOException {
        // Create a restricted allowed root
        Path allowedRoot = tempDir.resolve("allowed");
        Files.createDirectories(allowedRoot);
        var restrictedProps = new LocalImportProperties(allowedRoot.toRealPath().toString());
        var restrictedService =
                new LocalImportService(appProperties, restrictedProps, analysisProperties(), desktopPaths);

        // Create a target outside the allowed root
        Path outsideTarget = tempDir.resolve("secret-data");
        Files.createDirectories(outsideTarget);
        Files.writeString(outsideTarget.resolve("secret.txt"), "secret");

        // Create a symlink inside allowed root that points outside
        Path symlink = allowedRoot.resolve("escape-link");
        Files.createSymbolicLink(symlink, outsideTarget);

        assertThatThrownBy(() -> restrictedService.validateSource(symlink)).isInstanceOf(LocalImportException.class);
    }

    @Test
    void validateSource_acceptsValidDirectory() throws IOException {
        Path validDir = tempDir.resolve("project");
        Files.createDirectories(validDir);
        Files.writeString(validDir.resolve("Main.java"), "class Main {}");

        // Should not throw
        service.validateSource(validDir);
    }

    @Test
    void validateSource_requiresPickerGrantWhenNoServerRootIsConfigured() throws IOException {
        Path selected = tempDir.resolve("picked-project");
        Files.createDirectories(selected);
        Files.writeString(selected.resolve("Main.java"), "class Main {}");
        var desktopOnlyService = new LocalImportService(
                appProperties, new LocalImportProperties(""), analysisProperties(), desktopPaths);

        assertThatThrownBy(() -> desktopOnlyService.validateSource(selected)).isInstanceOf(LocalImportException.class);

        Path granted = desktopPaths.authorize(selected);

        assertThat(desktopOnlyService.validateSource(selected)).isEqualTo(granted);
    }

    @Test
    void importFolder_copiesFiles() throws IOException {
        Path source = tempDir.resolve("source-project");
        Files.createDirectories(source.resolve("src"));
        Files.writeString(source.resolve("src/Main.java"), "class Main {}");
        Files.writeString(source.resolve("README.md"), "# Hello");

        Path target = tempDir.resolve("data/repos/1");

        LocalImportService.LocalImportResult result = service.importFolder(source, target);

        assertThat(result).isNotNull();
        assertThat(result.headSha()).hasSize(40);
        assertThat(result.branch()).isNull();
        assertThat(result.hasUncommittedChanges()).isFalse();

        // Files are copied
        assertThat(target.resolve("src/Main.java")).exists();
        assertThat(target.resolve("README.md")).exists();
    }

    @Test
    void importFolder_replacesStaleFilesAndCreatesAnalyzableGitSnapshot() throws Exception {
        Path source = tempDir.resolve("replace-source");
        Files.createDirectories(source);
        Files.writeString(source.resolve("old.txt"), "old");
        Path target = tempDir.resolve("data/repos/replace");

        service.importFolder(source, target);
        Files.delete(source.resolve("old.txt"));
        Files.writeString(source.resolve("new.txt"), "new");
        LocalImportService.LocalImportResult refreshed = service.importFolder(source, target);

        assertThat(target.resolve("old.txt")).doesNotExist();
        assertThat(target.resolve("new.txt")).exists();
        try (org.eclipse.jgit.api.Git git = org.eclipse.jgit.api.Git.open(target.toFile())) {
            assertThat(git.getRepository()
                            .resolve(org.eclipse.jgit.lib.Constants.HEAD)
                            .name())
                    .isEqualTo(refreshed.headSha());
        }
        assertThat(new FileInventoryScanner().scan(target, 100, 1_048_576).files())
                .extracting(file -> file.path())
                .containsExactly("new.txt");
    }

    @Test
    void fingerprintUsesGitBlobHashesAndChangesWithoutStoringContent() throws IOException {
        Path source = tempDir.resolve("fingerprint-source");
        Files.createDirectories(source);
        Files.writeString(source.resolve("file.txt"), "before");
        String before = service.fingerprint(source).get("file.txt");

        Files.writeString(source.resolve("file.txt"), "after");
        String after = service.fingerprint(source).get("file.txt");

        assertThat(before).hasSize(40).isNotEqualTo(after);
    }

    @Test
    void importFolder_skipsBlockedDirs() throws IOException {
        Path source = tempDir.resolve("blocked-dirs");
        Files.createDirectories(source.resolve("node_modules/pkg"));
        Files.writeString(source.resolve("node_modules/pkg/index.js"), "module.exports = {}");
        Files.createDirectories(source.resolve("src"));
        Files.writeString(source.resolve("src/app.js"), "console.log('hello')");

        Path target = tempDir.resolve("data/repos/2");

        service.importFolder(source, target);

        assertThat(target.resolve("src/app.js")).exists();
        assertThat(target.resolve("node_modules")).doesNotExist();
    }

    @Test
    void importFolder_readsGitInfo() throws Exception {
        Path source = tempDir.resolve("git-project");
        Files.createDirectories(source);
        Files.writeString(source.resolve("Main.java"), "class Main {}");

        // Init a git repo
        org.eclipse.jgit.api.Git git =
                org.eclipse.jgit.api.Git.init().setDirectory(source.toFile()).call();
        git.add().addFilepattern(".").call();
        git.commit().setMessage("initial").call();

        Path target = tempDir.resolve("data/repos/3");
        LocalImportService.LocalImportResult result = service.importFolder(source, target);

        assertThat(result.headSha()).hasSize(40); // full SHA
        assertThat(result.branch()).isNotNull();
        assertThat(result.hasUncommittedChanges()).isNull(); // no unbounded Git status inspection

        git.close();
    }

    @Test
    void importFolder_keepsDirtyStatusUnknownAndImportsWorkingBytes() throws Exception {
        Path source = tempDir.resolve("dirty-project");
        Files.createDirectories(source);
        Files.writeString(source.resolve("Main.java"), "class Main {}");

        org.eclipse.jgit.api.Git git =
                org.eclipse.jgit.api.Git.init().setDirectory(source.toFile()).call();
        git.add().addFilepattern(".").call();
        git.commit().setMessage("initial").call();

        // Create uncommitted change
        Files.writeString(source.resolve("New.java"), "class New {}");

        Path target = tempDir.resolve("data/repos/4");
        LocalImportService.LocalImportResult result = service.importFolder(source, target);

        assertThat(result.hasUncommittedChanges()).isNull();
        assertThat(Files.readString(target.resolve("New.java"))).isEqualTo("class New {}");

        git.close();
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void importFolder_rejectsTargetSymlinkEscape() throws IOException {
        Path source = tempDir.resolve("safe-source");
        Files.createDirectories(source);
        Files.writeString(source.resolve("file.txt"), "safe");
        Path reposRoot = tempDir.resolve("data/repos");
        Files.createDirectories(reposRoot);
        Path outside = tempDir.resolve("outside-target");
        Files.createDirectories(outside);
        Path escape = reposRoot.resolve("escape");
        Files.createSymbolicLink(escape, outside);

        assertThatThrownBy(() -> service.importFolder(source, escape.resolve("1")))
                .isInstanceOf(LocalImportException.class)
                .hasMessageContaining("escapes the repository storage root");
    }

    private static AnalysisProperties analysisProperties() {
        return new AnalysisProperties(20_000, 1_048_576, 10_000, 5, 1_000, 0.5);
    }
}
