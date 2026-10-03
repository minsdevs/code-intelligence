package dev.codeintelligence.maintenance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import dev.codeintelligence.ai.AiRequestPlanService;
import dev.codeintelligence.ai.AssistantController;
import dev.codeintelligence.ai.AssistantService;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.job.JobProgressPublisher;
import dev.codeintelligence.job.JobRecord;
import dev.codeintelligence.job.JobRepository;
import dev.codeintelligence.job.JobStatus;
import dev.codeintelligence.job.JobType;
import dev.codeintelligence.job.JobWorker;
import dev.codeintelligence.job.JobWorkspaceProvider;
import dev.codeintelligence.job.Pipeline;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.core.task.SimpleAsyncTaskExecutor;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.json.JsonMapper;

@Timeout(15)
class MaintenanceBackgroundLeaseTest {
    private final MaintenanceGate gate = new MaintenanceGate();
    private final UUID id = UUID.randomUUID();

    @Test
    void streamStillOwnsItsWriterAfterHttpReturnAndEmitterCompletionUntilServiceReturns() throws Exception {
        var service = mock(AssistantService.class);
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        when(service.ask(anyLong(), anyLong(), any())).thenAnswer(invocation -> {
            entered.countDown();
            awaitLatch(release);
            throw new IllegalStateException("synthetic provider failure after completion");
        });
        var controller = controller(service);
        try {
            var request = gate.admitRequest();
            var emitter = controller.stream(1, null, local());
            request.close();
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
            gate.begin(id);
            emitter.complete();
            assertThat(view().state()).isEqualTo("DRAINING");
            assertThat(view().activeRequests()).isZero();
            assertThat(view().activeWriters()).isEqualTo(1);
        } finally {
            release.countDown();
            executor(controller).close();
        }
        assertThat(view().state()).isEqualTo("DRAINED");
    }

    @Test
    void streamAcceptedByOlderRequestCanStartAfterBeginAndStillReleasesOnFailure() {
        var service = mock(AssistantService.class);
        when(service.ask(anyLong(), anyLong(), any())).thenThrow(new IllegalArgumentException("synthetic failure"));
        var controller = controller(service);
        try (var request = gate.admitRequest()) {
            gate.begin(id);
            controller.stream(1, null, local());
        } finally {
            executor(controller).close();
        }
        assertThat(view().state()).isEqualTo("DRAINED");
    }

    @Test
    void streamDeniedByBarrierNeverCallsTheServiceOrExecutorAndRejectionReleasesTheLease() {
        var service = mock(AssistantService.class);
        var controller = controller(service);
        gate.begin(id);
        assertThatThrownBy(() -> controller.stream(1, null, local())).isInstanceOf(ResponseStatusException.class);
        verifyNoInteractions(service);
        gate.end(gate.current(id), 0);
        executor(controller).close();
        assertThatThrownBy(() -> controller.stream(1, null, local())).isInstanceOf(RuntimeException.class);
        gate.begin(id);
        assertThat(view().state()).isEqualTo("DRAINED");
    }

    @Test
    void jobLeaseSurvivesDoneRowWorkspaceCloseAndFinalCancellationCleanup() throws Exception {
        var repository = mock(JobRepository.class);
        var workspaces = mock(JobWorkspaceProvider.class);
        var workspace = mock(JobWorkspaceProvider.Workspace.class);
        var closeEntered = new CountDownLatch(1);
        var releaseClose = new CountDownLatch(1);
        var cancellationEntered = new CountDownLatch(1);
        var releaseCancellation = new CountDownLatch(1);
        JobRecord job = new JobRecord(7, 1, null, JobType.IMPORT, JobStatus.RUNNING, null, Instant.EPOCH, null, null);
        when(repository.markJobRunning(7)).thenReturn(true);
        when(repository.findJob(7)).thenReturn(Optional.of(job));
        when(repository.findSteps(7)).thenReturn(List.of());
        when(workspaces.open(job)).thenReturn(workspace);
        when(workspace.clonePath()).thenReturn(Path.of("/tmp/synthetic-maintenance-workspace"));
        doAnswer(invocation -> {
                    closeEntered.countDown();
                    awaitLatch(releaseClose);
                    return null;
                })
                .when(workspace)
                .close();
        when(repository.finishCancellation(7)).thenAnswer(invocation -> {
            cancellationEntered.countDown();
            awaitLatch(releaseCancellation);
            return false;
        });
        var worker = worker(repository, workspaces);
        try {
            worker.dispatch(7);
            assertThat(closeEntered.await(3, TimeUnit.SECONDS)).isTrue();
            gate.begin(id);
            assertThat(view().activeJobs()).isEqualTo(1);
            releaseClose.countDown();
            assertThat(cancellationEntered.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(view().state()).isEqualTo("DRAINING");
            assertThat(view().activeJobs()).isEqualTo(1);
        } finally {
            releaseClose.countDown();
            releaseCancellation.countDown();
            await().atMost(Duration.ofSeconds(3))
                    .untilAsserted(() -> assertThat(view().activeJobs()).isZero());
            jobExecutor(worker).close();
        }
        assertThat(view().state()).isEqualTo("DRAINED");
    }

    @Test
    void falseJobClaimReleasesAndAnOlderRequestCanDispatchAfterBegin() {
        var repository = mock(JobRepository.class);
        var workspaces = mock(JobWorkspaceProvider.class);
        var worker = worker(repository, workspaces);
        try (var request = gate.admitRequest()) {
            gate.begin(id);
            worker.dispatch(7);
        }
        await().atMost(Duration.ofSeconds(3))
                .untilAsserted(() -> assertThat(view().state()).isEqualTo("DRAINED"));
        verifyNoInteractions(workspaces);
        jobExecutor(worker).close();
    }

    @Test
    void failedJobSubmissionDoesNotLeakButNeverBypassesAClosedBarrier() {
        var repository = mock(JobRepository.class);
        var workspaces = mock(JobWorkspaceProvider.class);
        var worker = worker(repository, workspaces);
        gate.begin(id);
        assertThatThrownBy(() -> worker.dispatch(7)).isInstanceOf(ResponseStatusException.class);
        verifyNoInteractions(repository, workspaces);
        gate.end(gate.current(id), 0);
        jobExecutor(worker).close();
        assertThatThrownBy(() -> worker.dispatch(7)).isInstanceOf(RuntimeException.class);
        gate.begin(id);
        assertThat(view().state()).isEqualTo("DRAINED");
    }

    private AssistantController controller(AssistantService service) {
        return new AssistantController(service, JsonMapper.builder().build(), mock(AiRequestPlanService.class), gate);
    }

    private JobWorker worker(JobRepository repository, JobWorkspaceProvider workspaces) {
        return new JobWorker(
                repository,
                mock(Pipeline.class),
                mock(JobProgressPublisher.class),
                new AppProperties("/tmp/synthetic-maintenance-data", 2),
                workspaces,
                gate);
    }

    private MaintenanceGate.View view() {
        return gate.snapshot(gate.current(id), 0);
    }

    private static AuthenticatedUser local() {
        return new AuthenticatedUser(1, null, "local", null, null, CredentialKind.LOCAL);
    }

    private static ExecutorService executor(AssistantController controller) {
        return (ExecutorService) ReflectionTestUtils.getField(controller, "executor");
    }

    private static SimpleAsyncTaskExecutor jobExecutor(JobWorker worker) {
        return (SimpleAsyncTaskExecutor) ReflectionTestUtils.getField(worker, "executor");
    }

    private static void awaitLatch(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("synthetic latch timed out");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError("synthetic latch interrupted", error);
        }
    }
}
