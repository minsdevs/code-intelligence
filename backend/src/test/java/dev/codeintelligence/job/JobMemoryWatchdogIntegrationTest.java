package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.ControllableJobStep;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.OptionalLong;
import java.util.concurrent.CountDownLatch;
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

/** R10 (05 §4): the 6 GiB owner-tree watchdog refuses new analysis work and fails a running job. */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import(TestcontainersConfiguration.class)
class JobMemoryWatchdogIntegrationTest {
    private static final long GIB = 1024L * 1024 * 1024;
    private static final Duration TIMEOUT = Duration.ofSeconds(20);
    private static final AtomicLong UNIQUE = new AtomicLong(19_000);
    // Injected owner-tree RSS; in production desktop main reports it (ReportedOwnerTreeMemory).
    private static final AtomicLong RSS = new AtomicLong(GIB);

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void isolatedDataDir(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    /** A step that waits inside an interruptible worker call, like an analyzer request. */
    static final class WorkerCallStep implements JobStep {
        volatile CountDownLatch entered = new CountDownLatch(1);

        @Override
        public String key() {
            return "W1";
        }

        @Override
        public void run(JobContext ctx) {
            JobCancellation.interruptibly(() -> {
                entered.countDown();
                try {
                    Thread.sleep(Duration.ofSeconds(30));
                } catch (InterruptedException interrupted) {
                    throw new IllegalStateException("worker request aborted", interrupted);
                }
                return null;
            });
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class WatchdogConfig {
        @Bean
        ControllableJobStep memoryStepOne() {
            return new ControllableJobStep("M1");
        }

        @Bean
        WorkerCallStep memoryWorkerStep() {
            return new WorkerCallStep();
        }

        @Bean
        @Primary
        Pipeline memoryPipeline(ControllableJobStep memoryStepOne, WorkerCallStep memoryWorkerStep) {
            return new Pipeline(List.of(memoryStepOne, memoryWorkerStep));
        }

        @Bean
        @Primary
        AnalysisMemoryWatchdog injectedWatchdog() {
            return new AnalysisMemoryWatchdog(6 * GIB, () -> OptionalLong.of(RSS.get()), Duration.ofMillis(20));
        }
    }

    private record Fixture(long userId, long projectId) {}

    @Autowired
    private JobService jobService;

    @Autowired
    private JobRepository jobRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ControllableJobStep memoryStepOne;

    @Autowired
    private WorkerCallStep memoryWorkerStep;

    @BeforeEach
    void reset() {
        RSS.set(GIB);
        memoryStepOne.reset();
        memoryWorkerStep.entered = new CountDownLatch(1);
    }

    @Test
    void noNewJobStartsWhileTheOwnerTreeIsAboveTheLimit() {
        Fixture fixture = newProject();
        RSS.set(6 * GIB + 1);
        long refused = jobService.enqueue(fixture.projectId(), JobType.IMPORT);
        JobRecord job = awaitTerminal(refused);
        assertThat(job.status()).isEqualTo(JobStatus.FAILED);
        assertThat(failureCode(refused)).isEqualTo(AnalysisMemoryLimitException.CODE);
        assertThat(job.error()).contains("6 GiB");
        assertThat(memoryStepOne.runCount()).isZero();

        // Admission reopens once memory is back under the limit; the failed job can be retried.
        RSS.set(2 * GIB);
        jobService.retry(refused, fixture.userId());
        Awaitility.await().atMost(TIMEOUT).until(() -> memoryStepOne.runCount() == 1);
        RSS.set(7 * GIB);
        assertThat(awaitTerminal(refused).status()).isEqualTo(JobStatus.FAILED);
    }

    @Test
    void aRunningJobFailsWithTheMemoryLimitCodeAndItsWorkerCallIsInterrupted() throws Exception {
        Fixture fixture = newProject();
        long jobId = jobService.enqueue(fixture.projectId(), JobType.IMPORT);
        assertThat(memoryWorkerStep.entered.await(10, TimeUnit.SECONDS)).isTrue();
        long started = System.nanoTime();
        RSS.set(7 * GIB);
        JobRecord job = awaitTerminal(jobId);
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(10));
        assertThat(job.status()).isEqualTo(JobStatus.FAILED);
        assertThat(failureCode(jobId)).isEqualTo(AnalysisMemoryLimitException.CODE);
        assertThat(stepStatus(jobId, "M1")).isEqualTo(StepStatus.DONE);
        assertThat(stepStatus(jobId, "W1")).isEqualTo(StepStatus.FAILED);
        assertThat(jobService.hasActiveJob(fixture.projectId())).isFalse();
    }

    private String failureCode(long jobId) {
        return jdbcTemplate.queryForObject("select failure_code from analysis_jobs where id=?", String.class, jobId);
    }

    private StepStatus stepStatus(long jobId, String key) {
        return jobRepository.findSteps(jobId).stream()
                .filter(step -> step.stepKey().equals(key))
                .findFirst()
                .orElseThrow()
                .status();
    }

    private Fixture newProject() {
        long unique = UNIQUE.incrementAndGet();
        Long userId = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id", Long.class, unique, "mw-" + unique);
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
}
