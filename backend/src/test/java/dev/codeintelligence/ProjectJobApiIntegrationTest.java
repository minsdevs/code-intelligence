package dev.codeintelligence;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.testsupport.ControllableJobStep;
import dev.codeintelligence.testsupport.FakeGithubApi;
import dev.codeintelligence.testsupport.GitRepoFixtures;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.core.annotation.Order;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.EntityExchangeResult;
import org.springframework.test.web.servlet.client.RestTestClient;
import tools.jackson.databind.json.JsonMapper;

/**
 * End-to-end §1-2/§1-3 API surface over the real pipeline: IMPORT (JGit clone from a local bare
 * fixture, no network) → T_GATE (test-only controllable step) → FINALIZE.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@AutoConfigureRestTestClient
@Import(TestcontainersConfiguration.class)
class ProjectJobApiIntegrationTest {

    private static final Duration TIMEOUT = Duration.ofSeconds(20);
    private static final FakeGithubApi fakeGithub = new FakeGithubApi();

    @TempDir
    static Path root;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry) {
        registry.add("app.github.base-url", fakeGithub::baseUrl);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add(
                "app.github.clone-base-url",
                () -> originsRoot().toUri().toString().replaceAll("/+$", ""));
    }

    @AfterAll
    static void stopFakeGithub() {
        fakeGithub.close();
    }

    static Path originsRoot() {
        return root.resolve("origins");
    }

    static Path reposRoot() {
        return root.resolve("data").resolve("repos");
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class GatedPipelineConfig {

        @Bean
        @Order(5_000)
        ControllableJobStep gateStep() {
            return new ControllableJobStep("T_GATE");
        }
    }

    private record CreatedProject(long projectId, long jobId) {}

    private record SseEvent(String name, String data) {}

    @Autowired
    private RestTestClient restTestClient;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private JsonMapper jsonMapper;

    @Autowired
    private ControllableJobStep gateStep;

    @Autowired
    private Environment environment;

    @BeforeEach
    void resetGate() {
        gateStep.reset();
    }

    @Test
    void importPipelineClonesPromotesSnapshotAndRecordsSteps() throws Exception {
        ResponseCookie session = loginWithPat();
        String sha = GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "alpha1");

        CreatedProject created = createProject(session, "octocat", "alpha1");
        awaitJobDone(created.jobId());

        Map<String, Object> job = readJson(getAs(session, "/api/jobs/" + created.jobId(), HttpStatus.OK));
        assertThat(job.get("type")).isEqualTo("IMPORT");
        assertThat(job.get("status")).isEqualTo("DONE");
        assertThat(job.get("snapshotId")).isNotNull();
        assertThat(job.get("startedAt")).isNotNull();
        assertThat(job.get("finishedAt")).isNotNull();
        List<Map<String, Object>> steps = asList(job.get("steps"));
        assertThat(steps)
                .extracting(step -> step.get("stepKey"))
                .containsExactly(
                        "IMPORT",
                        "FILE_INVENTORY",
                        "LANGUAGE_FRAMEWORK",
                        "AREA_DETECTION",
                        "GIT_METADATA",
                        "SOURCE_PARSING",
                        "GRAPH_BUILD",
                        "EXTRACTION",
                        "T_GATE",
                        "FINALIZE");
        assertThat(steps).allSatisfy(step -> {
            assertThat(step.get("status")).isEqualTo("DONE");
            assertThat(step.get("attempt")).isEqualTo(1);
        });

        Map<String, Object> project = readJson(getAs(session, "/api/projects/" + created.projectId(), HttpStatus.OK));
        assertThat(project.get("repoOwner")).isEqualTo("octocat");
        assertThat(project.get("repoName")).isEqualTo("alpha1");
        assertThat(project.get("defaultBranch")).isEqualTo("main");
        Map<String, Object> snapshot = asMap(project.get("currentSnapshot"));
        assertThat(snapshot.get("commitSha")).isEqualTo(sha);
        assertThat(snapshot.get("status")).isEqualTo("READY");
        assertThat(asMap(project.get("latestJob")).get("status")).isEqualTo("DONE");

        Path clone = reposRoot().resolve(String.valueOf(created.projectId()));
        assertThat(clone.resolve(".git")).isDirectory();
        assertThat(clone.resolve("README.md")).exists();

        List<Map<String, Object>> projects = readJsonList(getAs(session, "/api/projects", HttpStatus.OK));
        assertThat(projects).anySatisfy(item -> {
            assertThat(((Number) item.get("id")).longValue()).isEqualTo(created.projectId());
            assertThat(asMap(item.get("currentSnapshot")).get("commitSha")).isEqualTo(sha);
            assertThat(item.get("selectedAreas")).isInstanceOf(List.class);
            assertThat(item.get("topTechnologies")).isInstanceOf(List.class);
            Map<String, Object> latestCommit = asMap(item.get("latestCommit"));
            assertThat(latestCommit.get("sha")).isEqualTo(sha);
            assertThat((String) latestCommit.get("message")).contains("initial commit");
            assertThat(item.containsKey("taskCount")).isFalse();
            assertThat(item.containsKey("noteCount")).isFalse();
        });
    }

    @Test
    void createAcceptsCanonicalGithubUrls() throws Exception {
        ResponseCookie session = loginWithPat();
        String sha = GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "via-url");

        Map<String, Object> json = readJson(postJson(
                session, "/api/projects", Map.of("url", "https://github.com/octocat/via-url"), HttpStatus.CREATED));
        Map<String, Object> project = asMap(json.get("project"));
        assertThat(project.get("repoOwner")).isEqualTo("octocat");
        assertThat(project.get("repoName")).isEqualTo("via-url");

        long jobId = ((Number) json.get("jobId")).longValue();
        awaitJobDone(jobId);
        long projectId = ((Number) project.get("id")).longValue();
        assertThat(currentSnapshotSha(session, projectId)).isEqualTo(sha);
    }

    @Test
    void duplicateImportForTheSameUserIsRejected() throws Exception {
        ResponseCookie session = loginWithPat();
        GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "dup1");
        CreatedProject created = createProject(session, "octocat", "dup1");
        awaitJobDone(created.jobId());

        postJson(session, "/api/projects", Map.of("repoOwner", "octocat", "repoName", "dup1"), HttpStatus.CONFLICT);
    }

    @Test
    void poisonedRepoInputsAreRejectedWithoutSideEffects() {
        ResponseCookie session = loginWithPat();
        Integer projectsBefore = jdbcTemplate.queryForObject("select count(*) from projects", Integer.class);
        Integer jobsBefore = jdbcTemplate.queryForObject("select count(*) from analysis_jobs", Integer.class);

        List<Map<String, String>> bodies = List.of(
                Map.of("repoOwner", "../x", "repoName", "demo"),
                Map.of("repoOwner", "octocat", "repoName", ".."),
                Map.of("repoOwner", "/etc/passwd", "repoName", "demo"),
                Map.of("url", "https://evil.com/octocat/demo"),
                Map.of("url", "git@github.com:octocat/demo.git"),
                Map.of("url", "ssh://git@github.com/octocat/demo"),
                Map.of("url", "https://github.com/octocat/demo", "repoOwner", "octocat", "repoName", "demo"),
                Map.of());
        for (Map<String, String> body : bodies) {
            postJson(session, "/api/projects", body, HttpStatus.BAD_REQUEST);
        }

        assertThat(jdbcTemplate.queryForObject("select count(*) from projects", Integer.class))
                .isEqualTo(projectsBefore);
        assertThat(jdbcTemplate.queryForObject("select count(*) from analysis_jobs", Integer.class))
                .isEqualTo(jobsBefore);
    }

    @Test
    void reanalyzeAdvancesTheSnapshotAndPrunesBeyondRetention() throws Exception {
        ResponseCookie session = loginWithPat();
        String sha1 = GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "re1");
        Path bare = originsRoot().resolve("octocat").resolve("re1.git");

        CreatedProject created = createProject(session, "octocat", "re1");
        awaitJobDone(created.jobId());
        assertThat(currentSnapshotSha(session, created.projectId())).isEqualTo(sha1);

        String sha2 = GitRepoFixtures.addCommit(bare, "second.txt", "second");
        long firstReanalyze = reanalyze(session, created.projectId());
        awaitJobDone(firstReanalyze);
        assertThat(currentSnapshotSha(session, created.projectId())).isEqualTo(sha2);

        String sha3 = GitRepoFixtures.addCommit(bare, "third.txt", "third");
        long secondReanalyze = reanalyze(session, created.projectId());
        awaitJobDone(secondReanalyze);

        Map<String, Object> project = readJson(getAs(session, "/api/projects/" + created.projectId(), HttpStatus.OK));
        assertThat(asMap(project.get("currentSnapshot")).get("commitSha")).isEqualTo(sha3);
        assertThat(asMap(project.get("latestJob")).get("type")).isEqualTo("REANALYZE");
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from snapshots where project_id = ?", Integer.class, created.projectId()))
                .as("retention keeps the two most recent snapshots")
                .isEqualTo(2);

        List<Map<String, Object>> jobs =
                readJsonList(getAs(session, "/api/projects/" + created.projectId() + "/jobs", HttpStatus.OK));
        assertThat(jobs).extracting(item -> item.get("type")).containsExactly("REANALYZE", "REANALYZE");
        List<Map<String, Object>> limited =
                readJsonList(getAs(session, "/api/projects/" + created.projectId() + "/jobs?limit=1", HttpStatus.OK));
        assertThat(limited).hasSize(1);
        assertThat(((Number) limited.getFirst().get("id")).longValue()).isEqualTo(secondReanalyze);
    }

    @Test
    void retryViaApiResumesFromTheFailedStep() throws Exception {
        ResponseCookie session = loginWithPat();
        GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "rt1");
        gateStep.failOnce();

        CreatedProject created = createProject(session, "octocat", "rt1");
        Awaitility.await().atMost(TIMEOUT).until(() -> "FAILED".equals(jobStatus(created.jobId())));

        Map<String, Object> failed = readJson(getAs(session, "/api/jobs/" + created.jobId(), HttpStatus.OK));
        assertThat((String) failed.get("error")).contains("T_GATE");
        List<Map<String, Object>> steps = asList(failed.get("steps"));
        assertThat(stepByKey(steps, "IMPORT").get("status")).isEqualTo("DONE");
        assertThat(stepByKey(steps, "T_GATE").get("status")).isEqualTo("FAILED");
        assertThat((String) stepByKey(steps, "T_GATE").get("error")).contains("simulated failure");
        assertThat(stepByKey(steps, "FINALIZE").get("status")).isEqualTo("PENDING");

        postEmpty(session, "/api/jobs/" + created.jobId() + "/retry", HttpStatus.ACCEPTED);
        awaitJobDone(created.jobId());

        List<Map<String, Object>> retried =
                asList(readJson(getAs(session, "/api/jobs/" + created.jobId(), HttpStatus.OK))
                        .get("steps"));
        assertThat(stepByKey(retried, "IMPORT").get("attempt"))
                .as("checkpoint: IMPORT must not run again")
                .isEqualTo(1);
        assertThat(stepByKey(retried, "T_GATE").get("attempt")).isEqualTo(2);
        assertThat(stepByKey(retried, "T_GATE").get("error")).isNull();
        assertThat(stepByKey(retried, "FINALIZE").get("attempt")).isEqualTo(1);
        assertThat(gateStep.runCount()).isEqualTo(2);

        Map<String, Object> project = readJson(getAs(session, "/api/projects/" + created.projectId(), HttpStatus.OK));
        assertThat(asMap(project.get("currentSnapshot")).get("status")).isEqualTo("READY");

        postEmpty(session, "/api/jobs/" + created.jobId() + "/retry", HttpStatus.CONFLICT);
    }

    @Test
    void cancelViaApiStopsAfterTheRunningStep() throws Exception {
        ResponseCookie session = loginWithPat();
        GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "cx1");
        gateStep.blockUntilReleased();

        CreatedProject created = createProject(session, "octocat", "cx1");
        awaitStepStatus(created.jobId(), "T_GATE", "RUNNING");

        postEmpty(session, "/api/jobs/" + created.jobId() + "/cancel", HttpStatus.ACCEPTED);
        gateStep.release();
        Awaitility.await()
                .atMost(TIMEOUT)
                .until(() -> "CANCELLED".equals(jobStatus(created.jobId()))
                        && "DONE".equals(stepStatus(created.jobId(), "T_GATE")));

        List<Map<String, Object>> steps = asList(readJson(getAs(session, "/api/jobs/" + created.jobId(), HttpStatus.OK))
                .get("steps"));
        assertThat(stepByKey(steps, "IMPORT").get("status")).isEqualTo("DONE");
        assertThat(stepByKey(steps, "T_GATE").get("status")).isEqualTo("DONE");
        assertThat(stepByKey(steps, "FINALIZE").get("status")).isEqualTo("PENDING");
        assertThat(jdbcTemplate.queryForObject(
                        "select current_snapshot_id from projects where id = ?", Long.class, created.projectId()))
                .as("cancelled run must not promote a snapshot")
                .isNull();

        postEmpty(session, "/api/jobs/" + created.jobId() + "/cancel", HttpStatus.CONFLICT);
        postEmpty(session, "/api/jobs/" + created.jobId() + "/retry", HttpStatus.CONFLICT);
    }

    @Test
    void deleteRemovesProjectRowsAndCloneDirectory() throws Exception {
        ResponseCookie session = loginWithPat();
        GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "del1");
        CreatedProject created = createProject(session, "octocat", "del1");
        awaitJobDone(created.jobId());
        Path clone = reposRoot().resolve(String.valueOf(created.projectId()));
        assertThat(clone).isDirectory();

        deleteAs(session, "/api/projects/" + created.projectId(), HttpStatus.NO_CONTENT);

        assertThat(clone).doesNotExist();
        getAs(session, "/api/projects/" + created.projectId(), HttpStatus.NOT_FOUND);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from analysis_jobs where project_id = ?", Integer.class, created.projectId()))
                .isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from snapshots where project_id = ?", Integer.class, created.projectId()))
                .isZero();
    }

    @Test
    void deleteWithAnActiveJobIsRejected() throws Exception {
        ResponseCookie session = loginWithPat();
        GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "del2");
        gateStep.blockUntilReleased();

        CreatedProject created = createProject(session, "octocat", "del2");
        awaitStepStatus(created.jobId(), "T_GATE", "RUNNING");

        deleteAs(session, "/api/projects/" + created.projectId(), HttpStatus.CONFLICT);

        postEmpty(session, "/api/jobs/" + created.jobId() + "/cancel", HttpStatus.ACCEPTED);
        gateStep.release();
        Awaitility.await().atMost(TIMEOUT).until(() -> "CANCELLED".equals(jobStatus(created.jobId())));
        deleteAs(session, "/api/projects/" + created.projectId(), HttpStatus.NO_CONTENT);
    }

    @Test
    void otherUsersProjectsAndJobsAreNotFound() throws Exception {
        ResponseCookie session = loginWithPat();
        Long foreignUser = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (31337, 'intruder') returning id", Long.class);
        Long foreignProject = jdbcTemplate.queryForObject(
                "insert into projects (user_id, name, repo_owner, repo_name) "
                        + "values (?, 'their-repo', 'them', 'their-repo') returning id",
                Long.class,
                foreignUser);
        Long foreignJob = jdbcTemplate.queryForObject(
                "insert into analysis_jobs (project_id, type, status) values (?, 'IMPORT', 'FAILED') returning id",
                Long.class,
                foreignProject);

        getAs(session, "/api/projects/" + foreignProject, HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + foreignProject + "/jobs", HttpStatus.NOT_FOUND);
        deleteAs(session, "/api/projects/" + foreignProject, HttpStatus.NOT_FOUND);
        postEmpty(session, "/api/projects/" + foreignProject + "/reanalyze", HttpStatus.NOT_FOUND);
        getAs(session, "/api/jobs/" + foreignJob, HttpStatus.NOT_FOUND);
        postEmpty(session, "/api/jobs/" + foreignJob + "/retry", HttpStatus.NOT_FOUND);
        postEmpty(session, "/api/jobs/" + foreignJob + "/cancel", HttpStatus.NOT_FOUND);
        assertThat(sseGet("/api/jobs/" + foreignJob + "/events", session.getValue())
                        .statusCode())
                .isEqualTo(404);
        getAs(session, "/api/jobs/999999", HttpStatus.NOT_FOUND);

        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from projects where id = ?", Integer.class, foreignProject))
                .isEqualTo(1);
    }

    @Test
    void unauthenticatedAndCsrfViolatingRequestsAreRejected() throws Exception {
        restTestClient.get().uri("/api/projects").exchange().expectStatus().isUnauthorized();
        restTestClient.get().uri("/api/jobs/1").exchange().expectStatus().isUnauthorized();
        assertThat(sseGet("/api/jobs/1/events", null).statusCode()).isEqualTo(401);

        ResponseCookie csrf = primeCsrfToken();
        restTestClient
                .post()
                .uri("/api/projects")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("repoOwner", "octocat", "repoName", "nope"))
                .exchange()
                .expectStatus()
                .isUnauthorized();

        ResponseCookie session = loginWithPat();
        restTestClient
                .post()
                .uri("/api/projects")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("SESSION", session.getValue())
                .body(Map.of("repoOwner", "octocat", "repoName", "nope"))
                .exchange()
                .expectStatus()
                .isForbidden();
    }

    @Test
    void sseSendsInitialSnapshotThenUpdatesUntilTerminal() throws Exception {
        ResponseCookie session = loginWithPat();
        GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "sse1");
        gateStep.blockUntilReleased();

        CreatedProject created = createProject(session, "octocat", "sse1");
        awaitStepStatus(created.jobId(), "T_GATE", "RUNNING");

        try (SseSession sse =
                new SseSession(serverUrl("/api/jobs/" + created.jobId() + "/events"), session.getValue())) {
            assertThat(sse.status()).isEqualTo(200);

            SseEvent first = sse.awaitEvent(event -> true);
            assertThat(first.name()).isEqualTo("snapshot");
            Map<String, Object> snapshot = readJson(first.data());
            assertThat(((Number) snapshot.get("id")).longValue()).isEqualTo(created.jobId());
            assertThat(snapshot.get("status")).isEqualTo("RUNNING");
            assertThat(asList(snapshot.get("steps"))).hasSize(10);

            gateStep.release();

            SseEvent done = sse.awaitEvent(event -> "update".equals(event.name())
                    && "DONE".equals(readJson(event.data()).get("status")));
            assertThat(asList(readJson(done.data()).get("steps")))
                    .allSatisfy(step -> assertThat(step.get("status")).isEqualTo("DONE"));
            assertThat(sse.awaitClosed(TIMEOUT))
                    .as("terminal update must complete the SSE connection")
                    .isTrue();
        }
        awaitJobDone(created.jobId());
    }

    @Test
    void sseOnAFinishedJobSendsTheSnapshotAndCompletesImmediately() throws Exception {
        ResponseCookie session = loginWithPat();
        GitRepoFixtures.createBareRepoWithCommit(originsRoot(), "octocat", "sse2");
        CreatedProject created = createProject(session, "octocat", "sse2");
        awaitJobDone(created.jobId());

        HttpResponse<String> response = sseGet("/api/jobs/" + created.jobId() + "/events", session.getValue());
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).contains("event:snapshot").contains("\"status\":\"DONE\"");
    }

    private CreatedProject createProject(ResponseCookie session, String owner, String name) {
        Map<String, Object> json = readJson(
                postJson(session, "/api/projects", Map.of("repoOwner", owner, "repoName", name), HttpStatus.CREATED));
        Map<String, Object> project = asMap(json.get("project"));
        return new CreatedProject(((Number) project.get("id")).longValue(), ((Number) json.get("jobId")).longValue());
    }

    private long reanalyze(ResponseCookie session, long projectId) {
        Map<String, Object> json =
                readJson(postEmpty(session, "/api/projects/" + projectId + "/reanalyze", HttpStatus.ACCEPTED));
        return ((Number) json.get("jobId")).longValue();
    }

    private String currentSnapshotSha(ResponseCookie session, long projectId) {
        Map<String, Object> project = readJson(getAs(session, "/api/projects/" + projectId, HttpStatus.OK));
        return (String) asMap(project.get("currentSnapshot")).get("commitSha");
    }

    private byte[] postJson(ResponseCookie session, String uri, Object body, HttpStatus expected) {
        ResponseCookie csrf = primeCsrfToken();
        return restTestClient
                .post()
                .uri(uri)
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(body)
                .exchange()
                .expectStatus()
                .isEqualTo(expected)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
    }

    private byte[] postEmpty(ResponseCookie session, String uri, HttpStatus expected) {
        ResponseCookie csrf = primeCsrfToken();
        return restTestClient
                .post()
                .uri(uri)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .exchange()
                .expectStatus()
                .isEqualTo(expected)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
    }

    private byte[] getAs(ResponseCookie session, String uri, HttpStatus expected) {
        return restTestClient
                .get()
                .uri(uri)
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isEqualTo(expected)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
    }

    private void deleteAs(ResponseCookie session, String uri, HttpStatus expected) {
        ResponseCookie csrf = primeCsrfToken();
        restTestClient
                .delete()
                .uri(uri)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .exchange()
                .expectStatus()
                .isEqualTo(expected);
    }

    private void awaitJobDone(long jobId) {
        Awaitility.await()
                .atMost(TIMEOUT)
                .until(() -> List.of("DONE", "FAILED", "CANCELLED").contains(jobStatus(jobId)));
        String status = jobStatus(jobId);
        if (!"DONE".equals(status)) {
            String error =
                    jdbcTemplate.queryForObject("select error from analysis_jobs where id = ?", String.class, jobId);
            Assertions.fail("job " + jobId + " ended " + status + " (error: " + error + ")");
        }
    }

    private static Map<String, Object> stepByKey(List<Map<String, Object>> steps, String stepKey) {
        return steps.stream()
                .filter(step -> stepKey.equals(step.get("stepKey")))
                .findFirst()
                .orElseThrow();
    }

    private String jobStatus(long jobId) {
        return jdbcTemplate.queryForObject("select status from analysis_jobs where id = ?", String.class, jobId);
    }

    private String stepStatus(long jobId, String stepKey) {
        return jdbcTemplate.queryForObject(
                "select status from analysis_job_steps where job_id = ? and step_key = ?",
                String.class,
                jobId,
                stepKey);
    }

    private void awaitStepStatus(long jobId, String stepKey, String expected) {
        Awaitility.await().atMost(TIMEOUT).until(() -> expected.equals(stepStatus(jobId, stepKey)));
    }

    private String serverUrl(String path) {
        return "http://127.0.0.1:" + environment.getProperty("local.server.port") + path;
    }

    private HttpResponse<String> sseGet(String path, String sessionValue) throws IOException, InterruptedException {
        HttpClient client = HttpClient.newHttpClient();
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(serverUrl(path)))
                    .timeout(TIMEOUT)
                    .header(HttpHeaders.ACCEPT, MediaType.TEXT_EVENT_STREAM_VALUE);
            if (sessionValue != null) {
                request.header(HttpHeaders.COOKIE, "SESSION=" + sessionValue);
            }
            return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        } finally {
            client.close();
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readJson(byte[] body) {
        return jsonMapper.readValue(body, Map.class);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readJson(String body) {
        return jsonMapper.readValue(body, Map.class);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> readJsonList(byte[] body) {
        return jsonMapper.readValue(body, List.class);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> asList(Object value) {
        return (List<Map<String, Object>>) value;
    }

    private ResponseCookie primeCsrfToken() {
        EntityExchangeResult<byte[]> result = restTestClient
                .get()
                .uri("/api/csrf")
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        ResponseCookie csrf = result.getResponseCookies().getFirst("XSRF-TOKEN");
        assertThat(csrf).isNotNull();
        return csrf;
    }

    private ResponseCookie loginWithPat() {
        ResponseCookie csrf = primeCsrfToken();
        EntityExchangeResult<byte[]> result = restTestClient
                .post()
                .uri("/api/auth/pat")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("token", FakeGithubApi.VALID_TOKEN))
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        ResponseCookie session = result.getResponseCookies().getFirst("SESSION");
        assertThat(session).isNotNull();
        return session;
    }

    /** Minimal SSE consumer over JDK HttpClient: parses {@code event:}/{@code data:} frames. */
    private final class SseSession implements AutoCloseable {

        private final HttpClient client = HttpClient.newHttpClient();
        private final HttpResponse<InputStream> response;
        private final List<SseEvent> events = new CopyOnWriteArrayList<>();
        private final CountDownLatch closed = new CountDownLatch(1);

        private SseSession(String url, String sessionValue) throws IOException, InterruptedException {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .header(HttpHeaders.ACCEPT, MediaType.TEXT_EVENT_STREAM_VALUE)
                    .header(HttpHeaders.COOKIE, "SESSION=" + sessionValue)
                    .GET()
                    .build();
            response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
            Thread.ofVirtual().name("sse-test-reader").start(this::readEvents);
        }

        int status() {
            return response.statusCode();
        }

        private void readEvents() {
            try (BufferedReader in =
                    new BufferedReader(new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
                String name = null;
                StringBuilder data = new StringBuilder();
                String line;
                while ((line = in.readLine()) != null) {
                    if (line.startsWith("event:")) {
                        name = line.substring("event:".length()).strip();
                    } else if (line.startsWith("data:")) {
                        data.append(line.substring("data:".length()).strip());
                    } else if (line.isEmpty() && name != null) {
                        events.add(new SseEvent(name, data.toString()));
                        name = null;
                        data.setLength(0);
                    }
                }
            } catch (IOException ignored) {
                // stream closed by the test or the server
            } finally {
                closed.countDown();
            }
        }

        SseEvent awaitEvent(Predicate<SseEvent> predicate) {
            Awaitility.await().atMost(TIMEOUT).until(() -> events.stream().anyMatch(predicate));
            return events.stream().filter(predicate).findFirst().orElseThrow();
        }

        boolean awaitClosed(Duration timeout) throws InterruptedException {
            return closed.await(timeout.toMillis(), TimeUnit.MILLISECONDS);
        }

        @Override
        public void close() {
            try {
                response.body().close();
            } catch (IOException ignored) {
                // already closed
            }
            client.close();
        }
    }
}
