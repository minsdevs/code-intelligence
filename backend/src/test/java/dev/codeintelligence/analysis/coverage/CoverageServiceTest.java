package dev.codeintelligence.analysis.coverage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.compare.SnapshotComparisonService;
import dev.codeintelligence.analysis.tree.TreeAnalyzerProperties;
import dev.codeintelligence.analysis.ts.TsAnalyzerProperties;
import dev.codeintelligence.export.ExportService;
import dev.codeintelligence.job.JobRepository;
import dev.codeintelligence.job.StepStatus;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import jakarta.persistence.EntityManager;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Real database regressions: inventory rows and job steps never become per-file outcome evidence. */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url=",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.github.base-url=http://127.0.0.1:1"
        })
@Import(TestcontainersConfiguration.class)
@Transactional
@SuppressWarnings("deprecation")
class CoverageServiceTest {

    private static final String LOCAL_IMPORT_EXCERPT = """
            {"schemaVersion":1,"policyVersion":"local-ingest-v1","acceptedFiles":7,"bytesRead":1024,
             "excludedEntriesByReason":{"GENERATED_DIRECTORY":1,"SECRET_PATH":2,"BINARY":3}}
            """;

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void isolatedDataDir(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    JdbcClient jdbcClient;

    @Autowired
    JobRepository jobs;

    @Autowired
    ProjectRepository projects;

    @Autowired
    SnapshotRepository snapshots;

    @Autowired
    EntityManager entityManager;

    @Autowired
    CoverageService service;

    @Autowired
    SnapshotComparisonService comparisons;

    @Autowired
    ExportService exports;

    @Autowired
    JsonMapper json;

    private long userId;
    private long projectId;
    private long snapshotId;

    @BeforeEach
    void inventory() {
        userId = jdbc.queryForObject(
                "insert into users (login, identity_type, local_key) values ('coverage-fixture', 'LOCAL', ?) returning id",
                Long.class,
                UUID.randomUUID().toString());
        projectId = jdbc.queryForObject(
                "insert into projects (user_id, name, repo_owner, repo_name) values (?, 'Coverage', 'fixture', 'coverage') returning id",
                Long.class,
                userId);
        snapshotId = snapshot();
        jdbc.update("update projects set current_snapshot_id=? where id=?", snapshotId, projectId);
        String[] languages = {"java", "java", "typescript", "kotlin", "rust", null, "unknown"};
        for (int i = 0; i < languages.length; i++) {
            jdbc.update(
                    "insert into files (snapshot_id,path,language,size,content_hash) values (?,?,?,?,?)",
                    snapshotId,
                    "fixture-" + i,
                    languages[i],
                    1,
                    "a".repeat(40));
        }
    }

    @Test
    void laterParserSuccessCannotErasePersistedAmbiguousIdentity() {
        jdbc.update(
                "update files set analysis_status='PARTIAL', analysis_reason='AMBIGUOUS_SYMBOL_IDENTITY' where snapshot_id=? and path='fixture-0'",
                snapshotId);
        dev.codeintelligence.analysis.core.FileAnalysisOutcome.record(
                jdbcClient, snapshotId, "fixture-0", "SUCCESS", "JAVA_PARSED");
        assertThat(jdbc.queryForObject(
                        "select analysis_status from files where snapshot_id=? and path='fixture-0'",
                        String.class,
                        snapshotId))
                .isEqualTo("PARTIAL");
        assertThat(jdbc.queryForObject(
                        "select analysis_reason from files where snapshot_id=? and path='fixture-0'",
                        String.class,
                        snapshotId))
                .isEqualTo("AMBIGUOUS_SYMBOL_IDENTITY");
    }

    @Test
    void measuredSnapshotCountsActualOutcomesAndKeepsOtherSnapshotsUnmeasured() {
        jdbc.update("""
                insert into snapshot_inventory_measurements
                (snapshot_id, discovered_files, excluded_for_count, excluded_for_size, excluded_binary, excluded_submodules)
                values (?,10,1,1,1,2)
                """, snapshotId);
        String[] states = {"SUCCESS", "PARTIAL", "FAILED", "UNSUPPORTED", "UNMEASURED", "TARGETED", "LEGACY_UNMEASURED"
        };
        for (int i = 0; i < states.length; i++) {
            jdbc.update(
                    "update files set analysis_status=?, analysis_targeted=? where snapshot_id=? and path=?",
                    states[i],
                    i < 3 || i == 5,
                    snapshotId,
                    "fixture-" + i);
        }
        CoverageReport report = service.getReport(projectId, userId, snapshotId);
        assertThat(report.snapshotId()).isEqualTo(snapshotId);
        assertThat(report.measurementStatus()).isEqualTo("PER_FILE_RECORDED");
        assertThat(report.outcomes()).isEqualTo(new CoverageReport.OutcomeSummary(10, 4, 1, 1, 1, 3, 1, 2, 1, 2));
        assertThat(report.fileCoverage().analyzedFiles()).isNull();
        assertThat(report.fileCoverage().skippedBinary()).isEqualTo(1);
        assertThat(report.languageCoverage())
                .filteredOn(l -> l.language().equals("java"))
                .allSatisfy(l -> assertThat(l.analyzed()).isEqualTo(1));
        long previous = snapshot();
        CoverageReport old = service.getReport(projectId, userId, previous);
        assertThat(old.measurementStatus()).isEqualTo("LEGACY_UNMEASURED");
        assertThat(old.outcomes()).isNull();
        assertThat(old.snapshotId()).isEqualTo(previous);
    }

    @Test
    void coverageIsReportedPerCapabilityWithoutInventingUnrecordedCapabilities() throws Exception {
        jdbc.update("""
                insert into snapshot_inventory_measurements
                (snapshot_id, discovered_files, excluded_for_count, excluded_for_size, excluded_binary, excluded_submodules)
                values (?,10,1,1,1,2)
                """, snapshotId);
        String[] states = {"SUCCESS", "PARTIAL", "FAILED", "UNSUPPORTED", "UNMEASURED", "TARGETED", "LEGACY_UNMEASURED"
        };
        for (int i = 0; i < states.length; i++) {
            jdbc.update(
                    "update files set analysis_status=?, analysis_targeted=? where snapshot_id=? and path=?",
                    states[i],
                    i < 3 || i == 5,
                    snapshotId,
                    "fixture-" + i);
        }
        CoverageReport report = service.getReport(projectId, userId, snapshotId);
        assertThat(report.capabilityOutcomes())
                .extracting(CoverageReport.CapabilityOutcome::capability)
                .containsExactly("P", "S", "C", "F", "X");
        CoverageReport.CapabilityOutcome parse = report.capabilityOutcomes().getFirst();
        // eligible = success + partial + failed + unsupported + pending; with unmeasured it partitions the file rows.
        assertThat(parse)
                .isEqualTo(new CoverageReport.CapabilityOutcome("P", "PER_FILE_RECORDED", 5, 1, 1, 1, 1, 1, 2));
        assertThat(parse.eligibleFiles() + parse.unmeasuredFiles())
                .isEqualTo(report.fileCoverage().inventoriedFiles());
        assertThat(report.capabilityOutcomes().subList(1, 5)).allSatisfy(capability -> {
            assertThat(capability.measurementStatus()).isEqualTo("NOT_RECORDED");
            assertThat(capability.eligibleFiles()).isNull();
            assertThat(capability.successfulFiles()).isNull();
            assertThat(capability.failedFiles()).isNull();
            assertThat(capability.unmeasuredFiles()).isNull();
        });
        JsonNode wire = json.readTree(json.writeValueAsString(report));
        assertThat(wire.path("capabilityOutcomes").get(0).path("eligibleFiles").asInt())
                .isEqualTo(5);
        assertThat(wire.path("capabilityOutcomes").get(1).get("successfulFiles").isNull())
                .isTrue();

        CoverageReport old = service.getReport(projectId, userId, snapshot());
        assertThat(old.capabilityOutcomes()).hasSize(5).allSatisfy(capability -> {
            assertThat(capability.measurementStatus()).isEqualTo("LEGACY_UNMEASURED");
            assertThat(capability.eligibleFiles()).isNull();
        });
    }

    @Test
    void storedFilesAreInventoryAndSerializedOutcomesRemainUnknown() throws Exception {
        CoverageReport report = service.getReport(projectId, userId);
        assertThat(report.measurementStatus()).isEqualTo("LEGACY_UNMEASURED");
        assertThat(report.supportStatus()).isEqualTo("UNVERIFIED");
        assertThat(report.fileCoverage().inventoriedFiles()).isEqualTo(7);
        assertThat(report.fileCoverage().discoveredFiles()).isEqualTo(7);
        assertThat(report.fileCoverage().analyzedFiles()).isNull();
        assertThat(report.fileCoverage().skippedForCount()).isNull();
        assertThat(report.fileCoverage().skippedForSize()).isNull();
        assertThat(report.fileCoverage().skippedBinary()).isNull();
        assertThat(report.languageCoverage())
                .extracting(CoverageReport.LanguageCoverage::language)
                .containsExactly("java", "unknown", "kotlin", "rust", "typescript");
        assertThat(report.languageCoverage()).allSatisfy(language -> {
            assertThat(language.analyzed()).isNull();
            assertThat(language.failed()).isNull();
            assertThat(language.skipped()).isNull();
        });
        assertThat(report.languageCoverage().stream()
                        .mapToInt(CoverageReport.LanguageCoverage::inventoriedFiles)
                        .sum())
                .isEqualTo(7);
        assertThat(report.partialResults().status()).isEqualTo("UNKNOWN");
        assertThat(report.partialResults().reason()).contains("completeness are unknown");
        assertThat(report.excludedFolders()).isEmpty();
        assertThat(report.unsupportedItems()).isEmpty();
        assertThat(report.localImport()).isNull();

        JsonNode wire = json.readTree(json.writeValueAsString(report));
        assertThat(wire.path("measurementStatus").asString()).isEqualTo("LEGACY_UNMEASURED");
        assertThat(wire.path("fileCoverage").path("inventoriedFiles").asInt()).isEqualTo(7);
        assertThat(wire.path("fileCoverage").has("analyzedFiles")).isTrue();
        assertThat(wire.path("fileCoverage").get("analyzedFiles").isNull()).isTrue();
        assertThat(wire.path("languageCoverage").get(0).get("failed").isNull()).isTrue();
        assertThat(wire.has("localImport")).isTrue();
        assertThat(wire.get("localImport").isNull()).isTrue();
    }

    @Test
    void localImportSummaryReadsDistinctRecordedCountsWithoutMeasuringAnalysis() throws Exception {
        importEvidence(projectId, snapshotId, "CONFIG", "LOCAL_IMPORT", LOCAL_IMPORT_EXCERPT);
        importEvidence(projectId, snapshotId, "CONFIG", "LOCAL_IMPORT", LOCAL_IMPORT_EXCERPT);
        CoverageReport report = service.getReport(projectId, userId);
        assertThat(report.localImport()).isNotNull();
        assertThat(report.localImport().acceptedFiles()).isEqualTo(7);
        assertThat(report.localImport().bytesRead()).isEqualTo(1024);
        assertThat(report.localImport().excludedEntriesByReason())
                .isEqualTo(Map.of("GENERATED_DIRECTORY", 1, "SECRET_PATH", 2, "BINARY", 3));
        assertThat(report.measurementStatus()).isEqualTo("LEGACY_UNMEASURED");
        assertThat(report.fileCoverage().analyzedFiles()).isNull();
        assertThat(report.partialResults().status()).isEqualTo("UNKNOWN");
        JsonNode wire = json.readTree(json.writeValueAsString(report));
        assertThat(wire.path("localImport").path("schemaVersion").asInt()).isEqualTo(1);
        assertThat(wire.path("localImport").path("policyVersion").asString()).isEqualTo("local-ingest-v1");
    }

    @Test
    void localImportEvidenceIsScopedToProjectSnapshotSubjectAndKind() {
        long otherProject = jdbc.queryForObject(
                "insert into projects (user_id,name,repo_owner,repo_name) values (?,'Other','fixture','other') returning id",
                Long.class,
                userId);
        importEvidence(otherProject, snapshotId, "CONFIG", "LOCAL_IMPORT", LOCAL_IMPORT_EXCERPT);
        importEvidence(projectId, snapshot(), "CONFIG", "LOCAL_IMPORT", LOCAL_IMPORT_EXCERPT);
        importEvidence(projectId, snapshotId, "CONFIG", "SNAPSHOT", LOCAL_IMPORT_EXCERPT);
        importEvidence(projectId, snapshotId, "FILE_LINE", "LOCAL_IMPORT", LOCAL_IMPORT_EXCERPT);
        assertThat(service.getReport(projectId, userId).localImport()).isNull();
        importEvidence(projectId, snapshotId, "CONFIG", "LOCAL_IMPORT", LOCAL_IMPORT_EXCERPT);
        assertThat(service.getReport(projectId, userId).localImport().acceptedFiles())
                .isEqualTo(7);
        assertThatThrownBy(() -> service.getReport(projectId, -1)).isInstanceOf(ProjectNotFoundException.class);
    }

    @Test
    void conflictingLocalImportEvidenceIsUnavailableInsteadOfSelectingOneRecord() {
        importEvidence(projectId, snapshotId, "CONFIG", "LOCAL_IMPORT", LOCAL_IMPORT_EXCERPT);
        importEvidence(
                projectId,
                snapshotId,
                "CONFIG",
                "LOCAL_IMPORT",
                LOCAL_IMPORT_EXCERPT.replace("\"acceptedFiles\":7", "\"acceptedFiles\":8"));
        assertThat(service.getReport(projectId, userId).localImport()).isNull();
    }

    @Test
    void explicitZeroLocalImportCountsRemainAvailableWithoutInventingAnalysisOutcomes() {
        importEvidence(projectId, snapshotId, "CONFIG", "LOCAL_IMPORT", """
                {"schemaVersion":1,"policyVersion":"local-ingest-v1","acceptedFiles":0,"bytesRead":0,
                 "excludedEntriesByReason":{}}
                """);
        CoverageReport report = service.getReport(projectId, userId);
        assertThat(report.localImport()).isNotNull();
        assertThat(report.localImport().acceptedFiles()).isZero();
        assertThat(report.localImport().bytesRead()).isZero();
        assertThat(report.localImport().excludedEntriesByReason()).isEmpty();
        assertThat(report.fileCoverage().analyzedFiles()).isNull();
    }

    @Test
    void localImportContractUpperBoundsRemainAvailable() {
        importEvidence(projectId, snapshotId, "CONFIG", "LOCAL_IMPORT", """
                {"schemaVersion":1,"policyVersion":"local-ingest-v1","acceptedFiles":50000,"bytesRead":536870912,
                 "excludedEntriesByReason":{"IGNORED":150000}}
                """);
        CoverageReport.LocalImportSummary summary =
                service.getReport(projectId, userId).localImport();
        assertThat(summary).isNotNull();
        assertThat(summary.acceptedFiles()).isEqualTo(50_000);
        assertThat(summary.bytesRead()).isEqualTo(536_870_912L);
        assertThat(summary.excludedEntriesByReason()).containsEntry("IGNORED", 150_000);
    }

    @ParameterizedTest
    @ValueSource(ints = {2048, 2049})
    void localImportEvidenceSizeBoundaryIsEnforcedBeforeParsing(int bytes) {
        importEvidence(
                projectId,
                snapshotId,
                "CONFIG",
                "LOCAL_IMPORT",
                LOCAL_IMPORT_EXCERPT + " ".repeat(bytes - LOCAL_IMPORT_EXCERPT.length()));
        CoverageReport.LocalImportSummary summary =
                service.getReport(projectId, userId).localImport();
        if (bytes == 2048) assertThat(summary).isNotNull();
        else assertThat(summary).isNull();
    }

    @ParameterizedTest(name = "local import rejects {0}")
    @MethodSource("invalidLocalImportEvidence")
    void malformedLocalImportEvidenceRemainsUnavailable(String scenario, String excerpt) {
        importEvidence(projectId, snapshotId, "CONFIG", "LOCAL_IMPORT", excerpt);
        assertThat(service.getReport(projectId, userId).localImport())
                .as(scenario)
                .isNull();
    }

    private static Stream<Arguments> invalidLocalImportEvidence() {
        return Stream.of(
                Arguments.of("invalid JSON", "{"),
                Arguments.of("null evidence", null),
                Arguments.of("non-object root", "[]"),
                Arguments.of(
                        "unsupported schema",
                        LOCAL_IMPORT_EXCERPT.replace("\"schemaVersion\":1", "\"schemaVersion\":2")),
                Arguments.of("unsupported policy", LOCAL_IMPORT_EXCERPT.replace("local-ingest-v1", "local-ingest-v2")),
                Arguments.of("missing field", LOCAL_IMPORT_EXCERPT.replace("\"bytesRead\":1024,", "")),
                Arguments.of(
                        "unknown field",
                        LOCAL_IMPORT_EXCERPT.replace("\"schemaVersion\":1", "\"extra\":true,\"schemaVersion\":1")),
                Arguments.of(
                        "string count", LOCAL_IMPORT_EXCERPT.replace("\"acceptedFiles\":7", "\"acceptedFiles\":\"7\"")),
                Arguments.of(
                        "fractional count",
                        LOCAL_IMPORT_EXCERPT.replace("\"acceptedFiles\":7", "\"acceptedFiles\":7.0")),
                Arguments.of(
                        "negative count", LOCAL_IMPORT_EXCERPT.replace("\"acceptedFiles\":7", "\"acceptedFiles\":-1")),
                Arguments.of(
                        "file cap", LOCAL_IMPORT_EXCERPT.replace("\"acceptedFiles\":7", "\"acceptedFiles\":50001")),
                Arguments.of("byte cap", LOCAL_IMPORT_EXCERPT.replace("\"bytesRead\":1024", "\"bytesRead\":536870913")),
                Arguments.of(
                        "integer overflow",
                        LOCAL_IMPORT_EXCERPT.replace("\"bytesRead\":1024", "\"bytesRead\":9223372036854775808")),
                Arguments.of("unknown exclusion", LOCAL_IMPORT_EXCERPT.replace("GENERATED_DIRECTORY", "OTHER")),
                Arguments.of("negative exclusion", LOCAL_IMPORT_EXCERPT.replace("\"BINARY\":3", "\"BINARY\":-1")),
                Arguments.of("non-integer exclusion", LOCAL_IMPORT_EXCERPT.replace("\"BINARY\":3", "\"BINARY\":true")),
                Arguments.of(
                        "nested exclusion", LOCAL_IMPORT_EXCERPT.replace("\"BINARY\":3", "\"BINARY\":{\"nested\":3}")),
                Arguments.of("exclusion cap", LOCAL_IMPORT_EXCERPT.replace("\"BINARY\":3", "\"BINARY\":200001")),
                Arguments.of("combined entry cap", LOCAL_IMPORT_EXCERPT.replace("\"BINARY\":3", "\"BINARY\":199991")),
                Arguments.of(
                        "duplicate root key",
                        LOCAL_IMPORT_EXCERPT.replace("\"acceptedFiles\":7", "\"acceptedFiles\":7,\"acceptedFiles\":8")),
                Arguments.of(
                        "duplicate exclusion key",
                        LOCAL_IMPORT_EXCERPT.replace("\"BINARY\":3", "\"BINARY\":3,\"BINARY\":4")),
                Arguments.of("trailing JSON", LOCAL_IMPORT_EXCERPT + "{}"));
    }

    @Test
    void currentConfigurationCannotRewriteRecordedFailuresOrCompleteness() {
        long jobId = job(snapshotId, "FAILED");
        step(jobId, "SOURCE_PARSING", 1, "DONE", null);
        step(jobId, "TS_PARSING", 2, "FAILED", "fixture parser failure");
        step(jobId, "TREE_PARSING", 3, "SKIPPED", null);
        CoverageReport baseline = service.buildReport(projectId, snapshotId);
        for (String tsUrl : List.of("", "http://127.0.0.1:3040")) {
            for (String treeUrl : List.of("", "http://127.0.0.1:3041")) {
                CoverageService configured = new CoverageService(
                        jdbcClient,
                        jobs,
                        projects,
                        new TsAnalyzerProperties(tsUrl, 30),
                        new TreeAnalyzerProperties(treeUrl, 30));
                assertThat(configured.buildReport(projectId, snapshotId)).isEqualTo(baseline);
            }
        }
        assertThat(baseline.analyzerStatuses())
                .extracting(CoverageReport.AnalyzerStatus::status)
                .containsExactly("done", "failed", "skipped");
        assertThat(baseline.analyzerStatuses().get(1).failureReason()).isEqualTo("fixture parser failure");
        assertThat(baseline.retryableIssues()).singleElement().asString().contains("fixture parser failure");
        assertThat(baseline.partialResults().status()).isEqualTo("UNKNOWN");
        assertThat(baseline.fileCoverage().analyzedFiles()).isNull();
    }

    @ParameterizedTest
    @EnumSource(StepStatus.class)
    void allRecordedStepStatesStillLeaveFileOutcomesUnmeasured(StepStatus status) {
        long jobId = job(snapshotId, "FAILED");
        step(jobId, "SOURCE_PARSING", 1, status.name(), status == StepStatus.FAILED ? "fixture failure" : null);
        CoverageReport report = service.buildReport(projectId, snapshotId);
        assertThat(report.analyzerStatuses().getFirst().status())
                .isEqualTo(status.name().toLowerCase(Locale.ROOT));
        assertThat(report.measurementStatus()).isEqualTo("LEGACY_UNMEASURED");
        assertThat(report.fileCoverage().analyzedFiles()).isNull();
        assertThat(report.languageCoverage())
                .allSatisfy(language -> assertThat(language.analyzed()).isNull());
    }

    @Test
    void absentStepsStayUnknownEvenWhenCurrentAnalyzersAreEnabled() {
        CoverageService configured = new CoverageService(
                jdbcClient,
                jobs,
                projects,
                new TsAnalyzerProperties("http://127.0.0.1:3040", 30),
                new TreeAnalyzerProperties("http://127.0.0.1:3041", 30));
        CoverageReport report = configured.buildReport(projectId, snapshotId);
        assertThat(report.analyzerStatuses())
                .allSatisfy(analyzer -> assertThat(analyzer.status()).isEqualTo("unknown"));
        assertThat(report.partialResults().status()).isEqualTo("UNKNOWN");
    }

    @Test
    void latestSnapshotJobDoesNotBorrowMissingStepsFromOlderOrOtherSnapshotJobs() {
        long older = job(snapshotId, "FAILED");
        step(older, "TS_PARSING", 1, "FAILED", "old failure");
        long latest = job(snapshotId, "DONE");
        step(latest, "SOURCE_PARSING", 1, "DONE", null);
        long unrelated = job(snapshot(), "FAILED");
        step(unrelated, "TS_PARSING", 1, "FAILED", "other snapshot failure");
        CoverageReport report = service.buildReport(projectId, snapshotId);
        assertThat(report.analyzerStatuses())
                .extracting(CoverageReport.AnalyzerStatus::status)
                .containsExactly("done", "unknown", "unknown");
        assertThat(report.retryableIssues()).isEmpty();
    }

    @Test
    void recordedInventoryOmissionsDoNotCreateADiscoveryDenominator() {
        evidence("Skipped 3 files over app.analysis.max-files.");
        evidence("Skipped 2 files over app.analysis.max-file-size.");
        CoverageReport report = service.buildReport(projectId, snapshotId);
        assertThat(report.fileCoverage().inventoriedFiles()).isEqualTo(7);
        assertThat(report.fileCoverage().discoveredFiles()).isEqualTo(7);
        assertThat(report.fileCoverage().skippedForCount()).isEqualTo(3);
        assertThat(report.fileCoverage().skippedForSize()).isEqualTo(2);
        assertThat(report.fileCoverage().analyzedFiles()).isNull();
    }

    @Test
    void conflictingOrMalformedOmissionEvidenceRemainsUnknown() {
        evidence("Skipped 3 files over app.analysis.max-files.");
        evidence("Skipped 4 files over app.analysis.max-files.");
        evidence("Skipped invalid files over app.analysis.max-file-size.");
        CoverageReport report = service.buildReport(projectId, snapshotId);
        assertThat(report.fileCoverage().skippedForCount()).isNull();
        assertThat(report.fileCoverage().skippedForSize()).isNull();
    }

    @Test
    void markdownExportUsesInventoryAndExplicitUnknownCoverage() {
        CoverageReport report = service.getReport(projectId, userId);
        String markdown = exports.toMarkdown(new ExportService.ExportData(
                "Coverage fixture",
                "LOCAL",
                "a".repeat(40),
                "2026-10-02",
                projectId,
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                report));
        assertThat(markdown).contains("Inventoried files: 7", "Analysis coverage: unmeasured", "completeness: unknown");
        assertThat(markdown).doesNotContain("Files analyzed:", "Skipped (binary): 0", ": null");
    }

    @Test
    void exportKeepsCapturedSnapshotWhenCurrentPointerChangesAndReadsRealAreaTables() {
        long target = snapshot();
        jdbc.update(
                "insert into files (snapshot_id,path,language,size,content_hash) values (?,'target.ts','typescript',1,?)",
                target,
                "b".repeat(40));
        long area = jdbc.queryForObject(
                "insert into project_areas (snapshot_id,area_type,confidence) values (?,'BACKEND',0.9) returning id",
                Long.class,
                snapshotId);
        // Insert out of order to exercise deterministic technology aggregation.
        jdbc.update("insert into area_technologies (area_id,name) values (?,'Spring Boot'),(?,'Java')", area, area);
        jdbc.update(
                "insert into project_areas (snapshot_id,area_type,confidence) values (?,'DATABASE',0.5),(?,'FRONTEND',1.0)",
                snapshotId,
                target);
        jdbc.update(
                "insert into features (snapshot_id,name,detection,confidence) values (?,'A feature','STATIC',0.9),(?,'B feature','STATIC',0.9)",
                snapshotId,
                target);
        jdbc.update(
                "insert into flows (snapshot_id,name,kind) values (?,'A flow','BACKEND'),(?,'B flow','BACKEND')",
                snapshotId,
                target);
        jdbc.update(
                "insert into analysis_findings (snapshot_id,category,severity,title) values (?,'FIXTURE','HIGH','A finding'),(?,'FIXTURE','HIGH','B finding')",
                snapshotId,
                target);
        String capturedCommit = snapshots
                .findByIdAndProjectId(snapshotId, projectId)
                .orElseThrow()
                .getCommitSha();

        // Schedule the pointer change at an exact call boundary. All data and subsequent reads use
        // the real database; clearing JPA's cache ensures a fresh current-snapshot read would see B.
        SnapshotRepository switchingSnapshots = mock(SnapshotRepository.class);
        when(switchingSnapshots.findByIdAndProjectId(snapshotId, projectId)).thenAnswer(ignored -> {
            var captured = snapshots.findByIdAndProjectId(snapshotId, projectId);
            jdbc.update("update projects set current_snapshot_id=? where id=?", target, projectId);
            entityManager.clear();
            return captured;
        });
        ExportService exporting = new ExportService(projects, switchingSnapshots, service, jdbcClient);
        ExportService.ExportData exported = exporting.buildExportData(projectId, userId);

        assertThat(jdbc.queryForObject("select current_snapshot_id from projects where id=?", Long.class, projectId))
                .isEqualTo(target);
        assertThat(exported.commitSha()).isEqualTo(capturedCommit);
        assertThat(exported.coverage().fileCoverage().inventoriedFiles()).isEqualTo(7);
        assertThat(service.getReport(projectId, userId).fileCoverage().inventoriedFiles())
                .isEqualTo(1);
        assertThat(exported.areas())
                .extracting(ExportService.ExportArea::areaType)
                .containsExactly("BACKEND", "DATABASE");
        assertThat(exported.areas().getFirst().technologies()).isEqualTo("Java, Spring Boot");
        assertThat(exported.areas().get(1).technologies()).isNull();
        assertThat(exported.features())
                .extracting(ExportService.ExportFeature::name)
                .containsExactly("A feature");
        assertThat(exported.flows()).extracting(ExportService.ExportFlow::name).containsExactly("A flow");
        assertThat(exported.findings())
                .extracting(ExportService.ExportFinding::title)
                .containsExactly("A finding");
    }

    @Test
    void snapshotComparisonPreservesExplicitStepFailureWithoutMeasuringCoverage() {
        long target = snapshot();
        long jobId = job(target, "FAILED");
        step(jobId, "TS_PARSING", 1, "FAILED", "fixture parser failure");
        var comparison = comparisons.compare(projectId, userId, snapshotId, target);
        assertThat(comparison.coverage().before().fileCoverage().inventoriedFiles())
                .isEqualTo(7);
        assertThat(comparison.coverage().after().fileCoverage().inventoriedFiles())
                .isZero();
        assertThat(comparison.coverage().after().fileCoverage().analyzedFiles()).isNull();
        assertThat(comparison.regressionWarnings())
                .singleElement()
                .asString()
                .contains("recorded analyzer step failure", "coverage remains unknown");
    }

    private long snapshot() {
        return jdbc.queryForObject(
                "insert into snapshots (project_id,commit_sha,status) values (?,?,'READY') returning id",
                Long.class,
                projectId,
                UUID.randomUUID().toString());
    }

    private long job(long snapshot, String status) {
        return jdbc.queryForObject(
                "insert into analysis_jobs (project_id,snapshot_id,type,status) values (?,?,'IMPORT',?) returning id",
                Long.class,
                projectId,
                snapshot,
                status);
    }

    private void step(long jobId, String key, int seq, String status, String error) {
        jdbc.update(
                "insert into analysis_job_steps (job_id,step_key,seq,status,error) values (?,?,?,?,?)",
                jobId,
                key,
                seq,
                status,
                error);
    }

    private void evidence(String excerpt) {
        long id = jdbc.queryForObject(
                "insert into evidences (project_id,kind,excerpt,created_by) values (?,'CONFIG',?,'STATIC') returning id",
                Long.class,
                projectId,
                excerpt);
        jdbc.update(
                "insert into evidence_links (evidence_id,subject_type,subject_id) values (?,'SNAPSHOT',?)",
                id,
                snapshotId);
    }

    private void importEvidence(long evidenceProject, long snapshot, String kind, String subject, String excerpt) {
        long id = jdbc.queryForObject(
                "insert into evidences (project_id,kind,excerpt,created_by) values (?,?,?,'STATIC') returning id",
                Long.class,
                evidenceProject,
                kind,
                excerpt);
        jdbc.update(
                "insert into evidence_links (evidence_id,subject_type,subject_id) values (?,?,?)",
                id,
                subject,
                snapshot);
    }
}
