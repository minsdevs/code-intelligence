package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.FileService;
import dev.codeintelligence.project.ProjectConflictException;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectService;
import dev.codeintelligence.testsupport.FakeGithubApi;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import javax.sql.DataSource;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;
import tools.jackson.databind.json.JsonMapper;

/**
 * G-JOB race matrix over the real 15-step pipeline, real PostgreSQL/Redis (Testcontainers), the
 * real HTTP job API and real JGit imports from local bare repositories. Deterministic latches sit
 * only around the real step bodies ({@link RaceStepGates}) and around the real Redis publish call
 * ({@link RacePublisher}); every database transition, guard and publication is product code. The
 * TypeScript/tree workers are disabled in this context (see JobAnalyzerWorkerRaceIntegrationTest).
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url=",
            "logging.level.dev.codeintelligence.job.JobWorker=OFF"
        })
@AutoConfigureRestTestClient
@Import(TestcontainersConfiguration.class)
class JobPipelineRaceIntegrationTest {

    /** The production pipeline order (asserted against the real beans below). */
    static final List<String> REAL_STEPS = List.of(
            "IMPORT",
            "FILE_INVENTORY",
            "LANGUAGE_FRAMEWORK",
            "AREA_DETECTION",
            "GIT_METADATA",
            "SOURCE_PARSING",
            "GRAPH_BUILD",
            "TS_PARSING",
            "TREE_PARSING",
            "EXTRACTION",
            "CROSS_DOMAIN",
            "FEATURE_DETECTION",
            "FLOW_DETECTION",
            "FINDING_DETECTION",
            "FINALIZE");

    private static final Duration TIMEOUT = Duration.ofSeconds(90);
    private static final FakeGithubApi fakeGithub = new FakeGithubApi();
    private static final AtomicInteger UNIQUE = new AtomicInteger();

    @TempDir
    static Path root;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.github.base-url", fakeGithub::baseUrl);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add(
                "app.github.clone-base-url",
                () -> root.resolve("origins").toUri().toString().replaceAll("/+$", ""));
    }

    @AfterAll
    static void stopFakeGithub() {
        fakeGithub.close();
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class RaceConfig {

        @Bean
        RaceStepGates raceStepGates() {
            return new RaceStepGates();
        }

        @Bean
        @Primary
        Pipeline racePipeline(List<JobStep> steps, RaceStepGates gates) {
            return new Pipeline(gates.wrap(steps));
        }

        @Bean
        @Primary
        RacePublisher racePublisher(JobRepository repository, StringRedisTemplate redis, JsonMapper json) {
            return new RacePublisher(repository, redis, json);
        }
    }

    record Analyzed(long projectId, long userId, String name, Path bare, long snapshotId) {}

    record Baseline(long snapshotId, UUID generation, Map<String, Object> fingerprint, long notes, long tasks) {}

    @Autowired
    private RestTestClient restTestClient;

    @Autowired
    private JsonMapper jsonMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private DataSource dataSource;

    @Autowired
    private RaceStepGates gates;

    @Autowired
    private RacePublisher publisher;

    @Autowired
    private Pipeline pipeline;

    @Autowired
    private JobService jobs;

    @Autowired
    private ProjectService projects;

    @Autowired
    private FileService files;

    @Autowired
    private org.springframework.core.env.Environment environment;

    // One PAT login per class: the real login endpoint is rate limited.
    private static RaceApi api;

    @BeforeEach
    void setUp() {
        gates.reset();
        publisher.reset();
        if (api == null) api = new RaceApi(restTestClient, jsonMapper);
    }

    @AfterEach
    void tearDown() {
        gates.reset();
        publisher.reset();
    }

    @Test
    void theMatrixEnumeratesEveryStepOfTheProductionPipeline() {
        assertThat(pipeline.stepsFor(JobType.REANALYZE))
                .extracting(JobStep::key)
                .containsExactlyElementsOf(REAL_STEPS);
        assertThat(pipeline.stepsFor(JobType.IMPORT)).extracting(JobStep::key).containsExactlyElementsOf(REAL_STEPS);
    }

    static Stream<Arguments> cancelPoints() {
        return REAL_STEPS.stream()
                .flatMap(step -> Stream.of(RaceStepGates.Point.values()).map(point -> Arguments.of(step, point)));
    }

    /**
     * Cancel while the real step row is RUNNING, either before its body starts or after its body
     * finished but before the checkpoint. A body that starts after the cancel stops at its first
     * cancellation checkpoint (T03; every step reports progress, which is one) and its row ends
     * FAILED with "cancelled"; the GitHub clone of IMPORT has no checkpoint and completes, and
     * FINALIZE refuses to publish a job that is no longer RUNNING. Exclusivity must hold until the
     * writer leaves, and nothing of the cancelled run may become current.
     */
    @ParameterizedTest(name = "cancel {1} of {0}")
    @MethodSource("cancelPoints")
    void cancelInsideEveryRealStepKeepsThePreviousResultAndReleasesTheProject(String step, RaceStepGates.Point point)
            throws Exception {
        Analyzed p = analyzedProject();
        Baseline before = baseline(p);
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.SERVICE, service("v2-" + p.name())), "second");
        RaceStepGates.Gate gate = gates.arm(step, point);
        long job = api.reanalyze(p.projectId());
        gate.awaitEntered();
        assertThat(gate.jobId()).isEqualTo(job);

        if (step.equals(FinalizeStep.KEY) && point == RaceStepGates.Point.AFTER_BODY) {
            // Publication, FINALIZE checkpoint and DONE committed together: completion has won.
            assertThat(stepStatus(job, step)).isEqualTo("DONE");
            assertThat(jobStatus(job)).isEqualTo("DONE");
            api.cancel(job, HttpStatus.CONFLICT);
            gate.release();
            assertThat(awaitTerminal(job)).isEqualTo("DONE");
            assertThat(currentSnapshot(p.projectId()))
                    .isEqualTo(snapshotOf(job))
                    .isNotEqualTo(before.snapshotId());
            assertThat(snapshotStatus(before.snapshotId())).isEqualTo("READY");
            assertThat(activeJobs(p.projectId())).isZero();
            return;
        }

        assertThat(stepStatus(job, step)).isEqualTo("RUNNING");
        api.cancel(job, HttpStatus.ACCEPTED);
        assertThat(jobStatus(job)).isEqualTo("CANCELLING");
        api.cancel(job, HttpStatus.CONFLICT);
        api.retry(job, HttpStatus.CONFLICT);
        api.reanalyzeRejected(p.projectId());
        api.delete(p.projectId(), HttpStatus.CONFLICT);
        assertThat(activeJobs(p.projectId()))
                .as("CANCELLING keeps the active-job lock")
                .isEqualTo(1);
        assertUnchanged(p, before);

        gate.release();
        assertThat(awaitTerminal(job)).isEqualTo("CANCELLED");
        if (point == RaceStepGates.Point.AFTER_BODY || step.equals("IMPORT")) {
            assertThat(stepStatus(job, step)).isEqualTo(step.equals(FinalizeStep.KEY) ? "FAILED" : "DONE");
        } else {
            assertThat(stepStatus(job, step)).as("the body observed the cancel").isEqualTo("FAILED");
            if (!step.equals(FinalizeStep.KEY)) assertThat(stepError(job, step)).isEqualTo("cancelled");
        }
        assertLaterStepsNeverRan(job, step);
        assertThat(activeJobs(p.projectId())).isZero();
        assertUnchanged(p, before);
        Long cancelled = snapshotOf(job);
        if (cancelled != null) {
            assertThat(cancelled).isNotEqualTo(before.snapshotId());
            assertThat(snapshotStatus(cancelled)).isNotEqualTo("READY");
        }
        api.retry(job, HttpStatus.CONFLICT);

        assertFreshAnalysisPublishes(p, before, "v2-" + p.name());
    }

    /**
     * T03 (05 §4): a cancel that lands inside the body of a long in-process step is observed by
     * that body at its next cancellation checkpoint. The body stops without persisting further
     * results, the worker leaves, and only then is the project released, within the 10 s bound
     * counted from the moment the parked worker may continue. Nothing the stopped worker owned can
     * change the cancelled job afterwards.
     */
    @ParameterizedTest(name = "cancel inside the body of {0}")
    @ValueSource(strings = {"SOURCE_PARSING", "GRAPH_BUILD"})
    void aCancelInsideALongInProcessStepIsObservedByItsBodyAndReleasesTheProjectWithinTheBound(String step)
            throws Exception {
        Analyzed p = analyzedProject();
        Baseline before = baseline(p);
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.SERVICE, service("v2-" + p.name())), "second");
        RacePublisher.Hold inside = publisher.holdInStepBody(p.projectId(), step);
        long job = api.reanalyze(p.projectId());
        inside.awaitParked();
        assertThat(inside.jobId()).isEqualTo(job);
        long staging = snapshotOf(job);
        long nodesAtCancel = count("select count(*) from graph_nodes where snapshot_id=?", staging);

        api.cancel(job, HttpStatus.ACCEPTED);
        assertThat(jobStatus(job)).isEqualTo("CANCELLING");
        assertThat(activeJobs(p.projectId()))
                .as("CANCELLING keeps the active-job lock")
                .isEqualTo(1);
        long released = System.nanoTime();
        inside.release();
        Awaitility.await()
                .atMost(Duration.ofSeconds(10))
                .pollInterval(Duration.ofMillis(50))
                .until(() -> "CANCELLED".equals(jobStatus(job)) && activeJobs(p.projectId()) == 0);
        Duration releaseTime = Duration.ofNanos(System.nanoTime() - released);
        System.out.printf(
                "T03 cancel inside %s: lock released %d ms after the worker resumed%n", step, releaseTime.toMillis());

        assertThat(stepStatus(job, step)).as("the body observed the cancel").isEqualTo("FAILED");
        assertThat(stepError(job, step)).isEqualTo("cancelled");
        assertThat(count("select count(*) from graph_nodes where snapshot_id=?", staging))
                .as("the stopped body persisted nothing after the cancel")
                .isEqualTo(nodesAtCancel);
        assertLaterStepsNeverRan(job, step);
        assertThat(inside.thread().join(Duration.ofSeconds(10)))
                .as("the worker thread has left")
                .isTrue();
        List<Map<String, Object>> stepsAfterExit = jdbc.queryForList(
                "select step_key, status, attempt, error from analysis_job_steps where job_id=? order by seq", job);
        assertThat(jobStatus(job)).isEqualTo("CANCELLED");
        assertThat(snapshotStatus(staging)).isNotEqualTo("READY");
        assertUnchanged(p, before);
        api.retry(job, HttpStatus.CONFLICT);

        assertFreshAnalysisPublishes(p, before, "v2-" + p.name());
        assertThat(jobStatus(job))
                .as("a later run cannot rewrite the cancelled job")
                .isEqualTo("CANCELLED");
        assertThat(jdbc.queryForList(
                        "select step_key, status, attempt, error from analysis_job_steps where job_id=? order by seq",
                        job))
                .isEqualTo(stepsAfterExit);
    }

    static Stream<String> realSteps() {
        return REAL_STEPS.stream();
    }

    /** A failure at any real step leaves the previous result current; retry resumes at that step. */
    @ParameterizedTest(name = "fail at {0}, then retry")
    @MethodSource("realSteps")
    void failureAtEveryRealStepKeepsThePreviousResultAndRetryResumesThere(String step) throws Exception {
        Analyzed p = analyzedProject();
        Baseline before = baseline(p);
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.SERVICE, service("v2-" + p.name())), "second");
        gates.failOnce(step);
        long job = api.reanalyze(p.projectId());
        assertThat(awaitTerminal(job)).isEqualTo("FAILED");
        assertThat(stepStatus(job, step)).isEqualTo("FAILED");
        assertLaterStepsNeverRan(job, step);
        assertThat(activeJobs(p.projectId())).isZero();
        assertUnchanged(p, before);

        api.retry(job, HttpStatus.ACCEPTED);
        assertThat(awaitTerminal(job)).isEqualTo("DONE");
        int failedIndex = REAL_STEPS.indexOf(step);
        for (int i = 0; i < REAL_STEPS.size(); i++) {
            assertThat(stepAttempt(job, REAL_STEPS.get(i)))
                    .as("checkpoint attempts for %s", REAL_STEPS.get(i))
                    .isEqualTo(i < failedIndex ? 1 : i == failedIndex ? 2 : 1);
        }
        long published = currentSnapshot(p.projectId());
        assertThat(published).isEqualTo(snapshotOf(job)).isNotEqualTo(before.snapshotId());
        assertThat(snapshotStatus(published)).isEqualTo("READY");
        assertThat(source(p, published)).contains("v2-" + p.name());
        assertThat(source(p, before.snapshotId())).contains("v1-" + p.name());
        assertThat(snapshotStatus(before.snapshotId())).isEqualTo("READY");
    }

    /**
     * B4 fencing: a worker that has already recorded FAILED may still be inside its final cleanup
     * when the user retries and then cancels the retried run. Only the worker that owns the
     * current run may complete its cancellation; otherwise the active-job lock is released while
     * the retried writer is still executing a step.
     */
    @Test
    void aFailedWorkerStillExitingCannotCompleteTheCancellationOfTheRetriedRun() throws Exception {
        Analyzed p = analyzedProject();
        Baseline before = baseline(p);
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.SERVICE, service("v2-" + p.name())), "second");
        RaceStepGates.Gate first = gates.arm("GIT_METADATA", RaceStepGates.Point.BEFORE_BODY);
        gates.failOnce("GIT_METADATA");
        long job = api.reanalyze(p.projectId());
        first.awaitEntered();
        RacePublisher.Hold exiting = publisher.holdFirst(job, JobStatus.FAILED);
        first.release();
        exiting.awaitParked();
        assertThat(jobStatus(job)).isEqualTo("FAILED");

        RaceStepGates.Gate resumed = gates.arm("GIT_METADATA", RaceStepGates.Point.BEFORE_BODY);
        api.retry(job, HttpStatus.ACCEPTED);
        resumed.awaitEntered();
        api.cancel(job, HttpStatus.ACCEPTED);
        assertThat(jobStatus(job)).isEqualTo("CANCELLING");

        exiting.release();
        assertThat(exiting.thread().join(Duration.ofSeconds(30)))
                .as("the first worker thread finished its cleanup")
                .isTrue();
        assertThat(jobStatus(job))
                .as("the retried writer is still inside GIT_METADATA")
                .isEqualTo("CANCELLING");
        assertThat(activeJobs(p.projectId())).isEqualTo(1);
        api.reanalyzeRejected(p.projectId());

        resumed.release();
        assertThat(awaitTerminal(job)).isEqualTo("CANCELLED");
        assertThat(activeJobs(p.projectId())).isZero();
        assertUnchanged(p, before);
        assertFreshAnalysisPublishes(p, before, "v2-" + p.name());
    }

    /**
     * Same window, framework-error path: if the exiting worker's last publish fails, its generic
     * error handler must not mark the retried (now RUNNING) run FAILED underneath its writer.
     */
    @Test
    void aFailedWorkerStillExitingCannotFailTheRetriedRunFromItsErrorHandler() throws Exception {
        Analyzed p = analyzedProject();
        Baseline before = baseline(p);
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.SERVICE, service("v2-" + p.name())), "second");
        RaceStepGates.Gate first = gates.arm("GIT_METADATA", RaceStepGates.Point.BEFORE_BODY);
        gates.failOnce("GIT_METADATA");
        long job = api.reanalyze(p.projectId());
        first.awaitEntered();
        RacePublisher.Hold exiting = publisher.holdFirst(job, JobStatus.FAILED);
        first.release();
        exiting.awaitParked();

        RaceStepGates.Gate resumed = gates.arm("GIT_METADATA", RaceStepGates.Point.BEFORE_BODY);
        api.retry(job, HttpStatus.ACCEPTED);
        resumed.awaitEntered();
        assertThat(jobStatus(job)).isEqualTo("RUNNING");

        exiting.releaseWithFailure();
        assertThat(exiting.thread().join(Duration.ofSeconds(30))).isTrue();
        assertThat(jobStatus(job))
                .as("the retried run still owns the job while its writer is inside GIT_METADATA")
                .isEqualTo("RUNNING");
        assertThat(activeJobs(p.projectId())).isEqualTo(1);

        resumed.release();
        assertThat(awaitTerminal(job)).isEqualTo("DONE");
        assertThat(currentSnapshot(p.projectId())).isEqualTo(snapshotOf(job)).isNotEqualTo(before.snapshotId());
        assertThat(source(p, before.snapshotId())).contains("v1-" + p.name());
        assertThat(activeJobs(p.projectId())).isZero();
    }

    /** A QUEUED job cancelled before its worker claims it never runs a step. */
    @Test
    void cancellingAQueuedJobBeforeItsWorkerClaimsItRunsNoStep() throws Exception {
        Analyzed p = analyzedProject();
        Baseline before = baseline(p);
        RacePublisher.Hold queued = publisher.holdFirstQueued(p.projectId());
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<Long> started = pool.submit(() -> api.reanalyze(p.projectId()));
            queued.awaitParked();
            long job = queued.jobId();
            assertThat(jobStatus(job)).isEqualTo("QUEUED");
            api.cancel(job, HttpStatus.ACCEPTED);
            assertThat(jobStatus(job)).isEqualTo("CANCELLED");
            queued.release();
            assertThat(started.get(30, TimeUnit.SECONDS)).isEqualTo(job);
            Awaitility.await().pollDelay(Duration.ofMillis(300)).atMost(TIMEOUT).until(() -> true);
            assertThat(jobStatus(job)).isEqualTo("CANCELLED");
            assertThat(jdbc.queryForObject(
                            "select count(*) from analysis_job_steps where job_id=? and (status<>'PENDING' or attempt<>0)",
                            Integer.class,
                            job))
                    .isZero();
            assertThat(snapshotOf(job)).isNull();
            assertThat(activeJobs(p.projectId())).isZero();
            assertUnchanged(p, before);
        } finally {
            queued.release();
            pool.shutdownNow();
        }
    }

    /**
     * Cancel racing the FINALIZE commit on the real job row lock. A third transaction holds the
     * row so both writers queue on it in a chosen order; exactly one outcome may result: either
     * published DONE with the cancel rejected, or CANCELLED with nothing published.
     */
    @ParameterizedTest(name = "{0} reaches the job row first")
    @ValueSource(strings = {"cancel", "finalize"})
    void cancelRacingTheFinalizeCommitHasExactlyOneOutcome(String first) throws Exception {
        Analyzed p = analyzedProject();
        Baseline before = baseline(p);
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.SERVICE, service("v2-" + p.name())), "second");
        RaceStepGates.Gate gate = gates.arm(FinalizeStep.KEY, RaceStepGates.Point.BEFORE_BODY);
        long job = api.reanalyze(p.projectId());
        gate.awaitEntered();
        ExecutorService pool = Executors.newSingleThreadExecutor();
        Future<Throwable> cancel = null;
        try (Connection lock = dataSource.getConnection()) {
            lock.setAutoCommit(false);
            try (PreparedStatement row = lock.prepareStatement("select id from analysis_jobs where id=? for update")) {
                row.setLong(1, job);
                row.executeQuery().close();
            }
            if (first.equals("cancel")) {
                cancel = pool.submit(() -> attempt(() -> jobs.cancel(job, p.userId())));
                awaitLockWaiters(1);
                gate.release();
                awaitLockWaiters(2);
            } else {
                gate.release();
                awaitLockWaiters(1);
                cancel = pool.submit(() -> attempt(() -> jobs.cancel(job, p.userId())));
                awaitLockWaiters(2);
            }
            lock.commit();
        } finally {
            gate.release();
        }
        Throwable cancelOutcome = cancel.get(60, TimeUnit.SECONDS);
        pool.shutdownNow();
        String terminal = awaitTerminal(job);
        if (first.equals("cancel")) {
            assertThat(cancelOutcome).isNull();
            assertThat(terminal).isEqualTo("CANCELLED");
            assertThat(stepStatus(job, FinalizeStep.KEY)).isEqualTo("FAILED");
            assertUnchanged(p, before);
            assertThat(snapshotStatus(snapshotOf(job))).isNotEqualTo("READY");
        } else {
            assertThat(cancelOutcome).isInstanceOf(JobConflictException.class);
            assertThat(terminal).isEqualTo("DONE");
            assertThat(currentSnapshot(p.projectId())).isEqualTo(snapshotOf(job));
            assertThat(snapshotStatus(snapshotOf(job))).isEqualTo("READY");
            assertThat(snapshotStatus(before.snapshotId())).isEqualTo("READY");
            assertThat(fingerprint(before.snapshotId()))
                    .as("the previous snapshot stays intact as history")
                    .isEqualTo(before.fingerprint());
        }
        assertThat(activeJobs(p.projectId())).isZero();
    }

    /** Project delete and a new analysis serialize on the project row in either order. */
    @ParameterizedTest(name = "{0} reaches the project row first")
    @ValueSource(strings = {"delete", "reanalyze"})
    void projectDeleteRacingANewAnalysisNeverLeavesAnOrphanOrDeletesAnActiveProject(String first) throws Exception {
        Analyzed p = analyzedProject();
        Path clone = root.resolve("data").resolve("repos").resolve(String.valueOf(p.projectId()));
        assertThat(clone).isDirectory();
        RaceStepGates.Gate gate = gates.arm("IMPORT", RaceStepGates.Point.BEFORE_BODY);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Future<Throwable> deletion;
        Future<Throwable> analysis;
        try (Connection lock = dataSource.getConnection()) {
            lock.setAutoCommit(false);
            try (PreparedStatement row = lock.prepareStatement("select id from projects where id=? for update")) {
                row.setLong(1, p.projectId());
                row.executeQuery().close();
            }
            if (first.equals("delete")) {
                deletion = pool.submit(() -> attempt(() -> projects.delete(p.projectId(), p.userId())));
                awaitLockWaiters(1);
                analysis = pool.submit(() -> attempt(() -> projects.reanalyze(p.projectId(), p.userId(), null)));
            } else {
                analysis = pool.submit(() -> attempt(() -> projects.reanalyze(p.projectId(), p.userId(), null)));
                awaitLockWaiters(1);
                deletion = pool.submit(() -> attempt(() -> projects.delete(p.projectId(), p.userId())));
            }
            awaitLockWaiters(2);
            lock.commit();
        }
        Throwable deleted = deletion.get(60, TimeUnit.SECONDS);
        Throwable analyzed = analysis.get(60, TimeUnit.SECONDS);
        pool.shutdownNow();
        if (first.equals("delete")) {
            gate.release();
            assertThat(deleted).isNull();
            assertThat(analyzed).isInstanceOf(ProjectNotFoundException.class);
            assertThat(count("select count(*) from projects where id=?", p.projectId()))
                    .isZero();
            assertThat(count("select count(*) from analysis_jobs where project_id=?", p.projectId()))
                    .isZero();
            assertThat(count("select count(*) from snapshots where project_id=?", p.projectId()))
                    .isZero();
            Awaitility.await().atMost(TIMEOUT).until(() -> !clone.toFile().exists());
        } else {
            assertThat(analyzed).isNull();
            assertThat(deleted).isInstanceOf(ProjectConflictException.class);
            gate.awaitEntered();
            long job = gate.jobId();
            assertThat(activeJobs(p.projectId())).isEqualTo(1);
            gate.release();
            assertThat(awaitTerminal(job)).isEqualTo("DONE");
            assertThat(count("select count(*) from projects where id=?", p.projectId()))
                    .isEqualTo(1);
            api.delete(p.projectId(), HttpStatus.NO_CONTENT);
            Awaitility.await().atMost(TIMEOUT).until(() -> !clone.toFile().exists());
        }
    }

    /** Duplicate starts: concurrent new analyses, and a retry racing a new analysis, admit one. */
    @Test
    void concurrentStartsAndRetryVersusNewAnalysisAdmitExactlyOneWriter() throws Exception {
        Analyzed p = analyzedProject();
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.SERVICE, service("v2-" + p.name())), "second");
        RaceStepGates.Gate gate = gates.arm("IMPORT", RaceStepGates.Point.BEFORE_BODY);
        ExecutorService pool = Executors.newFixedThreadPool(4);
        List<Future<Throwable>> starts = new ArrayList<>();
        try {
            for (int i = 0; i < 4; i++) {
                starts.add(pool.submit(() -> attempt(() -> projects.reanalyze(p.projectId(), p.userId(), null))));
            }
            int accepted = 0;
            for (Future<Throwable> start : starts) {
                Throwable outcome = start.get(60, TimeUnit.SECONDS);
                if (outcome == null) accepted++;
                else assertThat(outcome).isInstanceOf(JobConflictException.class);
            }
            assertThat(accepted).isEqualTo(1);
            gate.awaitEntered();
            assertThat(activeJobs(p.projectId())).isEqualTo(1);
            gate.release();
            assertThat(awaitTerminal(gate.jobId())).isEqualTo("DONE");

            gates.failOnce("FINDING_DETECTION");
            long failed = api.reanalyze(p.projectId());
            assertThat(awaitTerminal(failed)).isEqualTo("FAILED");
            RaceStepGates.Gate racing = gates.arm("FINDING_DETECTION", RaceStepGates.Point.BEFORE_BODY);
            RaceStepGates.Gate fresh = gates.arm("IMPORT", RaceStepGates.Point.BEFORE_BODY);
            Future<Throwable> retry = pool.submit(() -> attempt(() -> jobs.retry(failed, p.userId())));
            Future<Throwable> start =
                    pool.submit(() -> attempt(() -> projects.reanalyze(p.projectId(), p.userId(), null)));
            Throwable retried = retry.get(60, TimeUnit.SECONDS);
            Throwable started = start.get(60, TimeUnit.SECONDS);
            assertThat(retried == null ^ started == null)
                    .as("exactly one of retry/new analysis wins (retry=%s, start=%s)", retried, started)
                    .isTrue();
            assertThat(retried == null ? started : retried).isInstanceOf(JobConflictException.class);
            assertThat(activeJobs(p.projectId())).isEqualTo(1);
            RaceStepGates.Gate winner = retried == null ? racing : fresh;
            winner.awaitEntered();
            racing.release();
            fresh.release();
            assertThat(awaitTerminal(winner.jobId())).isEqualTo("DONE");
            assertThat(activeJobs(p.projectId())).isZero();
            assertThat(currentSnapshot(p.projectId())).isEqualTo(snapshotOf(winner.jobId()));
        } finally {
            gates.reset();
            pool.shutdownNow();
        }
    }

    /**
     * C07 substitute (incremental analysis is out of scope): full re-analysis of the same commit is
     * equivalent, a source change retracts a removed relation only from the new snapshot, and a
     * manifest-only change keeps the source graph while the old snapshot keeps its own facts.
     */
    @Test
    void fullReanalysisIsEquivalentForTheSameSnapshotAndRetractsRemovedRelations() throws Exception {
        Analyzed p = analyzedProject();
        long first = p.snapshotId();
        long same = analyzeAgain(p);
        assertThat(semantic(same)).isEqualTo(semantic(first));

        Set<String> callsBefore = edges(same, "ItemController", "ItemService");
        assertThat(callsBefore).as("fixture relation controller -> service").isNotEmpty();
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.CONTROLLER, """
                        package demo;

                        import org.springframework.web.bind.annotation.GetMapping;
                        import org.springframework.web.bind.annotation.RestController;

                        @RestController
                        public class ItemController {
                            @GetMapping("/api/items")
                            public String items() {
                                return "static";
                            }
                        }
                        """), "drop the service call");
        long changed = analyzeAgain(p);
        assertThat(edges(changed, "ItemController", "ItemService")).isEmpty();
        assertThat(edges(same, "ItemController", "ItemService")).isEqualTo(callsBefore);

        Map<String, Object> sourceGraph = semantic(changed);
        RaceRepos.commit(p.bare(), Map.of("package.json", """
                        {"name":"race-web","version":"1.0.0","dependencies":{"react":"18.2.0","react-dom":"18.2.0","axios":"1.7.2"}}
                        """), "manifest only");
        long manifest = analyzeAgain(p);
        Map<String, Object> afterManifest = semantic(manifest);
        assertThat(afterManifest.get("sourceNodes")).isEqualTo(sourceGraph.get("sourceNodes"));
        assertThat(afterManifest.get("sourceEdges")).isEqualTo(sourceGraph.get("sourceEdges"));
        assertThat(fileHash(manifest, "package.json")).isNotEqualTo(fileHash(changed, "package.json"));
        assertThat(fileHash(manifest, RaceRepos.CONTROLLER)).isEqualTo(fileHash(changed, RaceRepos.CONTROLLER));
        assertThat(currentSnapshot(p.projectId())).isEqualTo(manifest);
    }

    /**
     * Redis pub/sub loss: progress messages are fire-and-forget. Losing every message (including
     * the terminal one) never changes the database outcome; an already open stream is not healed
     * server-side, while polling and any new subscription observe the terminal state from the DB.
     */
    @Test
    void lostProgressMessagesNeverChangeTheOutcomeAndTheTerminalStateStaysObservable() throws Exception {
        Analyzed p = analyzedProject();
        RaceRepos.commit(p.bare(), Map.of(RaceRepos.SERVICE, service("v2-" + p.name())), "second");
        RaceStepGates.Gate gate = gates.arm("SOURCE_PARSING", RaceStepGates.Point.BEFORE_BODY);
        long job = api.reanalyze(p.projectId());
        gate.awaitEntered();
        try (SseReader stream = new SseReader("/api/jobs/" + job + "/events")) {
            assertThat(stream.await(line -> "RUNNING".equals(jobStatusOf(line)), Duration.ofSeconds(20)))
                    .isTrue();
            publisher.dropAll(true);
            gate.release();
            assertThat(awaitTerminal(job)).isEqualTo("DONE");
            assertThat(stream.await(line -> "DONE".equals(jobStatusOf(line)), Duration.ofSeconds(5)))
                    .as("a lost terminal message is not re-sent to an open stream")
                    .isFalse();
            assertThat(stream.closed()).isFalse();
        } finally {
            publisher.dropAll(false);
        }
        assertThat(api.job(job).get("status")).isEqualTo("DONE");
        try (SseReader late = new SseReader("/api/jobs/" + job + "/events")) {
            assertThat(late.await(line -> "DONE".equals(jobStatusOf(line)), Duration.ofSeconds(20)))
                    .isTrue();
            Awaitility.await().atMost(Duration.ofSeconds(20)).until(late::closed);
        }
        assertThat(currentSnapshot(p.projectId())).isEqualTo(snapshotOf(job));
        assertThat(activeJobs(p.projectId())).isZero();
    }

    /** The job-level status of an SSE data line (the first status field precedes the steps). */
    private static String jobStatusOf(String line) {
        if (!line.startsWith("data:")) return null;
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\\\?\"status\\\\?\":\\\\?\"([A-Z]+)")
                .matcher(line);
        return matcher.find() ? matcher.group(1) : null;
    }

    /** Minimal SSE line reader over the real HTTP endpoint with the test session. */
    private final class SseReader implements AutoCloseable {
        private final java.net.http.HttpClient client = java.net.http.HttpClient.newHttpClient();
        private final List<String> lines = new java.util.concurrent.CopyOnWriteArrayList<>();
        private final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        private final Thread reader;

        private SseReader(String path) {
            java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder(java.net.URI.create(
                            "http://127.0.0.1:" + environment.getProperty("local.server.port") + path))
                    .header("Accept", "text/event-stream")
                    .header("Cookie", "SESSION=" + api.sessionValue())
                    .GET()
                    .build();
            reader = Thread.ofVirtual().name("race-sse").start(() -> {
                try {
                    client.send(request, java.net.http.HttpResponse.BodyHandlers.ofLines())
                            .body()
                            .forEach(lines::add);
                } catch (Exception ignored) {
                    // Closed by the test or by the server.
                } finally {
                    done.countDown();
                }
            });
        }

        boolean await(java.util.function.Predicate<String> match, Duration timeout) throws InterruptedException {
            long deadline = System.nanoTime() + timeout.toNanos();
            while (System.nanoTime() < deadline) {
                if (lines.stream().anyMatch(match)) return true;
                Thread.sleep(50);
            }
            return lines.stream().anyMatch(match);
        }

        boolean closed() {
            return done.getCount() == 0;
        }

        @Override
        public void close() {
            client.shutdownNow();
            reader.interrupt();
        }
    }

    // ---------------------------------------------------------------- helpers

    private Analyzed analyzedProject() throws Exception {
        String name = "race" + UNIQUE.incrementAndGet();
        Path bare = RaceRepos.create(root.resolve("origins"), "octocat", name, RaceRepos.initialFiles("v1-" + name));
        RaceApi.Created created = api.createProject("octocat", name);
        assertThat(awaitTerminal(created.jobId())).isEqualTo("DONE");
        long userId = jdbc.queryForObject("select user_id from projects where id=?", Long.class, created.projectId());
        jdbc.update(
                "insert into notes(project_id,title,content_md) values (?,?,?)",
                created.projectId(),
                "race note",
                "kept across cancel");
        jdbc.update("insert into tasks(project_id,type,title) values (?,'REVIEW','race task')", created.projectId());
        return new Analyzed(created.projectId(), userId, name, bare, currentSnapshot(created.projectId()));
    }

    private long analyzeAgain(Analyzed p) {
        long job = api.reanalyze(p.projectId());
        assertThat(awaitTerminal(job)).isEqualTo("DONE");
        return currentSnapshot(p.projectId());
    }

    private void assertFreshAnalysisPublishes(Analyzed p, Baseline before, String marker) {
        long next = api.reanalyze(p.projectId());
        assertThat(awaitTerminal(next)).isEqualTo("DONE");
        long published = currentSnapshot(p.projectId());
        assertThat(published).isEqualTo(snapshotOf(next)).isNotEqualTo(before.snapshotId());
        assertThat(snapshotStatus(published)).isEqualTo("READY");
        assertThat(source(p, published)).contains(marker);
        assertThat(source(p, before.snapshotId()))
                .as("the previous result keeps its own retained source")
                .contains("v1-" + p.name());
        assertThat(activeJobs(p.projectId())).isZero();
    }

    private Baseline baseline(Analyzed p) {
        return new Baseline(
                p.snapshotId(),
                currentGeneration(p.projectId()),
                fingerprint(p.snapshotId()),
                count("select count(*) from notes where project_id=?", p.projectId()),
                count("select count(*) from tasks where project_id=?", p.projectId()));
    }

    private void assertUnchanged(Analyzed p, Baseline before) {
        assertThat(currentSnapshot(p.projectId())).as("current pointer").isEqualTo(before.snapshotId());
        assertThat(currentGeneration(p.projectId())).as("current generation").isEqualTo(before.generation());
        assertThat(fingerprint(before.snapshotId())).as("published facts").isEqualTo(before.fingerprint());
        assertThat(count("select count(*) from notes where project_id=?", p.projectId()))
                .isEqualTo(before.notes());
        assertThat(count("select count(*) from tasks where project_id=?", p.projectId()))
                .isEqualTo(before.tasks());
        assertThat(source(p, before.snapshotId())).contains("v1-" + p.name());
    }

    private void assertLaterStepsNeverRan(long job, String step) {
        for (String later : REAL_STEPS.subList(REAL_STEPS.indexOf(step) + 1, REAL_STEPS.size())) {
            assertThat(stepStatus(job, later)).as("%s status", later).isEqualTo("PENDING");
            assertThat(stepAttempt(job, later)).as("%s attempt", later).isZero();
        }
    }

    private List<String> snapshotTables() {
        return jdbc.queryForList(
                "select table_name from information_schema.columns where table_schema='public' "
                        + "and column_name='snapshot_id' order by table_name",
                String.class);
    }

    /** Every snapshot-scoped table count plus content digests of the graph and inventory. */
    private Map<String, Object> fingerprint(long snapshotId) {
        Map<String, Object> result = new TreeMap<>();
        for (String table : snapshotTables()) {
            result.put(table, count("select count(*) from " + table + " where snapshot_id=?", snapshotId));
        }
        result.put(
                "snapshot",
                jdbc.queryForMap("select status, commit_sha, analyzed_at from snapshots where id=?", snapshotId));
        result.putAll(semantic(snapshotId));
        return result;
    }

    /** Snapshot-independent facts (natural keys, relations, inventory hashes). */
    private Map<String, Object> semantic(long snapshotId) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put(
                "nodes",
                digest("select node_type || ' ' || natural_key from graph_nodes where snapshot_id=?", snapshotId));
        result.put("edges", digest(EDGES, snapshotId));
        result.put(
                "files",
                digest("select path || ' ' || coalesce(content_hash,'') from files where snapshot_id=?", snapshotId));
        result.put(
                "sourceNodes",
                digest(
                        "select node_type || ' ' || natural_key from graph_nodes where snapshot_id=? "
                                + "and natural_key not like '%package.json%' and natural_key not like '%axios%'",
                        snapshotId));
        result.put(
                "sourceEdges",
                digest(
                        EDGES + " and s.natural_key not like '%axios%' and t.natural_key not like '%axios%'",
                        snapshotId));
        Map<String, Long> counts = new TreeMap<>();
        for (String table : snapshotTables()) {
            if (Set.of("analysis_jobs", "source_manifests", "analysis_generations")
                    .contains(table)) continue;
            counts.put(table, count("select count(*) from " + table + " where snapshot_id=?", snapshotId));
        }
        result.put("counts", counts);
        return result;
    }

    private static final String EDGES = "select s.natural_key || ' -' || e.edge_type || '/' || e.confidence || '-> ' "
            + "|| t.natural_key from graph_edges e join graph_nodes s on s.id=e.source_node_id "
            + "join graph_nodes t on t.id=e.target_node_id where e.snapshot_id=?";

    private Set<String> edges(long snapshotId, String from, String to) {
        return new TreeSet<>(jdbc.queryForList(
                EDGES + " and s.natural_key like ? and t.natural_key like ?",
                String.class,
                snapshotId,
                "%" + from + "%",
                "%" + to + "%"));
    }

    private List<String> digest(String sql, long snapshotId) {
        List<String> rows = new ArrayList<>(jdbc.queryForList(sql, String.class, snapshotId));
        rows.sort(null);
        return rows;
    }

    private String fileHash(long snapshotId, String path) {
        return jdbc.queryForObject(
                "select content_hash from files where snapshot_id=? and path=?", String.class, snapshotId, path);
    }

    private String source(Analyzed p, long snapshotId) {
        return files.fileContent(p.projectId(), p.userId(), RaceRepos.SERVICE, snapshotId)
                .content();
    }

    private static String service(String marker) {
        return """
                package demo;

                public class ItemService {
                    public String load() {
                        return "%s";
                    }
                }
                """.formatted(marker);
    }

    private void awaitLockWaiters(int expected) {
        Awaitility.await()
                .atMost(Duration.ofSeconds(30))
                .until(() -> count("select count(*) from pg_stat_activity where datname=current_database() "
                                + "and wait_event_type='Lock' and pid<>pg_backend_pid()")
                        >= expected);
    }

    private interface Action {
        void run() throws Exception;
    }

    private static Throwable attempt(Action action) {
        try {
            action.run();
            return null;
        } catch (Throwable failure) {
            return failure;
        }
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
}
