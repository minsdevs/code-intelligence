package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.common.DesktopPrivateBootstrap;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigInteger;
import java.net.HttpCookie;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Shared C13 cost-egress harness: actual desktop HTTP/CSRF -> Java RequestPlan, approval store and
 * {@link AiCostLedger} on a disposable Testcontainers PostgreSQL -> private UDS -> real Node main
 * (lifecycle, journal, ai-desktop-gateway, ai-egress core, psql adapter, production catalog) -> a
 * call-counting fake provider transport ({@code desktop/test/fixtures/ai-cost-egress-runtime.cjs}).
 * OS safeStorage and the provider are synthetic. Every concrete class gets a fresh context, PostgreSQL,
 * installation identity, journal and main process. No Electron, Keychain or paid provider is used.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.desktop.api-token=public-synthetic-desktop-launch-token",
            "app.desktop.allowed-origin=http://127.0.0.1:43123",
            "app.desktop.ai-bootstrap-stdin=false",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.ai.openai.base-url=http://127.0.0.1:1",
            "app.ai.gemini.base-url=http://127.0.0.1:1",
            "app.github.base-url=http://127.0.0.1:1",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url="
        })
@Import({TestcontainersConfiguration.class, CostEgressHarness.RuntimeConfiguration.class})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Timeout(120)
abstract class CostEgressHarness {
    static final String LAUNCH_TOKEN = "public-synthetic-desktop-launch-token";
    static final String SYNTHETIC_KEY = "sk-publicSyntheticDesktopCostKey0123456789";
    static final String TOKEN_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    static final String SOURCE = "src/App.java";
    static final String SOURCE_TEXT = "class App { String value = \"approved-desktop-source\"; }\n";
    /** ceil((128000 * 0.15 + 2048 * 0.60) * 1.10) micro-USD with the pinned production catalog. */
    static final long RESERVATION = 22_472;
    /** ceil(60 * 0.15 + 40 * 0.075 + 50 * 0.60) micro-USD for the fake provider's default usage. */
    static final long ACTUAL = 42;

    @DynamicPropertySource
    static void freshInstallation(DynamicPropertyRegistry registry) {
        // Evaluated once per new application context: a fresh installation identity and root.
        String installation = UUID.randomUUID().toString();
        Path root = privateTemporaryDirectory();
        registry.add("app.desktop.local-identity", () -> installation);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
    }

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    JsonMapper json;

    @Autowired
    NodeRuntime runtime;

    @Autowired
    AiMainGatewayClient main;

    @Value("${local.server.port}")
    int port;

    @Value("${app.desktop.local-identity}")
    String installation;

    final HttpClient http =
            HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    long userId;

    @AfterAll
    void stopTheOwnedChildBeforeDeletingOnlyItsTemporaryFiles() throws Exception {
        Path root = runtime.root();
        runtime.close();
        try (var paths = Files.walk(root)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        }
    }

    // ---- desktop setup through the actual APIs ----

    Map<String, Object> saveSyntheticKey() throws Exception {
        Map<String, Object> settings = success(request(
                "PUT",
                "/api/ai/settings",
                Map.of("provider", "openai", "model", AiDesktopGateway.MODEL, "apiKey", SYNTHETIC_KEY)));
        assertThat(settings).containsEntry("state", "ENABLED").containsEntry("keySet", true);
        assertThat(json.writeValueAsString(settings)).doesNotContain(SYNTHETIC_KEY);
        return settings;
    }

    /** Saves the synthetic key, configures generous limits and activates; zero provider calls. */
    Map<String, Object> readyForRequests(String daily, String monthly) throws Exception {
        runtime.control(Map.of("mode", "success", "release", true));
        int before = runtime.events().size();
        Map<String, Object> initial = success(request("GET", "/api/ai/budget", null));
        assertThat(initial).containsEntry("available", true);
        userId = jdbc.queryForObject(
                "select id from users where identity_type='LOCAL' and local_key=?", Long.class, installation);
        saveSyntheticKey();
        Map<String, Object> ready = activate(configure(initial.get("policyRevision"), daily, monthly));
        assertThat(ready).containsEntry("state", "READY");
        assertThat(runtime.events()).hasSize(before);
        return ready;
    }

    Map<String, Object> configure(Object revision, String daily, String monthly) throws Exception {
        return success(request(
                "PUT",
                "/api/ai/budget",
                Map.of("expectedRevision", revision, "dailyLimitMicroUsd", daily, "monthlyLimitMicroUsd", monthly)));
    }

    Map<String, Object> activate(Map<String, Object> budget) throws Exception {
        assertThat(budget.get("activationToken")).asString().matches("[0-9a-f]{64}");
        return success(request(
                "POST",
                "/api/ai/budget/activate",
                Map.of(
                        "expectedRevision",
                        budget.get("policyRevision"),
                        "activationToken",
                        budget.get("activationToken"))));
    }

    /**
     * After a fail-closed outcome: the user's explicit path back. If main is not latched yet, saving the
     * same limits latches it (new policy revision); then one-use activation runs reconcile + activate.
     */
    Map<String, Object> reactivate() throws Exception {
        Map<String, Object> current = success(request("GET", "/api/ai/budget", null));
        if (current.get("activationToken") == null)
            current = configure(current.get("policyRevision"), (String) current.get("dailyLimitMicroUsd"), (String)
                    current.get("monthlyLimitMicroUsd"));
        return activate(current);
    }

    Money money() throws Exception {
        Map<String, Object> budget = success(request("GET", "/api/ai/budget", null));
        return new Money(
                Long.parseLong((String) budget.get("allDatesHeldMicroUsd")),
                Long.parseLong((String) budget.get("dailySettledMicroUsd")),
                Long.parseLong((String) budget.get("monthlySettledMicroUsd")),
                (String) budget.get("state"));
    }

    record Money(long held, long dailySettled, long monthlySettled, String state) {}

    // ---- requests ----

    Map<String, Object> askBody(String question, String focusedFile) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("question", question);
        value.put("intent", "EXPLAIN");
        value.put("view", "file");
        value.put("focusedFile", focusedFile);
        value.put("selectedAreas", List.of());
        value.put("excludedContextIds", List.of());
        return value;
    }

    Map<String, Object> defaultBody() {
        return askBody("Explain this approved desktop source file.", SOURCE);
    }

    Map<String, Object> prepare(Fixture fixture) throws Exception {
        return prepare(fixture, defaultBody());
    }

    Map<String, Object> prepare(Fixture fixture, Map<String, Object> body) throws Exception {
        return success(request("POST", route(fixture, "/request-plan"), body));
    }

    Reply ask(Fixture fixture, Map<String, Object> plan) throws Exception {
        return ask(fixture, plan, defaultBody());
    }

    Reply ask(Fixture fixture, Map<String, Object> plan, Map<String, Object> body) throws Exception {
        Map<String, Object> value = new LinkedHashMap<>(body);
        value.put("requestPlanToken", plan.get("requestPlanToken"));
        return request("POST", route(fixture, "/ask"), value);
    }

    String route(Fixture fixture, String suffix) {
        return "/api/projects/" + fixture.projectId() + "/ai" + suffix;
    }

    Reply request(String method, String route, Object body) throws Exception {
        return raw(method, route, body, true, !method.equals("GET"), null);
    }

    Reply raw(String method, String route, Object body, boolean authenticated, boolean csrf, String origin)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + route))
                .timeout(Duration.ofSeconds(40))
                .header("Accept", "application/json");
        if (authenticated) request.header("X-Code-Intelligence-Token", LAUNCH_TOKEN);
        if (origin != null) request.header("Origin", origin);
        if (csrf) {
            HttpResponse<String> token = http.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/csrf"))
                            .timeout(Duration.ofSeconds(10))
                            .GET()
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            assertThat(token.statusCode()).isEqualTo(204);
            String value = token.headers().allValues("set-cookie").stream()
                    .flatMap(header -> HttpCookie.parse(header).stream())
                    .filter(cookie -> cookie.getName().equals("XSRF-TOKEN"))
                    .findFirst()
                    .orElseThrow()
                    .getValue();
            request.header("Cookie", "XSRF-TOKEN=" + value).header("X-XSRF-TOKEN", value);
        }
        if (body == null) request.method(method, HttpRequest.BodyPublishers.noBody());
        else
            request.header("Content-Type", "application/json")
                    .method(
                            method,
                            HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body), StandardCharsets.UTF_8));
        HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
        return new Reply(response.statusCode(), response.body());
    }

    Map<String, Object> success(Reply reply) {
        assertThat(reply.status()).as("HTTP response: %s", reply.body()).isEqualTo(200);
        return read(reply.body());
    }

    void error(Reply reply, int status, String code) {
        assertThat(reply.status()).as("HTTP response: %s", reply.body()).isEqualTo(status);
        assertThat(read(reply.body())).containsEntry("code", code);
        assertThat(reply.body()).doesNotContain(SYNTHETIC_KEY, LAUNCH_TOKEN, TOKEN_KEY);
    }

    @SuppressWarnings("unchecked")
    Map<String, Object> read(String text) {
        return json.readValue(text, Map.class);
    }

    // ---- observations: fake provider, PostgreSQL and the main journal ----

    List<Map<String, Object>> eventsFor(Map<String, Object> plan) throws IOException {
        return eventsFor((String) plan.get("requestId"));
    }

    List<Map<String, Object>> eventsFor(String requestId) throws IOException {
        return runtime.events().stream()
                .filter(e -> requestId.equals(e.get("requestId")))
                .toList();
    }

    /** Exactly one provider invocation, issued only after PG DISPATCHED and the journal intent. */
    Map<String, Object> onlyDurablyIntendedEvent(Map<String, Object> plan) throws IOException {
        var events = eventsFor(plan);
        assertThat(events).hasSize(1);
        Map<String, Object> event = events.getFirst();
        assertThat(event)
                .containsEntry("ledgerStatusAtSend", "DISPATCHED")
                .containsEntry("evidenceCountAtSend", 0)
                .containsEntry("journalIntentAtSend", true)
                .containsEntry("credentialMatched", true)
                .containsEntry("method", "POST")
                .containsEntry("origin", "https://api.openai.com")
                .containsEntry("path", "/v1/chat/completions")
                .containsEntry("redirects", 0)
                .containsEntry("retries", 0)
                .containsEntry("timeoutMs", 60000)
                .containsEntry("maxResponseBytes", 2 * 1024 * 1024)
                .containsEntry("headerNames", List.of("Accept", "Authorization", "Content-Type"));
        assertThat(event.get("journalStatusAtSend")).isIn("RESERVED", "DISPATCHED");
        return event;
    }

    Map<String, Object> requestRow(Map<String, Object> plan) {
        return requestRow((String) plan.get("requestId"));
    }

    Map<String, Object> requestRow(String requestId) {
        return jdbc.queryForMap("select * from ai_request_ledger where request_id=?::uuid", requestId);
    }

    long requestCount(Map<String, Object> plan) {
        return jdbc.queryForObject(
                "select count(*) from ai_request_ledger where request_id=?::uuid", Long.class, plan.get("requestId"));
    }

    long ledgerRows() {
        return jdbc.queryForObject(
                "select count(*) from ai_request_ledger where installation_id=?", Long.class, installation);
    }

    long evidenceCount(Map<String, Object> plan) {
        return jdbc.queryForObject(
                "select count(*) from ai_usage_evidence where request_id=?::uuid", Long.class, plan.get("requestId"));
    }

    long messageCount(Fixture fixture) {
        return jdbc.queryForObject(
                "select count(*) from ai_messages m join ai_conversations c on c.id=m.conversation_id "
                        + "where c.project_id=?",
                Long.class,
                fixture.projectId());
    }

    long legacyUsageCount() {
        return jdbc.queryForObject("select count(*) from ai_usage_logs", Long.class);
    }

    /** Sum of every PG obligation: settled actual or the conservative held amount. */
    long pgLiability() {
        return jdbc.queryForObject("""
                select coalesce(sum(case when status='SETTLED' and not conflict then actual_micro_usd
                    else greatest(reserved_micro_usd, liability_floor_micro_usd) end), 0)
                from ai_request_ledger where installation_id=?
                """, Long.class, installation);
    }

    JsonNode journal() {
        return main.exchange("JOURNAL", Map.of("installationId", installation));
    }

    JsonNode journalRow(String requestId) {
        for (JsonNode row : journal().path("obligations"))
            if (requestId.equals(row.path("requestId").stringValue())) return row;
        return null;
    }

    boolean aiOff() {
        return main.exchange("STATUS", Map.of()).get("aiOff").asBoolean();
    }

    /** PG and the journal agree on one request's identity, state and integer microUSD amounts. */
    void assertObligation(String requestId, String status, long reserved, Long actual) {
        Map<String, Object> row = requestRow(requestId);
        assertThat(row)
                .containsEntry("status", status)
                .containsEntry("reserved_micro_usd", reserved)
                .containsEntry("actual_micro_usd", actual)
                .containsEntry("conflict", false);
        if (actual == null) assertThat(row.get("proof_sha256")).isNull();
        else assertThat(row.get("proof_sha256")).asString().matches("[0-9a-f]{64}");
        JsonNode journalRow = journalRow(requestId);
        assertThat(journalRow).as("journal obligation for %s", requestId).isNotNull();
        assertThat(journalRow.path("status").stringValue()).isEqualTo(status);
        assertThat(journalRow.path("reservedMicroUsd").stringValue()).isEqualTo(Long.toString(reserved));
        assertThat(journalRow.path("payloadSha256").stringValue()).isEqualTo(row.get("payload_sha256"));
        assertThat(journalRow.path("conflict").booleanValue()).isFalse();
        if (actual == null)
            assertThat(journalRow.path("actualMicroUsd").isNull()).isTrue();
        else {
            assertThat(journalRow.path("actualMicroUsd").stringValue()).isEqualTo(Long.toString(actual));
            assertThat(journalRow.path("proofSha256").stringValue()).isEqualTo(row.get("proof_sha256"));
        }
    }

    /** The journal's total obligation equals PG's, row by row and in sum. */
    void assertLedgerAgreement() {
        BigInteger journalTotal = BigInteger.ZERO;
        int journalRows = 0;
        for (JsonNode row : journal().path("obligations")) {
            journalRows++;
            boolean settled = "SETTLED".equals(row.path("status").stringValue())
                    && !row.path("conflict").booleanValue();
            BigInteger reserved = new BigInteger(row.path("reservedMicroUsd").stringValue());
            BigInteger floor = new BigInteger(row.path("liabilityFloorMicroUsd").stringValue());
            journalTotal = journalTotal.add(
                    settled ? new BigInteger(row.path("actualMicroUsd").stringValue()) : reserved.max(floor));
        }
        assertThat(journalRows).isEqualTo(ledgerRows());
        assertThat(journalTotal.longValueExact()).isEqualTo(pgLiability());
    }

    // ---- synthetic repository ----

    Fixture sourceFixture() throws Exception {
        return sourceFixture(Map.of(SOURCE, SOURCE_TEXT));
    }

    Fixture sourceFixture(Map<String, String> files) throws Exception {
        long projectId = jdbc.queryForObject("""
                insert into projects(user_id,name,repo_owner,repo_name)
                values (?,'desktop cost fixture','synthetic',?) returning id
                """, Long.class, userId, "cost-" + UUID.randomUUID());
        Path clone = runtime.root().resolve("data/repos").resolve(Long.toString(projectId));
        Map<String, String> oids = new LinkedHashMap<>();
        for (var file : files.entrySet()) {
            Path target = clone.resolve(file.getKey());
            Files.createDirectories(target.getParent());
            byte[] bytes = file.getValue().getBytes(StandardCharsets.UTF_8);
            Files.write(target, bytes);
            try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
                oids.put(
                        file.getKey(),
                        formatter.idFor(Constants.OBJ_BLOB, bytes).name());
            }
        }
        String commit;
        try (Git git = Git.init().setDirectory(clone.toFile()).call()) {
            git.add().addFilepattern(".").call();
            commit = git.commit()
                    .setMessage("public synthetic desktop source")
                    .setAuthor("Fixture", "fixture@example.invalid")
                    .setCommitter("Fixture", "fixture@example.invalid")
                    .call()
                    .name();
        }
        long snapshotId = jdbc.queryForObject("""
                insert into snapshots(project_id,commit_sha,status,analyzed_at)
                values (?,?,'READY',now()) returning id
                """, Long.class, projectId, commit);
        jdbc.update(
                "update projects set clone_path=?,current_snapshot_id=? where id=?",
                clone.toString(),
                snapshotId,
                projectId);
        for (var file : files.entrySet()) {
            String language = file.getKey().endsWith(".java") ? "java" : "yaml";
            jdbc.update(
                    "insert into files(snapshot_id,path,language,size,line_count,content_hash) values (?,?,?,?,?,?)",
                    snapshotId,
                    file.getKey(),
                    language,
                    file.getValue().getBytes(StandardCharsets.UTF_8).length,
                    (int) file.getValue().lines().count(),
                    oids.get(file.getKey()));
        }
        return new Fixture(projectId, snapshotId);
    }

    static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    static Path privateTemporaryDirectory() {
        try {
            Path directory =
                    Files.createTempDirectory(Path.of("/tmp"), "ci-c13-").toRealPath();
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
            return directory;
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot create the private cost-egress fixture", failure);
        }
    }

    record Fixture(long projectId, long snapshotId) {}

    record Reply(int status, String body) {}

    @TestConfiguration(proxyBeanMethods = false)
    static class RuntimeConfiguration {
        @Bean(destroyMethod = "close")
        NodeRuntime costEgressRuntime(PostgreSQLContainer postgres, JsonMapper json, Environment environment)
                throws Exception {
            String installation = environment.getRequiredProperty("app.desktop.local-identity");
            Path root = Path.of(environment.getRequiredProperty("app.data-dir")).getParent();
            boolean validationProvider = environment.getProperty("ci.c13.validation-provider", Boolean.class, false);
            return new NodeRuntime(postgres, json, installation, root, validationProvider);
        }

        @Bean
        @Primary
        DesktopPrivateBootstrap costEgressBootstrap(NodeRuntime runtime, JsonMapper json) {
            return new DesktopPrivateBootstrap(runtime.process.getInputStream(), json, Duration.ofSeconds(3));
        }
    }

    /** No inherited environment; config carries only this fresh test container's temporary login. */
    static final class NodeRuntime implements AutoCloseable {
        private final Path root;
        private final Path directory;
        private final JsonMapper json;
        private final Process process;
        private boolean closed;
        private boolean failClosedShutdown;
        private Integer exitStatus;
        private String closedRecord;

        NodeRuntime(
                PostgreSQLContainer postgres,
                JsonMapper json,
                String installation,
                Path root,
                boolean validationProvider)
                throws Exception {
            this.json = json;
            this.root = root;
            directory = Files.createDirectory(root.resolve("main"));
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
            assertThat(postgres.isRunning())
                    .as("Only the running disposable Testcontainer may be connected")
                    .isTrue();
            assertThat(postgres.getHost()).isIn("localhost", "127.0.0.1");
            var tls = postgres.execInContainer(
                    "sh",
                    "-ec",
                    "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=desktop-fixture "
                            + "-addext subjectAltName=IP:127.0.0.1 -keyout /tmp/desktop-fixture.key -out /tmp/desktop-fixture.crt "
                            + "2>/dev/null; chown postgres:postgres /tmp/desktop-fixture.key; chmod 600 /tmp/desktop-fixture.key; "
                            + "psql -v ON_ERROR_STOP=1 -U \"$1\" -d \"$2\" "
                            + "-c \"ALTER SYSTEM SET ssl_cert_file = '/tmp/desktop-fixture.crt'\" "
                            + "-c \"ALTER SYSTEM SET ssl_key_file = '/tmp/desktop-fixture.key'\" "
                            + "-c \"ALTER SYSTEM SET ssl = 'on'\" -c \"SELECT pg_reload_conf()\"",
                    "desktop-tls",
                    postgres.getUsername(),
                    postgres.getDatabaseName());
            assertThat(tls.getExitCode()).as("Owned test PostgreSQL TLS setup").isZero();
            org.awaitility.Awaitility.await()
                    .atMost(Duration.ofSeconds(10))
                    .until(() -> postgres.execInContainer(
                                    "psql",
                                    "-U",
                                    postgres.getUsername(),
                                    "-d",
                                    postgres.getDatabaseName(),
                                    "-Atc",
                                    "SHOW ssl")
                            .getStdout()
                            .trim()
                            .equals("on"));
            Path postgresRootCert = directory.resolve("postgres-root.crt");
            byte[] postgresCertificate =
                    postgres.copyFileFromContainer("/tmp/desktop-fixture.crt", input -> input.readAllBytes());
            Files.write(postgresRootCert, postgresCertificate);
            Files.setPosixFilePermissions(postgresRootCert, PosixFilePermissions.fromString("rw-------"));
            Path psql = executable(List.of(
                    "/opt/homebrew/bin/psql",
                    "/usr/local/bin/psql",
                    "/usr/lib/postgresql/16/bin/psql",
                    "/usr/bin/psql"));
            Path node = executable(List.of("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"));
            Path script = Path.of("../desktop/test/fixtures/ai-cost-egress-runtime.cjs")
                    .toRealPath();
            Path config = directory.resolve("config.json");
            Files.writeString(
                    config,
                    json.writeValueAsString(Map.of(
                            "installationId",
                            installation,
                            "psqlPath",
                            psql.toString(),
                            "postgresRootCert",
                            postgresRootCert.toString(),
                            "connection",
                            Map.of(
                                    "host",
                                    "127.0.0.1",
                                    "port",
                                    postgres.getMappedPort(5432),
                                    "user",
                                    postgres.getUsername(),
                                    "database",
                                    postgres.getDatabaseName()),
                            "databasePassword",
                            postgres.getPassword(),
                            "tokenEncryptionKey",
                            TOKEN_KEY,
                            "validationProvider",
                            validationProvider)),
                    StandardCharsets.UTF_8);
            Files.setPosixFilePermissions(config, PosixFilePermissions.fromString("rw-------"));
            control(Map.of("mode", "success", "release", true));
            ProcessBuilder builder = new ProcessBuilder(node.toString(), script.toString(), config.toString());
            builder.directory(directory.toFile());
            builder.environment().clear();
            builder.environment()
                    .putAll(Map.of(
                            "PATH",
                            "/usr/bin:/bin:/usr/sbin:/sbin",
                            "HOME",
                            directory.toString(),
                            "TMPDIR",
                            directory.toString(),
                            "LANG",
                            "C",
                            "TZ",
                            "UTC"));
            Path stderr = Files.createFile(directory.resolve("stderr.txt"));
            Files.setPosixFilePermissions(stderr, PosixFilePermissions.fromString("rw-------"));
            builder.redirectError(stderr.toFile());
            process = builder.start();
        }

        Path root() {
            return root;
        }

        /**
         * After a deliberate journal I/O fault the journal is poisoned for this process. Its shutdown is
         * then recorded, not required to report a clean close; the process must still exit.
         */
        synchronized void expectFailClosedShutdown() {
            failClosedShutdown = true;
        }

        Integer exitStatus() {
            return exitStatus;
        }

        String closedRecord() {
            return closedRecord;
        }

        private static Path executable(List<String> candidates) throws IOException {
            for (String candidate : candidates) {
                Path path = Path.of(candidate);
                if (Files.isRegularFile(path) && Files.isExecutable(path)) return path.toRealPath();
            }
            throw new IOException("A reviewed local Node/psql executable is required for this integration test");
        }

        synchronized void control(Map<String, Object> value) throws IOException {
            Path temporary = Files.createTempFile(directory, "control-", ".json");
            Files.writeString(temporary, json.writeValueAsString(value), StandardCharsets.UTF_8);
            Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"));
            Files.move(
                    temporary,
                    directory.resolve("control.json"),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        }

        List<Map<String, Object>> events() throws IOException {
            return lines("transports.jsonl");
        }

        /** Requests received by the loopback HTTP fake provider (validation-provider mode only). */
        List<Map<String, Object>> httpProviderRequests() throws IOException {
            return lines("http-provider.jsonl");
        }

        /** Non-provider requests to that port (stray local probes), answered 404 and kept for the record. */
        List<Map<String, Object>> httpStrayRequests() throws IOException {
            return lines("http-stray.jsonl");
        }

        List<Map<String, Object>> faults() throws IOException {
            return lines("faults.jsonl");
        }

        String stderr() throws IOException {
            return Files.readString(directory.resolve("stderr.txt"));
        }

        @SuppressWarnings("unchecked")
        private List<Map<String, Object>> lines(String name) throws IOException {
            Path path = directory.resolve(name);
            if (!Files.exists(path)) return List.of();
            String contents = Files.readString(path);
            List<Map<String, Object>> events = new ArrayList<>();
            // Only complete records count; the child may currently be appending its next record.
            int end = contents.lastIndexOf('\n');
            if (end >= 0)
                for (String line : contents.substring(0, end).split("\n")) events.add(json.readValue(line, Map.class));
            return events;
        }

        void awaitEvents(int count) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
            while (events().size() < count && System.nanoTime() < deadline) {
                assertThat(process.isAlive())
                        .as("Synthetic main process must remain alive")
                        .isTrue();
                Thread.sleep(20);
            }
            assertThat(events()).hasSize(count);
        }

        @Override
        public synchronized void close() throws Exception {
            if (closed) return;
            closed = true;
            if (process.isAlive()) {
                control(Map.of("mode", "success", "release", true));
                process.getOutputStream().close();
                if (!process.waitFor(20, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    process.waitFor(3, TimeUnit.SECONDS);
                    throw new AssertionError("Synthetic desktop main did not close after stdin EOF");
                }
            }
            exitStatus = process.exitValue();
            Path closedFile = directory.resolve("closed.json");
            closedRecord = Files.exists(closedFile) ? Files.readString(closedFile) : null;
            if (failClosedShutdown) return;
            assertThat(exitStatus).as("Synthetic main shutdown exit status").isZero();
            assertThat(closedRecord).isEqualTo("{\"closed\":true}");
            assertThat(Files.readString(directory.resolve("stderr.txt"))).isEmpty();
            try (var paths = Files.walk(directory.resolve("t"))) {
                assertThat(paths.filter(path -> !path.equals(directory.resolve("t")))
                                .toList())
                        .isEmpty();
            }
        }
    }
}
