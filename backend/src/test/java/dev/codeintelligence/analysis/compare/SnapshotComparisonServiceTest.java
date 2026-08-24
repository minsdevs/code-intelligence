package dev.codeintelligence.analysis.compare;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import dev.codeintelligence.analysis.coverage.CoverageReport;
import dev.codeintelligence.analysis.coverage.CoverageService;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.Snapshot;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;

class SnapshotComparisonServiceTest {

    private SnapshotComparisonService service;
    private ProjectRepository projects;

    @BeforeEach
    void setUp() {
        projects = mock(ProjectRepository.class);
        SnapshotRepository snapshots = mock(SnapshotRepository.class);
        CoverageService coverage = mock(CoverageService.class);
        service = new SnapshotComparisonService(projects, snapshots, coverage, mock(JdbcClient.class));

        Project project = mock(Project.class);
        Snapshot snapshot = mock(Snapshot.class);
        when(projects.findByIdAndUserId(5, 9)).thenReturn(Optional.of(project));
        when(snapshots.findByIdAndProjectId(12, 5)).thenReturn(Optional.of(snapshot));
        when(coverage.buildReport(5, 12)).thenReturn(emptyCoverage());
    }

    @Test
    void comparingTheSameSnapshotIsEmptyAndDeterministic() {
        var first = service.compare(5, 9, 12, 12);
        var second = service.compare(5, 9, 12, 12);

        assertThat(first).isEqualTo(second);
        assertThat(first.features().added()).isEmpty();
        assertThat(first.flows().removed()).isEmpty();
        assertThat(first.findings().changed()).isEmpty();
        assertThat(first.structure().nodes().added()).isEmpty();
        assertThat(first.structure().relationships().removed()).isEmpty();
        assertThat(first.regressionWarnings()).isEmpty();
    }

    @Test
    void comparisonIsOwnerScoped() {
        assertThatThrownBy(() -> service.compare(5, 10, 12, 12)).isInstanceOf(ProjectNotFoundException.class);
    }

    private static CoverageReport emptyCoverage() {
        return new CoverageReport(
                new CoverageReport.FileCoverage(0, 0, 0, 0, 0),
                List.of(),
                List.of(),
                List.of(),
                new CoverageReport.PartialResultInfo(false, false, false, null),
                List.of(),
                List.of());
    }
}
