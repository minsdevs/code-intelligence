package dev.codeintelligence.analysis.finding;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;

class FindingServiceJudgmentTest {

    private FindingService service;
    private ProjectRepository projects;

    @BeforeEach
    void setUp() {
        projects = mock(ProjectRepository.class);
        service = new FindingService(projects, mock(SnapshotRepository.class), mock(JdbcClient.class));
        when(projects.findByIdAndUserId(3, 4)).thenReturn(Optional.of(mock(Project.class)));
    }

    @Test
    void judgmentRejectsUnsupportedStatusBeforeWriting() {
        assertThatThrownBy(() -> service.judge(3, 4, 8, "HIDDEN_FOREVER", "no"))
                .isInstanceOf(InvalidFindingJudgmentException.class)
                .hasMessageContaining("Unsupported");
    }

    @Test
    void judgmentRejectsOversizedReasonBeforeWriting() {
        assertThatThrownBy(() -> service.judge(3, 4, 8, "FALSE_POSITIVE", "x".repeat(501)))
                .isInstanceOf(InvalidFindingJudgmentException.class)
                .hasMessageContaining("500");
    }

    @Test
    void judgmentDoesNotRevealAnotherUsersFinding() {
        assertThatThrownBy(() -> service.judge(3, 5, 8, "ACCEPTED", "reviewed"))
                .isInstanceOf(ProjectNotFoundException.class);
    }
}
