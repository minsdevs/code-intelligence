package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.databind.json.JsonMapper;

/** Failure/lifecycle probes use real emitters; the companion race suite verifies actual MVC SSE frames. */
class JobSseLifecycleTest {
    private static final long JOB_ID = 41;
    private static final long USER_ID = 7;
    private final JobDetailResponse running = state(JobStatus.RUNNING);
    private final ArrayDeque<SseEmitter> supplied = new ArrayDeque<>();
    private JsonMapper mapper;
    private JobSseBroadcaster broadcaster;
    private SseEmitter emitter;

    @BeforeEach
    void setUp() {
        mapper = spy(JsonMapper.builder().build());
        emitter = newEmitter();
        broadcaster = new JobSseBroadcaster(mock(RedisMessageListenerContainer.class), mapper) {
            @Override
            SseEmitter createEmitter() {
                return supplied.removeFirst();
            }
        };
        // Drive the existing heartbeat action explicitly rather than racing the real 15-second clock.
        ((ScheduledExecutorService) ReflectionTestUtils.getField(broadcaster, "heartbeatScheduler")).shutdownNow();
    }

    @AfterEach
    void close() {
        broadcaster.shutdown();
    }

    @Test
    void anOwnershipRecheckFailureRemovesTheRegistrationWithoutSendingBufferedData() throws Exception {
        JobService service = mock(JobService.class);
        AuthenticatedUser user = mock(AuthenticatedUser.class);
        when(user.userId()).thenReturn(USER_ID);
        JobNotFoundException failure = new JobNotFoundException();
        AtomicInteger reads = new AtomicInteger();
        when(service.getOwnedJob(JOB_ID, USER_ID)).thenAnswer(call -> {
            if (reads.incrementAndGet() == 1) return running;
            publish(state(JobStatus.DONE));
            throw failure;
        });

        assertThatThrownBy(() -> new JobEventsController(service, broadcaster).events(JOB_ID, user))
                .isSameAs(failure);

        assertThat(reads.get()).isEqualTo(2);
        assertThat(registry()).isEmpty();
        verify(emitter).completeWithError(failure);
        publish(state(JobStatus.CANCELLING));
        heartbeat();
        verify(emitter, never()).send(any(SseEmitter.SseEventBuilder.class));
    }

    @Test
    void initialSerializationFailurePrunesBeforeAnySnapshotOrBufferedUpdateIsSent() throws Exception {
        IllegalStateException failure = new IllegalStateException("synthetic snapshot serialization failure");
        doAnswer(call -> {
                    publish(state(JobStatus.DONE));
                    throw failure;
                })
                .when(mapper)
                .writeValueAsString(running);

        assertThat(broadcaster.subscribe(JOB_ID, running)).isSameAs(emitter);

        assertThat(registry()).isEmpty();
        verify(emitter).completeWithError(failure);
        verify(emitter, never()).send(any(SseEmitter.SseEventBuilder.class));
    }

    @Test
    void anInitialSendFailurePrunesImmediatelyWithoutWaitingForServletCompletion() throws Exception {
        IOException failure = new IOException("synthetic snapshot write failure");
        doThrow(failure).when(emitter).send(any(SseEmitter.SseEventBuilder.class));

        assertThat(broadcaster.subscribe(JOB_ID, running)).isSameAs(emitter);

        assertThat(registry()).isEmpty();
        verify(emitter).completeWithError(failure);
        publish(state(JobStatus.DONE));
        heartbeat();
        verify(emitter, times(1)).send(any(SseEmitter.SseEventBuilder.class));
    }

    @Test
    void aFailedUpdateRemovesOnlyItsOwnSubscriber() throws Exception {
        broadcaster.subscribe(JOB_ID, running);
        SseEmitter healthy = newEmitter();
        broadcaster.subscribe(JOB_ID, running);
        IOException failure = new IOException("synthetic update write failure");
        doThrow(failure).when(emitter).send(any(SseEmitter.SseEventBuilder.class));

        publish(state(JobStatus.CANCELLING));

        assertThat((List<?>) registry().get(JOB_ID)).hasSize(1);
        verify(emitter).completeWithError(failure);
        verify(healthy, times(2)).send(any(SseEmitter.SseEventBuilder.class));
        publish(state(JobStatus.DONE));
        verify(healthy, times(3)).send(any(SseEmitter.SseEventBuilder.class));
        verify(healthy).complete();
        verify(emitter, times(2)).send(any(SseEmitter.SseEventBuilder.class));
        assertThat(registry()).isEmpty();
    }

    @Test
    void aHeartbeatWriteFailureAlsoRemovesTheSubscription() throws Exception {
        broadcaster.subscribe(JOB_ID, running);
        IOException failure = new IOException("synthetic heartbeat write failure");
        doThrow(failure).when(emitter).send(any(SseEmitter.SseEventBuilder.class));

        heartbeat();

        verify(emitter).completeWithError(failure);
        assertThat(registry()).isEmpty();
        publish(state(JobStatus.DONE));
        heartbeat();
        verify(emitter, times(2)).send(any(SseEmitter.SseEventBuilder.class));
    }

    @ParameterizedTest
    @ValueSource(strings = {"completion", "timeout", "error"})
    @SuppressWarnings({"unchecked", "rawtypes"})
    void containerLifecycleCallbacksRemoveTheSubscription(String callbackName) throws Exception {
        broadcaster.subscribe(JOB_ID, running);
        if ("error".equals(callbackName)) {
            ArgumentCaptor<Consumer> callback = ArgumentCaptor.forClass(Consumer.class);
            verify(emitter).onError(callback.capture());
            callback.getValue().accept(new IOException("synthetic disconnect"));
        } else {
            ArgumentCaptor<Runnable> callback = ArgumentCaptor.forClass(Runnable.class);
            if ("timeout".equals(callbackName)) verify(emitter).onTimeout(callback.capture());
            else verify(emitter).onCompletion(callback.capture());
            callback.getValue().run();
            if ("timeout".equals(callbackName)) verify(emitter).complete();
        }

        assertThat(registry()).isEmpty();
        publish(state(JobStatus.DONE));
        heartbeat();
        verify(emitter, times(1)).send(any(SseEmitter.SseEventBuilder.class));
    }

    @Test
    void shutdownCompletesExistingSubscribersAndRefusesNewSnapshotLoads() throws Exception {
        broadcaster.subscribe(JOB_ID, running);
        broadcaster.shutdown();
        verify(emitter).complete();
        assertThat(registry()).isEmpty();
        SseEmitter later = newEmitter();
        AtomicInteger reads = new AtomicInteger();

        broadcaster.subscribeAfterOwnership(JOB_ID, () -> {
            reads.incrementAndGet();
            return running;
        });

        assertThat(reads.get()).isZero();
        assertThat(registry()).isEmpty();
        verify(later).complete();
        verify(later, never()).send(any(SseEmitter.SseEventBuilder.class));
    }

    @Test
    void synchronousPublishInsideTheSnapshotWriteCannotOvertakeThatWriteOrCompleteItEarly() throws Exception {
        List<String> order = new ArrayList<>();
        AtomicInteger sends = new AtomicInteger();
        doAnswer(call -> {
                    int number = sends.incrementAndGet();
                    order.add("enter-" + number);
                    if (number == 1) publish(state(JobStatus.DONE));
                    Object result = call.callRealMethod();
                    order.add("sent-" + number);
                    return result;
                })
                .when(emitter)
                .send(any(SseEmitter.SseEventBuilder.class));
        doAnswer(call -> {
                    order.add("complete");
                    return call.callRealMethod();
                })
                .when(emitter)
                .complete();

        broadcaster.subscribe(JOB_ID, running);

        assertThat(order).containsExactly("enter-1", "sent-1", "enter-2", "sent-2", "complete");
        assertThat(registry()).isEmpty();
        publish(state(JobStatus.RUNNING));
        heartbeat();
        assertThat(sends.get()).isEqualTo(2);
    }

    @Test
    void aPendingInitialLookupHasABoundedEventCountAndEmitsNoHeartbeat() throws Exception {
        String payload = mapper.writeValueAsString(running);
        broadcaster.subscribeAfterOwnership(JOB_ID, () -> {
            heartbeat();
            for (int i = 0; i <= JobSseBroadcaster.MAX_PENDING_EVENTS; i++) publish(payload);
            return running;
        });

        assertOverflowWithoutData();
    }

    @Test
    void oneOversizedPendingPayloadIsRejected() throws Exception {
        String payload = "x".repeat(JobSseBroadcaster.MAX_PENDING_PAYLOAD_CHARS + 1);
        broadcaster.subscribeAfterOwnership(JOB_ID, () -> {
            publish(payload);
            return running;
        });

        assertOverflowWithoutData();
    }

    @Test
    void accumulatedPendingPayloadsAreBoundedEvenBelowTheEventCountLimit() throws Exception {
        String payload = "x".repeat(JobSseBroadcaster.MAX_PENDING_PAYLOAD_CHARS / 2 + 1);
        broadcaster.subscribeAfterOwnership(JOB_ID, () -> {
            publish(payload);
            publish(payload);
            return running;
        });

        assertOverflowWithoutData();
    }

    private void assertOverflowWithoutData() throws Exception {
        assertThat(registry()).isEmpty();
        ArgumentCaptor<Throwable> failure = ArgumentCaptor.forClass(Throwable.class);
        verify(emitter).completeWithError(failure.capture());
        assertThat(failure.getValue())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("SSE pending event capacity exceeded");
        publish(state(JobStatus.DONE));
        heartbeat();
        verify(emitter, never()).send(any(SseEmitter.SseEventBuilder.class));
    }

    private SseEmitter newEmitter() {
        SseEmitter next = spy(new SseEmitter(1_000L));
        supplied.addLast(next);
        return next;
    }

    private Map<?, ?> registry() {
        return (Map<?, ?>) ReflectionTestUtils.getField(broadcaster, "emitters");
    }

    private void heartbeat() {
        ReflectionTestUtils.invokeMethod(broadcaster, "sendHeartbeats");
    }

    private void publish(JobDetailResponse state) {
        publish(mapper.writeValueAsString(state));
    }

    private void publish(String payload) {
        Message message = mock(Message.class);
        when(message.getChannel())
                .thenReturn(JobProgressPublisher.channelFor(JOB_ID).getBytes(StandardCharsets.UTF_8));
        when(message.getBody()).thenReturn(payload.getBytes(StandardCharsets.UTF_8));
        broadcaster.onMessage(message, null);
    }

    private static JobDetailResponse state(JobStatus status) {
        return new JobDetailResponse(JOB_ID, 2, 3L, JobType.IMPORT, status, null, null, null, null, List.of(), null);
    }
}
