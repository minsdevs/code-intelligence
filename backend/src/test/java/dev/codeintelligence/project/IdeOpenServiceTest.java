package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class IdeOpenServiceTest {

    private ProjectRepository projectRepository;
    private SnapshotRepository snapshotRepository;
    private IdeOpenService service;

    @BeforeEach
    void setUp() {
        projectRepository = mock(ProjectRepository.class);
        snapshotRepository = mock(SnapshotRepository.class);
        service = new IdeOpenService(projectRepository, snapshotRepository);
    }

    @Test
    void rejectsGithubProject() {
        Project project = new Project(1L, "test", "owner", "repo");
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        var request = new IdeOpenService.IdeOpenRequest("src/Main.java", 10, "vscode");

        assertThatThrownBy(() -> service.open(1L, 1L, request))
                .isInstanceOf(IdeOpenNotSupportedException.class)
                .hasMessageContaining("local");
    }

    @Test
    void rejectsPathTraversal() {
        Project project = new Project(1L, "test", "/tmp/test-project");
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        var request = new IdeOpenService.IdeOpenRequest("../../etc/passwd", 1, "vscode");

        assertThatThrownBy(() -> service.open(1L, 1L, request)).isInstanceOf(IdeOpenService.InvalidPathException.class);
    }

    @Test
    void rejectsAbsolutePath() {
        Project project = new Project(1L, "test", "/tmp/test-project");
        when(projectRepository.findByIdAndUserId(1L, 1L)).thenReturn(Optional.of(project));

        var request = new IdeOpenService.IdeOpenRequest("/etc/passwd", 1, "vscode");

        assertThatThrownBy(() -> service.open(1L, 1L, request)).isInstanceOf(IdeOpenService.InvalidPathException.class);
    }

    @Test
    void generatesVscodeUri() {
        String uri = service.buildUri(IdeOpenService.Ide.VSCODE, "/home/user/project/src/Main.java", 42);
        assertThat(uri).isEqualTo("vscode://file//home/user/project/src/Main.java:42");
    }

    @Test
    void generatesCursorUri() {
        String uri = service.buildUri(IdeOpenService.Ide.CURSOR, "/home/user/project/src/Main.java", 10);
        assertThat(uri).isEqualTo("cursor://file//home/user/project/src/Main.java:10");
    }

    @Test
    void generatesIntellijUri() {
        String uri = service.buildUri(IdeOpenService.Ide.INTELLIJ, "/home/user/project/src/Main.java", 5);
        assertThat(uri).startsWith("jetbrains://idea/open?file=");
        assertThat(uri).contains("line=5");
    }

    @Test
    void generatesWebstormUri() {
        String uri = service.buildUri(IdeOpenService.Ide.WEBSTORM, "/home/user/project/src/App.tsx", 1);
        assertThat(uri).startsWith("jetbrains://webstorm/open?file=");
        assertThat(uri).contains("line=1");
    }

    @Test
    void defaultsToVscodeForUnknownIde() {
        String uri = service.buildUri(IdeOpenService.Ide.VSCODE, "/path/to/file.ts", 1);
        assertThat(uri).startsWith("vscode://file/");
    }

    @Test
    void rejectsProjectNotOwned() {
        when(projectRepository.findByIdAndUserId(99L, 1L)).thenReturn(Optional.empty());

        var request = new IdeOpenService.IdeOpenRequest("src/Main.java", 1, "vscode");

        assertThatThrownBy(() -> service.open(99L, 1L, request)).isInstanceOf(ProjectNotFoundException.class);
    }
}
