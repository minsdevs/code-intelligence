package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** F-1 / SEC-M-02: a native-dialog grant is one exact root, pinned to its identity, expiring and spent once. */
class DesktopPathAuthorizationServiceTest {
    @TempDir
    Path temp;

    private final AtomicReference<Instant> now = new AtomicReference<>(Instant.parse("2026-10-07T10:00:00Z"));

    private DesktopPathAuthorizationService service() {
        return new DesktopPathAuthorizationService(new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return now.get();
            }
        });
    }

    private Path folder(String name) throws Exception {
        return Files.createDirectories(temp.resolve(name)).toRealPath();
    }

    @Test
    void aGrantCarriesTheCanonicalRootARandomNonceAndAnExpiry() throws Exception {
        Path root = folder("project");
        DesktopPathAuthorizationService paths = service();

        DesktopPathAuthorizationService.Grant first = paths.authorize(root.resolve("../project"));
        DesktopPathAuthorizationService.Grant second = paths.authorize(root);

        assertThat(first.path()).isEqualTo(root);
        assertThat(first.nonce()).matches("[0-9a-f]{64}").isNotEqualTo(second.nonce());
        assertThat(first.expiresAt()).isEqualTo(now.get().plus(DesktopPathAuthorizationService.GRANT_TTL));
        assertThat(DesktopPathAuthorizationService.GRANT_TTL).isLessThanOrEqualTo(Duration.ofMinutes(15));
        assertThat(paths.isGranted(first.nonce(), root)).isTrue();
        assertThat(paths.isAuthorized(root)).isTrue();
    }

    @Test
    void aGrantCoversExactlyItsRootNotDescendantsSiblingsOrOtherNonces() throws Exception {
        Path root = folder("project");
        Path child = folder("project/src");
        Path sibling = folder("sibling");
        DesktopPathAuthorizationService paths = service();
        String nonce = paths.authorize(root).nonce();

        assertThat(paths.isGranted(nonce, child)).isFalse();
        assertThat(paths.isGranted(nonce, sibling)).isFalse();
        assertThat(paths.isGranted("0".repeat(64), root)).isFalse();
        assertThat(paths.isGranted(null, root)).isFalse();
        assertThat(paths.isAuthorized(child)).isFalse();
        assertThat(paths.isAuthorized(sibling)).isFalse();
    }

    @Test
    void anExpiredGrantIsRefusedForPreviewAndConfirmation() throws Exception {
        Path root = folder("project");
        DesktopPathAuthorizationService paths = service();
        String nonce = paths.authorize(root).nonce();

        now.set(now.get().plus(DesktopPathAuthorizationService.GRANT_TTL));

        assertThat(paths.isGranted(nonce, root)).isFalse();
        assertThat(paths.isAuthorized(root)).isFalse();
        assertThatThrownBy(() -> paths.consume(nonce, root)).isInstanceOf(LocalImportException.class);
        assertThat(paths.isAuthorized(root)).isFalse();
    }

    @Test
    void aGrantIsSpentOnceAndItsRootThenServesOnlyTheConfirmedProject() throws Exception {
        Path root = folder("project");
        DesktopPathAuthorizationService paths = service();
        String nonce = paths.authorize(root).nonce();

        paths.consume(nonce, root);

        assertThat(paths.isGranted(nonce, root)).isFalse();
        assertThatThrownBy(() -> paths.consume(nonce, root)).isInstanceOf(LocalImportException.class);
        // Refresh and the approved copy of the confirmed project keep working without a new dialog.
        assertThat(paths.isAuthorized(root)).isTrue();
        assertThat(paths.isAuthorized(folder("project/src"))).isFalse();
    }

    @Test
    void aSwappedRootFolderIsRefusedEvenAtTheSamePath() throws Exception {
        Path root = folder("project");
        DesktopPathAuthorizationService paths = service();
        String nonce = paths.authorize(root).nonce();

        Files.move(root, temp.resolve("project-original"));
        Files.createDirectories(root);

        assertThat(paths.isGranted(nonce, root.toRealPath())).isFalse();
        assertThat(paths.isAuthorized(root.toRealPath())).isFalse();
        assertThatThrownBy(() -> paths.consume(nonce, root.toRealPath())).isInstanceOf(LocalImportException.class);
    }

    @Test
    void aRestoredProjectRootCarriesNoGrantForANewSelection() throws Exception {
        Path root = folder("project");
        DesktopPathAuthorizationService paths = service();

        assertThat(paths.restore(root)).isEqualTo(root);

        assertThat(paths.isAuthorized(root)).isTrue();
        assertThat(paths.isGranted(null, root)).isFalse();
        assertThat(paths.isAuthorized(folder("project/nested"))).isFalse();
    }

    @Test
    void nonDirectoriesAreNeverGranted() throws Exception {
        Path file = Files.writeString(temp.resolve("file.txt"), "x");
        DesktopPathAuthorizationService paths = service();

        assertThatThrownBy(() -> paths.authorize(file)).isInstanceOf(LocalImportException.class);
        assertThatThrownBy(() -> paths.restore(temp.resolve("missing"))).isInstanceOf(LocalImportException.class);
    }
}
