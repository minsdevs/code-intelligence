package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.job.JobWorker;
import java.net.CookieManager;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Real HTTP, CSRF, serializers and PostgreSQL; dispatch is observed without running analysis. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.desktop.api-token=preview-fixture-token",
            "app.desktop.local-identity=preview-http-fixture",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url=",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.github.base-url=http://127.0.0.1:1"
        })
@Import(TestcontainersConfiguration.class)
class LocalPreviewApiIntegrationTest {
    private static final int PORT = port();
    private static final String BASE = "http://127.0.0.1:" + PORT;

    @TempDir
    static Path root;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    JsonMapper json;

    @Autowired
    LocalSourceApprovalService approvals;

    @Autowired
    LocalImportService imports;

    @MockitoBean
    JobWorker worker;

    private final CookieManager cookies = new CookieManager();
    private final HttpClient http =
            HttpClient.newBuilder().cookieHandler(cookies).build();

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("server.port", () -> PORT);
        registry.add("app.desktop.allowed-origin", () -> BASE);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add("app.local-import.allowed-roots", () -> root.toString());
    }

    @Test
    void initialApprovalIsOneUseAndOutcomeReturnsTheExactOwnedJob() throws Exception {
        Path source = source();
        JsonNode preview = post("/api/projects/local/preview", Map.of("path", source.toString()), 200);
        assertThat(preview.path("changes").path("total").asInt()).isEqualTo(1);
        assertThat(preview.path("snapshotId").isNull()).isTrue();
        assertThat(preview.path("localImport").path("acceptedFiles").asInt()).isEqualTo(1);
        assertThat(preview.toString()).doesNotContain(root.toString(), "manifestSha256", "rootIdentity", "rootOwner");
        String token = preview.path("previewToken").asString();
        assertThat(token).matches("[0-9a-f]{64}");
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where token_sha256=?", Long.class, token))
                .isZero();
        JsonNode created = post("/api/projects/local", Map.of("path", source.toString(), "previewToken", token), 201);
        long project = created.path("project").path("id").asLong();
        long job = created.path("jobId").asLong();
        assertThat(jdbc.queryForObject(
                        "select project_id from job_local_source_inputs where job_id=?", Long.class, job))
                .isEqualTo(project);
        verify(worker, times(1)).dispatch(job);
        JsonNode outcome = post("/api/projects/local/preview-outcome", Map.of("previewToken", token), 200);
        assertThat(outcome.path("state").asString()).isEqualTo("CONSUMED");
        assertThat(outcome.path("projectId").asLong()).isEqualTo(project);
        assertThat(outcome.path("jobId").asLong()).isEqualTo(job);
        assertCode(
                post("/api/projects/local", Map.of("path", source.toString(), "previewToken", token), 409),
                "LOCAL_PREVIEW_CONSUMED");
        request("PATCH", "/api/projects/" + project + "/local-source", Map.of("path", source().toString()), 409, true);
        verify(worker, times(1)).dispatch(job);
    }

    @Test
    void absentApprovalAndLegacyCountsCannotCreateLocalJobs() throws Exception {
        Path source = source();
        assertCode(post("/api/projects/local", Map.of("path", source.toString()), 409), "LOCAL_PREVIEW_INVALID");
        verifyNoInteractions(worker);
        JsonNode preview = post("/api/projects/local/preview", Map.of("path", source.toString()), 200);
        JsonNode created = post(
                "/api/projects/local",
                Map.of(
                        "path",
                        source.toString(),
                        "previewToken",
                        preview.path("previewToken").asString()),
                201);
        long project = created.path("project").path("id").asLong();
        long job = created.path("jobId").asLong();
        jdbc.update("update analysis_jobs set status='FAILED' where id=?", job);
        assertCode(
                post(
                        "/api/projects/" + project + "/reanalyze",
                        Map.of("snapshotId", 1, "added", 1, "modified", 0, "deleted", 0),
                        409),
                "LOCAL_PREVIEW_INVALID");
        JsonNode refresh = post("/api/projects/" + project + "/local-preview", Map.of(), 200);
        assertThat(refresh.path("operation").asString()).isEqualTo("REFRESH");
        assertThat(refresh.path("snapshotId").isNull()).isTrue();
        JsonNode restarted = post(
                "/api/projects/" + project + "/reanalyze",
                Map.of("previewToken", refresh.path("previewToken").asString()),
                202);
        assertThat(restarted.path("jobId").asLong()).isNotEqualTo(job);
        assertThat(jdbc.queryForObject("select count(*) from projects where id=?", Long.class, project))
                .isEqualTo(1);
    }

    @Test
    void abandoningAnUncertainApprovalRevokesItWithoutCreatingAnything() throws Exception {
        Path source = source();
        String token = post("/api/projects/local/preview", Map.of("path", source.toString()), 200)
                .path("previewToken")
                .asString();
        JsonNode outcome = post("/api/projects/local/preview-outcome", Map.of("previewToken", token), 200);
        assertThat(outcome.path("state").asString()).isEqualTo("ABANDONED");
        assertThat(outcome.path("jobId").isNull()).isTrue();
        assertCode(
                post("/api/projects/local", Map.of("path", source.toString(), "previewToken", token), 409),
                "LOCAL_PREVIEW_INVALID");
        assertThat(jdbc.queryForObject(
                        "select count(*) from projects where local_path=?", Long.class, source.toString()))
                .isZero();
        verifyNoInteractions(worker);
    }

    @Test
    void previewAndOutcomeRequireCsrfEvenWithDesktopAuthentication() throws Exception {
        Path source = source();
        request("POST", "/api/projects/local/preview", Map.of("path", source.toString()), 403, false);
        String token = post("/api/projects/local/preview", Map.of("path", source.toString()), 200)
                .path("previewToken")
                .asString();
        request("POST", "/api/projects/local/preview-outcome", Map.of("previewToken", token), 403, false);
        assertThat(jdbc.queryForObject(
                        "select revoked_at is null from local_source_approvals where token_sha256=?",
                        Boolean.class,
                        LocalSourceApprovalService.tokenHash(token)))
                .isTrue();
        verifyNoInteractions(worker);
    }

    @Test
    void expiryUsesASafeStructuredConflictAndDoesNotReflectTheTokenOrSource() throws Exception {
        Path source = source();
        String token = post("/api/projects/local/preview", Map.of("path", source.toString()), 200)
                .path("previewToken")
                .asString();
        jdbc.update(
                "update local_source_approvals set issued_at=issued_at-interval '11 minutes', expires_at=expires_at-interval '11 minutes' where token_sha256=?",
                LocalSourceApprovalService.tokenHash(token));
        JsonNode error = post("/api/projects/local", Map.of("path", source.toString(), "previewToken", token), 409);
        assertCode(error, "LOCAL_PREVIEW_EXPIRED");
        assertThat(error.toString()).doesNotContain(token, source.toString(), "class HttpFixture");
        verifyNoInteractions(worker);
    }

    // UX P4: the preview names languages, expected depth and top-level areas, and an optional scope
    // is bound to the approval so the confirmed import copies exactly the previewed scope.
    @Test
    void previewReportsLanguagesExpectedDepthAndTopLevelAreas() throws Exception {
        Path source = mixedSource();
        JsonNode preview = post("/api/projects/local/preview", Map.of("path", source.toString()), 200);

        assertThat(preview.path("languages").toString())
                .isEqualTo(json.readTree("""
                        [{"language":"java","files":2,"expectedDepth":"SYMBOLS_AND_CALLS"},
                         {"language":"gradle","files":1,"expectedDepth":"CONFIGURATION"},
                         {"language":"markdown","files":1,"expectedDepth":"INVENTORY_ONLY"},
                         {"language":"typescript","files":1,"expectedDepth":"INVENTORY_ONLY"}]""").toString());
        assertThat(preview.path("directories").toString())
                .isEqualTo(json.readTree("""
                        [{"name":".","files":1},{"name":"docs","files":1},{"name":"src","files":3}]""").toString());
        assertThat(preview.path("scope").isNull()).isTrue();
    }

    @Test
    void aScopedApprovalImportsExactlyTheApprovedScope() throws Exception {
        Path source = mixedSource();
        JsonNode preview = post(
                "/api/projects/local/preview",
                Map.of(
                        "path",
                        source.toString(),
                        "scope",
                        Map.of("directories", java.util.List.of("src", "src"), "languages", java.util.List.of("java"))),
                200);

        assertThat(preview.path("scope").toString())
                .isEqualTo("{\"directories\":[\"src\"],\"languages\":[\"java\"]}");
        assertThat(preview.path("localImport").path("acceptedFiles").asInt()).isEqualTo(2);
        // docs/ pruned once, build.gradle at the root, src/app.ts outside the language scope.
        assertThat(preview.path("localImport").path("excludedEntriesByReason").path("OUT_OF_SCOPE").asInt())
                .isEqualTo(3);
        assertThat(preview.path("changedPaths").toString())
                .isEqualTo("[\"A src/Main.java\",\"A src/nested/Util.java\"]");
        assertThat(preview.path("languages").toString())
                .isEqualTo("[{\"language\":\"java\",\"files\":2,\"expectedDepth\":\"SYMBOLS_AND_CALLS\"}]");

        JsonNode created = post(
                "/api/projects/local",
                Map.of("path", source.toString(), "previewToken", preview.path("previewToken").asString()),
                201);
        long project = created.path("project").path("id").asLong();
        long job = created.path("jobId").asLong();
        assertThat(jdbc.queryForObject("select scope from job_local_source_inputs where job_id=?", String.class, job))
                .isEqualTo("{\"directories\":[\"src\"],\"languages\":[\"java\"]}");
        jdbc.update("update analysis_jobs set status = 'RUNNING' where id = ?", job);
        Path target = root.resolve("data/repos/scoped-" + job);
        imports.importApproved(approvals.requireJobInput(job, project), target);
        try (var files = Files.walk(target)) {
            assertThat(files.filter(Files::isRegularFile)
                            .map(file -> target.relativize(file).toString())
                            .filter(path -> !path.startsWith(".git"))
                            .sorted()
                            .toList())
                    .containsExactly("src/Main.java", "src/nested/Util.java");
        }
        // A refresh of the project keeps the approved scope instead of widening to the whole root.
        jdbc.update("update analysis_jobs set status = 'DONE' where id = ?", job);
        JsonNode refresh = post("/api/projects/" + project + "/local-preview", Map.of(), 200);
        assertThat(refresh.path("scope").toString()).isEqualTo(preview.path("scope").toString());
        assertThat(refresh.path("localImport").path("acceptedFiles").asInt()).isEqualTo(2);
    }

    @Test
    void anUnsafeOrUnknownScopeIsRefusedBeforeAnyApproval() throws Exception {
        Path source = mixedSource();
        for (Object scope : java.util.List.of(
                Map.of("directories", java.util.List.of("..")),
                Map.of("directories", java.util.List.of("src/nested")),
                Map.of("languages", java.util.List.of("klingon")))) {
            post("/api/projects/local/preview", Map.of("path", source.toString(), "scope", scope), 400);
        }
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where canonical_root=?",
                        Long.class,
                        source.toRealPath().toString()))
                .isZero();
    }

    private Path mixedSource() throws Exception {
        Path source = Files.createDirectory(root.resolve("mixed-" + UUID.randomUUID()));
        Files.createDirectories(source.resolve("src/nested"));
        Files.createDirectories(source.resolve("docs"));
        Files.writeString(source.resolve("src/Main.java"), "class Main {}\n");
        Files.writeString(source.resolve("src/nested/Util.java"), "class Util {}\n");
        Files.writeString(source.resolve("src/app.ts"), "export const app = 1;\n");
        Files.writeString(source.resolve("docs/guide.md"), "# Guide\n");
        Files.writeString(source.resolve("build.gradle"), "plugins { id 'java' }\n");
        return source;
    }

    private Path source() throws Exception {
        Path source = Files.createDirectory(root.resolve("http-" + UUID.randomUUID()));
        Files.writeString(source.resolve("Fixture.java"), "class HttpFixture {}\n");
        return source;
    }

    private static void assertCode(JsonNode response, String code) {
        assertThat(response.path("code").asString()).isEqualTo(code);
    }

    private JsonNode post(String path, Object body, int status) throws Exception {
        return request("POST", path, body, status, true);
    }

    private JsonNode request(String method, String path, Object body, int status, boolean csrf) throws Exception {
        if (csrf)
            http.send(
                    HttpRequest.newBuilder(URI.create(BASE + "/api/csrf")).GET().build(),
                    HttpResponse.BodyHandlers.discarding());
        var builder = HttpRequest.newBuilder(URI.create(BASE + path))
                .timeout(Duration.ofSeconds(30))
                .header("X-Code-Intelligence-Token", "preview-fixture-token")
                .header("Content-Type", "application/json");
        if (csrf)
            cookies.getCookieStore().getCookies().stream()
                    .filter(c -> c.getName().equals("XSRF-TOKEN"))
                    .findFirst()
                    .ifPresent(c -> builder.header("X-XSRF-TOKEN", c.getValue()));
        var response = http.send(
                builder.method(method, HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode())
                .as(method + " " + path + " " + response.body())
                .isEqualTo(status);
        return response.body().isBlank() ? json.createObjectNode() : json.readTree(response.body());
    }

    private static int port() {
        try (var socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
    }
}
