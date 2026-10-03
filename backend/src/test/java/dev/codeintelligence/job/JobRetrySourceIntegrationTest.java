package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.eclipse.jgit.api.Git;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.support.TransactionTemplate;

/** Real persisted checkpoints and local JGit objects; dispatch is observed without running analysis. */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url=",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.github.base-url=http://127.0.0.1:1"
        })
@Import(TestcontainersConfiguration.class)
class JobRetrySourceIntegrationTest {
    private static final AtomicLong UNIQUE = new AtomicLong(92_000);

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    JobRepository jobs;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    TransactionTemplate transactions;

    @Autowired
    AppProperties app;

    @Autowired
    AnalysisProperties analysis;

    private JobWorker worker;
    private JobProgressPublisher publisher;
    private JobService service;

    @BeforeEach
    void serviceWithObservedDispatch() {
        worker = mock(JobWorker.class);
        publisher = mock(JobProgressPublisher.class);
        service = newService();
    }

    private JobService newService() {
        return new JobService(
                jobs,
                new Pipeline(List.of()),
                worker,
                publisher,
                transactions,
                new RetrySourceGuard(jobs, app, analysis));
    }

    @ParameterizedTest
    @ValueSource(strings = {"IMPORT", "LOCAL_IMPORT"})
    void unchangedSourceRetainsTheCompletedImportCheckpoint(String importStep) throws Exception {
        Fixture fixture = checkpoint(importStep);
        JobStepRecord imported = jobs.findSteps(fixture.job()).getFirst();

        service.retry(fixture.job(), fixture.user());

        assertThat(jobs.findJob(fixture.job()).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        assertThat(jobs.findSteps(fixture.job()).getFirst()).isEqualTo(imported);
        assertThat(jobs.findSteps(fixture.job()).get(1)).satisfies(step -> {
            assertThat(step.status()).isEqualTo(StepStatus.PENDING);
            assertThat(step.attempt()).isEqualTo(1);
            assertThat(step.error()).isNull();
        });
        assertThat(current(fixture)).isEqualTo(fixture.previousSnapshot());
        verify(worker).dispatch(fixture.job());
        verify(publisher).publish(fixture.job());
    }

    @ParameterizedTest
    @ValueSource(strings = {"snapshot-attached", "failed-before-snapshot", "reset-after-failure"})
    void replacingTheRepositoryPreventsRetryOfTheOldCheckpoint(String laterOutcome) throws Exception {
        Fixture fixture = checkpoint("LOCAL_IMPORT");
        Files.move(fixture.root(), dataDir.resolve("old-repository-" + fixture.job()));
        String commitB = createRepository(fixture.root(), "BBBB");
        boolean attached = laterOutcome.equals("snapshot-attached");
        Long snapshotB = attached ? snapshot(fixture.project(), commitB, "READY") : null;
        long later = insertJob(fixture.project(), snapshotB, attached ? "DONE" : "FAILED");
        if (laterOutcome.equals("reset-after-failure")) {
            // A retry can erase import timestamps while retaining evidence of an attempt.
            jdbc.update("""
                    insert into analysis_job_steps (job_id, step_key, seq, status, attempt)
                    values (?, 'LOCAL_IMPORT', 1, 'PENDING', 1)
                    """, later);
        } else {
            attemptedImport(later, "LOCAL_IMPORT", attached ? "DONE" : "FAILED");
        }
        if (attached)
            jdbc.update("update projects set current_snapshot_id = ? where id = ?", snapshotB, fixture.project());

        rejectedWithoutMutation(fixture);
    }

    @Test
    void aLaterAttemptIsRejectedEvenWhenHeadAndWorkingBytesWereRestored() throws Exception {
        Fixture fixture = checkpoint("IMPORT");
        long later = insertJob(fixture.project(), null, "FAILED");
        attemptedImport(later, "IMPORT", "FAILED");

        rejectedWithoutMutation(fixture);
    }

    @Test
    void anImportThatNeverStartedDoesNotInvalidateTheCheckpoint() throws Exception {
        Fixture fixture = checkpoint("IMPORT");
        long later = insertJob(fixture.project(), null, "CANCELLED");
        jobs.insertStep(later, "IMPORT", 1);

        service.retry(fixture.job(), fixture.user());

        assertThat(jobs.findJob(fixture.job()).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        verify(worker).dispatch(fixture.job());
    }

    @Test
    void failedImportWithoutACompletedCheckpointRetainsItsExistingRetryPath() throws Exception {
        Fixture fixture = checkpoint("IMPORT");
        jdbc.update("update analysis_jobs set snapshot_id = null where id = ?", fixture.job());
        jdbc.update(
                "update analysis_job_steps set status = 'FAILED' where job_id = ? and step_key = 'IMPORT'",
                fixture.job());
        Files.move(fixture.root(), dataDir.resolve("before-import-" + fixture.job()));

        service.retry(fixture.job(), fixture.user());

        assertThat(jobs.findJob(fixture.job()).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        assertThat(jobs.findSteps(fixture.job()))
                .allSatisfy(step -> assertThat(step.status()).isEqualTo(StepStatus.PENDING));
        verify(worker).dispatch(fixture.job());
    }

    @Test
    void anOlderJobRetriedAfterThisImportAlsoCountsAsALaterWriter() throws Exception {
        Fixture fixture = checkpoint("IMPORT");
        // Job IDs alone are insufficient: the lower-ID job can retry after A imported.
        long newer = insertJob(fixture.project(), fixture.snapshot(), "FAILED");
        jdbc.update("update analysis_job_steps set job_id = ? where job_id = ?", newer, fixture.job());
        attemptedImport(fixture.job(), "IMPORT", "FAILED");
        Fixture checkpoint = new Fixture(
                fixture.user(),
                fixture.project(),
                newer,
                fixture.snapshot(),
                fixture.previousSnapshot(),
                fixture.root());

        rejectedWithoutMutation(checkpoint);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {"working-bytes", "missing-repository", "missing-snapshot", "different-head", "metadata-java"})
    void unverifiableSourceIsRejectedWithoutChangingAnyCheckpoint(String failure) throws Exception {
        Fixture fixture = checkpoint("IMPORT");
        switch (failure) {
            case "working-bytes" -> Files.writeString(fixture.root().resolve("App.java"), "BBBB");
            case "missing-repository" -> Files.move(fixture.root(), dataDir.resolve("missing-" + fixture.job()));
            case "missing-snapshot" ->
                jdbc.update("update analysis_jobs set snapshot_id = null where id = ?", fixture.job());
            case "metadata-java" -> {
                Path extra = fixture.root().resolve(".git/injected/src/main/java/demo/Helper.java");
                Files.createDirectories(extra.getParent());
                Files.writeString(extra, "package demo; public class Helper { public static void work() {} }");
            }
            case "different-head" -> {
                try (Git git = Git.open(fixture.root().toFile())) {
                    Files.writeString(fixture.root().resolve("App.java"), "BBBB");
                    commit(git);
                }
            }
            default -> throw new AssertionError(failure);
        }

        rejectedWithoutMutation(fixture);
    }

    @Test
    void snapshotMustBelongToTheSameProjectAsItsJob() throws Exception {
        Fixture fixture = checkpoint("IMPORT");
        Fixture other = checkpoint("IMPORT");
        jdbc.update("update analysis_jobs set snapshot_id = ? where id = ?", other.snapshot(), fixture.job());

        rejectedWithoutMutation(fixture);
    }

    @Test
    void restartRecoveryPreservesAProvenImportCheckpoint() throws Exception {
        Fixture fixture = checkpoint("LOCAL_IMPORT");
        JobStepRecord imported = jobs.findSteps(fixture.job()).getFirst();
        jdbc.update("update analysis_jobs set status = 'RUNNING', finished_at = null where id = ?", fixture.job());
        jdbc.update(
                "update analysis_job_steps set status = 'RUNNING', finished_at = null "
                        + "where job_id = ? and step_key = 'FILE_INVENTORY'",
                fixture.job());
        new JobStartupRecovery(jobs).recover();
        assertThat(jobs.findJob(fixture.job()).orElseThrow().error()).isEqualTo(JobStartupRecovery.INTERRUPTED_ERROR);

        newService().retry(fixture.job(), fixture.user());

        assertThat(jobs.findJob(fixture.job()).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        assertThat(jobs.findSteps(fixture.job()).getFirst()).isEqualTo(imported);
        verify(worker).dispatch(fixture.job());
    }

    @Test
    void foreignOwnershipAndActiveSiblingJobsStillBlockRetry() throws Exception {
        Fixture fixture = checkpoint("IMPORT");
        assertThatThrownBy(() -> service.retry(fixture.job(), fixture.user() + 1_000_000))
                .isInstanceOf(JobNotFoundException.class);
        long active = insertJob(fixture.project(), null, "QUEUED");
        JobRecord before = jobs.findJob(fixture.job()).orElseThrow();
        List<JobStepRecord> steps = jobs.findSteps(fixture.job());

        assertThatThrownBy(() -> service.retry(fixture.job(), fixture.user())).isInstanceOf(JobConflictException.class);

        assertThat(jobs.findJob(fixture.job()).orElseThrow()).isEqualTo(before);
        assertThat(jobs.findSteps(fixture.job())).isEqualTo(steps);
        assertThat(jobs.findJob(active).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        verifyNoInteractions(worker, publisher);
    }

    @Test
    void concurrentRetriesAdmitOneWinnerAndDispatchOnce() throws Exception {
        Fixture fixture = checkpoint("IMPORT");
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> {
                start.await();
                service.retry(fixture.job(), fixture.user());
                return true;
            });
            var second = executor.submit(() -> {
                start.await();
                service.retry(fixture.job(), fixture.user());
                return true;
            });
            start.countDown();
            int successes = 0;
            int conflicts = 0;
            for (var future : List.of(first, second)) {
                try {
                    assertThat(future.get(30, TimeUnit.SECONDS)).isTrue();
                    successes++;
                } catch (ExecutionException e) {
                    assertThat(e.getCause()).isInstanceOf(JobConflictException.class);
                    conflicts++;
                }
            }
            assertThat(successes).isEqualTo(1);
            assertThat(conflicts).isEqualTo(1);
        }
        assertThat(jobs.findJob(fixture.job()).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        verify(worker, times(1)).dispatch(fixture.job());
        verify(publisher, times(1)).publish(fixture.job());
    }

    @Test
    void anOuterTransactionRollbackDoesNotDispatchOrChangeTheCheckpoint() throws Exception {
        Fixture fixture = checkpoint("IMPORT");
        JobRecord before = jobs.findJob(fixture.job()).orElseThrow();
        List<JobStepRecord> steps = jobs.findSteps(fixture.job());

        transactions.executeWithoutResult(tx -> {
            service.retry(fixture.job(), fixture.user());
            verifyNoInteractions(worker, publisher);
            tx.setRollbackOnly();
        });

        assertThat(jobs.findJob(fixture.job()).orElseThrow()).isEqualTo(before);
        assertThat(jobs.findSteps(fixture.job())).isEqualTo(steps);
        verifyNoInteractions(worker, publisher);
    }

    private void rejectedWithoutMutation(Fixture fixture) {
        JobRecord before = jobs.findJob(fixture.job()).orElseThrow();
        List<JobStepRecord> steps = jobs.findSteps(fixture.job());
        Long current = current(fixture);
        List<java.util.Map<String, Object>> snapshots =
                jdbc.queryForList("select * from snapshots where project_id = ? order by id", fixture.project());

        assertThatThrownBy(() -> service.retry(fixture.job(), fixture.user()))
                .isInstanceOfSatisfying(JobConflictException.class, error -> {
                    assertThat(error.getStatusCode().value()).isEqualTo(409);
                    assertThat(error.getBody().getProperties()).containsEntry("code", "RETRY_SOURCE_UNVERIFIED");
                    assertThat(error.getBody().getDetail()).contains("Preview").doesNotContain(dataDir.toString());
                });

        assertThat(jobs.findJob(fixture.job()).orElseThrow()).isEqualTo(before);
        assertThat(jobs.findSteps(fixture.job())).isEqualTo(steps);
        assertThat(current(fixture)).isEqualTo(current);
        assertThat(jdbc.queryForList("select * from snapshots where project_id = ? order by id", fixture.project()))
                .isEqualTo(snapshots);
        verifyNoInteractions(worker, publisher);
    }

    private Fixture checkpoint(String importStep) throws Exception {
        long unique = UNIQUE.incrementAndGet();
        long user = jdbc.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                unique,
                "retry-" + unique);
        long project = jdbc.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name) values (?, ?, ?, ?) returning id
                """, Long.class, user, "retry-" + unique, "fixture", "retry-" + unique);
        Path root = app.reposRoot().resolve(Long.toString(project));
        String commit = createRepository(root, "AAAA");
        long previous = snapshot(project, "0".repeat(40), "READY");
        long snapshot = snapshot(project, commit, "FAILED");
        jdbc.update("update projects set current_snapshot_id = ? where id = ?", previous, project);
        long job = insertJob(project, snapshot, "FAILED");
        jdbc.update("""
                insert into analysis_job_steps
                  (job_id, step_key, seq, status, progress_pct, attempt, started_at, finished_at)
                values (?, ?, 1, 'DONE', 100, 1, now() - interval '3 minutes', now() - interval '2 minutes')
                """, job, importStep);
        jdbc.update("""
                insert into analysis_job_steps
                  (job_id, step_key, seq, status, progress_pct, attempt, error, started_at, finished_at)
                values (?, 'FILE_INVENTORY', 2, 'FAILED', 45, 1, 'fixture failure',
                        now() - interval '1 minute', now())
                """, job);
        return new Fixture(user, project, job, snapshot, previous, root);
    }

    private long insertJob(long project, Long snapshot, String status) {
        return jdbc.queryForObject("""
                insert into analysis_jobs (project_id, snapshot_id, type, status, error, started_at, finished_at)
                values (?, ?, 'IMPORT', ?, 'fixture failure', now() - interval '3 minutes', now()) returning id
                """, Long.class, project, snapshot, status);
    }

    private long snapshot(long project, String commit, String status) {
        return jdbc.queryForObject(
                "insert into snapshots (project_id, commit_sha, status) values (?, ?, ?) returning id",
                Long.class,
                project,
                commit,
                status);
    }

    private void attemptedImport(long job, String step, String status) {
        jdbc.update("""
                insert into analysis_job_steps (job_id, step_key, seq, status, attempt, started_at, finished_at)
                values (?, ?, 1, ?, 1, now(), now())
                """, job, step, status);
    }

    private Long current(Fixture fixture) {
        return jdbc.queryForObject(
                "select current_snapshot_id from projects where id = ?", Long.class, fixture.project());
    }

    private String createRepository(Path root, String source) throws Exception {
        Files.createDirectories(root);
        try (Git git = Git.init().setDirectory(root.toFile()).call()) {
            Files.writeString(root.resolve("App.java"), source);
            return commit(git);
        }
    }

    private String commit(Git git) throws Exception {
        git.add().addFilepattern(".").call();
        return git.commit()
                .setMessage("retry fixture")
                .setAuthor("Fixture", "fixture@example.invalid")
                .setCommitter("Fixture", "fixture@example.invalid")
                .call()
                .getName();
    }

    private record Fixture(long user, long project, long job, long snapshot, long previousSnapshot, Path root) {}
}
