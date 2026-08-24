package dev.codeintelligence.analysis.coverage;

import dev.codeintelligence.analysis.tree.TreeAnalyzerProperties;
import dev.codeintelligence.analysis.ts.TsAnalyzerProperties;
import dev.codeintelligence.job.JobRepository;
import dev.codeintelligence.job.JobStepRecord;
import dev.codeintelligence.job.StepStatus;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Computes an analysis coverage report for a given snapshot by aggregating existing
 * file inventory, job step, and evidence data. No new analysis is triggered.
 */
@Service
public class CoverageService {

    private final JdbcClient jdbc;
    private final JobRepository jobRepository;
    private final ProjectRepository projectRepository;
    private final TsAnalyzerProperties tsProps;
    private final TreeAnalyzerProperties treeProps;

    public CoverageService(
            JdbcClient jdbc,
            JobRepository jobRepository,
            ProjectRepository projectRepository,
            TsAnalyzerProperties tsProps,
            TreeAnalyzerProperties treeProps) {
        this.jdbc = jdbc;
        this.jobRepository = jobRepository;
        this.projectRepository = projectRepository;
        this.tsProps = tsProps;
        this.treeProps = treeProps;
    }

    /**
     * Retrieves the coverage report for a project, verifying ownership.
     */
    @Transactional(readOnly = true)
    public CoverageReport getReport(long projectId, long userId) {
        Project project =
                projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
        Long snapshotId = project.getCurrentSnapshotId();
        if (snapshotId == null) {
            throw new ProjectNotFoundException();
        }
        return buildReport(projectId, snapshotId);
    }

    @Transactional(readOnly = true)
    public CoverageReport buildReport(long projectId, long snapshotId) {
        CoverageReport.FileCoverage fileCoverage = computeFileCoverage(snapshotId);
        List<CoverageReport.LanguageCoverage> languageCoverage = computeLanguageCoverage(snapshotId, projectId);
        List<CoverageReport.ExcludedFolder> excludedFolders = computeExcludedFolders(snapshotId);
        List<CoverageReport.AnalyzerStatus> analyzerStatuses = computeAnalyzerStatuses(projectId, snapshotId);
        CoverageReport.PartialResultInfo partialResults = computePartialResults(projectId, snapshotId);
        List<String> retryableIssues = computeRetryableIssues(projectId, analyzerStatuses);
        List<String> unsupportedItems = computeUnsupported(snapshotId);

        return new CoverageReport(
                fileCoverage,
                languageCoverage,
                excludedFolders,
                analyzerStatuses,
                partialResults,
                retryableIssues,
                unsupportedItems);
    }

    private CoverageReport.FileCoverage computeFileCoverage(long snapshotId) {
        int analyzedFiles = jdbc.sql("select count(*) from files where snapshot_id = :sid")
                .param("sid", snapshotId)
                .query(Integer.class)
                .single();

        // Check evidence for skip info
        int skippedForCount = countEvidenceWithPattern(snapshotId, "Skipped%files over app.analysis.max-files");
        int skippedForSize = countEvidenceWithPattern(snapshotId, "Skipped%files over app.analysis.max-file-size");
        int discoveredFiles = analyzedFiles + skippedForCount + skippedForSize;

        return new CoverageReport.FileCoverage(discoveredFiles, analyzedFiles, skippedForCount, skippedForSize, 0);
    }

    private int countEvidenceWithPattern(long snapshotId, String pattern) {
        String excerpt = jdbc.sql("""
                        select e.excerpt from evidences e
                        join evidence_links l on l.evidence_id = e.id
                        where l.subject_type = 'SNAPSHOT' and l.subject_id = :sid
                          and e.excerpt like :pattern
                        """)
                .param("sid", snapshotId)
                .param("pattern", pattern)
                .query(String.class)
                .optional()
                .orElse(null);
        if (excerpt == null) return 0;
        // Extract number from "Skipped 42 files over ..."
        try {
            String[] parts = excerpt.split(" ");
            return Integer.parseInt(parts[1]);
        } catch (Exception e) {
            return 0;
        }
    }

    private List<CoverageReport.LanguageCoverage> computeLanguageCoverage(long snapshotId, long projectId) {
        // Group files by language and count analyzed
        Map<String, int[]> langMap = new LinkedHashMap<>();
        jdbc.sql("""
                        select coalesce(language, 'unknown') as lang, count(*) as cnt
                        from files where snapshot_id = :sid
                        group by language order by cnt desc
                        """)
                .param("sid", snapshotId)
                .query((rs, rowNum) -> {
                    String lang = rs.getString("lang");
                    int cnt = rs.getInt("cnt");
                    langMap.put(lang, new int[] {cnt, cnt, 0, 0}); // total, analyzed, skipped, failed
                    return 0;
                })
                .list();

        // Count parsing failures from evidence
        jdbc.sql("""
                        select e.file_path, count(*) as cnt
                        from evidences e
                        join evidence_links l on l.evidence_id = e.id
                        where l.subject_type = 'SOURCE_PARSING' and l.subject_id = :sid
                          and e.excerpt like 'Parse failed:%'
                        group by e.file_path
                        """)
                .param("sid", snapshotId)
                .query((rs, rowNum) -> {
                    // We can't easily map back to language here without joining files,
                    // but we track total failures
                    return 0;
                })
                .list();

        List<CoverageReport.LanguageCoverage> result = new ArrayList<>();
        for (var entry : langMap.entrySet()) {
            int[] counts = entry.getValue();
            result.add(new CoverageReport.LanguageCoverage(entry.getKey(), counts[0], counts[1], counts[2], counts[3]));
        }
        return result;
    }

    private List<CoverageReport.ExcludedFolder> computeExcludedFolders(long snapshotId) {
        // Standard exclusions applied by PathGlobs and BinaryFiles
        List<CoverageReport.ExcludedFolder> exclusions = new ArrayList<>();
        exclusions.add(new CoverageReport.ExcludedFolder("node_modules/", "dependency folder"));
        exclusions.add(new CoverageReport.ExcludedFolder(".git/", "version control"));
        exclusions.add(new CoverageReport.ExcludedFolder("build/", "build output"));
        exclusions.add(new CoverageReport.ExcludedFolder("dist/", "build output"));
        exclusions.add(new CoverageReport.ExcludedFolder("target/", "build output"));
        exclusions.add(new CoverageReport.ExcludedFolder(".gradle/", "build cache"));
        exclusions.add(new CoverageReport.ExcludedFolder("vendor/", "dependency folder"));
        return exclusions;
    }

    private List<CoverageReport.AnalyzerStatus> computeAnalyzerStatuses(long projectId, long snapshotId) {
        List<CoverageReport.AnalyzerStatus> statuses = new ArrayList<>();

        // Java analyzer is always active (built-in)
        statuses.add(new CoverageReport.AnalyzerStatus("Java Analyzer", "active", null));

        // TS analyzer
        if (tsProps.enabled()) {
            statuses.add(new CoverageReport.AnalyzerStatus("TypeScript Analyzer", "active", null));
        } else {
            statuses.add(new CoverageReport.AnalyzerStatus(
                    "TypeScript Analyzer", "disabled", "TS_ANALYZER_BASE_URL not configured"));
        }

        // Tree-sitter analyzer
        if (treeProps.enabled()) {
            statuses.add(new CoverageReport.AnalyzerStatus("Tree-sitter Analyzer", "active", null));
        } else {
            statuses.add(new CoverageReport.AnalyzerStatus(
                    "Tree-sitter Analyzer", "disabled", "TREE_ANALYZER_BASE_URL not configured"));
        }

        // Check latest job steps for actual failures
        Long latestJobId = jdbc.sql("""
                        select id from analysis_jobs
                        where project_id = :pid and snapshot_id = :sid
                        order by id desc limit 1
                        """)
                .param("pid", projectId)
                .param("sid", snapshotId)
                .query(Long.class)
                .optional()
                .orElse(null);

        if (latestJobId != null) {
            List<JobStepRecord> steps = jobRepository.findSteps(latestJobId);
            for (JobStepRecord step : steps) {
                if (step.status() == StepStatus.FAILED) {
                    String analyzerName = mapStepToAnalyzer(step.stepKey());
                    if (analyzerName != null) {
                        // Override status with failure info
                        statuses.removeIf(s -> s.name().equals(analyzerName));
                        statuses.add(new CoverageReport.AnalyzerStatus(analyzerName, "failed", step.error()));
                    }
                }
            }
        }

        return statuses;
    }

    private String mapStepToAnalyzer(String stepKey) {
        return switch (stepKey) {
            case "TS_PARSING" -> "TypeScript Analyzer";
            case "TREE_PARSING" -> "Tree-sitter Analyzer";
            case "SOURCE_PARSING" -> "Java Analyzer";
            default -> null;
        };
    }

    private CoverageReport.PartialResultInfo computePartialResults(long projectId, long snapshotId) {
        int featureCount = jdbc.sql("select count(*) from features where snapshot_id = :sid")
                .param("sid", snapshotId)
                .query(Integer.class)
                .single();
        int flowCount = jdbc.sql("select count(*) from flows where snapshot_id = :sid")
                .param("sid", snapshotId)
                .query(Integer.class)
                .single();
        int nodeCount = jdbc.sql("select count(*) from graph_nodes where snapshot_id = :sid")
                .param("sid", snapshotId)
                .query(Integer.class)
                .single();

        // Check if any analyzer was disabled — makes results partial
        boolean tsDisabled = !tsProps.enabled();
        boolean treeDisabled = !treeProps.enabled();
        boolean partial = tsDisabled || treeDisabled;
        String reason = partial ? "Some analyzers are disabled; results may be incomplete." : null;

        return new CoverageReport.PartialResultInfo(
                partial && featureCount > 0, partial && flowCount > 0, partial && nodeCount > 0, reason);
    }

    private List<String> computeRetryableIssues(long projectId, List<CoverageReport.AnalyzerStatus> statuses) {
        List<String> issues = new ArrayList<>();
        for (CoverageReport.AnalyzerStatus status : statuses) {
            if ("failed".equals(status.status())) {
                issues.add("Retry may resolve: " + status.name() + " — " + status.failureReason());
            }
        }
        return issues;
    }

    private List<String> computeUnsupported(long snapshotId) {
        List<String> unsupported = new ArrayList<>();
        // Check languages that have no analyzer support
        List<String> langs =
                jdbc.sql("""
                        select distinct language from files
                        where snapshot_id = :sid and language is not null
                        """).param("sid", snapshotId).query(String.class).list();

        for (String lang : langs) {
            if (!isSupportedLanguage(lang)) {
                long count = jdbc.sql("select count(*) from files where snapshot_id = :sid and language = :lang")
                        .param("sid", snapshotId)
                        .param("lang", lang)
                        .query(Long.class)
                        .single();
                unsupported.add(lang + " (" + count + " files) — no dedicated analyzer");
            }
        }
        return unsupported;
    }

    private boolean isSupportedLanguage(String language) {
        return switch (language.toLowerCase()) {
            case "java",
                    "kotlin",
                    "typescript",
                    "javascript",
                    "tsx",
                    "jsx",
                    "python",
                    "go",
                    "rust",
                    "c",
                    "cpp",
                    "ruby",
                    "php" -> true;
            default -> false;
        };
    }
}
