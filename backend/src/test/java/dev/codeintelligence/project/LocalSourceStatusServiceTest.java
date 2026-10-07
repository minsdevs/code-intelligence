package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.util.ReflectionTestUtils;

class LocalSourceStatusServiceTest {

    @TempDir
    Path tempDir;

    private ProjectRepository projects;
    private LocalImportService imports;
    private LocalSourceStatusService service;
    private Project project;

    @BeforeEach
    void setUp() {
        projects = mock(ProjectRepository.class);
        imports = mock(LocalImportService.class);
        service = new LocalSourceStatusService(projects, imports, mock(JdbcClient.class, RETURNS_DEEP_STUBS));
        project = new Project(7, "missing", tempDir.resolve("missing").toString());
        ReflectionTestUtils.setField(project, "id", 11L);
        ReflectionTestUtils.setField(project, "currentSnapshotId", 21L);
        when(projects.findByIdAndUserId(11, 7)).thenReturn(Optional.of(project));
    }

    @Test
    void restoredUnlinkedProjectsRequireReauthorizationWithoutSourceAccess() {
        for (String localPath : new String[] {null, "", "  "}) {
            ReflectionTestUtils.setField(project, "localPath", localPath);
            LocalSourceStatusService.LocalSourceStatus status = service.get(11, 7);
            assertThat(status.state()).isEqualTo(LocalSourceStatusService.State.REAUTHORIZATION_REQUIRED);
            assertThat(status.snapshotId()).isEqualTo(21);
            assertThat(status.changedPaths()).isEmpty();
            assertThat(status.fullAnalysisRequired()).isFalse();
            assertThatThrownBy(() ->
                            service.verifyRefresh(11, 7, new LocalSourceStatusService.RefreshConfirmation(21, 0, 1, 0)))
                    .isInstanceOf(LocalRefreshConflictException.class);
        }
        verifyNoInteractions(imports);
    }

    @Test
    void missingPathIsReportedWithoutAttemptingSourceAccess() {
        LocalSourceStatusService.LocalSourceStatus status = service.get(11, 7);

        assertThat(status.state()).isEqualTo(LocalSourceStatusService.State.PATH_MISSING);
        assertThat(status.snapshotId()).isEqualTo(21);
        assertThat(status.fullAnalysisRequired()).isFalse();
    }

    @Test
    void localRefreshRequiresAnExplicitPreviewConfirmation() {
        assertThatThrownBy(() -> service.verifyRefresh(11, 7, null))
                .isInstanceOf(LocalRefreshConflictException.class)
                .hasMessageContaining("Preview local changes");
    }

    @Test
    void anotherUserCannotInspectOrRefreshTheProject() {
        assertThatThrownBy(() -> service.get(11, 8)).isInstanceOf(ProjectNotFoundException.class);
        assertThatThrownBy(() -> service.verifyRefresh(11, 8, null)).isInstanceOf(ProjectNotFoundException.class);
    }

    @Test
    void inspectionFailureDoesNotPretendThatPickerAuthorizationExpired() throws Exception {
        Path source = Files.createDirectories(tempDir.resolve("missing"));
        when(imports.validateSource(source)).thenReturn(source);
        when(imports.fingerprint(source, null)).thenThrow(new LocalImportException("sensitive-source-sentinel", null));

        LocalSourceStatusService.LocalSourceStatus status = service.get(11, 7);

        assertThat(status.state()).isEqualTo(LocalSourceStatusService.State.INSPECTION_FAILED);
        assertThat(status.fullAnalysisRequired()).isFalse();
        assertThat(status.changedPaths()).isEmpty();
        assertThat(status.message()).contains("size limits").doesNotContain("sensitive-source-sentinel");
        assertThatThrownBy(() ->
                        service.verifyRefresh(11, 7, new LocalSourceStatusService.RefreshConfirmation(21, 0, 1, 0)))
                .isInstanceOf(LocalRefreshConflictException.class);
    }

    @Test
    void rejectedRootStillRequiresAnAllowedFolderBeforeFingerprinting() throws Exception {
        Path source = Files.createDirectories(tempDir.resolve("missing"));
        when(imports.validateSource(source)).thenThrow(new LocalImportException("private-path-sentinel", null));

        LocalSourceStatusService.LocalSourceStatus status = service.get(11, 7);

        assertThat(status.state()).isEqualTo(LocalSourceStatusService.State.REAUTHORIZATION_REQUIRED);
        assertThat(status.message()).doesNotContain("private-path-sentinel");
        verify(imports, never()).fingerprint(eq(source), any());
    }
}
