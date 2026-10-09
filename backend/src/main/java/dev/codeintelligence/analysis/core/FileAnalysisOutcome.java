package dev.codeintelligence.analysis.core;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;

/** Primary source-parser outcomes; success never asserts complete semantic or framework coverage. */
public record FileAnalysisOutcome(String path, String status, String reason) {
    private static final Set<String> TERMINAL = Set.of("SUCCESS", "PARTIAL", "FAILED", "UNSUPPORTED", "UNMEASURED");
    private static final int BATCH_SIZE = 500;
    private static final Pattern REASON_CODE = Pattern.compile("[A-Z_]{1,128}");

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
        requireStatus(status);
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

    public static void recordAll(JdbcClient jdbc, long snapshotId, Iterable<FileAnalysisOutcome> outcomes) {
        Batch batch = new Batch(jdbc, snapshotId);
        for (FileAnalysisOutcome outcome : outcomes) {
            requireStatus(outcome.status());
            batch.add(outcome.path(), outcome.status(), outcome.reason());
        }
        batch.flush();
    }

    public static void recordFiles(
            JdbcClient jdbc, long snapshotId, Iterable<String> paths, String status, String reason) {
        requireStatus(status);
        Batch batch = new Batch(jdbc, snapshotId);
        for (String path : paths) batch.add(path, status, reason);
        batch.flush();
    }

    /** Accept exactly one explicit outcome per submitted file; never infer success from HTTP 200. */
    public static void recordResponse(
            JdbcClient jdbc, long snapshotId, Iterable<String> submitted, List<FileAnalysisOutcome> outcomes) {
        var grouped = (outcomes == null ? List.<FileAnalysisOutcome>of() : outcomes)
                .stream()
                        .filter(o -> o != null && o.path() != null)
                        .collect(java.util.stream.Collectors.groupingBy(FileAnalysisOutcome::path));
        Batch batch = new Batch(jdbc, snapshotId);
        for (String path : submitted) {
            List<FileAnalysisOutcome> matches = grouped.getOrDefault(path, List.of());
            if (matches.size() != 1
                    || (matches.getFirst().status() == null
                            || !TERMINAL.contains(matches.getFirst().status()))) {
                batch.add(path, "UNMEASURED", "ANALYZER_OUTCOME_MISSING_OR_INVALID");
            } else {
                FileAnalysisOutcome outcome = matches.getFirst();
                // Only bounded reason codes are persisted; sidecar free text can contain source/secrets.
                String reason = outcome.reason();
                batch.add(
                        path,
                        outcome.status(),
                        reason != null && REASON_CODE.matcher(reason).matches() ? reason : "PARSER_REPORTED");
            }
        }
        batch.flush();
    }

    private static void requireStatus(String status) {
        if (!TERMINAL.contains(status) && !"TARGETED".equals(status))
            throw new IllegalArgumentException("outcome status");
    }

    private static final class Batch {
        private final JdbcClient jdbc;
        private final long snapshotId;
        private final List<Object[]> rows = new ArrayList<>();
        private final Set<String> paths = new HashSet<>();

        private Batch(JdbcClient jdbc, long snapshotId) {
            this.jdbc = jdbc;
            this.snapshotId = snapshotId;
        }

        private void add(String path, String status, String reason) {
            if (rows.size() == BATCH_SIZE) flush();
            // UPDATE FROM must see one row per path; duplicates keep their original transition order.
            if (!paths.add(path)) {
                flush();
                paths.add(path);
            }
            rows.add(new Object[] {path, status, reason});
        }

        private void flush() {
            if (rows.isEmpty()) return;
            jdbc.sql("""
                    update files f set
                      analysis_status=case when f.analysis_reason='AMBIGUOUS_SYMBOL_IDENTITY' and o.status <> 'FAILED'
                                           then 'PARTIAL' else o.status end,
                      analysis_reason=case when f.analysis_reason='AMBIGUOUS_SYMBOL_IDENTITY' and o.status <> 'FAILED'
                                           then f.analysis_reason else o.reason end,
                      analysis_targeted=(f.analysis_targeted or o.status <> 'UNMEASURED')
                    from (values :outcomes) as o(path, status, reason)
                    where f.snapshot_id=:sid and f.path=o.path
                    """).param("outcomes", rows).param("sid", snapshotId).update();
            rows.clear();
            paths.clear();
        }
    }
}
