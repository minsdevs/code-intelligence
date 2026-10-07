package dev.codeintelligence.evidence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.FileService;
import dev.codeintelligence.analysis.coverage.CoverageService;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.common.DesktopPrivateBootstrap;
import dev.codeintelligence.job.FinalizeStep;
import dev.codeintelligence.job.JobProgressPublisher;
import dev.codeintelligence.job.JobRepository;
import dev.codeintelligence.job.JobStatus;
import dev.codeintelligence.job.JobWorker;
import dev.codeintelligence.job.JobWorkspaceProvider;
import dev.codeintelligence.job.Pipeline;
import dev.codeintelligence.note.NoteService;
import dev.codeintelligence.project.DesktopPathAuthorizationService;
import dev.codeintelligence.project.LocalSourceApprovalService;
import dev.codeintelligence.project.ProjectController;
import dev.codeintelligence.project.ProjectService;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.json.JsonMapper;

/**
 * C06 evidence-history sequences (G-EVIDENCE) on real components: approved local imports, the real
 * worker and the complete Spring pipeline, PostgreSQL, the production Node vault/broker and the
 * real TypeScript analyzer sidecar (Java is parsed in-process). After every change sequence each
 * published fact of every retained snapshot is re-verified against the bytes the product serves
 * for that snapshot. The SFC offset cell is R2 and is recorded as outside this release.
 */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.tree-analyzer.base-url=",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.github.base-url=http://127.0.0.1:1",
            "logging.level.root=WARN"
        })
@Import(TestcontainersConfiguration.class)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class EvidenceHistoryIntegrationTest {
    private static final Path ANALYZER =
            Path.of("../analyzers/ts-analyzer").toAbsolutePath().normalize();
    private static NodeBridge bridge;
    private static Sidecar sidecar;
    private static final Map<String, Object> REPORT = new LinkedHashMap<>();
    /** Snapshot id -> path -> bytes approved for that snapshot (captured from the source at import). */
    private static final Map<Long, Map<String, byte[]>> IMPORTED = new TreeMap<>();

    private static Path source;
    private static long user;
    private static long project;
    private static final List<Long> snapshots = new ArrayList<>();
    private static long pinnedNote;

    @TestBean(methodName = "privateBootstrap")
    DesktopPrivateBootstrap privateBootstrap;

    static DesktopPrivateBootstrap privateBootstrap() {
        var json = new JsonMapper();
        byte[] bytes = json.writeValueAsBytes(Map.of(
                "version",
                2,
                "ai",
                Map.of("socketPath", "/tmp/c06-ai.sock", "capability", "e".repeat(64), "epoch", "f".repeat(64)),
                "source",
                Map.of("socketPath", bridge.socket.toString(), "capability", NodeBridge.TOKEN)));
        return new DesktopPrivateBootstrap(new ByteArrayInputStream(bytes), json, Duration.ofSeconds(3));
    }

    @TempDir
    static Path root;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    LocalSourceApprovalService approvals;

    @Autowired
    ProjectService projects;

    @Autowired
    DesktopPathAuthorizationService desktopPaths;

    @Autowired
    FileService files;

    @Autowired
    CoverageService coverage;

    @Autowired
    NoteService notes;

    @Autowired
    FinalizeStep finalizeStep;

    @Autowired
    Pipeline pipeline;

    @Autowired
    JobWorkspaceProvider workspaces;

    @Autowired
    JobRepository jobs;

    @Autowired
    AppProperties app;

    @MockitoBean
    JobWorker worker;

    @BeforeAll
    static void requireBuiltAnalyzer() {
        // The real analyzer is mandatory; without its compiled module this class is an explicit skip.
        Assumptions.assumeTrue(
                Files.isRegularFile(ANALYZER.resolve("dist/app.module.js")),
                "Build analyzers/ts-analyzer (tsc) to run the real-sidecar C06 sequences");
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        try {
            if (bridge == null) bridge = new NodeBridge();
            bridge.start();
            if (sidecar == null) sidecar = new Sidecar();
        } catch (Exception error) {
            throw new IllegalStateException("Disposable source bridge or analyzer failed to start", error);
        }
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add("app.local-import.allowed-roots", () -> "");
        registry.add("app.ts-analyzer.base-url", () -> sidecar.url);
    }

    @AfterAll
    static void close() throws Exception {
        try {
            writeReport();
        } finally {
            if (sidecar != null) sidecar.close();
            if (bridge != null) bridge.close();
        }
    }

    static final String CONTROLLER = "svc-a/src/main/java/com/acme/user/UserController.java";
    static final String SERVICE_A = "svc-a/src/main/java/com/acme/user/UserService.java";
    static final String SERVICE_B = "svc-b/src/main/java/com/acme/user/UserService.java";
    static final String UTIL = "web/src/util.ts";
    static final String CALLS = "web/src/calls.ts";
    static final String CRLF = "web/src/crlf.ts";
    static final String UNICODE = "web/src/unicode.ts";
    static final String BOM = "web/src/bom.ts";
    static final String API = "web/src/api.ts";
    static final String API_RENAMED = "web/src/users-api.ts";
    static final String APP = "web/src/App.tsx";
    static final String PACKAGE_JSON = "web/package.json";
    static final String APPLICATION_YML = "svc-a/src/main/resources/application.yml";
    static final String MIGRATION = "svc-a/src/main/resources/db/migration/V1__users.sql";

    static Map<String, String> initialTree() {
        Map<String, String> tree = new LinkedHashMap<>();
        tree.put(CONTROLLER, """
                package com.acme.user;

                import org.springframework.web.bind.annotation.GetMapping;
                import org.springframework.web.bind.annotation.RestController;

                @RestController
                public class UserController {
                    private final UserService service = new UserService();

                    @GetMapping("/users")
                    public String list() { return service.name() + service.name(); }
                }
                """);
        tree.put(SERVICE_A, """
                package com.acme.user;

                public class UserService {
                    public String name() { return "a"; }
                }
                """);
        tree.put(SERVICE_B, """
                package com.acme.user;

                public class UserService {
                    public String name() { return "b"; }

                    public int count() { return 2; }
                }
                """);
        tree.put(UTIL, """
                export function a(): number { return 1; }
                export function b(): number { return 2; }
                """);
        tree.put(CALLS, """
                import { a, b } from './util';
                export function both(): number { return a() + b(); }
                export function twice(): number { a(); a(); return 0; }
                """);
        tree.put(
                CRLF,
                "// crlf line endings\r\nexport function crlfOne(): number {\r\n  return 1;\r\n}\r\n"
                        + "export function crlfTwo(): number { return crlfOne(); }\r\n");
        tree.put(
                UNICODE,
                "// 한국어 주석과 이모지 😀 가 선언 앞에 있습니다\nconst label = '경로 😀 테스트';\n"
                        + "export function unicodeTarget(): string { return label; }\n");
        tree.put(
                BOM,
                Character.toString(0xFEFF) + "export function bomFirst(): number { return 1; }\n"
                        + "export function bomSecond(): number { return bomFirst(); }\n");
        tree.put(API, "export function loadUsers() { return fetch('/users'); }\n");
        tree.put(APP, """
                import { both } from './calls';
                export function App() { return <div>{both()}</div>; }
                """);
        // Whole-file CONFIG/MIGRATION facts: LF-terminated, CRLF without a final newline, and CRLF-terminated.
        tree.put(PACKAGE_JSON, "{\"name\":\"c06-web\",\"version\":\"1.0.0\"}\n");
        tree.put(APPLICATION_YML, "server:\r\n  port: 8080\r\nspring:\r\n  application:\r\n    name: c06");
        // No table statement: DB_TABLE facts still publish an open line range (accuracy finding D6).
        tree.put(MIGRATION, "CREATE SEQUENCE c06_ids\r\n  START WITH 1\r\n  INCREMENT BY 1;\r\n");
        return tree;
    }

    @Test
    @Order(1)
    @DisplayName("C06-01 initial import: every published fact verifies against retained bytes")
    void initialImport() throws Exception {
        String unique = UUID.randomUUID().toString();
        user = jdbc.queryForObject(
                "insert into users(login,identity_type,local_key) values (?, 'LOCAL', ?) returning id",
                Long.class,
                "c06-" + unique,
                unique);
        source = Files.createDirectories(root.resolve("sources/c06-project"));
        for (var file : initialTree().entrySet()) write(file.getKey(), file.getValue());
        String grant = desktopPaths.authorize(source).nonce();
        var preview = approvals.previewInitial(user, source.toString(), "C06 evidence history", grant);
        var created = projects.createFromLocal(
                user,
                new ProjectController.CreateLocalProjectRequest(
                        source.toString(), "C06 evidence history", preview.previewToken(), grant));
        project = created.project().id();
        Map<String, byte[]> approved = currentBytes();
        long snapshot = run(created.jobId());
        IMPORTED.put(snapshot, approved);
        snapshots.add(snapshot);
        // A user note written now pins the first snapshot's file row (resolved against the current snapshot).
        pinnedNote = notes.create(project, user, new NoteService.UpsertNote("Pinned", "See @file:" + API))
                .id();
        var audit = auditAll("C06-01");
        assertThat(audit.get(snapshot).nodeTypes).containsKeys("CONFIG", "MIGRATION");
        assertThat(audit.get(snapshot).counts.getOrDefault("nodeSpanVerified", 0))
                .isPositive();
        assertThat(audit.get(snapshot).counts.getOrDefault("edgeSpanVerified", 0))
                .isPositive();
    }

    @Test
    @Order(2)
    @DisplayName("C06-02 old snapshot vs working tree: a changed live folder never alters served history")
    void workingTreeChangeDoesNotLeakIntoTheSnapshot() throws Exception {
        long first = snapshots.getFirst();
        write(
                UTIL,
                "export function a(): number { return 10; }\nexport function b(): number { return 20; }\n"
                        + "export function c(): number { return 30; }\n");
        assertThat(files.fileContent(project, user, UTIL, first).content().getBytes(StandardCharsets.UTF_8))
                .isEqualTo(IMPORTED.get(first).get(UTIL));
        auditAll("C06-02");
    }

    @Test
    @Order(3)
    @DisplayName("C06-03 re-analysis after a content change: old and new snapshots each verify against their own bytes")
    void reanalysisKeepsBothGenerations() throws Exception {
        long next = reanalyze();
        assertThat(files.fileContent(project, user, UTIL, next).content()).contains("c(): number");
        assertThat(files.fileContent(project, user, UTIL, snapshots.getFirst()).content())
                .doesNotContain("c(): number");
        auditAll("C06-03");
    }

    @Test
    @Order(4)
    @DisplayName("C06-04 same-line calls: each call edge keeps its own target and callsite line")
    void sameLineCalls() {
        long current = snapshots.getLast();
        var calls = jdbc.queryForList("""
                select s.name as source, t.name as target, e.metadata->>'lineStart' as line
                from graph_edges e join graph_nodes s on s.id=e.source_node_id join graph_nodes t on t.id=e.target_node_id
                where e.snapshot_id=? and e.edge_type='CALLS' and e.metadata->>'filePath'=?
                order by 1,2,3
                """, current, CALLS);
        REPORT.put("C06-04 sameLineCalls", calls);
        assertThat(calls).anySatisfy(row -> {
            assertThat(row)
                    .containsEntry("source", "both")
                    .containsEntry("target", "a")
                    .containsEntry("line", "2");
        });
        assertThat(calls).anySatisfy(row -> {
            assertThat(row)
                    .containsEntry("source", "both")
                    .containsEntry("target", "b")
                    .containsEntry("line", "2");
        });
        assertThat(calls.stream()
                        .filter(row -> "twice".equals(row.get("source")))
                        .toList())
                .as("duplicate same-line calls to one target are one edge, never merged with another target")
                .allSatisfy(row -> assertThat(row).containsEntry("target", "a").containsEntry("line", "3"));
        auditAll("C06-04");
    }

    @Test
    @Order(5)
    @DisplayName("C06-05 CRLF: retained bytes keep CRLF and spans follow CRLF line boundaries")
    void crlf() throws Exception {
        long current = snapshots.getLast();
        byte[] bytes = files.fileContent(project, user, CRLF, current).content().getBytes(StandardCharsets.UTF_8);
        assertThat(new String(bytes, StandardCharsets.UTF_8)).contains("\r\n").doesNotContain("\n\n");
        assertSpan(current, CRLF, "crlfTwo", 5);
        assertSpan(current, CRLF, "crlfOne", 2);
        auditAll("C06-05");
    }

    @Test
    @Order(6)
    @DisplayName("C06-06 Unicode: multi-byte text before a declaration does not shift its span")
    void unicode() {
        long current = snapshots.getLast();
        assertSpan(current, UNICODE, "unicodeTarget", 3);
        assertThat(files.fileContent(project, user, UNICODE, current).content()).contains("😀");
        auditAll("C06-06");
    }

    @Test
    @Order(7)
    @DisplayName("C06-07 UTF-8 BOM: retained bytes keep the BOM and first-line spans stay on line 1")
    void bom() {
        long current = snapshots.getLast();
        byte[] bytes = files.fileContent(project, user, BOM, current).content().getBytes(StandardCharsets.UTF_8);
        assertThat(bytes).startsWith((byte) 0xEF, (byte) 0xBB, (byte) 0xBF);
        assertSpan(current, BOM, "bomFirst", 1);
        assertSpan(current, BOM, "bomSecond", 2);
        auditAll("C06-07");
    }

    @Test
    @Order(8)
    @DisplayName("C06-08 rename: the old snapshot serves the old path, the new snapshot only the new path")
    void rename() throws Exception {
        long before = snapshots.getLast();
        Files.move(source.resolve(API), source.resolve(API_RENAMED));
        long next = reanalyze();
        assertThat(paths(next)).contains(API_RENAMED).doesNotContain(API);
        assertThat(files.fileContent(project, user, API, before).content()).contains("loadUsers");
        assertThat(factsReferencing(next, API)).isZero();
        assertThat(factsReferencing(next, API_RENAMED)).isPositive();
        auditAll("C06-08");
    }

    @Test
    @Order(9)
    @DisplayName("C06-09 delete: the deleted file stays readable in history and leaves no fact in the new snapshot")
    void delete() throws Exception {
        long before = snapshots.getLast();
        Files.delete(source.resolve(UNICODE));
        long next = reanalyze();
        assertThat(paths(next)).doesNotContain(UNICODE);
        assertThat(files.fileContent(project, user, UNICODE, before).content()).contains("unicodeTarget");
        assertThat(factsReferencing(next, UNICODE)).isZero();
        auditAll("C06-09");
    }

    @Test
    @Order(10)
    @DisplayName("C06-10 unchanged re-analysis reproduces identical facts and leaves the previous snapshot intact")
    void unchangedReanalysis() throws Exception {
        long before = snapshots.getLast();
        List<String> previous = normalizedFacts(before);
        long next = reanalyze();
        assertThat(normalizedFacts(next)).isEqualTo(previous);
        assertThat(normalizedFacts(before)).isEqualTo(previous);
        auditAll("C06-10");
    }

    @Test
    @Order(11)
    @DisplayName("C06-11 duplicate namespace: a repeated FQCN in two modules is withheld, never merged onto one file")
    void duplicateNamespace() {
        long current = snapshots.getLast();
        var rows = jdbc.queryForList("""
                select n.node_type, n.natural_key, f.path, n.line_start, n.metadata->>'reason' as reason
                from graph_nodes n left join files f on f.id=n.file_id
                where n.snapshot_id=? and n.natural_key like 'java:com.acme.user.UserService%' order by 2
                """, current);
        REPORT.put("C06-11 duplicateNamespace", rows);
        assertThat(rows).isNotEmpty();
        for (var row : rows) {
            boolean ambiguous = "AMBIGUOUS".equals(row.get("node_type"));
            if (!ambiguous) {
                // A published declaration must belong to exactly one module and verify in that file.
                assertThat(row.get("path")).isIn(SERVICE_A, SERVICE_B);
            } else {
                assertThat(row.get("line_start")).isNull();
            }
        }
        assertThat(rows.stream().filter(row -> "java:com.acme.user.UserService".equals(row.get("natural_key"))))
                .as("one natural key per snapshot")
                .hasSizeLessThanOrEqualTo(1);
        auditAll("C06-11");
    }

    @Test
    @Order(12)
    @DisplayName("C06-12 pin: a note reference made on the first snapshot keeps its target and source")
    void notePinSurvivesLaterAnalyses() throws Exception {
        // The note was written in C06-01 against the first snapshot; later analyses must not remove its target.
        long first = snapshots.getFirst();
        long fileId =
                jdbc.queryForObject("select id from files where snapshot_id=? and path=?", Long.class, first, API);
        assertThat(jdbc.queryForObject(
                        "select subject_id from note_references where note_id=?", Long.class, pinnedNote))
                .isEqualTo(fileId);
        write(UTIL, "export function a(): number { return 11; }\nexport function b(): number { return 22; }\n");
        reanalyze();
        write(UTIL, "export function a(): number { return 12; }\nexport function b(): number { return 23; }\n");
        reanalyze();
        assertThat(jdbc.queryForObject("select count(*) from files where id=?", Integer.class, fileId))
                .isEqualTo(1);
        assertThat(files.fileContent(project, user, API, first).content()).contains("loadUsers");
        auditAll("C06-12");
    }

    @Test
    @Order(13)
    @DisplayName(
            "C06-13 GC: no retained snapshot source is evicted; legacy-contract pruning keeps note-pinned snapshots")
    void retentionNeverEvictsRetainedSource() {
        assertThat(snapshots).hasSizeGreaterThan(app.snapshotRetention() + 2);
        for (long snapshot : snapshots) {
            assertThat(jdbc.queryForObject("select status from snapshots where id=?", String.class, snapshot))
                    .isEqualTo("READY");
            assertThat(jdbc.queryForObject(
                            "select source_contract_version from snapshots where id=?", Integer.class, snapshot))
                    .isEqualTo(1);
        }
        int blobRows =
                jdbc.queryForObject("select count(*) from source_blobs where project_id=?", Integer.class, project);
        int referenced = jdbc.queryForObject("""
                select count(distinct e.blob_sha256) from source_manifest_entries e where e.project_id=?
                """, Integer.class, project);
        assertThat(blobRows).isEqualTo(referenced);
        REPORT.put("C06-13 retainedSnapshots", snapshots.size());
        REPORT.put("C06-13 retainedBlobs", blobRows);
        auditAll("C06-13");
        REPORT.put("C06-13 legacyPrune", legacyPruneOfANotePinnedSnapshot());
    }

    /** Legacy (source_contract_version 0, e.g. GitHub) snapshots pinned by a note survive FinalizeStep pruning. */
    private Map<String, Object> legacyPruneOfANotePinnedSnapshot() {
        String unique = UUID.randomUUID().toString();
        long legacyUser = jdbc.queryForObject(
                "insert into users(login,identity_type,local_key) values (?, 'LOCAL', ?) returning id",
                Long.class,
                "c06-legacy-" + unique,
                unique);
        long legacy = jdbc.queryForObject(
                "insert into projects(user_id,name,repo_owner,repo_name) values (?, 'legacy', 'fixture', ?) returning id",
                Long.class,
                legacyUser,
                unique);
        List<Long> ids = new ArrayList<>();
        for (int index = 0; index < 4; index++) {
            ids.add(jdbc.queryForObject(
                    "insert into snapshots(project_id,commit_sha,status) values (?, ?, ?) returning id",
                    Long.class,
                    legacy,
                    String.valueOf(index).repeat(40),
                    index < 3 ? "READY" : "ANALYZING"));
        }
        long pinnedFile = jdbc.queryForObject(
                "insert into files(snapshot_id,path,size,content_hash) values (?, 'Pinned.java', 1, ?) returning id",
                Long.class,
                ids.getFirst(),
                "a".repeat(40));
        long note = jdbc.queryForObject(
                "insert into notes(project_id,title,content_md) values (?, 'legacy pin', 'See @file:Pinned.java') returning id",
                Long.class,
                legacy);
        jdbc.update(
                "insert into note_references(note_id,subject_type,subject_id,raw_target,label) values (?, 'FILE', ?, 'Pinned.java', 'Pinned.java')",
                note,
                pinnedFile);
        long job = jdbc.queryForObject(
                "insert into analysis_jobs(project_id,type,status,snapshot_id) values (?, 'REANALYZE', 'RUNNING', ?) returning id",
                Long.class,
                legacy,
                ids.getLast());
        jdbc.update(
                "insert into analysis_job_steps(job_id,step_key,seq,status) values (?, ?, 1, 'RUNNING')",
                job,
                FinalizeStep.KEY);
        finalizeStep.run(new dev.codeintelligence.testsupport.TestJobContext(job, legacy, ids.getLast(), root));
        boolean snapshotKept =
                jdbc.queryForObject("select count(*) from snapshots where id=?", Integer.class, ids.getFirst()) == 1;
        boolean fileKept = jdbc.queryForObject("select count(*) from files where id=?", Integer.class, pinnedFile) == 1;
        boolean noteKept = jdbc.queryForObject("select count(*) from notes where id=?", Integer.class, note) == 1;
        Map<String, Object> observed = new LinkedHashMap<>();
        observed.put("retention", app.snapshotRetention());
        observed.put("pinnedLegacySnapshotKept", snapshotKept);
        observed.put("pinnedFileRowKept", fileKept);
        observed.put("noteKept", noteKept);
        observed.put("status", snapshotKept && fileKept ? "PASS" : "FAIL_SPEC_DEVIATION");
        assertThat(noteKept).isTrue();
        assertThat(snapshotKept)
                .as("legacy prune keeps the note-pinned snapshot")
                .isTrue();
        assertThat(fileKept).isTrue();
        // A surviving legacy snapshot reports unmeasured results, never recorded success.
        var legacyCoverage = coverage.buildReport(legacy, ids.getLast());
        assertThat(legacyCoverage.measurementStatus()).isEqualTo("LEGACY_UNMEASURED");
        assertThat(legacyCoverage.outcomes()).isNull();
        observed.put("legacyCoverageMeasurementStatus", legacyCoverage.measurementStatus());
        return observed;
    }

    @Test
    @Order(14)
    @DisplayName("C06-14 coverage partition: file and outcome counts equal the approved manifest for every snapshot")
    void coveragePartition() {
        Map<Long, Object> partitions = new TreeMap<>();
        for (long snapshot : snapshots) {
            var report = coverage.buildReport(project, snapshot);
            assertThat(report.measurementStatus()).isEqualTo("PER_FILE_RECORDED");
            var outcomes = report.outcomes();
            int rows = jdbc.queryForObject("select count(*) from files where snapshot_id=?", Integer.class, snapshot);
            int manifest = jdbc.queryForObject(
                    "select file_count from source_manifests where snapshot_id=?", Integer.class, snapshot);
            assertThat(rows)
                    .isEqualTo(manifest)
                    .isEqualTo(IMPORTED.get(snapshot).size());
            assertThat(outcomes.successfulFiles()
                            + outcomes.partialFiles()
                            + outcomes.failedFiles()
                            + outcomes.unsupportedFiles()
                            + outcomes.unmeasuredFiles()
                            + outcomes.pendingFiles())
                    .as("outcome statuses partition the inventory")
                    .isEqualTo(rows);
            assertThat(outcomes.discoveredFiles())
                    .as("discovered = inventoried + excluded + submodules")
                    .isEqualTo(rows + outcomes.excludedFiles() + outcomes.excludedSubmodules());
            assertThat(outcomes.targetedFiles())
                    .isEqualTo(jdbc.queryForObject(
                            "select count(*) from files where snapshot_id=? and analysis_targeted",
                            Integer.class,
                            snapshot));
            assertThat(outcomes.pendingFiles())
                    .as("no file left pending after a completed job")
                    .isZero();
            assertThat(report.localImport()).isNotNull();
            assertThat(report.localImport().acceptedFiles()).isEqualTo(manifest);
            partitions.put(snapshot, outcomes);
        }
        REPORT.put("C06-14 coveragePartitions", partitions);
    }

    @Test
    @Order(15)
    @DisplayName("C06-15 SFC offset cell is R2 and outside this release (recorded, not run)")
    void sfcOffsetIsOutsideThisRelease() {
        REPORT.put("C06-15 sfcOffset", "NOT_RUN: R2 cell, outside the first release scope (06 corpus table)");
        Assumptions.abort("C06 SFC offset is an R2 cell and not part of this release");
    }

    private long reanalyze() throws Exception {
        var preview = approvals.previewRefresh(project, user);
        long job = projects.reanalyze(project, user, preview.previewToken());
        Map<String, byte[]> approved = currentBytes();
        long snapshot = run(job);
        IMPORTED.put(snapshot, approved);
        snapshots.add(snapshot);
        return snapshot;
    }

    private long run(long jobId) {
        JobWorker isolated = new JobWorker(jobs, pipeline, mock(JobProgressPublisher.class), app, workspaces);
        try {
            ReflectionTestUtils.invokeMethod(isolated, "runJob", jobId);
        } finally {
            ReflectionTestUtils.invokeMethod(isolated, "shutdown");
        }
        var job = jobs.findJob(jobId).orElseThrow();
        assertThat(job.status())
                .as("job " + jobId + " " + jobs.findSteps(jobId))
                .isEqualTo(JobStatus.DONE);
        long current = jdbc.queryForObject("select current_snapshot_id from projects where id=?", Long.class, project);
        assertThat(current).isEqualTo(job.snapshotId());
        return current;
    }

    private Map<Long, PublishedFactAudit.Result> auditAll(String label) {
        var audit = new PublishedFactAudit(jdbc, files);
        Map<Long, PublishedFactAudit.Result> results = new TreeMap<>();
        Map<String, Object> summary = new LinkedHashMap<>();
        for (long snapshot : snapshots) {
            var result = audit.audit(project, user, snapshot, IMPORTED.get(snapshot));
            results.put(snapshot, result);
            summary.put(Long.toString(snapshot), result.toMap());
        }
        REPORT.put(label, summary);
        writeReport();
        for (var entry : results.entrySet()) {
            assertThat(entry.getValue().failures)
                    .as(label + " snapshot " + entry.getKey())
                    .isEmpty();
            assertThat(entry.getValue().verifiedFacts()).isPositive();
        }
        return results;
    }

    private void assertSpan(long snapshot, String path, String name, int line) {
        var rows = jdbc.queryForList("""
                select n.line_start from graph_nodes n join files f on f.id=n.file_id
                where n.snapshot_id=? and f.path=? and n.name=? and n.node_type<>'AMBIGUOUS'
                """, snapshot, path, name);
        assertThat(rows)
                .as(path + "#" + name)
                .isNotEmpty()
                .allSatisfy(row -> assertThat(row.get("line_start")).isEqualTo(line));
    }

    private List<String> paths(long snapshot) {
        return jdbc.queryForList("select path from files where snapshot_id=? order by path", String.class, snapshot);
    }

    private int factsReferencing(long snapshot, String path) {
        return jdbc.queryForObject("""
                select (select count(*) from graph_nodes n join files f on f.id=n.file_id where n.snapshot_id=? and f.path=?)
                     + (select count(*) from graph_edges e where e.snapshot_id=? and e.metadata->>'filePath'=?)
                     + (select count(*) from graph_nodes n where n.snapshot_id=? and n.natural_key like '%' || ? || '%')
                """, Integer.class, snapshot, path, snapshot, path, snapshot, path);
    }

    private List<String> normalizedFacts(long snapshot) {
        List<String> facts = new ArrayList<>(jdbc.queryForList("""
                select concat_ws('|', n.node_type, n.natural_key, n.name, coalesce(f.path,''), coalesce(n.line_start::text,''),
                                 coalesce(n.line_end::text,''), coalesce(f.content_hash,''))
                from graph_nodes n left join files f on f.id=n.file_id where n.snapshot_id=?
                """, String.class, snapshot));
        facts.addAll(jdbc.queryForList("""
                select concat_ws('|', e.edge_type, s.natural_key, t.natural_key, e.confidence, e.metadata::text)
                from graph_edges e join graph_nodes s on s.id=e.source_node_id join graph_nodes t on t.id=e.target_node_id
                where e.snapshot_id=?
                """, String.class, snapshot));
        facts.sort(String::compareTo);
        return facts;
    }

    private static void write(String relative, String content) throws Exception {
        Path file = source.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
    }

    private static Map<String, byte[]> currentBytes() throws Exception {
        Map<String, byte[]> result = new TreeMap<>();
        try (var paths = Files.walk(source)) {
            for (Path file : paths.filter(Files::isRegularFile).toList())
                result.put(source.relativize(file).toString(), Files.readAllBytes(file));
        }
        return result;
    }

    private static synchronized void writeReport() {
        try {
            Path report =
                    Path.of("build", "reports", "c06-evidence-history.json").toAbsolutePath();
            Files.createDirectories(report.getParent());
            Map<String, Object> document = new LinkedHashMap<>();
            document.put("format", 1);
            document.put("corpus", "C06 evidence-history");
            document.put("results", REPORT);
            Files.writeString(
                    report, new JsonMapper().writerWithDefaultPrettyPrinter().writeValueAsString(document) + "\n");
        } catch (Exception error) {
            throw new IllegalStateException("C06 report could not be written", error);
        }
    }

    /** The production analyzer module on an ephemeral loopback port (accuracy-server.cjs, no .env). */
    private static final class Sidecar implements AutoCloseable {
        private final Process process;
        private final String url;

        Sidecar() throws Exception {
            Path log = Files.createTempFile(root, "analyzer-", ".log");
            process = new ProcessBuilder(
                            "node", ANALYZER.resolve("accuracy-server.cjs").toString())
                    .directory(ANALYZER.toFile())
                    .redirectError(log.toFile())
                    .start();
            var reader = process.inputReader(StandardCharsets.UTF_8);
            var executor = Executors.newVirtualThreadPerTaskExecutor();
            try {
                url = executor.submit(reader::readLine).get(30, TimeUnit.SECONDS);
            } finally {
                executor.shutdownNow();
            }
            if (url == null || !url.matches("http://127\\.0\\.0\\.1:[0-9]+")) {
                process.destroyForcibly();
                throw new IllegalStateException("Analyzer did not report a loopback URL");
            }
        }

        @Override
        public void close() throws Exception {
            process.destroy();
            if (!process.waitFor(15, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
        }
    }

    private static final class NodeBridge implements AutoCloseable {
        private static final String TOKEN = "b".repeat(64); // Public fixture capability, never a source root key.
        private final Path root;
        private final Path socket;
        private final Path config;
        private final Path stderr;
        private Process process;
        private BufferedReader stdout;

        NodeBridge() throws Exception {
            root = Files.createTempDirectory(
                            Path.of("/tmp"),
                            "ci-c06-",
                            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
                    .toRealPath();
            socket = root.resolve("broker.sock");
            config = Files.createFile(
                    root.resolve("config.json"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            stderr = Files.createFile(
                    root.resolve("stderr.log"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            Files.writeString(
                    config,
                    JsonMapper.builder()
                            .build()
                            .writeValueAsString(Map.of(
                                    "root", root.toString(), "socketPath", socket.toString(), "authToken", TOKEN)));
        }

        synchronized void start() throws Exception {
            if (process != null && process.isAlive()) return;
            Path fixture = Path.of("../desktop/test/fixtures/source-store-server.cjs")
                    .toAbsolutePath()
                    .normalize();
            assertThat(fixture).isRegularFile();
            process = new ProcessBuilder("node", fixture.toString(), config.toString())
                    .redirectError(stderr.toFile())
                    .start();
            stdout = process.inputReader(StandardCharsets.UTF_8);
            var readers = Executors.newVirtualThreadPerTaskExecutor();
            var ready = readers.submit(stdout::readLine);
            try {
                assertThat(ready.get(10, TimeUnit.SECONDS)).isEqualTo("READY");
            } catch (Throwable error) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
                throw error;
            } finally {
                readers.shutdownNow();
                assertThat(readers.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
            }
            assertThat(Files.readString(stderr)).isEmpty();
        }

        synchronized void stop() throws Exception {
            if (process == null) return;
            if (process.isAlive()) {
                process.getOutputStream().write("stop\n".getBytes(StandardCharsets.UTF_8));
                process.getOutputStream().flush();
                if (!process.waitFor(15, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    throw new AssertionError("Disposable source bridge did not stop");
                }
            }
            assertThat(process.exitValue()).isZero();
            assertThat(stdout.readLine()).isNull();
            assertThat(Files.readString(stderr)).isEmpty();
            stdout.close();
            process = null;
        }

        @Override
        public void close() throws Exception {
            stop();
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }
}
