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
            "SECRET_CONTENT");
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
        List<CoverageReport.AnalyzerStatus> analyzerStatuses = computeAnalyzerStatuses(projectId, snapshotId);
        return new CoverageReport(
                computeFileCoverage(projectId, snapshotId),
                computeLanguageInventory(snapshotId),
                // The exclusion policy for a past snapshot was not persisted.
                List.of(),
                analyzerStatuses,
                new CoverageReport.PartialResultInfo(
                        false, false, false, CoverageReport.COMPLETENESS_UNKNOWN, "UNKNOWN"),
                computeRetryableIssues(analyzerStatuses),
                // No capability was verified by these inventory rows, regardless of language.
                List.of(),
                CoverageReport.LEGACY_UNMEASURED,
                CoverageReport.SUPPORT_UNVERIFIED,
                readLocalImportSummary(projectId, snapshotId));
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

    private List<CoverageReport.LanguageCoverage> computeLanguageInventory(long snapshotId) {
        return jdbc.sql("""
                        select coalesce(language, 'unknown') as lang, count(*) as cnt
                        from files where snapshot_id = :sid
                        group by coalesce(language, 'unknown') order by cnt desc, lang
                        """)
                .param("sid", snapshotId)
                .query((rs, rowNum) -> new CoverageReport.LanguageCoverage(
                        rs.getString("lang"), rs.getInt("cnt"), null, null, null, rs.getInt("cnt")))
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
