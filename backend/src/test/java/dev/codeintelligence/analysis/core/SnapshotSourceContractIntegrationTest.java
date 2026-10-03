package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import dev.codeintelligence.TestcontainersConfiguration;
import java.io.ByteArrayOutputStream;
import java.net.CookieManager;
import java.net.ServerSocket;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.DeflaterOutputStream;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Dedicated snapshotSourceTest gate; all sources, identities and database rows are disposable fixtures. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.desktop.api-token=s1-fixture-token",
            "app.desktop.local-identity=s1-fixture",
            "app.analysis.max-file-size=1024",
            "app.snapshot-retention=10",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url=",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.github.base-url=http://127.0.0.1:1"
        })
@Import(TestcontainersConfiguration.class)
class SnapshotSourceContractIntegrationTest {
    private static final int PORT = availablePort();
    private static final String BASE = "http://127.0.0.1:" + PORT;
    private static final String TOKEN = "s1-fixture-token";

    @TempDir
    static Path root;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    JsonMapper json;

    private final CookieManager cookies = new CookieManager();
    private final HttpClient http =
            HttpClient.newBuilder().cookieHandler(cookies).build();
    private final HttpClient anonymousHttp = HttpClient.newHttpClient();

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("server.port", () -> PORT);
        registry.add("app.desktop.allowed-origin", () -> BASE);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add("app.local-import.allowed-roots", () -> root.toString());
    }

    @BeforeEach
    void isolatePreviewQuotaBetweenIndependentBrowserScenarios() {
        // All scenarios share this disposable desktop identity. Keep immutable job receipts while
        // removing previous scenarios' preview grants; the production issuance quota stays intact.
        jdbc.update("delete from local_source_approvals");
    }

    @ParameterizedTest(name = "S1 group 1 import/refresh/preservation [{0}]")
    @ValueSource(strings = {"java", "typescript"})
    void importRefreshNeverSubstitutesCurrentBytes(String language) throws Exception {
        Fixture f = fixture(language);
        assertContent(f, f.a(), f.before());
        assertThat(f.after().getBytes(StandardCharsets.UTF_8))
                .hasSameSizeAs(f.before().getBytes(StandardCharsets.UTF_8));
        Files.writeString(f.source().resolve(f.path()), f.after());
        JsonNode status = get("/api/projects/" + f.project() + "/local-source-status", 200);
        assertThat(status.path("state").asString()).isEqualTo("CHANGED");
        assertThat(status.path("changes").path("added").asInt()).isZero();
        assertThat(status.path("changes").path("modified").asInt()).isEqualTo(1);
        assertThat(status.path("changes").path("deleted").asInt()).isZero();
        assertThat(status.path("changes").path("total").asInt()).isEqualTo(1);
        AtomicBoolean reading = new AtomicBoolean(true);
        CountDownLatch firstRead = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var reads = executor.submit(() -> {
                List<Integer> statuses = new ArrayList<>();
                try {
                    do {
                        statuses.add(assertOldReadDuringRefresh(f));
                        firstRead.countDown();
                    } while (reading.get());
                } finally {
                    firstRead.countDown();
                }
                return statuses;
            });
            try {
                assertThat(firstRead.await(15, TimeUnit.SECONDS))
                        .as("first concurrent source read")
                        .isTrue();
                if (reads.isDone()) reads.get(); // Surface a reader failure before starting the refresh.
                JsonNode preview =
                        request("POST", "/api/projects/" + f.project() + "/local-preview", Map.of(), true, 200);
                JsonNode job = request(
                        "POST",
                        "/api/projects/" + f.project() + "/reanalyze",
                        Map.of("previewToken", preview.path("previewToken").asString()),
                        true,
                        202);
                finish(job.path("jobId").asLong());
            } finally {
                reading.set(false);
            }
            List<Integer> statuses = reads.get(35, TimeUnit.SECONDS);
            assertThat(statuses).contains(200).hasSizeGreaterThan(1);
            System.out.println("Concurrent snapshot A reads during refresh: " + statuses.size() + ", unavailable="
                    + statuses.stream().filter(code -> code == 410).count());
        }
        long b = current(f.project());
        assertThat(b).isNotEqualTo(f.a());
        assertContent(f, b, f.after());
        JsonNode old = get(sourceUrl(f, f.path(), f.a()), 410);
        assertThat(old.path("code").asString()).isEqualTo("SOURCE_UNAVAILABLE");
        assertSentinels(f);
        assertSource(f, f.after());
        assertThat(get("/api/projects/" + f.project() + "/files?snapshotId=" + b, 200)
                        .size())
                .isEqualTo(1);
    }

    @ParameterizedTest(name = "S1 group 2 blob/encoding/bounds/integrity [{0}]")
    @ValueSource(strings = {"java", "typescript"})
    void workingTreeAndInvalidObjectsCannotChangeSource(String language) throws Exception {
        Fixture f = fixture(language);
        Files.writeString(f.repoPath().resolve(f.path()), "changed working tree");
        assertContent(f, f.a(), f.before());
        Path outside = root.resolve("outside-" + UUID.randomUUID());
        Files.writeString(outside, "never-display-this-secret");
        Files.delete(f.repoPath().resolve(f.path()));
        Files.createSymbolicLink(f.repoPath().resolve(f.path()), outside);
        assertContent(f, f.a(), f.before());
        for (int size : new int[] {1023, 1024, 1025}) {
            String path = "bounds-" + size + ".txt";
            byte[] bytes = "x".repeat(size).getBytes(StandardCharsets.UTF_8);
            inventory(f, path, insert(f, Constants.OBJ_BLOB, bytes), size);
            JsonNode response = get(sourceUrl(f, path, f.a()), size > 1024 ? 413 : 200);
            if (size <= 1024) assertThat(response.path("content").asString()).hasSize(size);
        }
        inventory(f, "forged-size.txt", insert(f, Constants.OBJ_BLOB, new byte[1025]), 1);
        get(sourceUrl(f, "forged-size.txt", f.a()), 413);
        inventory(f, "binary.txt", insert(f, Constants.OBJ_BLOB, new byte[] {1, 0, 2}), 3);
        get(sourceUrl(f, "binary.txt", f.a()), 415);
        inventory(f, "encoding.txt", insert(f, Constants.OBJ_BLOB, new byte[] {(byte) 0xc3, 0x28}), 2);
        assertThat(get(sourceUrl(f, "encoding.txt", f.a()), 415).path("code").asString())
                .isEqualTo("SOURCE_ENCODING_UNSUPPORTED");
        inventory(f, "missing.txt", "f".repeat(40), 0);
        assertThat(get(sourceUrl(f, "missing.txt", f.a()), 410).path("code").asString())
                .isEqualTo("SOURCE_UNAVAILABLE");
        inventory(f, "legacy.txt", "not-an-object-id", 0);
        assertThat(get(sourceUrl(f, "legacy.txt", f.a()), 410).path("code").asString())
                .isEqualTo("SOURCE_CONTEXT_UNKNOWN");
        inventory(f, "tree.txt", insert(f, Constants.OBJ_TREE, new byte[0]), 0);
        assertThat(get(sourceUrl(f, "tree.txt", f.a()), 409).path("code").asString())
                .isEqualTo("EVIDENCE_STALE");
        String corrupt =
                insert(f, Constants.OBJ_BLOB, ("integrity-" + UUID.randomUUID()).getBytes(StandardCharsets.UTF_8));
        byte[] changed = "tampered".getBytes(StandardCharsets.UTF_8);
        writeLooseObject(f, corrupt, ("blob " + changed.length + "\0tampered").getBytes(StandardCharsets.UTF_8));
        inventory(f, "corrupt.txt", corrupt, changed.length);
        assertThat(get(sourceUrl(f, "corrupt.txt", f.a()), 409).path("code").asString())
                .isEqualTo("EVIDENCE_STALE");
        String malformed = insert(f, Constants.OBJ_BLOB, new byte[] {'a'});
        writeLooseObject(f, malformed, "blob 1\0abc".getBytes(StandardCharsets.UTF_8));
        inventory(f, "malformed-header.txt", malformed, 1);
        assertThat(get(sourceUrl(f, "malformed-header.txt", f.a()), 409)
                        .path("code")
                        .asString())
                .isEqualTo("EVIDENCE_STALE");
        String overlongHeader = insert(f, Constants.OBJ_BLOB, new byte[0]);
        writeLooseObject(f, overlongHeader, ("blob " + "0".repeat(59) + "\0").getBytes(StandardCharsets.UTF_8));
        inventory(f, "overlong-header.txt", overlongHeader, 0);
        assertThat(get(sourceUrl(f, "overlong-header.txt", f.a()), 409)
                        .path("code")
                        .asString())
                .isEqualTo("EVIDENCE_STALE");
        inventory(f, "size-mismatch.txt", insert(f, Constants.OBJ_BLOB, new byte[] {'o', 'k'}), 1);
        assertThat(get(sourceUrl(f, "size-mismatch.txt", f.a()), 409)
                        .path("code")
                        .asString())
                .isEqualTo("EVIDENCE_STALE");
        Path retired = f.repoPath().resolveSibling(f.project() + ".retired");
        Files.move(f.repoPath(), retired);
        try {
            assertThat(get(sourceUrl(f, f.path(), f.a()), 410).path("code").asString())
                    .isEqualTo("SOURCE_UNAVAILABLE");
        } finally {
            Files.move(retired, f.repoPath());
        }
        assertSentinels(f);
        assertSource(f, f.before());
    }

    @ParameterizedTest(name = "S1 group 3 ownership/path/evidence context [{0}]")
    @ValueSource(strings = {"java", "typescript"})
    void authorizationAndEvidenceBinding(String language) throws Exception {
        Fixture f = fixture(language), other = fixture(language, "PPPP", "QQQQ");
        request("GET", sourceUrl(f, f.path(), f.a()), null, false, 401);
        get(sourceUrl(f, f.path(), other.a()), 404);
        for (String path : List.of("../secret", "/etc/passwd", "%2e%2e/secret", "x/../../y")) {
            get(sourceUrl(f, path, f.a()), 400);
        }
        long stranger = jdbc.queryForObject(
                "insert into users (login, identity_type, local_key) values (?, 'LOCAL', ?) returning id",
                Long.class,
                "other-" + UUID.randomUUID(),
                UUID.randomUUID().toString());
        jdbc.update("update projects set user_id=? where id=?", stranger, other.project());
        get(sourceUrl(other, other.path(), other.a()), 404);
        get("/api/projects/" + other.project() + "/files?snapshotId=" + other.a(), 404);
        JsonNode verified = get(sourceUrl(f, f.path(), f.a()) + "&evidenceId=" + f.evidence(), 200);
        assertThat(verified.path("evidenceState").asString()).isEqualTo("LEGACY_SOURCE_UNVERIFIED");
        get(sourceUrl(f, f.path(), f.a()) + "&evidenceId=" + other.evidence(), 404);
        long unresolved = evidence(f.project(), f.path(), "unresolvable subject");
        jdbc.update(
                "insert into evidence_links (evidence_id,subject_type,subject_id) values (?, 'FEATURE', -1)",
                unresolved);
        assertThat(get(sourceUrl(f, f.path(), f.a()) + "&evidenceId=" + unresolved, 410)
                        .path("code")
                        .asString())
                .isEqualTo("SOURCE_CONTEXT_UNKNOWN");
        long b = retainedB(f);
        get(sourceUrl(f, f.path(), b) + "&evidenceId=" + f.evidence(), 409);
        assertThat(get(
                                "/api/projects/" + f.project() + "/file-content?path=" + encoded(f.path())
                                        + "&evidenceId=" + f.evidence(),
                                410)
                        .path("code")
                        .asString())
                .isEqualTo("SOURCE_CONTEXT_UNKNOWN");
        assertSentinels(f);
        assertSentinels(other);
        assertSource(f, f.before());
        assertSource(other, other.before());
    }

    @ParameterizedTest(name = "S1 group 4 real UI races/cache/errors [{0}]")
    @ValueSource(strings = {"java", "typescript"})
    void realUiSnapshotRacesAndRefresh(String language) throws Exception {
        Fixture f = fixture(language), other = fixture(language, "PPPP", "QQQQ");
        long b = retainedB(f);
        long otherB = retainedB(other);
        inventory(f, "missing.txt", "f".repeat(40), 0);
        inventory(f, "stale.txt", insert(f, Constants.OBJ_TREE, new byte[0]), 0);
        browser(
                f,
                Map.of(
                        "scenario",
                        "races",
                        "b",
                        b,
                        "otherProject",
                        other.project(),
                        "otherSnapshot",
                        otherB,
                        "otherAfter",
                        other.after()));
        assertSentinels(f);
        assertSentinels(other);
        assertSource(f, f.before().replace("AAAA", "CCCC"));
        assertSource(other, other.before());
    }

    @ParameterizedTest(name = "S1 group 5 real UI code/feature/note navigation [{0}]")
    @ValueSource(strings = {"java", "typescript"})
    void realUiThreeSourceEntrypoints(String language) throws Exception {
        Fixture f = fixture(language);
        Files.writeString(f.repoPath().resolve(f.path()), "working tree is not snapshot source");
        browser(f, Map.of("scenario", "navigation"));
        assertSentinels(f);
        assertSource(f, f.after());
    }

    @ParameterizedTest(name = "S1 group 6 current API/notes/tasks compatibility [{0}]")
    @ValueSource(strings = {"java", "typescript"})
    void additiveContractAndExistingData(String language) throws Exception {
        Fixture f = fixture(language);
        JsonNode body = get("/api/projects/" + f.project() + "/file-content?path=" + encoded(f.path()), 200);
        assertThat(body.path("content").asString()).isEqualTo(f.before());
        assertThat(body.path("resolvedSnapshotId").asLong()).isEqualTo(f.a());
        assertThat(body.path("sourceState").asString()).isEqualTo("AVAILABLE");
        assertThat(body.path("contentOid").asString()).matches("[a-f0-9]{40}");
        assertThat(get("/api/projects/" + f.project() + "/files", 200)
                        .get(0)
                        .path("resolvedSnapshotId")
                        .asLong())
                .isEqualTo(f.a());
        assertThat(get("/api/projects/" + f.project() + "/stats", 200)
                        .path("fileCount")
                        .asInt())
                .isEqualTo(1);
        get("/api/projects/" + f.project() + "/notes/" + f.note(), 200);
        get("/api/projects/" + f.project() + "/tasks", 200);
        long b = retainedB(f);
        JsonNode latest = get("/api/projects/" + f.project() + "/file-content?path=" + encoded(f.path()), 200);
        assertThat(latest.path("resolvedSnapshotId").asLong()).isEqualTo(b);
        assertThat(latest.path("content").asString()).isEqualTo(f.after());
        assertSentinels(f);
        assertSource(f, f.before());
    }

    private Fixture fixture(String language) throws Exception {
        return fixture(language, "AAAA", "BBBB");
    }

    private Fixture fixture(String language, String beforeMarker, String afterMarker) throws Exception {
        boolean java = language.equals("java");
        String path = java ? "App.java" : "app.ts";
        String template = java ? "class App { String value = \"AAAA\"; }\n" : "export const value = 'AAAA';\n";
        String before = template.replace("AAAA", beforeMarker);
        String after = template.replace("AAAA", afterMarker);
        Path source = Files.createDirectory(root.resolve("source-" + UUID.randomUUID()));
        Files.writeString(source.resolve(path), before);
        try (Git git = Git.init().setDirectory(source.toFile()).call()) {
            git.add().addFilepattern(".").call();
            git.commit()
                    .setMessage("Source repository sentinel")
                    .setAuthor("S1 fixture", "s1@fixture.invalid")
                    .setCommitter("S1 fixture", "s1@fixture.invalid")
                    .call();
        }
        Files.writeString(source.resolve(".git/s1-preservation-sentinel"), "Do not rewrite source Git metadata.\n");
        Map<String, String> sourceState = treeState(source);
        String name = "s1-" + UUID.randomUUID();
        JsonNode preview = request(
                "POST", "/api/projects/local/preview", Map.of("path", source.toString(), "name", name), true, 200);
        JsonNode created = request(
                "POST",
                "/api/projects/local",
                Map.of(
                        "path",
                        source.toString(),
                        "name",
                        name,
                        "previewToken",
                        preview.path("previewToken").asString()),
                true,
                201);
        long project = created.path("project").path("id").asLong();
        finish(created.path("jobId").asLong());
        long a = current(project);
        Path clone = root.resolve("data/repos/" + project);
        long note = jdbc.queryForObject(
                "insert into notes (project_id,title,content_md) values (?, 'S1 sentinel', ?) returning id",
                Long.class,
                project,
                "Keep original note @file:" + path);
        long file = jdbc.queryForObject("select id from files where snapshot_id=? and path=?", Long.class, a, path);
        jdbc.update(
                "insert into note_references (note_id,subject_type,subject_id,raw_target,label) values (?, 'FILE', ?, ?, 'preserve file link')",
                note,
                file,
                path);
        long task = jdbc.queryForObject(
                "insert into tasks (project_id,type,title,description,status,origin) values (?, 'LEARNING', 'S1 task', 'keep task body', 'OPEN', 'USER') returning id",
                Long.class,
                project);
        jdbc.update("insert into task_goals (task_id,seq,content,done) values (?, 1, 'keep task goal', true)", task);
        jdbc.update("insert into learning_records (task_id,note) values (?, 'keep learning record')", task);
        long feature = jdbc.queryForObject(
                "insert into features (snapshot_id,name,detection,confidence) values (?, 'S1 source feature', 'STATIC', 1) returning id",
                Long.class,
                a);
        long evidence = evidence(project, path, "snapshot fixture");
        jdbc.update(
                "insert into evidence_links (evidence_id,subject_type,subject_id) values (?, 'FEATURE', ?)",
                evidence,
                feature);
        jdbc.update(
                "insert into evidence_links (evidence_id,subject_type,subject_id) values (?, 'TASK', ?)",
                evidence,
                task);
        long legacyFlow = jdbc.queryForObject(
                "insert into flows (snapshot_id,name,kind) values (?, 'S1 legacy flow', 'BACKEND') returning id",
                Long.class,
                a);
        long legacyEvidence = evidence(project, path, "legacy fixture");
        jdbc.update(
                "insert into evidence_links (evidence_id,subject_type,subject_id) values (?, 'FLOW', ?)",
                legacyEvidence,
                legacyFlow);
        Fixture fixture = new Fixture(
                project,
                a,
                path,
                before,
                after,
                source,
                clone,
                feature,
                evidence,
                note,
                task,
                legacyFlow,
                sourceState,
                sentinelRows(note, task, evidence));
        assertSource(fixture, before);
        return fixture;
    }

    private long evidence(long project, String path, String excerpt) {
        return jdbc.queryForObject(
                "insert into evidences (project_id,kind,file_path,line_start,line_end,excerpt,created_by) values (?, 'FILE_LINE', ?, 1, 1, ?, 'STATIC') returning id",
                Long.class,
                project,
                path,
                excerpt);
    }

    private long retainedB(Fixture f) throws Exception {
        long b = jdbc.queryForObject(
                "insert into snapshots (project_id,commit_sha,status,analyzed_at) values (?, ?, 'READY', now()) returning id",
                Long.class,
                f.project(),
                "b".repeat(40));
        String oid = insert(f, Constants.OBJ_BLOB, f.after().getBytes(StandardCharsets.UTF_8));
        jdbc.update(
                "insert into files (snapshot_id,path,language,size,line_count,content_hash) values (?, ?, ?, ?, 1, ?)",
                b,
                f.path(),
                LanguageDetector.detect(f.path()),
                f.after().getBytes(StandardCharsets.UTF_8).length,
                oid);
        jdbc.update("update projects set current_snapshot_id=? where id=?", b, f.project());
        return b;
    }

    private void inventory(Fixture f, String path, String oid, int size) {
        jdbc.update(
                "insert into files (snapshot_id,path,language,size,line_count,content_hash) values (?, ?, 'text', ?, 1, ?)",
                f.a(),
                path,
                size,
                oid);
    }

    private String insert(Fixture f, int type, byte[] bytes) throws Exception {
        try (Git git = Git.open(f.repoPath().toFile());
                var insert = git.getRepository().newObjectInserter()) {
            String oid = insert.insert(type, bytes).name();
            insert.flush();
            return oid;
        }
    }

    private void writeLooseObject(Fixture f, String oid, byte[] raw) throws Exception {
        ByteArrayOutputStream packed = new ByteArrayOutputStream();
        try (DeflaterOutputStream out = new DeflaterOutputStream(packed)) {
            out.write(raw);
        }
        Path object = f.repoPath().resolve(".git/objects/" + oid.substring(0, 2) + "/" + oid.substring(2));
        // JGit protects loose objects as read-only; only this disposable managed fixture is corrupted.
        assertThat(object.toFile().setWritable(true, true)).isTrue();
        Files.write(object, packed.toByteArray());
    }

    private Map<String, List<Map<String, Object>>> sentinelRows(long note, long task, long evidence) {
        Map<String, List<Map<String, Object>>> result = new LinkedHashMap<>();
        result.put("note", jdbc.queryForList("select * from notes where id=?", note));
        result.put(
                "note references",
                jdbc.queryForList("select * from note_references where note_id=? order by id", note));
        result.put("task", jdbc.queryForList("select * from tasks where id=?", task));
        result.put("task goals", jdbc.queryForList("select * from task_goals where task_id=? order by id", task));
        result.put(
                "learning records",
                jdbc.queryForList("select * from learning_records where task_id=? order by id", task));
        result.put("task evidence", jdbc.queryForList("select * from evidences where id=?", evidence));
        result.put(
                "evidence links",
                jdbc.queryForList("select * from evidence_links where evidence_id=? order by id", evidence));
        return result;
    }

    private void assertSentinels(Fixture f) {
        assertThat(sentinelRows(f.note(), f.task(), f.evidence()))
                .as("notes/tasks and linked row IDs, bodies, ownership, timestamps and targets")
                .isEqualTo(f.sentinels());
    }

    private static Map<String, String> treeState(Path directory) throws Exception {
        Map<String, String> result = new LinkedHashMap<>();
        try (var paths = Files.walk(directory)) {
            for (Path path : paths.sorted().toList()) {
                if (path.equals(directory)) continue;
                String value = Files.isSymbolicLink(path)
                        ? "link:" + Files.readSymbolicLink(path)
                        : Files.isDirectory(path)
                                ? "directory"
                                : "file:" + Base64.getEncoder().encodeToString(Files.readAllBytes(path));
                result.put(directory.relativize(path).toString(), value);
            }
        }
        return result;
    }

    private void assertSource(Fixture f, String expectedContent) throws Exception {
        Map<String, String> expected = new LinkedHashMap<>(f.sourceState());
        expected.put(
                f.path(),
                "file:" + Base64.getEncoder().encodeToString(expectedContent.getBytes(StandardCharsets.UTF_8)));
        assertThat(treeState(f.source()))
                .as("complete original source tree, including existing .git metadata")
                .isEqualTo(expected);
    }

    private int assertOldReadDuringRefresh(Fixture f) throws Exception {
        HttpResponse<String> response = http.send(
                HttpRequest.newBuilder(URI.create(BASE + sourceUrl(f, f.path(), f.a())))
                        .header("X-Code-Intelligence-Token", TOKEN)
                        .timeout(Duration.ofSeconds(30))
                        .GET()
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode())
                .as("concurrent source read: " + response.body())
                .isIn(200, 410);
        JsonNode body = json.readTree(response.body());
        if (response.statusCode() == 200) {
            assertThat(body.path("resolvedSnapshotId").asLong()).isEqualTo(f.a());
            assertThat(body.path("content").asString()).isEqualTo(f.before());
        } else {
            assertThat(body.path("code").asString()).isEqualTo("SOURCE_UNAVAILABLE");
            assertThat(body.has("content")).isFalse();
            assertThat(response.body()).doesNotContain("AAAA", "BBBB", "CCCC", "PPPP", "QQQQ");
        }
        return response.statusCode();
    }

    private void assertContent(Fixture f, long snapshot, String expected) throws Exception {
        JsonNode response = get(sourceUrl(f, f.path(), snapshot), 200);
        assertThat(response.path("resolvedSnapshotId").asLong()).isEqualTo(snapshot);
        assertThat(response.path("content").asString()).isEqualTo(expected);
    }

    private long current(long project) {
        return jdbc.queryForObject("select current_snapshot_id from projects where id=?", Long.class, project);
    }

    private void finish(long id) {
        await().atMost(Duration.ofSeconds(45))
                .pollInterval(Duration.ofMillis(100))
                .untilAsserted(() -> assertThat(
                                get("/api/jobs/" + id, 200).path("status").asString())
                        .isEqualTo("DONE"));
    }

    private static String encoded(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static String sourceUrl(Fixture f, String path, long snapshot) {
        return "/api/projects/" + f.project() + "/file-content?path=" + encoded(path) + "&snapshotId=" + snapshot;
    }

    private JsonNode get(String path, int status) throws Exception {
        return request("GET", path, null, true, status);
    }

    private JsonNode request(String method, String path, Object body, boolean authenticated, int expected)
            throws Exception {
        if (!method.equals("GET"))
            http.send(
                    HttpRequest.newBuilder(URI.create(BASE + "/api/csrf")).GET().build(),
                    HttpResponse.BodyHandlers.discarding());
        HttpRequest.Builder builder =
                HttpRequest.newBuilder(URI.create(BASE + path)).timeout(Duration.ofSeconds(30));
        if (authenticated) builder.header("X-Code-Intelligence-Token", TOKEN);
        if (body != null) builder.header("Content-Type", "application/json");
        cookies.getCookieStore().getCookies().stream()
                .filter(c -> c.getName().equals("XSRF-TOKEN"))
                .findFirst()
                .ifPresent(c -> builder.header("X-XSRF-TOKEN", c.getValue()));
        HttpResponse<String> response = (authenticated ? http : anonymousHttp)
                .send(
                        builder.method(
                                        method,
                                        body == null
                                                ? HttpRequest.BodyPublishers.noBody()
                                                : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                                .build(),
                        HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode())
                .as(method + " " + path + " " + response.body())
                .isEqualTo(expected);
        JsonNode parsed = response.body().isBlank() ? json.createObjectNode() : json.readTree(response.body());
        if (expected >= 400) {
            assertThat(parsed.has("content")).isFalse();
            assertThat(response.body())
                    .doesNotContain("AAAA", "BBBB", "CCCC", "PPPP", "QQQQ", "never-display-this-secret");
        }
        return parsed;
    }

    private void browser(Fixture f, Map<String, Object> extras) throws Exception {
        Map<String, Object> args = new LinkedHashMap<>(extras);
        args.put("baseUrl", BASE);
        args.put("token", TOKEN);
        args.put("project", f.project());
        args.put("a", f.a());
        args.put("path", f.path());
        args.put("before", f.before());
        args.put("after", f.after());
        args.put("sourceFile", f.source().resolve(f.path()).toString());
        args.put("feature", f.feature());
        args.put("evidence", f.evidence());
        args.put("note", f.note());
        args.put("legacyFlow", f.legacyFlow());
        Path input = Files.createTempFile(root, "browser-", ".json");
        Files.writeString(input, json.writeValueAsString(args));
        Path script = Path.of("../frontend/e2e/snapshot-source-real.cjs")
                .toAbsolutePath()
                .normalize();
        Process process = new ProcessBuilder("node", script.toString(), input.toString())
                .redirectErrorStream(true)
                .start();
        Path output = input.resolveSibling(input.getFileName() + ".log");
        Thread drain = Thread.ofVirtual().start(() -> {
            try (var stream = process.getInputStream()) {
                Files.copy(stream, output);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        boolean completed = process.waitFor(150, TimeUnit.SECONDS);
        if (!completed) process.destroyForcibly();
        drain.join(5000);
        String log = Files.readString(output);
        System.out.println(log);
        assertThat(completed).as("browser timeout").isTrue();
        assertThat(process.exitValue()).as(log).isZero();
    }

    private static int availablePort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private record Fixture(
            long project,
            long a,
            String path,
            String before,
            String after,
            Path source,
            Path repoPath,
            long feature,
            long evidence,
            long note,
            long task,
            long legacyFlow,
            Map<String, String> sourceState,
            Map<String, List<Map<String, Object>>> sentinels) {}
}
