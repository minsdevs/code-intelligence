package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.job.JobWorker;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * F-1 / SEC-M-02 on real PostgreSQL without a configured allowed root: a new local selection is
 * previewed and confirmed only under its native-dialog grant, which is spent once by the
 * confirmation and refused for a swapped folder.
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
class DesktopPathGrantIntegrationTest {
    @TempDir
    static Path root;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    LocalSourceApprovalService approvals;

    @Autowired
    ProjectService projects;

    @Autowired
    DesktopPathAuthorizationService desktopPaths;

    @MockitoBean
    JobWorker worker;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add("app.local-import.allowed-roots", () -> "");
    }

    @Test
    void aSelectionIsPreviewedRepeatedlyButConfirmedOnlyOnceUnderItsGrant() throws Exception {
        long user = user();
        Path source = source();
        String grant = desktopPaths.authorize(source).nonce();

        assertThatThrownBy(() -> approvals.previewInitial(user, source.toString(), "no grant"))
                .isInstanceOf(LocalImportException.class);
        assertThatThrownBy(() -> approvals.previewInitial(user, source.toString(), "forged", "0".repeat(64)))
                .isInstanceOf(LocalImportException.class);
        approvals.previewInitial(user, source.toString(), "first look", grant);
        LocalSourcePreview preview = approvals.previewInitial(user, source.toString(), "Granted", grant);
        LocalSourcePreview spare = approvals.previewInitial(user, source.toString(), "Granted again", grant);

        var created = projects.createFromLocal(
                user,
                new ProjectController.CreateLocalProjectRequest(
                        source.toString(), "Granted", preview.previewToken(), grant));

        assertThat(created.jobId()).isPositive();
        // Replay: the spent grant neither confirms another approval nor previews the folder again.
        assertThatThrownBy(() -> projects.createFromLocal(
                        user,
                        new ProjectController.CreateLocalProjectRequest(
                                source.toString(), "Granted again", spare.previewToken(), grant)))
                .isInstanceOf(LocalImportException.class);
        assertThatThrownBy(() -> approvals.previewInitial(user, source.toString(), "replayed", grant))
                .isInstanceOf(LocalImportException.class);
        assertThat(jdbc.queryForObject("select count(*) from projects where user_id = ?", Integer.class, user))
                .isEqualTo(1);
        // The confirmed project's own refresh needs no new dialog.
        jdbc.update(
                "update analysis_jobs set status = 'DONE' where project_id = ?",
                created.project().id());
        assertThat(approvals.previewRefresh(created.project().id(), user).operation())
                .isEqualTo("REFRESH");
    }

    @Test
    void aConfirmationWithoutTheGrantCreatesNothingAndLeavesTheGrantUsable() throws Exception {
        long user = user();
        Path source = source();
        String grant = desktopPaths.authorize(source).nonce();
        LocalSourcePreview preview = approvals.previewInitial(user, source.toString(), "Missing grant", grant);

        assertThatThrownBy(() -> projects.createFromLocal(
                        user,
                        new ProjectController.CreateLocalProjectRequest(
                                source.toString(), "Missing grant", preview.previewToken())))
                .isInstanceOf(LocalImportException.class);

        assertThat(jdbc.queryForObject("select count(*) from projects where user_id = ?", Integer.class, user))
                .isZero();
        assertThat(desktopPaths.isGranted(grant, source.toRealPath())).isTrue();
    }

    @Test
    void aFolderSwappedAfterTheDialogIsNotPreviewed() throws Exception {
        long user = user();
        Path source = source();
        String grant = desktopPaths.authorize(source).nonce();

        Files.move(source, source.resolveSibling(source.getFileName() + "-original"));
        Files.createDirectories(source);
        Files.writeString(source.resolve("a.txt"), "AAAA");

        assertThatThrownBy(() -> approvals.previewInitial(user, source.toString(), "Swapped", grant))
                .isInstanceOf(LocalImportException.class);
    }

    @Test
    void aRelinkSpendsItsOwnGrant() throws Exception {
        long user = user();
        Path source = source();
        String grant = desktopPaths.authorize(source).nonce();
        LocalSourcePreview preview = approvals.previewInitial(user, source.toString(), "Relinked", grant);
        long project = projects.createFromLocal(
                        user,
                        new ProjectController.CreateLocalProjectRequest(
                                source.toString(), "Relinked", preview.previewToken(), grant))
                .project()
                .id();
        jdbc.update("update analysis_jobs set status = 'DONE' where project_id = ?", project);
        Path moved = source();

        assertThatThrownBy(() -> projects.relinkLocalSource(project, user, moved.toString(), null))
                .isInstanceOf(LocalImportException.class);
        String relink = desktopPaths.authorize(moved).nonce();
        projects.relinkLocalSource(project, user, moved.toString(), relink);
        assertThatThrownBy(() -> projects.relinkLocalSource(project, user, moved.toString(), relink))
                .isInstanceOf(LocalImportException.class);
    }

    private long user() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject(
                "insert into users (login, identity_type, local_key) values (?, 'LOCAL', ?) returning id",
                Long.class,
                "grant-fixture-" + unique,
                unique);
    }

    private Path source() throws Exception {
        Path source = Files.createDirectories(root.resolve("sources/" + UUID.randomUUID()));
        Files.writeString(source.resolve("a.txt"), "AAAA");
        return source.toRealPath();
    }
}
