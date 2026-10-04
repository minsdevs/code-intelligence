package dev.codeintelligence.analysis.core;

import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;

/** Primary source-parser outcomes; success never asserts complete semantic or framework coverage. */
public record FileAnalysisOutcome(String path, String status, String reason) {
    private static final Set<String> TERMINAL = Set.of("SUCCESS", "PARTIAL", "FAILED", "UNSUPPORTED", "UNMEASURED");

    public static String initialStatus(InventoriedFile file) {
        String language = file.language() == null ? "" : file.language().toLowerCase(Locale.ROOT);
        String path = file.path().toLowerCase(Locale.ROOT);
        if (Set.of("java", "typescript", "javascript", "python", "go").contains(language)
                || path.endsWith(".vue")
                || path.endsWith(".svelte")) return "UNMEASURED";
        // Config/document extractors have no per-file contract yet. Do not claim their success.
        if (Set.of("kotlin", "swift", "rust", "ruby", "php", "csharp", "c", "cpp")
                .contains(language)) return "UNSUPPORTED";
        return "UNMEASURED";
    }

    public static void record(JdbcClient jdbc, long snapshotId, String path, String status, String reason) {
        if (!TERMINAL.contains(status) && !"TARGETED".equals(status))
            throw new IllegalArgumentException("outcome status");
        jdbc.sql("""
                update files set
                  analysis_status=case when analysis_reason='AMBIGUOUS_SYMBOL_IDENTITY' and :status <> 'FAILED'
                                       then 'PARTIAL' else :status end,
                  analysis_reason=case when analysis_reason='AMBIGUOUS_SYMBOL_IDENTITY' and :status <> 'FAILED'
                                       then analysis_reason else :reason end,
                  analysis_targeted=(analysis_targeted or :targeted)
                where snapshot_id=:sid and path=:path
                """)
                .param("targeted", !"UNMEASURED".equals(status))
                .param("status", status)
                .param("reason", reason)
                .param("sid", snapshotId)
                .param("path", path)
                .update();
    }

    /** Accept exactly one explicit outcome per submitted file; never infer success from HTTP 200. */
    public static void recordResponse(
            JdbcClient jdbc, long snapshotId, List<String> submitted, List<FileAnalysisOutcome> outcomes) {
        var grouped = (outcomes == null ? List.<FileAnalysisOutcome>of() : outcomes)
                .stream()
                        .filter(o -> o != null && o.path() != null)
                        .collect(java.util.stream.Collectors.groupingBy(FileAnalysisOutcome::path));
        for (String path : submitted) {
            List<FileAnalysisOutcome> matches = grouped.getOrDefault(path, List.of());
            if (matches.size() != 1
                    || (matches.getFirst().status() == null
                            || !TERMINAL.contains(matches.getFirst().status()))) {
                record(jdbc, snapshotId, path, "UNMEASURED", "ANALYZER_OUTCOME_MISSING_OR_INVALID");
            } else {
                FileAnalysisOutcome outcome = matches.getFirst();
                // Only bounded reason codes are persisted; sidecar free text can contain source/secrets.
                String reason = outcome.reason();
                record(
                        jdbc,
                        snapshotId,
                        path,
                        outcome.status(),
                        reason != null && reason.matches("[A-Z_]{1,128}") ? reason : "PARSER_REPORTED");
            }
        }
    }
}
