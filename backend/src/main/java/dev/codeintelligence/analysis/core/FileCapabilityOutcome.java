package dev.codeintelligence.analysis.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * One adapter's outcome for one file and one capability other than parsing (S symbols, C calls, F framework,
 * X cross-domain; 03 FileOutcome). The parsing outcome P stays on {@link FileAnalysisOutcome}. A file without a
 * recorded row for a capability is unmeasured for it; a TARGETED row is pending until its step ends.
 */
public record FileCapabilityOutcome(String path, String capability, String status, String reason) {
    public static final List<String> CAPABILITIES = List.of("S", "C", "F", "X");
    private static final Set<String> STATUSES =
            Set.of("TARGETED", "SUCCESS", "PARTIAL", "FAILED", "UNSUPPORTED", "UNMEASURED");
    private static final Set<String> TERMINAL = Set.of("SUCCESS", "PARTIAL", "FAILED", "UNSUPPORTED", "UNMEASURED");
    private static final Pattern REASON_CODE = Pattern.compile("[A-Z_]{1,128}");
    private static final int BATCH_SIZE = 500;

    public FileCapabilityOutcome {
        if (!CAPABILITIES.contains(capability)) throw new IllegalArgumentException("capability");
        if (!STATUSES.contains(status)) throw new IllegalArgumentException("outcome status");
    }

    /** Capabilities an adapter owns for a language (03 AdapterDescriptor): the language registry of this release. */
    public static List<String> ownedCapabilities(String language) {
        String lower = language == null ? "" : language.toLowerCase(Locale.ROOT);
        return switch (lower) {
            case "java", "typescript", "javascript" -> List.of("S", "C", "F", "X");
            case "sql" -> List.of("S", "X");
            case "python", "go" -> List.of("S");
            default -> List.of();
        };
    }

    /** Capabilities no adapter of this release owns for the language; their outcome is UNSUPPORTED. */
    public static List<String> unsupportedCapabilities(String language) {
        List<String> owned = ownedCapabilities(language);
        return CAPABILITIES.stream()
                .filter(capability -> !owned.contains(capability))
                .toList();
    }

    /** Languages with a per-file parsing contract: their unsupported capabilities are recorded at inventory. */
    public static boolean measured(String language) {
        String lower = language == null ? "" : language.toLowerCase(Locale.ROOT);
        return !"UNMEASURED"
                        .equals(FileAnalysisOutcome.initialStatus(new InventoriedFile("x." + lower, lower, 0, 0, "")))
                || !ownedCapabilities(lower).isEmpty();
    }

    public static void recordAll(JdbcClient jdbc, long snapshotId, Iterable<FileCapabilityOutcome> outcomes) {
        Batch batch = new Batch(jdbc, snapshotId);
        for (FileCapabilityOutcome outcome : outcomes) batch.add(outcome);
        batch.flush();
    }

    public static void recordFiles(
            JdbcClient jdbc,
            long snapshotId,
            Iterable<String> paths,
            List<String> capabilities,
            String status,
            String reason) {
        Batch batch = new Batch(jdbc, snapshotId);
        for (String path : paths) {
            for (String capability : capabilities)
                batch.add(new FileCapabilityOutcome(path, capability, status, reason));
        }
        batch.flush();
    }

    /** Exactly one terminal outcome per submitted file and capability; anything else is unmeasured, never success. */
    public static void recordResponse(
            JdbcClient jdbc,
            long snapshotId,
            Iterable<String> submitted,
            List<String> capabilities,
            List<FileCapabilityOutcome> outcomes) {
        var grouped = new java.util.HashMap<String, List<FileCapabilityOutcome>>();
        for (FileCapabilityOutcome outcome : outcomes == null ? List.<FileCapabilityOutcome>of() : outcomes) {
            if (outcome == null || outcome.path() == null) continue;
            grouped.computeIfAbsent(outcome.path() + "\n" + outcome.capability(), key -> new ArrayList<>())
                    .add(outcome);
        }
        Batch batch = new Batch(jdbc, snapshotId);
        for (String path : submitted) {
            for (String capability : capabilities) {
                List<FileCapabilityOutcome> matches = grouped.getOrDefault(path + "\n" + capability, List.of());
                if (matches.size() != 1 || !TERMINAL.contains(matches.getFirst().status())) {
                    batch.add(new FileCapabilityOutcome(
                            path, capability, "UNMEASURED", "ANALYZER_OUTCOME_MISSING_OR_INVALID"));
                } else {
                    FileCapabilityOutcome outcome = matches.getFirst();
                    String reason = outcome.reason();
                    batch.add(new FileCapabilityOutcome(
                            path,
                            capability,
                            outcome.status(),
                            reason != null && REASON_CODE.matcher(reason).matches() ? reason : "ANALYZER_REPORTED"));
                }
            }
        }
        batch.flush();
    }

    private static final class Batch {
        private final JdbcClient jdbc;
        private final long snapshotId;
        private final List<Object[]> rows = new ArrayList<>();

        private Batch(JdbcClient jdbc, long snapshotId) {
            this.jdbc = jdbc;
            this.snapshotId = snapshotId;
        }

        private void add(FileCapabilityOutcome outcome) {
            if (rows.size() == BATCH_SIZE) flush();
            rows.add(new Object[] {outcome.path(), outcome.capability(), outcome.status(), outcome.reason()});
        }

        private void flush() {
            if (rows.isEmpty()) return;
            // Later rows of one batch win on the same (file, capability): keep the last transition.
            jdbc.sql("""
                    insert into file_capability_outcomes (file_id, capability, status, reason)
                    select f.id, o.capability, o.status, o.reason
                    from (select distinct on (path, capability) path, capability, status, reason, ordinality
                          from unnest(:paths::text[], :capabilities::text[], :statuses::text[], :reasons::text[])
                          with ordinality as o(path, capability, status, reason, ordinality)
                          order by path, capability, ordinality desc) o
                    join files f on f.snapshot_id=:sid and f.path=o.path
                    on conflict (file_id, capability) do update set status=excluded.status, reason=excluded.reason
                    """)
                    .param("paths", rows.stream().map(row -> row[0]).toArray(String[]::new))
                    .param("capabilities", rows.stream().map(row -> row[1]).toArray(String[]::new))
                    .param("statuses", rows.stream().map(row -> row[2]).toArray(String[]::new))
                    .param("reasons", rows.stream().map(row -> row[3]).toArray(String[]::new))
                    .param("sid", snapshotId)
                    .update();
            rows.clear();
        }
    }
}
