package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

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
    private LocalSourceStatusService service;
    private Project project;

    @BeforeEach
    void setUp() {
        projects = mock(ProjectRepository.class);
        LocalImportService imports = mock(LocalImportService.class);
        service = new LocalSourceStatusService(projects, imports, mock(JdbcClient.class));
        project = new Project(7, "missing", tempDir.resolve("missing").toString());
        ReflectionTestUtils.setField(project, "id", 11L);
        ReflectionTestUtils.setField(project, "currentSnapshotId", 21L);
        when(projects.findByIdAndUserId(11, 7)).thenReturn(Optional.of(project));
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
}
