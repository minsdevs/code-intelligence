package dev.codeintelligence.maintenance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.when;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.ai.AssistantService;
import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.job.JobWorker;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.session.Session;
import org.springframework.session.SessionRepository;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Explicit opt-in: real loopback HTTP/security/CSRF and disposable PostgreSQL/Redis. No provider,
 * original project data or external network is used. Run with CI_BACKUP_MAINTENANCE_PG=1.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.desktop.api-token=synthetic-maintenance-launch-token",
            "app.desktop.path-token=synthetic-maintenance-main-token",
            "app.desktop.local-identity=synthetic-maintenance-installation",
            "app.desktop.allowed-origin=http://127.0.0.1:4311"
        })
@Import(TestcontainersConfiguration.class)
@EnabledIfEnvironmentVariable(named = "CI_BACKUP_MAINTENANCE_PG", matches = "1")
@Timeout(30)
class MaintenanceApiIntegrationTest {
    private static final String LAUNCH = "synthetic-maintenance-launch-token";
    private static final String MAIN = "synthetic-maintenance-main-token";
    private static final String IDENTITY = "synthetic-maintenance-installation";

    @TempDir
    static Path directory;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry properties) {
        properties.add("app.data-dir", () -> directory.resolve("data").toString());
    }

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private JsonMapper json;

    @Autowired
    private MaintenanceGate gate;

    @Autowired
    private SessionRepository<?> sessions;

    @MockitoBean
    private AssistantService assistant;

    @MockitoBean
    private JobWorker jobWorker;

    @Value("${local.server.port}")
    private int port;

    private final HttpClient http =
            HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private UUID id;
    private long ownerId;

    @BeforeEach
    void prepareOnlySyntheticInstallation() throws Exception {
        reset(assistant, jobWorker);
        id = UUID.randomUUID();
        assertThat(get("/api/auth/me").statusCode()).isEqualTo(200);
        ownerId = jdbc.queryForObject("select id from users where local_key=?", Long.class, IDENTITY);
        jdbc.update("delete from projects where user_id=?", ownerId);
        jdbc.update("update users set github_id=null, identity_type='LOCAL' where id=?", ownerId);
    }

    @AfterEach
    void clearOnlyTheTestBarrier() {
        if (gate.active()) gate.end(gate.current(id), 0);
        http.close();
    }

    @Test
    void fixedControlIsCsrfExemptWhileOtherPostRoutesStillRequireCsrf() throws Exception {
        var begin = command("BEGIN");
        assertThat(begin.statusCode()).isEqualTo(200);
        JsonNode view = json.readTree(begin.body());
        assertThat(view.size()).isEqualTo(5);
        assertThat(view.get("transactionId").stringValue()).isEqualTo(id.toString());
        assertThat(view.get("state").stringValue()).isEqualTo("DRAINED");
        assertThat(command("BEGIN").body()).isEqualTo(begin.body());
        assertThat(post(commandBody(UUID.randomUUID(), "BEGIN"), MAIN, null, true)
                        .statusCode())
                .isEqualTo(409);
        assertThat(command("END").statusCode()).isEqualTo(200);
        assertThat(command("STATUS").statusCode()).isEqualTo(409);
        assertThat(postPath("/api/projects/1/ai/ask", "{}", null, null).statusCode())
                .isEqualTo(403);
        assertThat(postPath(MaintenanceController.PATH + "/other", "{}", MAIN, null)
                        .statusCode())
                .isEqualTo(403);
        assertThat(get("/api/auth/me").statusCode()).isEqualTo(200);
    }

    @Test
    void launchTokenAloneCannotActivateAndMalformedCommandsDoNotChangeState() throws Exception {
        assertThat(post(commandBody(id, "BEGIN"), null, null, true).statusCode())
                .isEqualTo(403);
        assertThat(post(commandBody(id, "BEGIN"), "wrong-main-token", null, true)
                        .statusCode())
                .isEqualTo(403);
        assertThat(post(commandBody(id, "BEGIN"), MAIN, null, false).statusCode())
                .isEqualTo(401);
        for (String invalid : new String[] {
            commandBody(id, "begin"),
            commandBody(id, "BEGIN").replace("}", ",\"extra\":true}"),
            commandBody(id, "BEGIN").replace("}", ",\"operation\":\"END\"}"),
            commandBody(id, "BEGIN").replace(id.toString(), "1-1-1-1-1")
        }) {
            assertThat(post(invalid, MAIN, null, true).statusCode()).isEqualTo(400);
            assertThat(gate.active()).isFalse();
        }
    }

    @Test
    void localLinkedOwnerRetainsControlButForeignInstallationAndPatPrincipalCannot() throws Exception {
        jdbc.update("update users set identity_type='LOCAL_LINKED', github_id=899001 where id=?", ownerId);
        assertThat(command("BEGIN").statusCode()).isEqualTo(200);
        assertThat(command("END").statusCode()).isEqualTo(200);

        Long foreign = jdbc.queryForObject("""
                insert into users(login,local_key,identity_type)
                values ('synthetic-foreign',?,'LOCAL_LINKED') returning id
                """, Long.class, "synthetic-foreign-" + id);
        try {
            String foreignCookie =
                    cookie(new AuthenticatedUser(foreign, null, "local", null, null, CredentialKind.LOCAL));
            assertThat(post(commandBody(id, "BEGIN"), MAIN, foreignCookie, false)
                            .statusCode())
                    .isEqualTo(403);
            String patCookie =
                    cookie(new AuthenticatedUser(ownerId, 899001L, "linked", null, null, CredentialKind.PAT));
            assertThat(post(commandBody(id, "BEGIN"), MAIN, patCookie, false).statusCode())
                    .isEqualTo(403);
            assertThat(gate.active()).isFalse();
        } finally {
            jdbc.update("delete from users where id=?", foreign);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"QUEUED", "RUNNING", "CANCELLING"})
    void realSqlActiveJobBlocksDrainEvenWithoutAnyWorkerLease(String status) throws Exception {
        Long project = jdbc.queryForObject("""
                insert into projects(user_id,name,repo_owner,repo_name)
                values (?,'synthetic-maintenance-project','synthetic','fixture') returning id
                """, Long.class, ownerId);
        Long job = jdbc.queryForObject("""
                insert into analysis_jobs(project_id,type,status) values (?,'IMPORT',?) returning id
                """, Long.class, project, status);
        var begin = json.readTree(command("BEGIN").body());
        assertThat(begin.get("state").stringValue()).isEqualTo("DRAINING");
        assertThat(begin.get("activeJobs").longValue()).isEqualTo(1);
        jdbc.update("update analysis_jobs set status='CANCELLED' where id=?", job);
        assertThat(json.readTree(command("STATUS").body()).get("state").stringValue())
                .isEqualTo("DRAINED");
    }

    @Test
    void authenticationCallbacksAndOrdinaryReadsAreStoppedWhileHealthAndControlRemainReachable() throws Exception {
        assertThat(command("BEGIN").statusCode()).isEqualTo(200);
        Long users = jdbc.queryForObject("select count(*) from users", Long.class);
        for (String path : new String[] {
            "/api/auth/me",
            "/api/auth/github/native/callback?code=synthetic&state=synthetic",
            "/login/oauth2/code/github?code=synthetic",
            "/oauth2/authorization/github",
            "/api/projects"
        }) {
            assertThat(get(path).statusCode()).as(path).isEqualTo(503);
        }
        assertThat(get("/actuator/health").statusCode()).isEqualTo(200);
        assertThat(command("STATUS").statusCode()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select count(*) from users", Long.class))
                .isEqualTo(users);
    }

    @Test
    void previouslyAdmittedSynchronousHttpPreventsDrainUntilItsWholeResponseCompletes() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        when(assistant.status(anyLong())).thenAnswer(invocation -> {
            entered.countDown();
            awaitLatch(release);
            return null;
        });
        var request =
                http.sendAsync(request("/api/ai/status", true).GET().build(), HttpResponse.BodyHandlers.ofString());
        try {
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
            var begin = json.readTree(command("BEGIN").body());
            assertThat(begin.get("state").stringValue()).isEqualTo("DRAINING");
            assertThat(begin.get("activeRequests").longValue()).isEqualTo(1);
            assertThat(get("/api/ai/status").statusCode()).isEqualTo(503);
        } finally {
            release.countDown();
        }
        assertThat(request.get(5, TimeUnit.SECONDS).statusCode()).isEqualTo(200);
        await().atMost(Duration.ofSeconds(5))
                .untilAsserted(() -> assertThat(json.readTree(command("STATUS").body())
                                .get("state")
                                .stringValue())
                        .isEqualTo("DRAINED"));
    }

    @Test
    void actualSseHttpReturnOrClientCancellationCannotReleaseTheRunningAiWriter() throws Exception {
        var csrfResponse = get("/api/csrf");
        String cookie = csrfResponse.headers().allValues("set-cookie").stream()
                .filter(value -> value.startsWith("XSRF-TOKEN="))
                .findFirst()
                .orElseThrow()
                .split(";", 2)[0];
        String csrf = cookie.substring("XSRF-TOKEN=".length());
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        when(assistant.ask(anyLong(), anyLong(), any())).thenAnswer(invocation -> {
            entered.countDown();
            awaitLatch(release);
            throw new IllegalStateException("synthetic provider stopped");
        });
        var call = http.sendAsync(
                request("/api/projects/1/ai/ask/stream", true)
                        .header("Content-Type", "application/json")
                        .header("Cookie", cookie)
                        .header("X-XSRF-TOKEN", csrf)
                        .POST(HttpRequest.BodyPublishers.ofString("{}"))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        try {
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(command("BEGIN").statusCode()).isEqualTo(200);
            call.cancel(true);
            await().atMost(Duration.ofSeconds(3)).untilAsserted(() -> {
                var status = json.readTree(command("STATUS").body());
                assertThat(status.get("activeRequests").longValue()).isZero();
                assertThat(status.get("activeWriters").longValue()).isEqualTo(1);
                assertThat(status.get("state").stringValue()).isEqualTo("DRAINING");
            });
        } finally {
            release.countDown();
        }
        await().atMost(Duration.ofSeconds(5))
                .untilAsserted(() -> assertThat(json.readTree(command("STATUS").body())
                                .get("state")
                                .stringValue())
                        .isEqualTo("DRAINED"));
    }

    private HttpResponse<String> command(String operation) throws Exception {
        return post(commandBody(id, operation), MAIN, null, true);
    }

    private static String commandBody(UUID id, String operation) {
        return "{\"transactionId\":\"" + id + "\",\"operation\":\"" + operation + "\"}";
    }

    private HttpResponse<String> get(String path) throws Exception {
        return http.send(request(path, true).GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(String body, String token, String cookie, boolean launch) throws Exception {
        var request = request(MaintenanceController.PATH, launch).header("Content-Type", "application/json");
        if (token != null) request.header(MaintenanceController.PATH_TOKEN_HEADER, token);
        if (cookie != null) request.header("Cookie", cookie);
        return http.send(
                request.POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> postPath(String path, String body, String token, String cookie) throws Exception {
        var request = request(path, true).header("Content-Type", "application/json");
        if (token != null) request.header(MaintenanceController.PATH_TOKEN_HEADER, token);
        if (cookie != null) request.header("Cookie", cookie);
        return http.send(
                request.POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpRequest.Builder request(String path, boolean launch) {
        var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(10));
        if (launch) builder.header("X-Code-Intelligence-Token", LAUNCH);
        return builder;
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private String cookie(AuthenticatedUser principal) {
        Session session = sessions.createSession();
        var context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(
                UsernamePasswordAuthenticationToken.authenticated(principal, null, principal.getAuthorities()));
        session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, context);
        ((SessionRepository) sessions).save(session);
        return "SESSION=" + Base64.getEncoder().encodeToString(session.getId().getBytes(StandardCharsets.UTF_8));
    }

    private static void awaitLatch(CountDownLatch latch) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) throw new AssertionError("synthetic HTTP latch timed out");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError("synthetic HTTP latch interrupted", error);
        }
    }
}
