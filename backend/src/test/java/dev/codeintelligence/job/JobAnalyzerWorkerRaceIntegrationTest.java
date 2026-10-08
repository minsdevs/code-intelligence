package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.FileService;
import dev.codeintelligence.testsupport.FakeGithubApi;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;
import tools.jackson.databind.json.JsonMapper;

/**
 * G-JOB worker races with the real TypeScript analyzer process (the production Nest module from
 * {@code analyzers/ts-analyzer/dist}) owned by this test: it is started with ProcessBuilder and
 * SIGKILLed only through its own {@link Process} handle, never by a looked-up PID. The backend
 * talks to it over a loopback byte relay that can withhold the analyze response, so the kill or
 * cancel lands while the request is in flight. Run by validation/pre-release/job-race-backend.cjs
 * --with-analyzer; skipped in the default suite where no analyzer build is supplied.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.tree-analyzer.base-url=",
            "logging.level.dev.codeintelligence.job.JobWorker=OFF"
        })
@AutoConfigureRestTestClient
@Import(TestcontainersConfiguration.class)
@EnabledIfSystemProperty(named = "job-race.ts-analyzer", matches = "/.+")
class JobAnalyzerWorkerRaceIntegrationTest {

    private static final Duration TIMEOUT = Duration.ofSeconds(120);
    private static final FakeGithubApi fakeGithub = new FakeGithubApi();
    private static final AtomicInteger UNIQUE = new AtomicInteger();
    private static AnalyzerRelay relay;
    private static OwnedAnalyzer analyzer;

    @TempDir
    static Path root;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) throws IOException {
        relay = new AnalyzerRelay();
        analyzer = OwnedAnalyzer.start(root);
        relay.target(analyzer.port());
        registry.add("app.github.base-url", fakeGithub::baseUrl);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add(
                "app.github.clone-base-url",
                () -> root.resolve("origins").toUri().toString().replaceAll("/+$", ""));
        registry.add("app.ts-analyzer.base-url", relay::url);
    }

    @AfterAll
    static void stopOwnedProcesses() throws Exception {
        fakeGithub.close();
        if (relay != null) relay.close();
        if (analyzer != null) analyzer.close();
    }

    record Analyzed(long projectId, long userId, String name, Path bare, long snapshotId) {}

    @Autowired
    private RestTestClient restTestClient;

    @Autowired
    private JsonMapper jsonMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private FileService files;

    // One PAT login per class: the real login endpoint is rate limited.
    private static RaceApi api;

    @BeforeEach
    void setUp() throws Exception {
        relay.disarm();
        if (!analyzer.alive()) {
            analyzer = OwnedAnalyzer.start(root);
            relay.target(analyzer.port());
        }
        if (api == null) api = new RaceApi(restTestClient, jsonMapper);
    }

    @AfterEach
    void tearDown() {
        relay.disarm();
    }

    /**
     * SIGKILL of the analyzer worker while its analyze request is in flight: the step fails with
     * a recorded per-file reason, nothing becomes current, the lock is released, and retry on a
     * new worker process completes from the TS_PARSING checkpoint.
     */
    @Test
    void analyzerKilledMidRequestFailsOnlyThatRunAndRetryRecoversOnANewWorker() throws Exception {
        Analyzed p = analyzedProject();
        Map<String, Object> before = fingerprint(p.snapshotId());
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.APP, app("v2-" + p.name())), "second");
        AnalyzerRelay.Hold hold = relay.arm();
        long job = api.reanalyze(p.projectId());
        hold.awaitRequest();
        boolean resultProduced = hold.responseArrived();
        int exit = analyzer.killForcibly();
        hold.decide(AnalyzerRelay.Decision.DROP);

        assertThat(exit).as("SIGKILL exit status of the owned analyzer").isEqualTo(128 + 9);
        assertThat(awaitTerminal(job)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("select failure_code from analysis_jobs where id=?", String.class, job))
                .isEqualTo("TS_ANALYZER_TRANSPORT_ERROR");
        assertThat(stepStatus(job, "TS_PARSING")).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("select error from analysis_jobs where id=?", String.class, job))
                .contains("TS_PARSING");
        Long staging = snapshotOf(job);
        assertThat(outcomeReasons(staging)).containsOnly("ANALYZER_REQUEST_FAILED");
        assertThat(snapshotStatus(staging)).isNotEqualTo("READY");
        assertThat(activeJobs(p.projectId())).isZero();
        assertThat(currentSnapshot(p.projectId())).isEqualTo(p.snapshotId());
        assertThat(fingerprint(p.snapshotId())).isEqualTo(before);
        assertThat(resultProduced)
                .as("no response byte was delivered before the kill")
                .isFalse();

        analyzer = OwnedAnalyzer.start(root);
        relay.target(analyzer.port());
        api.retry(job, HttpStatus.ACCEPTED);
        assertThat(awaitTerminal(job)).isEqualTo("DONE");
        assertThat(stepAttempt(job, "TS_PARSING")).isEqualTo(2);
        assertThat(stepAttempt(job, "SOURCE_PARSING")).isEqualTo(1);
        assertThat(currentSnapshot(p.projectId())).isEqualTo(staging);
        assertThat(outcomeReasons(staging)).doesNotContain("ANALYZER_REQUEST_FAILED");
        assertThat(source(p, p.snapshotId(), RaceRepos.APP)).contains("v1-" + p.name());
        assertThat(source(p, staging, RaceRepos.APP)).contains("v2-" + p.name());
    }

    /** The analyzer is gone before the request: fail fast, then a retry after restart succeeds. */
    @Test
    void analyzerDeadBeforeTheRequestFailsTheStepAndRetryAfterRestartSucceeds() throws Exception {
        Analyzed p = analyzedProject();
        Map<String, Object> before = fingerprint(p.snapshotId());
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.APP, app("v2-" + p.name())), "second");
        assertThat(analyzer.killForcibly()).isEqualTo(128 + 9);
        long job = api.reanalyze(p.projectId());
        assertThat(awaitTerminal(job)).isEqualTo("FAILED");
        assertThat(stepStatus(job, "TS_PARSING")).isEqualTo("FAILED");
        assertThat(outcomeReasons(snapshotOf(job))).containsOnly("ANALYZER_UNAVAILABLE");
        assertThat(currentSnapshot(p.projectId())).isEqualTo(p.snapshotId());
        assertThat(fingerprint(p.snapshotId())).isEqualTo(before);
        assertThat(activeJobs(p.projectId())).isZero();

        analyzer = OwnedAnalyzer.start(root);
        relay.target(analyzer.port());
        api.retry(job, HttpStatus.ACCEPTED);
        assertThat(awaitTerminal(job)).isEqualTo("DONE");
        assertThat(currentSnapshot(p.projectId())).isEqualTo(snapshotOf(job));
    }

    /**
     * T03 (05 §4): cancel aborts the in-flight analyzer request. The analyzer has produced its
     * result and the relay withholds it; the cancel interrupts the waiting request, the step ends
     * and the project is released within the 10 s bound instead of at the 30 s read timeout. The
     * withheld result delivered afterwards reaches neither the cancelled run's staging snapshot
     * nor the current result.
     */
    @Test
    void cancelAbortsTheInFlightAnalyzerRequestAndReleasesTheProjectWithinTheBound() throws Exception {
        Analyzed p = analyzedProject();
        Map<String, Object> before = fingerprint(p.snapshotId());
        UUID generation = currentGeneration(p.projectId());
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.APP, app("v2-" + p.name())), "second");
        AnalyzerRelay.Hold hold = relay.arm();
        long job = api.reanalyze(p.projectId());
        hold.awaitRequest();
        assertThat(hold.awaitResponse(60))
                .as("the analyzer produced its result")
                .isTrue();
        Long staging = snapshotOf(job);
        Map<String, Object> stagingAtCancel = fingerprint(staging);

        long requested = System.nanoTime();
        api.cancel(job, HttpStatus.ACCEPTED);
        long acknowledged = System.nanoTime();
        Awaitility.await()
                .atMost(Duration.ofSeconds(10))
                .pollInterval(Duration.ofMillis(50))
                .until(() -> "CANCELLED".equals(jobStatus(job)) && activeJobs(p.projectId()) == 0);
        System.out.printf(
                "T03 cancel during the analyzer request: ack %d ms, lock released %d ms after the request%n",
                Duration.ofNanos(acknowledged - requested).toMillis(),
                Duration.ofNanos(System.nanoTime() - requested).toMillis());
        assertThat(stepStatus(job, "TS_PARSING")).isEqualTo("FAILED");
        assertThat(stepError(job, "TS_PARSING")).isEqualTo("cancelled");
        assertThat(stepStatus(job, "TREE_PARSING")).isEqualTo("PENDING");
        assertThat(outcomeReasons(staging)).doesNotContain("ANALYZER_REQUEST_FAILED");

        hold.decide(AnalyzerRelay.Decision.DELIVER);
        assertThat(hold.awaitClosed(30)).isTrue();
        assertThat(hold.clientWriteFailed())
                .as("the aborted request's connection was already closed by the backend")
                .isTrue();
        assertThat(fingerprint(staging))
                .as("the withheld result reached nothing")
                .isEqualTo(stagingAtCancel);
        assertThat(snapshotStatus(staging)).isNotEqualTo("READY");
        assertThat(jobStatus(job)).isEqualTo("CANCELLED");
        assertThat(currentSnapshot(p.projectId())).isEqualTo(p.snapshotId());
        assertThat(currentGeneration(p.projectId())).isEqualTo(generation);
        assertThat(fingerprint(p.snapshotId())).isEqualTo(before);
        assertThat(activeJobs(p.projectId())).isZero();

        long next = api.reanalyze(p.projectId());
        assertThat(awaitTerminal(next)).isEqualTo("DONE");
        assertThat(currentSnapshot(p.projectId())).isEqualTo(snapshotOf(next));
        assertThat(source(p, snapshotOf(next), RaceRepos.APP)).contains("v2-" + p.name());
        assertThat(source(p, p.snapshotId(), RaceRepos.APP)).contains("v1-" + p.name());
    }

    /**
     * Fencing after a bounded cancel: the request is aborted at cancel, a newer run publishes, and
     * the old analyzer result released only then writes nothing and changes no job state.
     */
    @Test
    void aStaleAnalyzerResultAfterABoundedCancelAndANewerPublishWritesNothing() throws Exception {
        Analyzed p = analyzedProject();
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.APP, app("v2-" + p.name())), "second");
        AnalyzerRelay.Hold hold = relay.arm();
        long job = api.reanalyze(p.projectId());
        hold.awaitRequest();
        assertThat(hold.awaitResponse(60)).isTrue();
        api.cancel(job, HttpStatus.ACCEPTED);
        Awaitility.await()
                .atMost(Duration.ofSeconds(10))
                .pollInterval(Duration.ofMillis(50))
                .until(() -> "CANCELLED".equals(jobStatus(job)) && activeJobs(p.projectId()) == 0);
        assertThat(stepStatus(job, "TS_PARSING")).isEqualTo("FAILED");
        assertThat(currentSnapshot(p.projectId())).isEqualTo(p.snapshotId());

        long next = api.reanalyze(p.projectId());
        assertThat(awaitTerminal(next)).isEqualTo("DONE");
        long published = currentSnapshot(p.projectId());
        Map<String, Object> current = fingerprint(published);
        Map<String, Object> cancelled = fingerprint(snapshotOf(job));
        hold.decide(AnalyzerRelay.Decision.DELIVER);
        assertThat(hold.awaitClosed(30)).isTrue();
        assertThat(hold.clientWriteFailed())
                .as("the backend connection was already gone when the stale result was released")
                .isTrue();
        assertThat(fingerprint(published)).isEqualTo(current);
        assertThat(fingerprint(snapshotOf(job))).isEqualTo(cancelled);
        assertThat(jobStatus(job)).isEqualTo("CANCELLED");
        assertThat(jobStatus(next)).isEqualTo("DONE");
    }

    // ---------------------------------------------------------------- helpers

    private Analyzed analyzedProject() throws Exception {
        String name = "worker" + UNIQUE.incrementAndGet();
        Map<String, String> initial = new java.util.LinkedHashMap<>(RaceRepos.initialFiles("v1-" + name));
        initial.put(RaceRepos.APP, app("v1-" + name));
        Path bare = RaceRepos.create(root.resolve("origins"), "octocat", name, initial);
        RaceApi.Created created = api.createProject("octocat", name);
        assertThat(awaitTerminal(created.jobId())).isEqualTo("DONE");
        long userId = jdbc.queryForObject("select user_id from projects where id=?", Long.class, created.projectId());
        long snapshot = currentSnapshot(created.projectId());
        assertThat(outcomeReasons(snapshot)).doesNotContain("ANALYZER_REQUEST_FAILED", "ANALYZER_UNAVAILABLE");
        assertThat(count(
                        "select count(*) from graph_nodes where snapshot_id=? and natural_key like ?",
                        snapshot,
                        "%App.tsx%"))
                .as("the real analyzer contributed TypeScript facts")
                .isPositive();
        return new Analyzed(created.projectId(), userId, name, bare, snapshot);
    }

    private static String app(String marker) {
        return """
                export async function loadItems(): Promise<string> {
                  const response = await fetch('/api/items');
                  return response.text() + '%s';
                }
                export default function App() { return null; }
                """.formatted(marker);
    }

    private Map<String, Object> fingerprint(long snapshotId) {
        Map<String, Object> result = new TreeMap<>();
        for (String table : jdbc.queryForList(
                "select table_name from information_schema.columns where table_schema='public' "
                        + "and column_name='snapshot_id' order by table_name",
                String.class)) {
            result.put(table, count("select count(*) from " + table + " where snapshot_id=?", snapshotId));
        }
        result.put(
                "snapshot",
                jdbc.queryForMap("select status, commit_sha, analyzed_at from snapshots where id=?", snapshotId));
        result.put(
                "nodes",
                jdbc.queryForList(
                        "select natural_key from graph_nodes where snapshot_id=? order by natural_key",
                        String.class,
                        snapshotId));
        result.put(
                "outcomes",
                jdbc.queryForList(
                        "select path || ' ' || analysis_status || ' ' || coalesce(analysis_reason,'') from files "
                                + "where snapshot_id=? order by path",
                        String.class,
                        snapshotId));
        return result;
    }

    /** Per-file outcome reasons recorded for the TypeScript primary sources of a snapshot. */
    private Set<String> outcomeReasons(long snapshotId) {
        return new java.util.TreeSet<>(jdbc.queryForList(
                "select coalesce(analysis_reason, analysis_status) from files where snapshot_id=? "
                        + "and (path like '%.ts' or path like '%.tsx')",
                String.class, snapshotId));
    }

    private String source(Analyzed p, long snapshotId, String path) {
        return files.fileContent(p.projectId(), p.userId(), path, snapshotId).content();
    }

    private String awaitTerminal(long jobId) {
        Awaitility.await()
                .atMost(TIMEOUT)
                .until(() -> Set.of("DONE", "FAILED", "CANCELLED").contains(jobStatus(jobId)));
        return jobStatus(jobId);
    }

    private String jobStatus(long jobId) {
        return jdbc.queryForObject("select status from analysis_jobs where id=?", String.class, jobId);
    }

    private String stepStatus(long jobId, String step) {
        return jdbc.queryForObject(
                "select status from analysis_job_steps where job_id=? and step_key=?", String.class, jobId, step);
    }

    private String stepError(long jobId, String step) {
        return jdbc.queryForObject(
                "select error from analysis_job_steps where job_id=? and step_key=?", String.class, jobId, step);
    }

    private int stepAttempt(long jobId, String step) {
        return jdbc.queryForObject(
                "select attempt from analysis_job_steps where job_id=? and step_key=?", Integer.class, jobId, step);
    }

    private Long snapshotOf(long jobId) {
        return jdbc.queryForObject("select snapshot_id from analysis_jobs where id=?", Long.class, jobId);
    }

    private String snapshotStatus(long snapshotId) {
        return jdbc.queryForObject("select status from snapshots where id=?", String.class, snapshotId);
    }

    private long currentSnapshot(long projectId) {
        return jdbc.queryForObject("select current_snapshot_id from projects where id=?", Long.class, projectId);
    }

    private UUID currentGeneration(long projectId) {
        return jdbc.queryForObject("select current_generation_id from projects where id=?", UUID.class, projectId);
    }

    private long activeJobs(long projectId) {
        return count(
                "select count(*) from analysis_jobs where project_id=? and status in ('QUEUED','RUNNING','CANCELLING')",
                projectId);
    }

    private long count(String sql, Object... args) {
        Long value = jdbc.queryForObject(sql, Long.class, args);
        return value == null ? 0 : value;
    }

    /** The analyzer process this test started; only its own Process handle is ever signalled. */
    static final class OwnedAnalyzer implements AutoCloseable {
        private final Process process;
        private final int port;

        private OwnedAnalyzer(Process process, int port) {
            this.process = process;
            this.port = port;
        }

        static OwnedAnalyzer start(Path work) throws IOException {
            Path directory = Path.of(System.getProperty("job-race.ts-analyzer"));
            Path home = Files.createDirectories(work.resolve("analyzer-home"));
            ProcessBuilder builder = new ProcessBuilder(System.getProperty("job-race.node"), "accuracy-server.cjs")
                    .directory(directory.toFile())
                    .redirectError(ProcessBuilder.Redirect.appendTo(
                            work.resolve("analyzer.log").toFile()));
            Map<String, String> env = builder.environment();
            env.keySet().retainAll(Set.of("PATH", "LANG", "LC_ALL", "TMPDIR"));
            env.put("HOME", home.toString());
            Process process = builder.start();
            try {
                CompletableFuture<String> line = CompletableFuture.supplyAsync(() -> {
                    try {
                        return new BufferedReader(
                                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))
                                .readLine();
                    } catch (IOException e) {
                        return null;
                    }
                });
                String url = line.get(30, TimeUnit.SECONDS);
                if (url == null || !url.matches("http://127\\.0\\.0\\.1:[0-9]+")) {
                    throw new IllegalStateException("analyzer did not report a loopback URL");
                }
                return new OwnedAnalyzer(process, Integer.parseInt(url.substring(url.lastIndexOf(':') + 1)));
            } catch (Exception e) {
                process.destroyForcibly();
                throw new IllegalStateException("owned analyzer failed to start", e);
            }
        }

        int port() {
            return port;
        }

        boolean alive() {
            return process.isAlive();
        }

        /** SIGKILL through the owned handle; returns the observed exit status. */
        int killForcibly() throws InterruptedException {
            process.destroyForcibly();
            if (!process.waitFor(30, TimeUnit.SECONDS)) throw new IllegalStateException("owned analyzer survived");
            return process.exitValue();
        }

        @Override
        public void close() throws InterruptedException {
            if (!process.isAlive()) return;
            process.destroy();
            if (!process.waitFor(10, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                process.waitFor(10, TimeUnit.SECONDS);
            }
        }
    }
}
