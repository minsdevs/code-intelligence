package dev.codeintelligence.export;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import dev.codeintelligence.analysis.coverage.CoverageReport;
import dev.codeintelligence.analysis.coverage.CoverageService;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;

class ExportServiceTest {

    private ProjectRepository projectRepository;
    private SnapshotRepository snapshotRepository;
    private CoverageService coverageService;
    private JdbcClient jdbc;
    private ExportService service;

    @BeforeEach
    void setUp() {
        projectRepository = mock(ProjectRepository.class);
        snapshotRepository = mock(SnapshotRepository.class);
        coverageService = mock(CoverageService.class);
        jdbc = mock(JdbcClient.class, org.mockito.Mockito.RETURNS_DEEP_STUBS);
        service = new ExportService(projectRepository, snapshotRepository, coverageService, jdbc);
    }

    @Test
    void markdownContainsStructure() {
        var data = sampleData();
        String md = service.toMarkdown(data);

        assertThat(md).contains("# TestProject — Analysis Summary");
        assertThat(md).contains("**Commit:** `abc123`");
        assertThat(md).contains("## Areas");
        assertThat(md).contains("## Key Features");
        assertThat(md).contains("## Representative Flows");
        assertThat(md).contains("## Risk Findings");
        assertThat(md).contains("## Coverage");
    }

    @Test
    void markdownContainsInternalLinks() {
        var data = sampleData();
        String md = service.toMarkdown(data);

        assertThat(md).contains("[→ view](/projects/1/features/");
        assertThat(md).contains("[→ view](/projects/1/flows/");
    }

    @Test
    void markdownDoesNotContainSourceCode() {
        var data = sampleData();
        String md = service.toMarkdown(data);

        // Should not contain code blocks with source content
        assertThat(md).doesNotContain("public class");
        assertThat(md).doesNotContain("import ");
        assertThat(md).doesNotContain("function ");
    }

    @Test
    void markdownRedactsSecrets() {
        // SecretMask.redact() is applied at buildExportData time, not in toMarkdown.
        // Verify that data that went through SecretMask produces safe markdown.
        String masked = dev.codeintelligence.evidence.SecretMask.redact("Auth with ghp_secrettoken123456789");
        var data = new ExportService.ExportData(
                "Project",
                "LOCAL",
                "abc123",
                "2026-08-24",
                1L,
                List.of(new ExportService.ExportArea("BACKEND", 0.9, "Java, Spring")),
                List.of(new ExportService.ExportFeature(1L, masked, "AST", 0.9)),
                List.of(),
                List.of(),
                emptyCoverage());
        String md = service.toMarkdown(data);

        assertThat(md).doesNotContain("ghp_secrettoken123456789");
        assertThat(md).contains("[REDACTED]");
    }

    @Test
    void jsonContainsRequiredFields() {
        var data = sampleData();
        Map<String, Object> json = service.toJson(data);

        assertThat(json).containsKey("projectName");
        assertThat(json).containsKey("commitSha");
        assertThat(json).containsKey("areas");
        assertThat(json).containsKey("features");
        assertThat(json).containsKey("flows");
        assertThat(json).containsKey("findings");
        assertThat(json).containsKey("coverage");
        assertThat(json).containsKey("_links");
    }

    @Test
    void jsonLinksAreCorrect() {
        var data = sampleData();
        Map<String, Object> json = service.toJson(data);

        @SuppressWarnings("unchecked")
        Map<String, String> links = (Map<String, String>) json.get("_links");
        assertThat(links.get("features")).isEqualTo("/projects/1/features");
        assertThat(links.get("flows")).isEqualTo("/projects/1/flows");
    }

    private ExportService.ExportData sampleData() {
        return new ExportService.ExportData(
                "TestProject",
                "LOCAL",
                "abc123",
                "2026-08-24 10:00 (UTC)",
                1L,
                List.of(
                        new ExportService.ExportArea("BACKEND", 0.95, "Java, Spring Boot"),
                        new ExportService.ExportArea("FRONTEND", 0.8, "React, TypeScript")),
                List.of(
                        new ExportService.ExportFeature(1L, "User Authentication", "AST", 0.92),
                        new ExportService.ExportFeature(2L, "Payment Processing", "HEURISTIC", 0.85)),
                List.of(new ExportService.ExportFlow(1L, "Login Flow", "REQUEST")),
                List.of(new ExportService.ExportFinding(1L, "SECURITY", "HIGH", "SQL Injection risk")),
                emptyCoverage());
    }

    private CoverageReport emptyCoverage() {
        return new CoverageReport(
                new CoverageReport.FileCoverage(100, 80, 10, 5, 5),
                List.of(),
                List.of(),
                List.of(),
                new CoverageReport.PartialResultInfo(false, false, false, null),
                List.of(),
                List.of());
    }
}
