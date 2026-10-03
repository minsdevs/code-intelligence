package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.ControllableJobStep;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** Job framework semantics (§1-3) against a fake three-step pipeline: S1 → S2 → S3. */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import(TestcontainersConfiguration.class)
class JobFrameworkIntegrationTest {

    private static final Duration TIMEOUT = Duration.ofSeconds(20);
    private static final AtomicLong UNIQUE = new AtomicLong(9_000);

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void isolatedDataDir(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class FakePipelineConfig {

        @Bean
        ControllableJobStep fakeStepOne() {
            return new ControllableJobStep("S1");
        }

        @Bean
        ControllableJobStep fakeStepTwo() {
            return new ControllableJobStep("S2");
        }

        @Bean
        ControllableJobStep fakeStepThree() {
            return new ControllableJobStep("S3");
        }

        @Bean
        @Primary
        Pipeline fakePipeline(
                ControllableJobStep fakeStepOne, ControllableJobStep fakeStepTwo, ControllableJobStep fakeStepThree) {
            return new Pipeline(List.of(fakeStepOne, fakeStepTwo, fakeStepThree));
        }
    }

    private record Fixture(long userId, long projectId) {}

    @Autowired
    private JobService jobService;

    @Autowired
    private JobRepository jobRepository;

    @Autowired
    private JobStartupRecovery startupRecovery;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ControllableJobStep fakeStepOne;

    @Autowired
    private ControllableJobStep fakeStepTwo;

    @Autowired
    private ControllableJobStep fakeStepThree;

    @BeforeEach
    void resetSteps() {
        fakeStepOne.reset();
        fakeStepTwo.reset();
        fakeStepThree.reset();
    }

    @Test
    void pipelineRunsEveryStepInOrderToDone() {
        Fixture fixture = newProject();

        long jobId = jobService.enqueue(fixture.projectId(), JobType.IMPORT);

        JobRecord job = awaitTerminal(jobId);
        assertThat(job.status()).isEqualTo(JobStatus.DONE);
        assertThat(job.startedAt()).isNotNull();
        assertThat(job.finishedAt()).isNotNull();
        assertThat(job.error()).isNull();

        List<JobStepRecord> steps = jobRepository.findSteps(jobId);
        assertThat(steps).extracting(JobStepRecord::stepKey).containsExactly("S1", "S2", "S3");
        assertThat(steps).allSatisfy(step -> {
            assertThat(step.status()).isEqualTo(StepStatus.DONE);
            assertThat(step.attempt()).isEqualTo(1);
            assertThat(step.progressPct()).isEqualTo(100);
            assertThat(step.startedAt()).isNotNull();
            assertThat(step.finishedAt()).isNotNull();
        });
        assertThat(steps.get(0).finishedAt()).isBeforeOrEqualTo(steps.get(1).startedAt());
        assertThat(steps.get(1).finishedAt()).isBeforeOrEqualTo(steps.get(2).startedAt());
        assertThat(fakeStepOne.runCount()).isEqualTo(1);
        assertThat(fakeStepTwo.runCount()).isEqualTo(1);
        assertThat(fakeStepThree.runCount()).isEqualTo(1);
    }

    @Test
    void retryResumesFromTheFailedStepWithoutRerunningDoneSteps() {
        Fixture fixture = newProject();
        fakeStepTwo.failOnce();

        long jobId = jobService.enqueue(fixture.projectId(), JobType.IMPORT);

        JobRecord failed = awaitTerminal(jobId);
        assertThat(failed.status()).isEqualTo(JobStatus.FAILED);
        assertThat(failed.error()).contains("S2");
        assertThat(stepByKey(jobId, "S1").status()).isEqualTo(StepStatus.DONE);
        JobStepRecord failedStep = stepByKey(jobId, "S2");
        assertThat(failedStep.status()).isEqualTo(StepStatus.FAILED);
        assertThat(failedStep.attempt()).isEqualTo(1);
        assertThat(failedStep.error()).contains("simulated failure in S2");
        assertThat(stepByKey(jobId, "S3").status()).isEqualTo(StepStatus.PENDING);
        assertThat(fakeStepThree.runCount()).isZero();

        jobService.retry(jobId, fixture.userId());

        JobRecord retried = awaitTerminal(jobId);
        assertThat(retried.status()).isEqualTo(JobStatus.DONE);
        assertThat(fakeStepOne.runCount())
                .as("checkpoint: DONE step must not run again")
                .isEqualTo(1);
        assertThat(fakeStepTwo.runCount()).isEqualTo(2);
        assertThat(fakeStepThree.runCount()).isEqualTo(1);
        assertThat(stepByKey(jobId, "S1").attempt()).isEqualTo(1);
        assertThat(stepByKey(jobId, "S2").attempt()).isEqualTo(2);
        assertThat(stepByKey(jobId, "S2").error()).isNull();
        assertThat(stepByKey(jobId, "S3").attempt()).isEqualTo(1);
    }

    @Test
    void secondEnqueueWhileAJobIsActiveIsRejected() {
        Fixture fixture = newProject();
        fakeStepOne.blockUntilReleased();

        long jobId = jobService.enqueue(fixture.projectId(), JobType.IMPORT);
        try {
            assertThat(jobService.hasActiveJob(fixture.projectId())).isTrue();
            assertThatThrownBy(() -> jobService.enqueue(fixture.projectId(), JobType.REANALYZE))
                    .isInstanceOf(JobConflictException.class);
        } finally {
            fakeStepOne.release();
        }
        assertThat(awaitTerminal(jobId).status()).isEqualTo(JobStatus.DONE);

        long nextJobId = jobService.enqueue(fixture.projectId(), JobType.REANALYZE);
        assertThat(awaitTerminal(nextJobId).status()).isEqualTo(JobStatus.DONE);
    }

    @Test
    void concurrentEnqueuesAdmitExactlyOneActiveJob() throws Exception {
        Fixture fixture = newProject();
        fakeStepOne.blockUntilReleased();

        int attempts = 4;
        ExecutorService pool = Executors.newFixedThreadPool(attempts);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Long>> futures = new ArrayList<>();
        try {
            for (int i = 0; i < attempts; i++) {
                futures.add(pool.submit(() -> {
                    start.await();
                    return jobService.enqueue(fixture.projectId(), JobType.IMPORT);
                }));
            }
            start.countDown();

            long winner = -1;
            int conflicts = 0;
            for (Future<Long> future : futures) {
                try {
                    winner = future.get(30, TimeUnit.SECONDS);
                } catch (ExecutionException e) {
                    assertThat(e.getCause()).isInstanceOf(JobConflictException.class);
                    conflicts++;
                }
            }
            assertThat(conflicts).isEqualTo(attempts - 1);
            assertThat(winner).isPositive();

            fakeStepOne.release();
            assertThat(awaitTerminal(winner).status()).isEqualTo(JobStatus.DONE);
        } finally {
            fakeStepOne.release();
            pool.shutdownNow();
        }
    }

    @Test
    void cancelRetainsExclusiveProjectOwnershipUntilTheWriterActuallyStops() {
        Fixture fixture = newProject();
        fakeStepTwo.blockUntilReleased();
        long jobId = jobService.enqueue(fixture.projectId(), JobType.IMPORT);
        awaitStepStatus(jobId, "S2", StepStatus.RUNNING);
        try {
            jobService.cancel(jobId, fixture.userId());
            assertThat(jobRepository.findJob(jobId).orElseThrow().status().name())
                    .isEqualTo("CANCELLING");
            assertThat(jobService.hasActiveJob(fixture.projectId())).isTrue();
            assertThatThrownBy(() -> jobService.enqueue(fixture.projectId(), JobType.REANALYZE))
                    .isInstanceOf(JobConflictException.class);
        } finally {
            fakeStepTwo.release();
        }
        assertThat(awaitTerminal(jobId).status()).isEqualTo(JobStatus.CANCELLED);
        assertThat(jobService.hasActiveJob(fixture.projectId())).isFalse();
        assertThat(awaitTerminal(jobService.enqueue(fixture.projectId(), JobType.REANALYZE))
                        .status())
                .isEqualTo(JobStatus.DONE);
    }

    @Test
    void cancelStopsAfterTheRunningStepCompletes() {
        Fixture fixture = newProject();
        fakeStepTwo.blockUntilReleased();

        long jobId = jobService.enqueue(fixture.projectId(), JobType.IMPORT);
        awaitStepStatus(jobId, "S2", StepStatus.RUNNING);

        jobService.cancel(jobId, fixture.userId());
        assertThat(jobRepository.findJob(jobId).orElseThrow().status()).isEqualTo(JobStatus.CANCELLING);

        fakeStepTwo.release();
        awaitStepStatus(jobId, "S2", StepStatus.DONE);

        JobRecord job = awaitTerminal(jobId);
        assertThat(job.status()).isEqualTo(JobStatus.CANCELLED);
        assertThat(job.finishedAt()).isNotNull();
        assertThat(stepByKey(jobId, "S3").status()).isEqualTo(StepStatus.PENDING);
        assertThat(fakeStepThree.runCount()).isZero();

        assertThatThrownBy(() -> jobService.cancel(jobId, fixture.userId())).isInstanceOf(JobConflictException.class);
    }

    @Test
    void failedRunningStepStillCompletesCancellationAndReleasesExclusivity() {
        Fixture fixture = newProject();
        fakeStepTwo.blockUntilReleased();
        fakeStepTwo.failOnce();
        long jobId = jobService.enqueue(fixture.projectId(), JobType.IMPORT);
        awaitStepStatus(jobId, "S2", StepStatus.RUNNING);
        jobService.cancel(jobId, fixture.userId());
        fakeStepTwo.release();
        assertThat(awaitTerminal(jobId).status()).isEqualTo(JobStatus.CANCELLED);
        assertThat(stepByKey(jobId, "S2").status()).isEqualTo(StepStatus.FAILED);
        assertThat(jobService.hasActiveJob(fixture.projectId())).isFalse();
    }

    @Test
    void restartCompletesAnInterruptedCancellationWithoutRetryingIt() {
        Fixture fixture = newProject();
        Long id = jdbcTemplate.queryForObject(
                "insert into analysis_jobs(project_id, type, status) values (?, 'IMPORT', 'CANCELLING') returning id",
                Long.class,
                fixture.projectId());
        assertThat(jobService.hasActiveJob(fixture.projectId())).isTrue();
        startupRecovery.recover();
        assertThat(jobRepository.findJob(id).orElseThrow().status()).isEqualTo(JobStatus.CANCELLED);
        assertThat(jobService.hasActiveJob(fixture.projectId())).isFalse();
        assertThatThrownBy(() -> jobService.retry(id, fixture.userId())).isInstanceOf(JobConflictException.class);
    }

    @Test
    void queuedCancellationFinishesImmediatelyWithoutStartingAWorker() {
        Fixture fixture = newProject();
        long id = jobRepository.insertJob(fixture.projectId(), JobType.IMPORT);
        jobService.cancel(id, fixture.userId());
        assertThat(jobRepository.findJob(id).orElseThrow().status()).isEqualTo(JobStatus.CANCELLED);
        assertThat(jobRepository.findJob(id).orElseThrow().finishedAt()).isNotNull();
        assertThat(jobService.hasActiveJob(fixture.projectId())).isFalse();
    }

    @Test
    void startupRecoveryFailsInterruptedJobsAndRetryResumesFromCheckpoint() {
        Fixture fixture = newProject();
        Long jobId = jdbcTemplate.queryForObject(
                "insert into analysis_jobs (project_id, type, status, started_at) "
                        + "values (?, 'IMPORT', 'RUNNING', now()) returning id",
                Long.class,
                fixture.projectId());
        jdbcTemplate.update(
                "insert into analysis_job_steps (job_id, step_key, seq, status, progress_pct, attempt, started_at, "
                        + "finished_at) values (?, 'S1', 1, 'DONE', 100, 1, now(), now())",
                jobId);
        jdbcTemplate.update(
                "insert into analysis_job_steps (job_id, step_key, seq, status, progress_pct, attempt, started_at) "
                        + "values (?, 'S2', 2, 'RUNNING', 0, 1, now())",
                jobId);
        jdbcTemplate.update(
                "insert into analysis_job_steps (job_id, step_key, seq, status, attempt) "
                        + "values (?, 'S3', 3, 'PENDING', 0)",
                jobId);

        assertThat(startupRecovery.recover()).isEqualTo(1);

        JobRecord recovered = jobRepository.findJob(jobId).orElseThrow();
        assertThat(recovered.status()).isEqualTo(JobStatus.FAILED);
        assertThat(recovered.error()).isEqualTo("interrupted by backend restart");
        assertThat(stepByKey(jobId, "S1").status()).isEqualTo(StepStatus.DONE);
        JobStepRecord interrupted = stepByKey(jobId, "S2");
        assertThat(interrupted.status()).isEqualTo(StepStatus.FAILED);
        assertThat(interrupted.error()).isEqualTo("interrupted by backend restart");
        assertThat(stepByKey(jobId, "S3").status()).isEqualTo(StepStatus.PENDING);

        jobService.retry(jobId, fixture.userId());

        assertThat(awaitTerminal(jobId).status()).isEqualTo(JobStatus.DONE);
        assertThat(fakeStepOne.runCount()).as("checkpoint survives a restart").isZero();
        assertThat(fakeStepTwo.runCount()).isEqualTo(1);
        assertThat(fakeStepThree.runCount()).isEqualTo(1);
        assertThat(stepByKey(jobId, "S2").attempt()).isEqualTo(2);
    }

    @Test
    void retryOfANonFailedJobIsRejectedAndForeignJobsStayHidden() {
        Fixture fixture = newProject();
        long jobId = jobService.enqueue(fixture.projectId(), JobType.IMPORT);
        assertThat(awaitTerminal(jobId).status()).isEqualTo(JobStatus.DONE);

        assertThatThrownBy(() -> jobService.retry(jobId, fixture.userId())).isInstanceOf(JobConflictException.class);

        Fixture stranger = newProject();
        assertThatThrownBy(() -> jobService.getOwnedJob(jobId, stranger.userId()))
                .isInstanceOf(JobNotFoundException.class);
        assertThatThrownBy(() -> jobService.cancel(jobId, stranger.userId())).isInstanceOf(JobNotFoundException.class);
    }

    private Fixture newProject() {
        long unique = UNIQUE.incrementAndGet();
        Long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id", Long.class, unique, "fw-" + unique);
        Long projectId = jdbcTemplate.queryForObject(
                "insert into projects (user_id, name, repo_owner, repo_name) values (?, ?, ?, ?) returning id",
                Long.class,
                userId,
                "repo-" + unique,
                "owner-" + unique,
                "repo-" + unique);
        return new Fixture(userId, projectId);
    }

    private JobRecord awaitTerminal(long jobId) {
        Awaitility.await()
                .atMost(TIMEOUT)
                .until(() -> jobRepository.findJob(jobId).orElseThrow().status().terminal());
        return jobRepository.findJob(jobId).orElseThrow();
    }

    private void awaitStepStatus(long jobId, String stepKey, StepStatus expected) {
        Awaitility.await().atMost(TIMEOUT).until(() -> stepByKey(jobId, stepKey).status() == expected);
    }

    private JobStepRecord stepByKey(long jobId, String stepKey) {
        return jobRepository.findSteps(jobId).stream()
                .filter(step -> step.stepKey().equals(stepKey))
                .findFirst()
                .orElseThrow();
    }
}
