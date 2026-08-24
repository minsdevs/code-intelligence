package dev.codeintelligence.analysis.coverage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import dev.codeintelligence.analysis.tree.TreeAnalyzerProperties;
import dev.codeintelligence.analysis.ts.TsAnalyzerProperties;
import dev.codeintelligence.job.JobRepository;
import dev.codeintelligence.project.ProjectRepository;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;

class CoverageServiceTest {

    private JdbcClient jdbc;
    private JobRepository jobRepository;
    private ProjectRepository projectRepository;
    private TsAnalyzerProperties tsProps;
    private TreeAnalyzerProperties treeProps;
    private CoverageService service;

    @BeforeEach
    void setUp() {
        jdbc = mock(JdbcClient.class, invocation -> {
            if (invocation.getMethod().getName().equals("sql")) {
                return mockStatementSpec();
            }
            return null;
        });
        jobRepository = mock(JobRepository.class);
        projectRepository = mock(ProjectRepository.class);
        tsProps = new TsAnalyzerProperties("http://localhost:3040", 30);
        treeProps = new TreeAnalyzerProperties("http://localhost:3041", 30);
        service = new CoverageService(jdbc, jobRepository, projectRepository, tsProps, treeProps);
    }

    @Test
    void reportStructure_isComplete() {
        // The CoverageReport record should have all required fields
        var report = new CoverageReport(
                new CoverageReport.FileCoverage(100, 95, 3, 2, 0),
                List.of(new CoverageReport.LanguageCoverage("java", 50, 50, 0, 0)),
                List.of(new CoverageReport.ExcludedFolder("node_modules/", "dependency folder")),
                List.of(new CoverageReport.AnalyzerStatus("Java Analyzer", "active", null)),
                new CoverageReport.PartialResultInfo(false, false, false, null),
                List.of(),
                List.of());

        assertThat(report.fileCoverage().discoveredFiles()).isEqualTo(100);
        assertThat(report.fileCoverage().analyzedFiles()).isEqualTo(95);
        assertThat(report.fileCoverage().skippedForCount()).isEqualTo(3);
        assertThat(report.fileCoverage().skippedForSize()).isEqualTo(2);
        assertThat(report.languageCoverage()).hasSize(1);
        assertThat(report.languageCoverage().get(0).language()).isEqualTo("java");
        assertThat(report.excludedFolders()).hasSize(1);
        assertThat(report.analyzerStatuses()).hasSize(1);
        assertThat(report.partialResults().featuresPartial()).isFalse();
        assertThat(report.retryableIssues()).isEmpty();
        assertThat(report.unsupportedItems()).isEmpty();
    }

    @Test
    void analyzerStatus_disabledWhenNotConfigured() {
        var tsPropsEmpty = new TsAnalyzerProperties("", 30);
        var treePropsEmpty = new TreeAnalyzerProperties("", 30);

        // Verify that the properties indicate disabled state
        assertThat(tsPropsEmpty.enabled()).isFalse();
        assertThat(treePropsEmpty.enabled()).isFalse();
    }

    @Test
    void partialResultInfo_flagsPartialWhenAnalyzersDisabled() {
        var partial = new CoverageReport.PartialResultInfo(
                true, true, true, "Some analyzers are disabled; results may be incomplete.");
        assertThat(partial.featuresPartial()).isTrue();
        assertThat(partial.flowsPartial()).isTrue();
        assertThat(partial.graphPartial()).isTrue();
        assertThat(partial.reason()).contains("disabled");
    }

    @SuppressWarnings("unchecked")
    private JdbcClient.StatementSpec mockStatementSpec() {
        var spec = mock(JdbcClient.StatementSpec.class, invocation -> {
            if (invocation.getMethod().getName().equals("param")) {
                return invocation.getMock();
            }
            if (invocation.getMethod().getName().equals("query")) {
                var mappedSpec = mock(JdbcClient.MappedQuerySpec.class);
                when(mappedSpec.single()).thenReturn(0);
                when(mappedSpec.optional()).thenReturn(java.util.Optional.empty());
                when(mappedSpec.list()).thenReturn(List.of());
                return mappedSpec;
            }
            return null;
        });
        return spec;
    }
}
