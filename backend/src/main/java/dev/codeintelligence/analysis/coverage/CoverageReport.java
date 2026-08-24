package dev.codeintelligence.analysis.coverage;

import java.util.List;

/**
 * Analysis Coverage Report: shows what was analyzed, what was skipped, and what failed.
 * This gives users a clear picture of result completeness.
 */
public record CoverageReport(
        FileCoverage fileCoverage,
        List<LanguageCoverage> languageCoverage,
        List<ExcludedFolder> excludedFolders,
        List<AnalyzerStatus> analyzerStatuses,
        PartialResultInfo partialResults,
        List<String> retryableIssues,
        List<String> unsupportedItems) {

    public record FileCoverage(
            int discoveredFiles, int analyzedFiles, int skippedForCount, int skippedForSize, int skippedBinary) {}

    public record LanguageCoverage(String language, int total, int analyzed, int skipped, int failed) {}

    public record ExcludedFolder(String path, String reason) {}

    public record AnalyzerStatus(String name, String status, String failureReason) {}

    public record PartialResultInfo(
            boolean featuresPartial, boolean flowsPartial, boolean graphPartial, String reason) {}
}
