package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import dev.codeintelligence.common.security.AuthenticatedUser;
import jakarta.servlet.Filter;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.MethodParameter;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.mock.web.DelegatingServletOutputStream;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;
import tools.jackson.databind.json.JsonMapper;

/** Actual Spring SSE framing with a synthetic service and Redis messages; no DB or network. */
class JobSseSubscriptionRaceTest {
    private static final long JOB_ID = 41;
    private static final long USER_ID = 7;

    private final JobDetailResponse running = state(JobStatus.RUNNING);
    private final JobDetailResponse done = state(JobStatus.DONE);
    private final JobService service = mock(JobService.class);
    private final AuthenticatedUser user = mock(AuthenticatedUser.class);
    private JobSseBroadcaster broadcaster;
    private JsonMapper mapper;
    private String doneJson;

    @BeforeEach
    void setUp() {
        mapper = spy(JsonMapper.builder().build());
        doneJson = mapper.writeValueAsString(done);
        broadcaster = new JobSseBroadcaster(mock(RedisMessageListenerContainer.class), mapper);
        when(user.userId()).thenReturn(USER_ID);
        when(service.getOwnedJob(JOB_ID, USER_ID)).thenReturn(running);
    }

    @AfterEach
    void close() {
        broadcaster.shutdown();
    }

    @Test
    void completionPublishedAfterOwnershipReadButBeforeRegistrationIsRecoveredFromTheDatabase() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        when(service.getOwnedJob(JOB_ID, USER_ID)).thenAnswer(call -> {
            if (reads.incrementAndGet() == 1) {
                // The first lookup observed RUNNING, then the committed DONE event
                // was delivered before the controller could register its subscriber.
                broadcaster.onMessage(message(doneJson), null);
                return running;
            }
            return done;
        });

        MvcResult result = mvc().perform(get("/api/jobs/{id}/events", JOB_ID)).andReturn();

        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        assertThat(wire(result))
                .contains("event:snapshot", "\"status\":\"DONE\"")
                .doesNotContain("\"status\":\"RUNNING\"");
        assertThat(reads.get()).isEqualTo(2);
        assertThat(result.getAsyncResult(1_000)).isNull();
    }

    @Test
    void terminalDeliveryDuringInitialSnapshotMustFollowThatSnapshotAndCompleteTheStream() throws Exception {
        AtomicBoolean published = new AtomicBoolean();
        doAnswer(call -> {
                    if (published.compareAndSet(false, true)) {
                        // Explicit event order, not a timing assumption: delivery happens
                        // inside initial snapshot serialization, before its first wire write.
                        broadcaster.onMessage(message(doneJson), null);
                    }
                    return call.callRealMethod();
                })
                .when(mapper)
                .writeValueAsString(running);

        MvcResult result = mvc().perform(get("/api/jobs/{id}/events", JOB_ID)).andReturn();

        String body = wire(result);
        assertThat(published).isTrue();
        assertThat(body).contains("event:snapshot", "\"status\":\"RUNNING\"", "event:update", "\"status\":\"DONE\"");
        assertThat(body.indexOf("event:snapshot")).isLessThan(body.indexOf("event:update"));
        assertThat(result.getAsyncResult(1_000)).isNull();
    }

    @Test
    void anOldTerminalBroadcastCannotCompleteASubscriberAddedAfterItsTargetSelection() throws Exception {
        CountDownLatch terminalWriteEntered = new CountDownLatch(1);
        CountDownLatch releaseTerminalWrite = new CountDownLatch(1);
        Filter gate = terminalWriteGate(terminalWriteEntered, releaseTerminalWrite);
        MockMvc mvc = mvc(gate);
        MvcResult first = mvc.perform(get("/api/jobs/{id}/events", JOB_ID).requestAttr("holdTerminal", true))
                .andReturn();
        assertThat(wire(first)).contains("\"status\":\"RUNNING\"");

        var executor = Executors.newSingleThreadExecutor();
        try {
            var terminal = executor.submit(() -> broadcaster.onMessage(message(doneJson), null));
            await(terminalWriteEntered);
            // The broadcaster is already writing to its selected first subscriber.
            // A separate retry/connection now has a RUNNING database snapshot.
            MvcResult later = mvc.perform(get("/api/jobs/{id}/events", JOB_ID)).andReturn();
            assertThat(wire(later)).contains("event:snapshot", "\"status\":\"RUNNING\"");
            releaseTerminalWrite.countDown();
            terminal.get(5, TimeUnit.SECONDS);
            assertThat(first.getAsyncResult(1_000)).isNull();

            broadcaster.onMessage(message(mapper.writeValueAsString(state(JobStatus.CANCELLING))), null);
            assertThat(wire(later))
                    .contains("event:update", "\"status\":\"CANCELLING\"")
                    .doesNotContain("\"status\":\"DONE\"");
        } finally {
            releaseTerminalWrite.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void rejectedOwnershipCannotRegisterOrSendThroughTheBroadcaster() {
        JobSseBroadcaster untouched = mock(JobSseBroadcaster.class);
        when(service.getOwnedJob(JOB_ID, USER_ID)).thenThrow(new JobNotFoundException());

        assertThatThrownBy(() -> new JobEventsController(service, untouched).events(JOB_ID, user))
                .isInstanceOf(JobNotFoundException.class);
        verifyNoInteractions(untouched);
    }

    @Test
    void aTerminalReloadSupersedesNonterminalEventsBufferedDuringTheLookup() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        String runningJson = mapper.writeValueAsString(running);
        when(service.getOwnedJob(JOB_ID, USER_ID)).thenAnswer(call -> {
            if (reads.incrementAndGet() == 1) return running;
            broadcaster.onMessage(message(runningJson), null);
            return done;
        });

        MvcResult result = mvc().perform(get("/api/jobs/{id}/events", JOB_ID)).andReturn();

        assertThat(wire(result))
                .contains("event:snapshot", "\"status\":\"DONE\"")
                .doesNotContain("event:update", "\"status\":\"RUNNING\"");
        assertThat(result.getAsyncResult(1_000)).isNull();
    }

    @Test
    void aBlockedInitialReloadDoesNotBlockAnExistingSubscriberAndBuffersItsOwnTerminal() throws Exception {
        CountDownLatch reloadEntered = new CountDownLatch(1);
        CountDownLatch releaseReload = new CountDownLatch(1);
        AtomicInteger reads = new AtomicInteger();
        when(service.getOwnedJob(JOB_ID, USER_ID)).thenAnswer(call -> {
            if (reads.incrementAndGet() == 4) {
                reloadEntered.countDown();
                await(releaseReload);
            }
            return running;
        });
        MockMvc mvc = mvc();
        MvcResult existing = mvc.perform(get("/api/jobs/{id}/events", JOB_ID)).andReturn();
        var executor = Executors.newFixedThreadPool(2);
        try {
            var connecting = executor.submit(
                    () -> mvc.perform(get("/api/jobs/{id}/events", JOB_ID)).andReturn());
            await(reloadEntered);
            var publish = executor.submit(() -> broadcaster.onMessage(message(doneJson), null));
            publish.get(3, TimeUnit.SECONDS);
            assertThat(wire(existing)).contains("event:update", "\"status\":\"DONE\"");
            assertThat(existing.getAsyncResult(1_000)).isNull();

            releaseReload.countDown();
            MvcResult later = connecting.get(3, TimeUnit.SECONDS);
            String body = wire(later);
            assertThat(body).contains("event:snapshot", "event:update", "\"status\":\"DONE\"");
            assertThat(body.indexOf("event:snapshot")).isLessThan(body.indexOf("event:update"));
            assertThat(later.getAsyncResult(1_000)).isNull();
        } finally {
            releaseReload.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    private MockMvc mvc(Filter... filters) {
        return MockMvcBuilders.standaloneSetup(new JobEventsController(service, broadcaster))
                .setCustomArgumentResolvers(new HandlerMethodArgumentResolver() {
                    @Override
                    public boolean supportsParameter(MethodParameter parameter) {
                        return parameter.getParameterType() == AuthenticatedUser.class;
                    }

                    @Override
                    public Object resolveArgument(
                            MethodParameter parameter,
                            ModelAndViewContainer container,
                            NativeWebRequest request,
                            org.springframework.web.bind.support.WebDataBinderFactory binderFactory) {
                        return user;
                    }
                })
                .addFilters(filters)
                .build();
    }

    private static Filter terminalWriteGate(CountDownLatch entered, CountDownLatch release) {
        return (request, response, chain) -> {
            if (!Boolean.TRUE.equals(((HttpServletRequest) request).getAttribute("holdTerminal"))) {
                chain.doFilter(request, response);
                return;
            }
            chain.doFilter(request, new HttpServletResponseWrapper((HttpServletResponse) response) {
                private ServletOutputStream stream;

                @Override
                public ServletOutputStream getOutputStream() throws IOException {
                    if (stream == null) {
                        stream = new DelegatingServletOutputStream(new FilterOutputStream(super.getOutputStream()) {
                            private static final String MARKER = "\"status\":\"DONE\"";
                            private final StringBuilder tail = new StringBuilder();
                            private boolean held;

                            @Override
                            public void write(int value) throws IOException {
                                tail.append((char) (value & 0xff));
                                if (tail.length() > MARKER.length()) tail.deleteCharAt(0);
                                if (!held && MARKER.contentEquals(tail)) {
                                    held = true;
                                    entered.countDown();
                                    await(release);
                                }
                                out.write(value);
                            }

                            @Override
                            public void write(byte[] bytes, int offset, int length) throws IOException {
                                for (int i = offset; i < offset + length; i++) write(bytes[i]);
                            }
                        });
                    }
                    return stream;
                }
            });
        };
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("SSE fixture phase was not reached");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("SSE fixture interrupted", interrupted);
        }
    }

    private static String wire(MvcResult result) throws Exception {
        return result.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static Message message(String json) {
        Message message = mock(Message.class);
        when(message.getChannel())
                .thenReturn(JobProgressPublisher.channelFor(JOB_ID).getBytes(StandardCharsets.UTF_8));
        when(message.getBody()).thenReturn(json.getBytes(StandardCharsets.UTF_8));
        return message;
    }

    private static JobDetailResponse state(JobStatus status) {
        return new JobDetailResponse(JOB_ID, 2, 3L, JobType.IMPORT, status, null, null, null, null, List.of(), null);
    }
}
