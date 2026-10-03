package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.job.FinalizeStep;
import dev.codeintelligence.job.JobConflictException;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobProgressPublisher;
import dev.codeintelligence.job.JobRepository;
import dev.codeintelligence.job.JobService;
import dev.codeintelligence.job.JobStartupRecovery;
import dev.codeintelligence.job.JobStatus;
import dev.codeintelligence.job.JobType;
import dev.codeintelligence.job.JobWorker;
import dev.codeintelligence.job.Pipeline;
import dev.codeintelligence.job.StepStatus;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionTemplate;

/** Real PostgreSQL approval/receipt transactions. Normal dispatch never starts a worker. */
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
class LocalSourceApprovalIntegrationTest {
    private static final Duration WAIT = Duration.ofSeconds(15);

    @TempDir
    static Path root;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    TransactionTemplate transactions;

    @Autowired
    LocalSourceApprovalService approvals;

    @Autowired
    LocalImportService imports;

    @Autowired
    ProjectService projects;

    @Autowired
    JobService jobService;

    @Autowired
    JobRepository jobs;

    @Autowired
    ImportStep importStep;

    @Autowired
    FileInventoryStep inventoryStep;

    @Autowired
    FinalizeStep finalizeStep;

    @Autowired
    dev.codeintelligence.job.JobWorkspaceProvider workspaces;

    @Autowired
    AppProperties app;

    @MockitoBean
    JobWorker worker;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add("app.local-import.allowed-roots", () -> root.toString());
    }

    @BeforeEach
    void resetDispatch() {
        reset(worker);
    }

    @Test
    void initialConfirmationCopiesThePrivateBindingAndDispatchesOnlyAfterCommit() throws Exception {
        Fixture f = fixture();
        LocalSourcePreview preview = preview(f);
        LocalSourceBinding inspected = imports.inspect(f.source()).binding();
        assertThat(preview.previewToken()).matches("[0-9a-f]{64}");
        assertThat(jdbc.queryForObject(
                        "select token_sha256 from local_source_approvals where user_id = ?", String.class, f.user()))
                .isNotEqualTo(preview.previewToken())
                .isEqualTo(LocalSourceApprovalService.tokenHash(preview.previewToken()));
        var created = transactions.execute(tx -> {
            var result = confirm(f, preview);
            verifyNoInteractions(worker);
            assertCounts(f.user(), 1, 1, 1);
            return result;
        });
        assertThat(created).isNotNull();
        verify(worker).dispatch(created.jobId());
        running(created.jobId());
        assertThat(approvals.requireJobInput(created.jobId(), created.project().id()))
                .isEqualTo(inspected);
        assertThat(approvals.outcome(f.user(), preview.previewToken()))
                .isEqualTo(new LocalSourceApprovalService.Outcome(
                        "CONSUMED", created.project().id(), created.jobId()));
        assertThat(Files.readString(f.source().resolve("a.txt"))).isEqualTo("AAAA");
    }

    @Test
    void anotherOwnerCannotConsumeOrRevokeAnApproval() throws Exception {
        Fixture owner = fixture();
        Fixture other = fixture();
        LocalSourcePreview preview = preview(owner);
        rejected(() -> projects.createFromLocal(other.user(), request(owner, preview)), "LOCAL_PREVIEW_INVALID");
        assertThat(approvals.outcome(other.user(), preview.previewToken()))
                .isEqualTo(new LocalSourceApprovalService.Outcome("ABANDONED", null, null));
        assertCounts(owner.user(), 0, 0, 0);
        assertCounts(other.user(), 0, 0, 0);
        verifyNoInteractions(worker);
        var created = confirm(owner, preview);
        verify(worker).dispatch(created.jobId());
    }

    @Test
    void initialAndRefreshPurposesCannotBeInterchanged() throws Exception {
        Fixture f = fixture();
        long project = project(f);
        var initial = preview(f);
        var refresh = approvals.previewRefresh(project, f.user());
        rejected(() -> projects.reanalyze(project, f.user(), initial.previewToken()), "LOCAL_PREVIEW_INVALID");
        rejected(() -> projects.createFromLocal(f.user(), request(f, refresh)), "LOCAL_PREVIEW_INVALID");
        assertCounts(f.user(), 1, 0, 0);
        verifyNoInteractions(worker);
        long job = projects.reanalyze(project, f.user(), refresh.previewToken());
        assertThat(jdbc.queryForObject(
                        "select base_snapshot_id is null from job_local_source_inputs where job_id = ?",
                        Boolean.class,
                        job))
                .isTrue();
        verify(worker).dispatch(job);
    }

    @Test
    void refreshApprovalCannotAuthorizeAnotherProjectOfTheSameOwner() throws Exception {
        Fixture f = fixture();
        long first = project(f);
        long second = project(new Fixture(f.user(), f.source(), f.name() + "-other"));
        var preview = approvals.previewRefresh(first, f.user());
        rejected(() -> projects.reanalyze(second, f.user(), preview.previewToken()), "LOCAL_PREVIEW_INVALID");
        assertCounts(f.user(), 2, 0, 0);
        verifyNoInteractions(worker);
    }

    @Test
    void aConsumedTokenCannotCreateAnotherJob() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        var created = confirm(f, preview);
        rejected(() -> confirm(f, preview), "LOCAL_PREVIEW_CONSUMED");
        assertCounts(f.user(), 1, 1, 1);
        verify(worker, times(1)).dispatch(created.jobId());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void baselineChangesIncludingNullToSnapshotInvalidateTheApproval(boolean existingSnapshot) throws Exception {
        Fixture f = fixture();
        long project = project(f);
        if (existingSnapshot) current(project, snapshot(project, "a".repeat(40)));
        var preview = approvals.previewRefresh(project, f.user());
        current(project, snapshot(project, "b".repeat(40)));
        rejected(() -> projects.reanalyze(project, f.user(), preview.previewToken()), "LOCAL_PREVIEW_BASE_CHANGED");
        assertCounts(f.user(), 1, 0, 0);
        verifyNoInteractions(worker);
        assertUnconsumed(preview);
    }

    @Test
    void failedInitialProjectCanStartAFreshApprovedJobWithANullBaseline() throws Exception {
        Fixture f = fixture();
        long project = project(f);
        long failed = job(project, "FAILED");
        var preview = approvals.previewRefresh(project, f.user());
        assertThat(preview.snapshotId()).isNull();
        long fresh = projects.reanalyze(project, f.user(), preview.previewToken());
        assertThat(fresh).isNotEqualTo(failed);
        assertCounts(f.user(), 1, 2, 1);
        running(fresh);
        assertThat(approvals.requireJobInput(fresh, project))
                .isEqualTo(imports.inspect(f.source()).binding());
        verify(worker).dispatch(fresh);
    }

    @Test
    void rollbackRemovesProjectJobAndReceiptAndDoesNotConsumeOrDispatch() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        transactions.executeWithoutResult(tx -> {
            confirm(f, preview);
            assertCounts(f.user(), 1, 1, 1);
            verifyNoInteractions(worker);
            tx.setRollbackOnly();
        });
        assertCounts(f.user(), 0, 0, 0);
        assertUnconsumed(preview);
        verifyNoInteractions(worker);
        var created = confirm(f, preview);
        verify(worker).dispatch(created.jobId());
    }

    @Test
    void expiryAtBindRollsBackTheAlreadyInsertedJobAndAfterCommitDispatch() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        rejected(
                () -> transactions.executeWithoutResult(tx -> {
                    var prepared = approvals.prepareInitial(
                            f.user(), preview.previewToken(), f.source().toString(), f.name());
                    long project = project(f);
                    long job = jobService.enqueue(project, JobType.IMPORT);
                    expire(preview);
                    approvals.bind(prepared, project, job);
                }),
                "LOCAL_PREVIEW_EXPIRED");
        assertCounts(f.user(), 0, 0, 0);
        assertUnconsumed(preview);
        verifyNoInteractions(worker);
    }

    @Test
    void expiryIsEvaluatedAfterWaitingForTheTokenLock() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        jdbc.update("""
                with instant as (select clock_timestamp() as time)
                update local_source_approvals set issued_at = instant.time - interval '9 minutes 55 seconds',
                    expires_at = instant.time + interval '5 seconds'
                from instant where token_sha256 = ?
                """, hash(preview));
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger waiterPid = new AtomicInteger();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var holder = executor.submit(() -> transactions.executeWithoutResult(tx -> {
                lockToken(preview);
                locked.countDown();
                waitFor(release);
            }));
            try {
                waitFor(locked);
                var confirmation = executor.submit(() -> transactions.execute(tx -> {
                    waiterPid.set(backendPid());
                    return confirm(f, preview);
                }));
                awaitBlocked(waiterPid);
                assertThat(jdbc.queryForObject(
                                "select expires_at > clock_timestamp() from local_source_approvals where token_sha256 = ?",
                                Boolean.class,
                                hash(preview)))
                        .as("confirmation must acquire its transaction before the locked token expires")
                        .isTrue();
                await().atMost(WAIT)
                        .until(() -> Boolean.TRUE.equals(jdbc.queryForObject(
                                "select expires_at <= clock_timestamp() from local_source_approvals where token_sha256 = ?",
                                Boolean.class,
                                hash(preview))));
                release.countDown();
                assertThatThrownBy(() -> confirmation.get(15, TimeUnit.SECONDS))
                        .isInstanceOf(ExecutionException.class)
                        .hasCauseInstanceOf(LocalSourceApprovalException.class)
                        .satisfies(error -> assertCode(error.getCause(), "LOCAL_PREVIEW_EXPIRED"));
            } finally {
                release.countDown();
            }
            holder.get(15, TimeUnit.SECONDS);
        }
        assertCounts(f.user(), 0, 0, 0);
        assertUnconsumed(preview);
        verifyNoInteractions(worker);
    }

    @Test
    void receiptCannotBeUpdatedEvenWhenThePreviewIsLaterDeleted() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        var created = confirm(f, preview);
        running(created.jobId());
        var binding =
                approvals.requireJobInput(created.jobId(), created.project().id());
        assertThatThrownBy(() -> jdbc.update(
                        "update job_local_source_inputs set manifest_sha256 = ? where job_id = ?",
                        "f".repeat(64),
                        created.jobId()))
                .isInstanceOf(DataIntegrityViolationException.class);
        expire(preview);
        approvals.previewInitial(f.user(), f.source().toString(), f.name() + "-cleanup");
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where token_sha256 = ?",
                        Integer.class,
                        hash(preview)))
                .isZero();
        assertThat(approvals.requireJobInput(created.jobId(), created.project().id()))
                .isEqualTo(binding);
        assertThat(approvals.outcome(f.user(), preview.previewToken()))
                .isEqualTo(new LocalSourceApprovalService.Outcome(
                        "CONSUMED", created.project().id(), created.jobId()));
    }

    @Test
    void historicalConsumedReceiptDoesNotExpireWithItsTenMinutePreview() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        long project = project(f);
        long job = job(project, "RUNNING");
        // Seed a historical persisted receipt once, rather than updating an immutable receipt.
        jdbc.update("""
                with instant as (select clock_timestamp() as time)
                update local_source_approvals set issued_at = instant.time - interval '23 minutes',
                    expires_at = instant.time - interval '13 minutes', consumed_at = instant.time - interval '14 minutes',
                    consumed_job_id = ? from instant where token_sha256 = ?
                """, job, hash(preview));
        jdbc.update("""
                insert into job_local_source_inputs (job_id, project_id, approval_token_sha256, purpose,
                    base_snapshot_id, schema_version, canonical_root, root_device, root_inode, policy_version,
                    limits_sha256, manifest_sha256, selected_files, selected_bytes, approved_at)
                select ?, ?, token_sha256, purpose, base_snapshot_id, schema_version, canonical_root,
                    root_device, root_inode, policy_version, limits_sha256, manifest_sha256,
                    selected_files, selected_bytes, consumed_at from local_source_approvals where token_sha256 = ?
                """, job, project, hash(preview));
        assertThat(jdbc.queryForObject(
                        "select approved_at < clock_timestamp() - interval '10 minutes' "
                                + "from job_local_source_inputs where job_id = ?",
                        Boolean.class,
                        job))
                .isTrue();
        approvals.previewInitial(f.user(), f.source().toString(), f.name() + "-cleanup");
        assertThat(approvals.requireJobInput(job, project))
                .isEqualTo(imports.inspect(f.source()).binding());
        assertThat(approvals.outcome(f.user(), preview.previewToken()))
                .isEqualTo(new LocalSourceApprovalService.Outcome("CONSUMED", project, job));
        verifyNoInteractions(worker);
    }

    @Test
    void consumedReceiptSurvivesPreviewExpiryCleanupAndSameJobRestartRetry() throws Exception {
        Fixture f = fixture();
        var inspected = imports.inspect(f.source());
        var preview = preview(f);
        var created = confirm(f, preview);
        long project = created.project().id();
        long job = created.jobId();
        var receipt = jdbc.queryForMap("select * from job_local_source_inputs where job_id = ?", job);
        assertThat(receipt.get("manifest_sha256")).isEqualTo(inspected.binding().manifestSha256());

        expire(preview);
        approvals.previewInitial(f.user(), f.source().toString(), f.name() + "-cleanup");
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where token_sha256 = ?",
                        Integer.class,
                        hash(preview)))
                .isZero();

        // Exercise the real local import/inventory/finalization slice without external analyzers.
        jdbc.update(
                "delete from analysis_job_steps where job_id = ? and step_key not in (?, ?, ?)",
                job,
                ImportStep.KEY,
                FileInventoryStep.KEY,
                FinalizeStep.KEY);
        assertThat(jobs.findSteps(job)).hasSize(3);
        assertThat(jobs.markJobRunning(job)).isTrue();
        long importId = jobs.findSteps(job).stream()
                .filter(step -> ImportStep.KEY.equals(step.stepKey()))
                .findFirst()
                .orElseThrow()
                .id();
        jobs.markStepRunning(importId);
        assertThat(approvals.requireJobInput(job, project)).isEqualTo(inspected.binding());

        new JobStartupRecovery(jobs).recover();
        var interrupted = jobs.findJob(job).orElseThrow();
        assertThat(interrupted.status()).isEqualTo(JobStatus.FAILED);
        assertThat(interrupted.failureCode()).isNull();
        assertThat(interrupted.snapshotId()).isNull();
        assertThat(jobs.findSteps(job).getFirst().status()).isEqualTo(StepStatus.FAILED);

        jobService.retry(job, f.user());
        assertThat(jobs.findJob(job).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        verify(worker, times(2)).dispatch(job);
        JobWorker isolated = new JobWorker(
                jobs,
                new Pipeline(List.of(importStep, inventoryStep, finalizeStep)),
                mock(JobProgressPublisher.class),
                app,
                workspaces);
        try {
            isolated.dispatch(job);
            await().atMost(WAIT)
                    .until(() -> jobs.findJob(job).orElseThrow().status().terminal());
        } finally {
            ReflectionTestUtils.invokeMethod(isolated, "shutdown");
        }

        var completed = jobs.findJob(job).orElseThrow();
        assertThat(completed.status()).isEqualTo(JobStatus.DONE);
        assertThat(completed.failureCode()).isNull();
        assertThat(completed.snapshotId()).isNotNull();
        assertThat(jobs.findSteps(job))
                .allSatisfy(step -> assertThat(step.status()).isEqualTo(StepStatus.DONE));
        assertThat(jobs.findSteps(job).getFirst().attempt()).isEqualTo(2);
        long snapshot = completed.snapshotId();
        assertThat(jdbc.queryForObject("select current_snapshot_id from projects where id = ?", Long.class, project))
                .isEqualTo(snapshot);
        assertThat(jdbc.queryForObject("select status from snapshots where id = ?", String.class, snapshot))
                .isEqualTo("READY");
        assertThat(jdbc.queryForObject(
                        "select content_hash from files where snapshot_id = ? and path = 'a.txt'",
                        String.class,
                        snapshot))
                .isEqualTo(inspected.gitFingerprints().get("a.txt"));
        Path target = app.reposRoot().resolve(Long.toString(project));
        try (var git = Git.open(target.toFile());
                var walk = new RevWalk(git.getRepository())) {
            var repository = git.getRepository();
            var head = repository.resolve(Constants.HEAD);
            assertThat(jdbc.queryForObject("select commit_sha from snapshots where id = ?", String.class, snapshot))
                    .isEqualTo(head.name());
            try (var tree =
                    TreeWalk.forPath(repository, "a.txt", walk.parseCommit(head).getTree())) {
                assertThat(tree).isNotNull();
                var blob = tree.getObjectId(0);
                assertThat(blob.name()).isEqualTo(inspected.gitFingerprints().get("a.txt"));
                assertThat(repository.open(blob, Constants.OBJ_BLOB).getBytes())
                        .isEqualTo("AAAA".getBytes(StandardCharsets.UTF_8));
            }
        }
        assertThat(Files.readString(target.resolve("a.txt"))).isEqualTo("AAAA");
        assertThat(Files.readString(f.source().resolve("a.txt"))).isEqualTo("AAAA");
        assertThat(jdbc.queryForMap("select * from job_local_source_inputs where job_id = ?", job))
                .isEqualTo(receipt);
        assertThat(approvals.outcome(f.user(), preview.previewToken()))
                .isEqualTo(new LocalSourceApprovalService.Outcome("CONSUMED", project, job));
        assertCounts(f.user(), 1, 1, 1);
        verifyNoMoreInteractions(worker);
    }

    @Test
    void confirmationFirstMakesRecoveryReturnItsExactReceiptAfterCommitAndCleanup() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        CountDownLatch bound = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger outcomePid = new AtomicInteger();
        ProjectService.CreatedProject created;
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var confirmation = executor.submit(() -> transactions.execute(tx -> {
                var result = confirm(f, preview);
                bound.countDown();
                waitFor(release);
                return result;
            }));
            try {
                waitFor(bound);
                var recovery = executor.submit(() -> transactions.execute(tx -> {
                    outcomePid.set(backendPid());
                    return approvals.outcome(f.user(), preview.previewToken());
                }));
                awaitBlocked(outcomePid);
                verifyNoInteractions(worker);
                release.countDown();
                created = confirmation.get(15, TimeUnit.SECONDS);
                assertThat(recovery.get(15, TimeUnit.SECONDS))
                        .isEqualTo(new LocalSourceApprovalService.Outcome(
                                "CONSUMED", created.project().id(), created.jobId()));
            } finally {
                release.countDown();
            }
        }
        expire(preview);
        approvals.previewInitial(f.user(), f.source().toString(), f.name() + "-cleanup");
        assertThat(approvals.outcome(f.user(), preview.previewToken()))
                .isEqualTo(new LocalSourceApprovalService.Outcome(
                        "CONSUMED", created.project().id(), created.jobId()));
        assertCounts(f.user(), 1, 1, 1);
        verify(worker).dispatch(created.jobId());
    }

    @Test
    void recoveryFirstRevokesALateConfirmationWithoutAnyProjectJobReceiptOrDispatch() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        CountDownLatch revoked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger confirmPid = new AtomicInteger();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var recovery = executor.submit(() -> transactions.execute(tx -> {
                var result = approvals.outcome(f.user(), preview.previewToken());
                revoked.countDown();
                waitFor(release);
                return result;
            }));
            try {
                waitFor(revoked);
                var confirmation = executor.submit(() -> transactions.execute(tx -> {
                    confirmPid.set(backendPid());
                    return confirm(f, preview);
                }));
                awaitBlocked(confirmPid);
                release.countDown();
                assertThat(recovery.get(15, TimeUnit.SECONDS))
                        .isEqualTo(new LocalSourceApprovalService.Outcome("ABANDONED", null, null));
                assertThatThrownBy(() -> confirmation.get(15, TimeUnit.SECONDS))
                        .isInstanceOf(ExecutionException.class)
                        .hasCauseInstanceOf(LocalSourceApprovalException.class)
                        .satisfies(error -> assertCode(error.getCause(), "LOCAL_PREVIEW_INVALID"));
            } finally {
                release.countDown();
            }
        }
        assertThat(approvals.outcome(f.user(), preview.previewToken()))
                .isEqualTo(new LocalSourceApprovalService.Outcome("ABANDONED", null, null));
        assertCounts(f.user(), 0, 0, 0);
        verifyNoInteractions(worker);
    }

    @Test
    void concurrentConfirmationsCreateExactlyOneJobAndReceipt() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> attemptConfirmation(f, preview, start));
            var second = executor.submit(() -> attemptConfirmation(f, preview, start));
            start.countDown();
            var attempts = List.of(first.get(15, TimeUnit.SECONDS), second.get(15, TimeUnit.SECONDS));
            var winners = attempts.stream()
                    .filter(attempt -> attempt.created() != null)
                    .toList();
            assertThat(winners).hasSize(1);
            assertThat(attempts.stream()
                            .filter(attempt -> attempt.error() != null)
                            .toList())
                    .hasSize(1)
                    .allSatisfy(
                            attempt -> assertThat(attempt.error()).isInstanceOf(LocalSourceApprovalException.class));
            verify(worker).dispatch(winners.getFirst().created().jobId());
            verifyNoMoreInteractions(worker);
        }
        assertCounts(f.user(), 1, 1, 1);
    }

    @Test
    void relinkingInvalidatesTheOldApprovalAndActiveJobsBlockRelinking() throws Exception {
        Fixture f = fixture();
        long project = project(f);
        var preview = approvals.previewRefresh(project, f.user());
        Path replacement = Files.createDirectories(root.resolve("replacement-" + UUID.randomUUID()));
        Files.writeString(replacement.resolve("a.txt"), "AAAA");
        projects.relinkLocalSource(project, f.user(), replacement.toString());
        rejected(() -> projects.reanalyze(project, f.user(), preview.previewToken()), "LOCAL_SOURCE_CHANGED");
        assertCounts(f.user(), 1, 0, 0);
        long active = job(project, "RUNNING");
        assertThatThrownBy(() ->
                        projects.relinkLocalSource(project, f.user(), f.source().toString()))
                .isInstanceOf(ProjectConflictException.class);
        assertThat(jdbc.queryForObject("select local_path from projects where id = ?", String.class, project))
                .isEqualTo(replacement.toRealPath().toString());
        assertThat(jobs.findJob(active)).isPresent();
        verifyNoInteractions(worker);
    }

    @Test
    void replacingTheApprovedRootRejectsConfirmationEvenWithIdenticalFiles() throws Exception {
        Fixture f = fixture();
        var preview = preview(f);
        Files.move(f.source(), f.source().resolveSibling(f.source().getFileName() + "-original"));
        Files.createDirectory(f.source());
        Files.writeString(f.source().resolve("a.txt"), "AAAA");
        rejected(() -> confirm(f, preview), "LOCAL_SOURCE_CHANGED");
        assertCounts(f.user(), 0, 0, 0);
        verifyNoInteractions(worker);
    }

    @Test
    void aLegacyLocalJobCannotImportWithoutAPersistedReceipt() throws Exception {
        Fixture f = fixture();
        long project = project(f);
        long job = job(project, "RUNNING");
        JobContext ctx = mock(JobContext.class);
        when(ctx.jobId()).thenReturn(job);
        when(ctx.projectId()).thenReturn(project);
        when(ctx.clonePath()).thenReturn(app.reposRoot().resolve(Long.toString(project)));
        when(ctx.snapshotId()).thenReturn(Optional.empty());
        rejected(() -> approvals.requireJobInput(job, project), "LOCAL_PREVIEW_INVALID");
        rejected(() -> importStep.run(ctx), "LOCAL_PREVIEW_INVALID");
        assertThat(ctx.clonePath()).doesNotExist();
        assertThat(jdbc.queryForObject("select count(*) from snapshots where project_id = ?", Integer.class, project))
                .isZero();
        assertThat(Files.readString(f.source().resolve("a.txt"))).isEqualTo("AAAA");
        verifyNoInteractions(worker);
    }

    @Test
    void sourcePolicyFailurePersistsPreviewRecoveryCodeAndPreservesThePreviousSnapshot() throws Exception {
        Fixture f = fixture();
        long project = project(f);
        Path target = app.reposRoot().resolve(Long.toString(project));
        var old = imports.importFolder(f.source(), target);
        long previous = snapshot(project, old.headSha());
        current(project, previous);
        Files.writeString(f.source().resolve("a.txt"), "BBBB");
        var preview = approvals.previewRefresh(project, f.user());
        long job = projects.reanalyze(project, f.user(), preview.previewToken());
        Files.writeString(f.source().resolve(".gitignore"), "[unsupported-pattern]\n");

        // An isolated real worker executes only this local import fixture, with no external publisher.
        JobWorker isolated = new JobWorker(
                jobs, new Pipeline(List.of(importStep)), mock(JobProgressPublisher.class), app, workspaces);
        try {
            isolated.dispatch(job);
            await().atMost(WAIT)
                    .until(() -> "FAILED"
                            .equals(jdbc.queryForObject(
                                    "select status from analysis_jobs where id = ?", String.class, job)));
        } finally {
            ReflectionTestUtils.invokeMethod(isolated, "shutdown");
        }

        assertThat(jdbc.queryForObject("select failure_code from analysis_jobs where id = ?", String.class, job))
                .isEqualTo("LOCAL_PREVIEW_REQUIRED");
        assertThat(jdbc.queryForObject("select error from analysis_jobs where id = ?", String.class, job))
                .doesNotContain(f.source().toString(), "unsupported-pattern");
        assertThat(jdbc.queryForObject("select current_snapshot_id from projects where id = ?", Long.class, project))
                .isEqualTo(previous);
        assertThat(jdbc.queryForObject("select count(*) from snapshots where project_id = ?", Integer.class, project))
                .isEqualTo(1);
        assertThat(Files.readString(target.resolve("a.txt"))).isEqualTo("AAAA");
        assertThat(target.resolve(".gitignore")).doesNotExist();
        var failed = jobs.findJob(job).orElseThrow();
        var failedSteps = jobs.findSteps(job);
        assertThatThrownBy(() -> jobService.retry(job, f.user()))
                .isInstanceOf(JobConflictException.class)
                .satisfies(error -> assertThat(
                                ((JobConflictException) error).getBody().getDetail())
                        .contains("new local preview"));
        assertThat(jobs.findJob(job).orElseThrow()).isEqualTo(failed);
        assertThat(jobs.findSteps(job)).isEqualTo(failedSteps);
        verify(worker).dispatch(job);
        verifyNoMoreInteractions(worker);
    }

    @Test
    void quotaCountsConsumedAndRevokedUnexpiredGrantsPerOwnerUntilCleanup() throws Exception {
        Fixture f = fixture();
        var grants = new java.util.ArrayList<LocalSourcePreview>();
        for (int index = 0; index < 16; index++) grants.add(preview(f));
        var consumed = confirm(f, grants.getFirst());
        var receipt = jdbc.queryForMap("select * from job_local_source_inputs where job_id = ?", consumed.jobId());
        assertThat(approvals.outcome(f.user(), grants.get(1).previewToken()))
                .isEqualTo(new LocalSourceApprovalService.Outcome("ABANDONED", null, null));

        // Consuming or abandoning a grant cannot refund its ten-minute issuance budget.
        rejected(() -> preview(f), "LOCAL_PREVIEW_BUSY");
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where user_id = ?", Integer.class, f.user()))
                .isEqualTo(16);
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where user_id = ? and consumed_at is not null",
                        Integer.class,
                        f.user()))
                .isEqualTo(1);
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where user_id = ? and revoked_at is not null",
                        Integer.class,
                        f.user()))
                .isEqualTo(1);
        assertCounts(f.user(), 1, 1, 1);

        Fixture other = fixture();
        var otherGrant = preview(other);
        assertThat(otherGrant.previewToken()).isNotBlank();
        assertCounts(other.user(), 0, 0, 0);
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where user_id = ?", Integer.class, other.user()))
                .isEqualTo(1);

        jdbc.update("""
                with instant as (select clock_timestamp() as time)
                update local_source_approvals set issued_at = instant.time - interval '11 minutes',
                    expires_at = instant.time - interval '1 minute'
                from instant where user_id = ?
                """, f.user());
        var nextGrant = preview(f);
        assertThat(nextGrant.previewToken()).isNotBlank();
        assertThat(jdbc.queryForObject(
                        "select count(*) from local_source_approvals where user_id = ?", Integer.class, f.user()))
                .isEqualTo(1);
        assertThat(jdbc.queryForMap("select * from job_local_source_inputs where job_id = ?", consumed.jobId()))
                .isEqualTo(receipt);
        assertThat(approvals.outcome(f.user(), grants.getFirst().previewToken()))
                .isEqualTo(new LocalSourceApprovalService.Outcome(
                        "CONSUMED", consumed.project().id(), consumed.jobId()));
        assertCounts(f.user(), 1, 1, 1);
        verify(worker).dispatch(consumed.jobId());
        verifyNoMoreInteractions(worker);
    }

    private Fixture fixture() throws Exception {
        String unique = UUID.randomUUID().toString();
        long user = jdbc.queryForObject(
                "insert into users (login, identity_type, local_key) " + "values (?, 'LOCAL', ?) returning id",
                Long.class,
                "approval-fixture-" + unique,
                unique);
        Path source = Files.createDirectories(root.resolve("sources/" + unique));
        Files.writeString(source.resolve("a.txt"), "AAAA");
        return new Fixture(user, source, "Approval fixture " + unique);
    }

    private long project(Fixture f) {
        return jdbc.queryForObject(
                """
                insert into projects (user_id, name, repo_owner, repo_name, source_type, local_path)
                values (?, ?, 'local', ?, 'LOCAL', ?) returning id
                """, Long.class, f.user(), f.name(), f.name(), f.source().toString());
    }

    private long job(long project, String status) {
        return jdbc.queryForObject(
                "insert into analysis_jobs (project_id, type, status) " + "values (?, 'IMPORT', ?) returning id",
                Long.class,
                project,
                status);
    }

    private long snapshot(long project, String commit) {
        return jdbc.queryForObject(
                "insert into snapshots (project_id, commit_sha, status) " + "values (?, ?, 'READY') returning id",
                Long.class,
                project,
                commit);
    }

    private void current(long project, long snapshot) {
        jdbc.update("update projects set current_snapshot_id = ? where id = ?", snapshot, project);
    }

    private void running(long job) {
        jdbc.update("update analysis_jobs set status = 'RUNNING' where id = ?", job);
    }

    private LocalSourcePreview preview(Fixture f) {
        return approvals.previewInitial(f.user(), f.source().toString(), f.name());
    }

    private ProjectController.CreateLocalProjectRequest request(Fixture f, LocalSourcePreview preview) {
        return new ProjectController.CreateLocalProjectRequest(f.source().toString(), f.name(), preview.previewToken());
    }

    private ProjectService.CreatedProject confirm(Fixture f, LocalSourcePreview preview) {
        return projects.createFromLocal(f.user(), request(f, preview));
    }

    private Attempt attemptConfirmation(Fixture f, LocalSourcePreview preview, CountDownLatch start) {
        waitFor(start);
        try {
            return new Attempt(confirm(f, preview), null);
        } catch (RuntimeException e) {
            return new Attempt(null, e);
        }
    }

    private void expire(LocalSourcePreview preview) {
        jdbc.update("""
                with instant as (select clock_timestamp() as time)
                update local_source_approvals set issued_at = instant.time - interval '11 minutes',
                    expires_at = instant.time - interval '1 minute'
                from instant where token_sha256 = ?
                """, hash(preview));
    }

    private String hash(LocalSourcePreview preview) {
        return LocalSourceApprovalService.tokenHash(preview.previewToken());
    }

    private void assertUnconsumed(LocalSourcePreview preview) {
        assertThat(jdbc.queryForObject(
                        "select consumed_at is null and consumed_job_id is null "
                                + "from local_source_approvals where token_sha256 = ?",
                        Boolean.class,
                        hash(preview)))
                .isTrue();
    }

    private void assertCounts(long user, int projects, int jobs, int receipts) {
        assertThat(jdbc.queryForObject("select count(*) from projects where user_id = ?", Integer.class, user))
                .isEqualTo(projects);
        assertThat(jdbc.queryForObject(
                        "select count(*) from analysis_jobs j join projects p on p.id = j.project_id "
                                + "where p.user_id = ?",
                        Integer.class,
                        user))
                .isEqualTo(jobs);
        assertThat(jdbc.queryForObject(
                        "select count(*) from job_local_source_inputs i join projects p on p.id = i.project_id "
                                + "where p.user_id = ?",
                        Integer.class,
                        user))
                .isEqualTo(receipts);
    }

    private void lockToken(LocalSourcePreview preview) {
        jdbc.queryForObject(
                "select id from local_source_approvals where token_sha256 = ? for update", Long.class, hash(preview));
    }

    private int backendPid() {
        return jdbc.queryForObject("select pg_backend_pid()", Integer.class);
    }

    private void awaitBlocked(AtomicInteger pid) {
        await().atMost(WAIT)
                .until(() -> pid.get() > 0
                        && Boolean.TRUE.equals(jdbc.queryForObject(
                                "select exists(select 1 from pg_stat_activity where pid = ? and wait_event_type = 'Lock')",
                                Boolean.class,
                                pid.get())));
    }

    private static void waitFor(CountDownLatch latch) {
        try {
            if (!latch.await(15, TimeUnit.SECONDS)) throw new AssertionError("Fixture latch timed out");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }

    private static void rejected(ThrowingCallable operation, String code) {
        assertThatThrownBy(operation)
                .isInstanceOf(LocalSourceApprovalException.class)
                .satisfies(error -> assertCode(error, code));
    }

    private static void assertCode(Throwable error, String code) {
        assertThat(((LocalSourceApprovalException) error).getBody().getProperties())
                .containsEntry("code", code);
    }

    private record Fixture(long user, Path source, String name) {}

    private record Attempt(ProjectService.CreatedProject created, RuntimeException error) {}
}
