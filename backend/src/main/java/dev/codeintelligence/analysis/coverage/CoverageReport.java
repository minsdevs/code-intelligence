package dev.codeintelligence.analysis.coverage;

import java.util.List;
import java.util.Map;

/**
 * Snapshot inventory, explicit parser outcomes, and recorded job-step facts. Legacy snapshots do not persist per-file analyzer
 * outcomes, so inventory counts and completed steps cannot establish analysis coverage or support.
 * Existing JSON keys remain, but unmeasured counters are now null; numeric-only clients must update.
 */
public record CoverageReport(
        FileCoverage fileCoverage,
        List<LanguageCoverage> languageCoverage,
        List<ExcludedFolder> excludedFolders,
        List<AnalyzerStatus> analyzerStatuses,
        PartialResultInfo partialResults,
        List<String> retryableIssues,
        List<String> unsupportedItems,
        String measurementStatus,
        String supportStatus,
        LocalImportSummary localImport,
        Long snapshotId,
        OutcomeSummary outcomes,
        List<CapabilityOutcome> capabilityOutcomes) {

    /** Adapter capabilities in report order (03 AdapterDescriptor capability set). */
    public static final List<String> CAPABILITIES = List.of("P", "S", "C", "F", "X");

    public static final String NOT_RECORDED = "NOT_RECORDED";

    /**
     * Per-capability file partition (03 coverage invariants): eligible = successful + partial + failed + unsupported +
     * pending; a cancelled attempt never publishes its snapshot, so its files stay pending. eligible + unmeasured equals
     * the snapshot's file rows. Counts are null when the capability's outcomes were not recorded for this snapshot.
     */
    public record CapabilityOutcome(
            String capability,
            String measurementStatus,
            Integer eligibleFiles,
            Integer successfulFiles,
            Integer partialFiles,
            Integer failedFiles,
            Integer unsupportedFiles,
            Integer pendingFiles,
            Integer unmeasuredFiles) {

        public static CapabilityOutcome unrecorded(String capability, String measurementStatus) {
            return new CapabilityOutcome(capability, measurementStatus, null, null, null, null, null, null, null);
        }
    }

    public CoverageReport(
            FileCoverage fileCoverage,
            List<LanguageCoverage> languageCoverage,
            List<ExcludedFolder> excludedFolders,
            List<AnalyzerStatus> analyzerStatuses,
            PartialResultInfo partialResults,
            List<String> retryableIssues,
            List<String> unsupportedItems,
            String measurementStatus,
            String supportStatus,
            LocalImportSummary localImport,
            Long snapshotId,
            OutcomeSummary outcomes) {
        this(
                fileCoverage,
                languageCoverage,
                excludedFolders,
                analyzerStatuses,
                partialResults,
                retryableIssues,
                unsupportedItems,
                measurementStatus,
                supportStatus,
                localImport,
                snapshotId,
                outcomes,
                null);
    }

    public record OutcomeSummary(
            int discoveredFiles,
            int targetedFiles,
            int successfulFiles,
            int partialFiles,
            int failedFiles,
            int excludedFiles,
            int unsupportedFiles,
            int unmeasuredFiles,
            int pendingFiles,
            int excludedSubmodules) {}

    public CoverageReport(
            FileCoverage fileCoverage,
            List<LanguageCoverage> languageCoverage,
            List<ExcludedFolder> excludedFolders,
            List<AnalyzerStatus> analyzerStatuses,
            PartialResultInfo partialResults,
            List<String> retryableIssues,
            List<String> unsupportedItems,
            String measurementStatus,
            String supportStatus,
            LocalImportSummary localImport) {
        this(
                fileCoverage,
                languageCoverage,
                excludedFolders,
                analyzerStatuses,
                partialResults,
                retryableIssues,
                unsupportedItems,
                measurementStatus,
                supportStatus,
                localImport,
                null,
                null);
    }

    public static final String LEGACY_UNMEASURED = "LEGACY_UNMEASURED";
    public static final String SUPPORT_UNVERIFIED = "UNVERIFIED";
    public static final String COMPLETENESS_UNKNOWN = "Per-file analyzer outcomes were not recorded for this snapshot. "
            + "Analysis coverage and result completeness are unknown.";

    /** Older reports have no measured local-import summary. */
    public CoverageReport(
            FileCoverage fileCoverage,
            List<LanguageCoverage> languageCoverage,
            List<ExcludedFolder> excludedFolders,
            List<AnalyzerStatus> analyzerStatuses,
            PartialResultInfo partialResults,
            List<String> retryableIssues,
            List<String> unsupportedItems,
            String measurementStatus,
            String supportStatus) {
        this(
                fileCoverage,
                languageCoverage,
                excludedFolders,
                analyzerStatuses,
                partialResults,
                retryableIssues,
                unsupportedItems,
                measurementStatus,
                supportStatus,
                null);
    }

    /** Source-compatible legacy construction does not establish a measured or supported result. */
    public CoverageReport(
            FileCoverage fileCoverage,
            List<LanguageCoverage> languageCoverage,
            List<ExcludedFolder> excludedFolders,
            List<AnalyzerStatus> analyzerStatuses,
            PartialResultInfo partialResults,
            List<String> retryableIssues,
            List<String> unsupportedItems) {
        this(
                fileCoverage,
                languageCoverage,
                excludedFolders,
                analyzerStatuses,
                partialResults,
                retryableIssues,
                unsupportedItems,
                LEGACY_UNMEASURED,
                SUPPORT_UNVERIFIED);
    }

    /**
     * inventoriedFiles counts stored file rows, not parser successes. discoveredFiles is a deprecated
     * inventory alias, not a complete discovery denominator. Skip counts describe recorded inventory
     * omissions only; absent or ambiguous evidence is null, never an inferred zero.
     */
    public record FileCoverage(
            @Deprecated int discoveredFiles,
            @Deprecated Integer analyzedFiles,
            Integer skippedForCount,
            Integer skippedForSize,
            Integer skippedBinary,
            int inventoriedFiles) {

        /** The old analyzedFiles value was an inventory count; preserve it only under that meaning. */
        public FileCoverage(
                int discoveredFiles, int analyzedFiles, int skippedForCount, int skippedForSize, int skippedBinary) {
            this(analyzedFiles, null, null, null, null, analyzedFiles);
        }
    }

    /** total is a deprecated inventory alias. Parser counters are null unless this run recorded its inventory and per-file outcomes. */
    public record LanguageCoverage(
            String language,
            @Deprecated int total,
            @Deprecated Integer analyzed,
            @Deprecated Integer skipped,
            @Deprecated Integer failed,
            int inventoriedFiles) {

        public LanguageCoverage(String language, int total, int analyzed, int skipped, int failed) {
            this(language, total, null, null, null, total);
        }
    }

    public record ExcludedFolder(String path, String reason) {}

    /**
     * Recorded import selection counts, never analysis outcomes. Excluded directory entries count
     * once; their unvisited descendants are not measured. bytesRead includes policy-file reads.
     */
    public record LocalImportSummary(
            int schemaVersion,
            String policyVersion,
            int acceptedFiles,
            long bytesRead,
            Map<String, Integer> excludedEntriesByReason) {
        public LocalImportSummary {
            excludedEntriesByReason = Map.copyOf(excludedEntriesByReason);
        }
    }

    /** status is a persisted job-step status or unknown. A done step may have performed no analysis. */
    public record AnalyzerStatus(String name, String status, String failureReason) {}

    /** Deprecated flags do not measure completeness; clients must read status, which is UNKNOWN. */
    public record PartialResultInfo(
            @Deprecated boolean featuresPartial,
            @Deprecated boolean flowsPartial,
            @Deprecated boolean graphPartial,
            String reason,
            String status) {

        public PartialResultInfo(boolean featuresPartial, boolean flowsPartial, boolean graphPartial, String reason) {
            this(false, false, false, COMPLETENESS_UNKNOWN, "UNKNOWN");
        }
    }
}
