package dev.codeintelligence.analysis.coverage;

import dev.codeintelligence.analysis.tree.TreeAnalyzerProperties;
import dev.codeintelligence.analysis.ts.TsAnalyzerProperties;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.job.JobRepository;
import dev.codeintelligence.job.JobStepRecord;
import dev.codeintelligence.job.StepStatus;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Reads inventory and persisted job steps without inferring per-file analyzer outcomes. */
@Service
public class CoverageService {

    // Versioned evidence bounds; changing today's import configuration must not rewrite old facts.
    private static final int LOCAL_IMPORT_MAX_EXCERPT_BYTES = 2048;
    private static final int LOCAL_IMPORT_MAX_FILES = 50_000;
    private static final int LOCAL_IMPORT_MAX_ENTRIES = 200_000;
    private static final long LOCAL_IMPORT_MAX_BYTES_READ = 536_870_912L;
    private static final String LOCAL_IMPORT_POLICY = "local-ingest-v1";
    private static final Set<String> LOCAL_IMPORT_FIELDS =
            Set.of("schemaVersion", "policyVersion", "acceptedFiles", "bytesRead", "excludedEntriesByReason");
    private static final Set<String> LOCAL_IMPORT_REASONS = Set.of(
            "GENERATED_DIRECTORY",
            "SECRET_PATH",
            "IGNORED",
            "BINARY",
            "OVERSIZED",
            "FILE_LIMIT",
            "SYMLINK",
            "HARD_LINK",
            "SECRET_CONTENT",
            "SUBMODULE");
    private static final JsonMapper LOCAL_IMPORT_JSON = JsonMapper.builder(JsonFactory.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .streamReadConstraints(StreamReadConstraints.builder()
                            .maxDocumentLength(LOCAL_IMPORT_MAX_EXCERPT_BYTES)
                            .maxNestingDepth(2)
                            .maxTokenCount(64)
                            .maxNameLength(32)
                            .maxStringLength(64)
                            .maxNumberLength(10)
                            .build())
                    .build())
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();

    private final JdbcClient jdbc;
    private final JobRepository jobRepository;
    private final ProjectRepository projectRepository;

    public CoverageService(
            JdbcClient jdbc,
            JobRepository jobRepository,
            ProjectRepository projectRepository,
            TsAnalyzerProperties tsProps,
            TreeAnalyzerProperties treeProps) {
        this.jdbc = jdbc;
        this.jobRepository = jobRepository;
        this.projectRepository = projectRepository;
        // Keep the constructor compatible; today's sidecar configuration is not historical evidence.
    }

    @Transactional(readOnly = true)
    public CoverageReport getReport(long projectId, long userId) {
        return getReport(projectId, userId, null);
    }

    @Transactional(readOnly = true)
    public CoverageReport getReport(long projectId, long userId, Long requestedSnapshotId) {
        Project project =
                projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
        Long snapshotId = requestedSnapshotId != null ? requestedSnapshotId : project.getCurrentSnapshotId();
        if (snapshotId == null) {
            throw new ProjectNotFoundException();
        }
        boolean owned = jdbc.sql("select exists(select 1 from snapshots where id=:sid and project_id=:pid)")
                .param("sid", snapshotId)
                .param("pid", projectId)
                .query(Boolean.class)
                .single();
        if (!owned) throw new dev.codeintelligence.analysis.core.SnapshotNotFoundException();
        return buildReport(projectId, snapshotId);
    }

    @Transactional(readOnly = true)
    public CoverageReport buildReport(long projectId, long snapshotId) {
        List<CoverageReport.AnalyzerStatus> analyzerStatuses = computeAnalyzerStatuses(projectId, snapshotId);
        CoverageReport.OutcomeSummary outcomes = computeOutcomes(snapshotId);
        return new CoverageReport(
                computeFileCoverage(projectId, snapshotId),
                computeLanguageInventory(snapshotId, outcomes != null),
                // The exclusion policy for a past snapshot was not persisted.
                List.of(),
                analyzerStatuses,
                new CoverageReport.PartialResultInfo(
                        false,
                        false,
                        false,
                        outcomes == null
                                ? CoverageReport.COMPLETENESS_UNKNOWN
                                : "Recorded parser outcomes do not establish complete semantic, call, or framework coverage.",
                        "UNKNOWN"),
                computeRetryableIssues(analyzerStatuses),
                // No capability was verified by these inventory rows, regardless of language.
                List.of(),
                outcomes == null ? CoverageReport.LEGACY_UNMEASURED : "PER_FILE_RECORDED",
                CoverageReport.SUPPORT_UNVERIFIED,
                readLocalImportSummary(projectId, snapshotId),
                snapshotId,
                outcomes,
                computeCapabilityOutcomes(snapshotId, outcomes != null));
    }

    /**
     * The recorded per-file outcome is the primary parser's, so it measures capability P only. Symbol, call, framework
     * and cross-language outcomes are not persisted per file and stay unrecorded instead of borrowing P's counts.
     */
    private List<CoverageReport.CapabilityOutcome> computeCapabilityOutcomes(long snapshotId, boolean measured) {
        List<CoverageReport.CapabilityOutcome> capabilities = new ArrayList<>();
        for (String capability : CoverageReport.CAPABILITIES) {
            if (!measured) {
                capabilities.add(
                        CoverageReport.CapabilityOutcome.unrecorded(capability, CoverageReport.LEGACY_UNMEASURED));
            } else if (!"P".equals(capability)) {
                capabilities.add(CoverageReport.CapabilityOutcome.unrecorded(capability, CoverageReport.NOT_RECORDED));
            } else {
                capabilities.add(jdbc.sql("""
                                select count(*) filter (where analysis_status='SUCCESS') as successful,
                                       count(*) filter (where analysis_status='PARTIAL') as partial,
                                       count(*) filter (where analysis_status='FAILED') as failed,
                                       count(*) filter (where analysis_status='UNSUPPORTED') as unsupported,
                                       count(*) filter (where analysis_status='TARGETED') as pending,
                                       count(*) filter (where analysis_status in ('UNMEASURED','LEGACY_UNMEASURED'))
                                           as unmeasured
                                from files where snapshot_id=:sid
                                """)
                        .param("sid", snapshotId)
                        .query((rs, n) -> new CoverageReport.CapabilityOutcome(
                                capability,
                                "PER_FILE_RECORDED",
                                rs.getInt("successful")
                                        + rs.getInt("partial")
                                        + rs.getInt("failed")
                                        + rs.getInt("unsupported")
                                        + rs.getInt("pending"),
                                rs.getInt("successful"),
                                rs.getInt("partial"),
                                rs.getInt("failed"),
                                rs.getInt("unsupported"),
                                rs.getInt("pending"),
                                rs.getInt("unmeasured")))
                        .single());
            }
        }
        return List.copyOf(capabilities);
    }

    /** Recorded per-file outcomes of a snapshot, or null when the snapshot predates per-file measurement. */
    @Transactional(readOnly = true)
    public CoverageReport.OutcomeSummary outcomes(long snapshotId) {
        return computeOutcomes(snapshotId);
    }

    private CoverageReport.OutcomeSummary computeOutcomes(long snapshotId) {
        return jdbc.sql("""
                select m.discovered_files, m.excluded_for_count+m.excluded_for_size+m.excluded_binary as excluded_files,
                       m.excluded_submodules,
                       count(f.id) filter (where f.analysis_targeted) as targeted,
                       count(f.id) filter (where f.analysis_status='SUCCESS') as successful,
                       count(f.id) filter (where f.analysis_status='PARTIAL') as partial,
                       count(f.id) filter (where f.analysis_status='FAILED') as failed,
                       count(f.id) filter (where f.analysis_status='UNSUPPORTED') as unsupported,
                       count(f.id) filter (where f.analysis_status in ('UNMEASURED','LEGACY_UNMEASURED')) as unmeasured,
                       count(f.id) filter (where f.analysis_status='TARGETED') as pending
                from snapshot_inventory_measurements m left join files f on f.snapshot_id=m.snapshot_id
                where m.snapshot_id=:sid
                group by m.snapshot_id, m.discovered_files, m.excluded_for_count, m.excluded_for_size,
                         m.excluded_binary, m.excluded_submodules
                """)
                .param("sid", snapshotId)
                .query((rs, n) -> new CoverageReport.OutcomeSummary(
                        rs.getInt("discovered_files"),
                        rs.getInt("targeted"),
                        rs.getInt("successful"),
                        rs.getInt("partial"),
                        rs.getInt("failed"),
                        rs.getInt("excluded_files"),
                        rs.getInt("unsupported"),
                        rs.getInt("unmeasured"),
                        rs.getInt("pending"),
                        rs.getInt("excluded_submodules")))
                .optional()
                .orElse(null);
    }

    private CoverageReport.LocalImportSummary readLocalImportSummary(long projectId, long snapshotId) {
        List<String> excerpts = jdbc.sql("""
                        select distinct case when octet_length(e.excerpt) <= :maxBytes
                                             then e.excerpt else null end as excerpt
                        from evidences e
                        join evidence_links l on l.evidence_id = e.id
                        where e.project_id = :pid and e.kind = 'CONFIG'
                          and l.subject_type = :subjectType and l.subject_id = :sid
                        limit 2
                        """)
                .param("pid", projectId)
                .param("sid", snapshotId)
                .param("subjectType", EvidenceSubjects.LOCAL_IMPORT)
                .param("maxBytes", LOCAL_IMPORT_MAX_EXCERPT_BYTES)
                .query(String.class)
                .list();
        // Missing, oversized, or multiple distinct observations do not establish a summary.
        if (excerpts.size() != 1 || excerpts.getFirst() == null) return null;
        try {
            JsonNode root = LOCAL_IMPORT_JSON.readTree(excerpts.getFirst());
            if (root == null
                    || !root.isObject()
                    || root.size() != LOCAL_IMPORT_FIELDS.size()
                    || !LOCAL_IMPORT_FIELDS.containsAll(root.propertyNames())) return null;
            JsonNode schema = root.get("schemaVersion");
            JsonNode policy = root.get("policyVersion");
            JsonNode accepted = root.get("acceptedFiles");
            JsonNode bytes = root.get("bytesRead");
            JsonNode reasons = root.get("excludedEntriesByReason");
            if (!boundedInteger(schema, 1)
                    || schema.intValue() != 1
                    || !policy.isString()
                    || !LOCAL_IMPORT_POLICY.equals(policy.asString())
                    || !boundedInteger(accepted, LOCAL_IMPORT_MAX_FILES)
                    || !boundedInteger(bytes, LOCAL_IMPORT_MAX_BYTES_READ)
                    || !reasons.isObject()
                    || !LOCAL_IMPORT_REASONS.containsAll(reasons.propertyNames())) return null;
            Map<String, Integer> counts = new LinkedHashMap<>();
            long entries = accepted.longValue();
            for (var entry : reasons.properties()) {
                if (!boundedInteger(entry.getValue(), LOCAL_IMPORT_MAX_ENTRIES)) return null;
                entries += entry.getValue().longValue();
                if (entries > LOCAL_IMPORT_MAX_ENTRIES) return null;
                counts.put(entry.getKey(), entry.getValue().intValue());
            }
            return new CoverageReport.LocalImportSummary(
                    1, LOCAL_IMPORT_POLICY, accepted.intValue(), bytes.longValue(), counts);
        } catch (JacksonException ignored) {
            // Do not log or expose malformed evidence text, which might include local paths.
            return null;
        }
    }

    private static boolean boundedInteger(JsonNode node, long maximum) {
        return node != null
                && node.isIntegralNumber()
                && node.canConvertToLong()
                && node.longValue() >= 0
                && node.longValue() <= maximum;
    }

    private CoverageReport.FileCoverage computeFileCoverage(long projectId, long snapshotId) {
        int inventoriedFiles = jdbc.sql("select count(*) from files where snapshot_id = :sid")
                .param("sid", snapshotId)
                .query(Integer.class)
                .single();
        List<int[]> measured = jdbc.sql(
                        "select excluded_for_count,excluded_for_size,excluded_binary from snapshot_inventory_measurements where snapshot_id=:sid")
                .param("sid", snapshotId)
                .query((rs, n) -> new int[] {rs.getInt(1), rs.getInt(2), rs.getInt(3)})
                .list();
        if (!measured.isEmpty()) {
            int[] counts = measured.getFirst();
            return new CoverageReport.FileCoverage(
                    inventoriedFiles, null, counts[0], counts[1], counts[2], inventoriedFiles);
        }
        Integer skippedForCount = recordedInventorySkipCount(projectId, snapshotId, "max-files");
        Integer skippedForSize = recordedInventorySkipCount(projectId, snapshotId, "max-file-size");
        return new CoverageReport.FileCoverage(
                inventoriedFiles, null, skippedForCount, skippedForSize, null, inventoriedFiles);
    }

    private Integer recordedInventorySkipCount(long projectId, long snapshotId, String budget) {
        List<String> excerpts = jdbc.sql("""
                        select distinct e.excerpt from evidences e
                        join evidence_links l on l.evidence_id = e.id
                        where e.project_id = :pid and l.subject_type = 'SNAPSHOT' and l.subject_id = :sid
                          and e.excerpt like :pattern
                        """)
                .param("pid", projectId)
                .param("sid", snapshotId)
                .param("pattern", "Skipped%files over app.analysis." + budget + "%")
                .query(String.class)
                .list();
        // Legacy retries can leave more than one observation. Do not sum or select an arbitrary one.
        if (excerpts.size() != 1) return null;
        String excerpt = excerpts.getFirst();
        if (!excerpt.matches("Skipped [0-9]+ files over app\\.analysis\\." + budget + "\\.")) return null;
        try {
            return Integer.valueOf(excerpt.split(" ")[1]);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private List<CoverageReport.LanguageCoverage> computeLanguageInventory(long snapshotId, boolean measured) {
        return jdbc.sql("""
                        select coalesce(language, 'unknown') as lang, count(*) as cnt,
                               count(*) filter(where analysis_status='SUCCESS') as successful,
                               count(*) filter(where analysis_status='FAILED') as failed
                        from files where snapshot_id = :sid
                        group by coalesce(language, 'unknown') order by cnt desc, lang
                        """)
                .param("sid", snapshotId)
                .query((rs, rowNum) -> new CoverageReport.LanguageCoverage(
                        rs.getString("lang"),
                        rs.getInt("cnt"),
                        measured ? rs.getInt("successful") : null,
                        null,
                        measured ? rs.getInt("failed") : null,
                        rs.getInt("cnt")))
                .list();
    }

    private List<CoverageReport.AnalyzerStatus> computeAnalyzerStatuses(long projectId, long snapshotId) {
        Map<String, CoverageReport.AnalyzerStatus> statuses = new LinkedHashMap<>();
        for (String name : List.of("Java Analyzer", "TypeScript Analyzer", "Tree-sitter Analyzer")) {
            statuses.put(name, new CoverageReport.AnalyzerStatus(name, "unknown", null));
        }
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
            for (JobStepRecord step : jobRepository.findSteps(latestJobId)) {
                String name = mapStepToAnalyzer(step.stepKey());
                if (name != null) {
                    statuses.put(
                            name,
                            new CoverageReport.AnalyzerStatus(
                                    name,
                                    step.status().name().toLowerCase(Locale.ROOT),
                                    step.status() == StepStatus.FAILED ? step.error() : null));
                }
            }
        }
        return List.copyOf(statuses.values());
    }

    private String mapStepToAnalyzer(String stepKey) {
        return switch (stepKey) {
            case "TS_PARSING" -> "TypeScript Analyzer";
            case "TREE_PARSING" -> "Tree-sitter Analyzer";
            case "SOURCE_PARSING" -> "Java Analyzer";
            default -> null;
        };
    }

    private List<String> computeRetryableIssues(List<CoverageReport.AnalyzerStatus> statuses) {
        List<String> issues = new ArrayList<>();
        for (CoverageReport.AnalyzerStatus status : statuses) {
            if ("failed".equals(status.status())) {
                issues.add("Recorded step failure: " + status.name()
                        + (status.failureReason() == null ? "" : " — " + status.failureReason()));
            }
        }
        return List.copyOf(issues);
    }
}
