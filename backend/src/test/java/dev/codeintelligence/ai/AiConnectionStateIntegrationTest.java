package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.FakeGithubApi;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.EntityExchangeResult;
import org.springframework.test.web.servlet.client.RestTestClient;
import tools.jackson.databind.json.JsonMapper;

/** Real settings HTTP, transactions and runtime resolver; providers are local in-memory stand-ins. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.auth.pat-login-max-attempts=100",
            "app.ai.provider=openai",
            "app.ai.openai.api-key=ENV_ONLY_SENTINEL",
            "app.ai.openai.chat-model=gpt-4o-mini",
            "app.ai.openai.chat-models=gpt-4o-mini"
        })
@AutoConfigureRestTestClient
@Import({TestcontainersConfiguration.class, AiConnectionStateIntegrationTest.Providers.class})
@Timeout(20)
class AiConnectionStateIntegrationTest {
    private static final FakeGithubApi GITHUB = new FakeGithubApi();
    private static final String MODEL = "gpt-4o-mini";

    @TempDir
    static Path root;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.github.base-url", GITHUB::baseUrl);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
    }

    @AfterAll
    static void closeGithub() {
        GITHUB.close();
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class Providers {
        @Bean
        @Primary
        FakeFactory connectionStateFactory() {
            return new FakeFactory();
        }
    }

    @Autowired
    private RestTestClient http;

    @Autowired
    private JsonMapper json;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private AiSettingsService settings;

    @Autowired
    private AIProviderResolver resolver;

    @Autowired
    private FakeFactory factory;

    @Autowired
    private AiDispatchGate gate;

    @Autowired
    private AiProperties properties;

    @Autowired
    private ConfigurableEnvironment environment;

    private ResponseCookie session;
    private long userId;

    @BeforeEach
    void loginAndResetOwnFixture() {
        assertThat(properties.models("openai")).contains(MODEL);
        ResponseCookie csrf = csrf();
        var login = http.post()
                .uri("/api/auth/pat")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("token", FakeGithubApi.VALID_TOKEN))
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        session = login.getResponseCookies().getFirst("SESSION");
        assertThat(session).isNotNull();
        userId =
                jdbc.queryForObject("select id from users where github_id=?", Long.class, FakeGithubApi.USER_GITHUB_ID);
        assertThat(gate.activeRequests(userId)).isZero();
        jdbc.update("delete from user_ai_settings where user_id=?", userId);
        jdbc.update("delete from user_ai_preferences where user_id=?", userId);
        factory.reset();
    }

    @Test
    void environmentKeyDoesNotOptInANewUser() {
        assertThat(get("/api/ai/settings")).isNull();
        assertThat(get("/api/ai/status")).containsEntry("configured", false);
        assertThat(resolver.resolve(userId).enabled()).isFalse();
        assertThat(factory.created.get()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"chat", "embed", "stream", "testConnection"})
    void desktopSafetyBlocksExistingAndNewConnectionsWhileOffRemainsAvailable(String operation) {
        save("synthetic-key-before-desktop-guard");
        AIProvider previouslyResolved = resolver.resolve(userId);
        long revision =
                jdbc.queryForObject("select revision from user_ai_preferences where user_id=?", Long.class, userId);
        factory.reset();
        String sourceName = "synthetic-desktop-safety-fixture";
        environment
                .getPropertySources()
                .addFirst(new MapPropertySource(
                        sourceName, Map.of("app.desktop.local-identity", "synthetic-guard-identity")));
        try {
            assertThat(get("/api/ai/status"))
                    .containsEntry("configured", false)
                    .containsEntry("blockedReason", "DESKTOP_AI_SAFETY_UNAVAILABLE");
            assertThat(resolver.resolve(userId).enabled()).isFalse();
            assertThatThrownBy(() -> invoke(previouslyResolved, operation))
                    .isInstanceOf(AiSafetyUnavailableException.class);
            assertThat(change(HttpMethod.PUT, body("synthetic-must-not-probe"), HttpStatus.SERVICE_UNAVAILABLE))
                    .containsEntry("code", "DESKTOP_AI_SAFETY_UNAVAILABLE");
            assertThat(jdbc.queryForObject(
                            "select revision from user_ai_preferences where user_id=?", Long.class, userId))
                    .isEqualTo(revision);
            assertThat(factory.created.get()
                            + factory.probes.get()
                            + factory.chats.get()
                            + factory.embeddings.get()
                            + factory.streams.get())
                    .isZero();
            assertThat(change(HttpMethod.DELETE, null, HttpStatus.OK)).containsEntry("state", "OFF");
            assertThat(keyCount()).isZero();
        } finally {
            environment.getPropertySources().remove(sourceName);
        }
    }

    @Test
    void saveClearAndAFreshResolverKeepOffPreferencesWithoutEnvironmentFallback() {
        var saved = save("synthetic-explicit-key");
        assertThat(saved).containsEntry("state", "ENABLED").containsEntry("keySet", true);
        assertThat(saved.toString()).doesNotContain("synthetic-explicit-key", "ENV_ONLY_SENTINEL");
        assertThat(get("/api/ai/status")).containsEntry("configured", true);

        var disabled = change(HttpMethod.DELETE, null, HttpStatus.OK);

        assertThat(disabled)
                .containsEntry("state", "OFF")
                .containsEntry("keySet", false)
                .containsEntry("keyMasked", null)
                .containsEntry("provider", "openai")
                .containsEntry("model", MODEL)
                .containsEntry("activeRequests", 0);
        assertThat(get("/api/ai/settings")).isEqualTo(disabled);
        assertThat(get("/api/ai/status")).containsEntry("configured", false);
        assertThat(new AIProviderConfig.RuntimeAIProvider(settings, factory)
                        .resolve(userId)
                        .enabled())
                .isFalse();
        assertThat(keyCount()).isZero();
        assertThat(factory.probes.get()).isEqualTo(1);
        assertThat(factory.chats.get() + factory.embeddings.get() + factory.streams.get())
                .isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"chat", "embed", "stream", "testConnection"})
    void alreadyResolvedProvidersMustRecheckOffBeforeEveryOperation(String operation) {
        save("synthetic-key-before-clear");
        AIProvider resolved = resolver.resolve(userId);
        change(HttpMethod.DELETE, null, HttpStatus.OK);

        assertThatThrownBy(() -> invoke(resolved, operation)).isInstanceOf(AiSettingsChangedException.class);

        assertThat(factory.probes.get()).isEqualTo(1);
        assertThat(factory.chats.get() + factory.embeddings.get() + factory.streams.get())
                .isZero();
        assertThat(gate.activeRequests(userId)).isZero();
    }

    @Test
    void reconnectStateNeverDecryptsOrReusesAnOldCredential() {
        save("synthetic-original-key");
        jdbc.update(
                "update user_ai_preferences set connection_state='RECONNECT_REQUIRED', revision=revision+1 where user_id=?",
                userId);
        jdbc.update("update user_ai_settings set encrypted_key='invalid-ciphertext-sentinel' where user_id=?", userId);
        factory.reset();

        assertThat(get("/api/ai/settings"))
                .containsEntry("state", "RECONNECT_REQUIRED")
                .containsEntry("keySet", false)
                .containsEntry("keyMasked", null)
                .containsEntry("model", MODEL);
        assertThat(get("/api/ai/status")).containsEntry("configured", false);
        change(HttpMethod.PUT, body(""), HttpStatus.BAD_REQUEST);
        assertThat(factory.created.get()).isZero();

        var reconnected = save("synthetic-new-key");
        assertThat(reconnected).containsEntry("state", "ENABLED").containsEntry("keySet", true);
        assertThat(get("/api/ai/status")).containsEntry("configured", true);
    }

    @Test
    void missingCredentialRequiresReconnectEvenIfThePreferenceSaysEnabled() {
        jdbc.update("""
                insert into user_ai_preferences (user_id,provider,model,connection_state)
                values (?, 'openai', ?, 'ENABLED')
                """, userId, MODEL);
        assertThat(get("/api/ai/settings"))
                .containsEntry("state", "RECONNECT_REQUIRED")
                .containsEntry("keySet", false);
        assertThat(get("/api/ai/status")).containsEntry("configured", false);
        assertThat(factory.created.get()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"ciphertext", "authentication", "nonce", "keyVersion"})
    void anUnreadableEnabledKeyShowsReconnectAndRequiresAnExplicitNewKey(String damage) {
        save("synthetic-original-key");
        AIProvider previouslyResolved = resolver.resolve(userId);
        switch (damage) {
            case "ciphertext" ->
                jdbc.update(
                        "update user_ai_settings set encrypted_key='invalid-ciphertext-sentinel' where user_id=?",
                        userId);
            case "authentication" ->
                jdbc.update(
                        "update user_ai_settings set encrypted_key=? where user_id=?",
                        java.util.Base64.getEncoder().encodeToString(new byte[32]),
                        userId);
            case "nonce" -> jdbc.update("update user_ai_settings set nonce=decode('', 'hex') where user_id=?", userId);
            case "keyVersion" -> jdbc.update("update user_ai_settings set key_version=99 where user_id=?", userId);
            default -> throw new AssertionError(damage);
        }
        factory.reset();

        assertThat(get("/api/ai/settings"))
                .containsEntry("state", "RECONNECT_REQUIRED")
                .containsEntry("keySet", false)
                .containsEntry("keyMasked", null)
                .containsEntry("model", MODEL);
        assertThat(get("/api/ai/status")).containsEntry("configured", false);
        assertThat(resolver.resolve(userId).enabled()).isFalse();
        assertThatThrownBy(() -> invoke(previouslyResolved, "chat")).isInstanceOf(AiSettingsChangedException.class);
        assertThat(factory.chats.get()).isZero();
        change(HttpMethod.PUT, body(""), HttpStatus.BAD_REQUEST);
        assertThat(factory.created.get()).isZero();

        assertThat(save("synthetic-replacement-key")).containsEntry("state", "ENABLED");
    }

    @Test
    void aSlowSaveCannotReenableTheAccountAfterClear() throws Exception {
        Block block = new Block("synthetic-slow-key");
        factory.probeBlock = block;
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var pending = executor.submit(() -> settings.set(userId, "openai", MODEL, block.key));
            try {
                assertThat(block.entered.await(5, TimeUnit.SECONDS)).isTrue();
                var cleared = change(HttpMethod.DELETE, null, HttpStatus.OK);
                assertThat(cleared).containsEntry("state", "OFF").containsEntry("activeRequests", 1);
            } finally {
                block.release.countDown();
            }
            assertThatThrownBy(() -> pending.get(5, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class)
                    .hasCauseInstanceOf(AiSettingsChangedException.class);
        }
        assertThat(get("/api/ai/settings")).containsEntry("state", "OFF").containsEntry("activeRequests", 0);
        assertThat(keyCount()).isZero();
        assertThat(resolver.resolve(userId).enabled()).isFalse();
    }

    @Test
    void aLaterSaveWinsEvenWhenAnEarlierConnectionProbeFinishesLast() throws Exception {
        Block block = new Block("synthetic-older-key");
        factory.probeBlock = block;
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var older = executor.submit(() -> settings.set(userId, "openai", MODEL, block.key));
            try {
                assertThat(block.entered.await(5, TimeUnit.SECONDS)).isTrue();
                save("synthetic-newer-key");
            } finally {
                block.release.countDown();
            }
            assertThatThrownBy(() -> older.get(5, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class)
                    .hasCauseInstanceOf(AiSettingsChangedException.class);
        }
        assertThat(settings.getKey(userId).orElseThrow().apiKey()).isEqualTo("synthetic-newer-key");
        assertThat(gate.activeRequests(userId)).isZero();
    }

    @Test
    void offDoesNotWaitForAnEarlierAdmittedRequestAndReportsIt() throws Exception {
        save("synthetic-active-key");
        AIProvider provider = resolver.resolve(userId);
        Block block = new Block("synthetic-active-key");
        factory.chatBlock = block;
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var inFlight = executor.submit(() -> provider.chat(new AIProvider.ChatRequest("test", "test", true)));
            try {
                assertThat(block.entered.await(5, TimeUnit.SECONDS)).isTrue();
                var off = executor.submit(() -> change(HttpMethod.DELETE, null, HttpStatus.OK));
                assertThat(off.get(3, TimeUnit.SECONDS))
                        .containsEntry("state", "OFF")
                        .containsEntry("activeRequests", 1);
                assertThatThrownBy(() -> provider.embed("must-not-send"))
                        .isInstanceOf(AiSettingsChangedException.class);
            } finally {
                block.release.countDown();
            }
            assertThat(inFlight.get(5, TimeUnit.SECONDS).explanation()).isEqualTo("synthetic response");
        }
        assertThat(get("/api/ai/settings")).containsEntry("activeRequests", 0);
        assertThat(factory.chats.get()).isEqualTo(1);
        assertThat(factory.embeddings.get()).isZero();
    }

    @Test
    void aCredentialDeleteFailureRollsBackOffAndRevisionTogether() {
        save("synthetic-preserved-key");
        long before = revision();
        jdbc.execute("""
                create function ci_test_reject_key_delete() returns trigger language plpgsql as $$
                begin raise exception 'synthetic deletion failure'; end $$
                """);
        jdbc.execute("create trigger ci_test_reject_key_delete before delete on user_ai_settings "
                + "for each row execute function ci_test_reject_key_delete()");
        try {
            change(HttpMethod.DELETE, null, HttpStatus.INTERNAL_SERVER_ERROR);
            assertThat(revision()).isEqualTo(before);
            assertThat(keyCount()).isEqualTo(1);
            assertThat(get("/api/ai/settings"))
                    .containsEntry("state", "ENABLED")
                    .containsEntry("keySet", true);
        } finally {
            jdbc.execute("drop trigger ci_test_reject_key_delete on user_ai_settings");
            jdbc.execute("drop function ci_test_reject_key_delete()");
        }
    }

    @Test
    void clearIsOwnerScopedAndStillRequiresCsrf() {
        save("synthetic-own-key");
        long other = jdbc.queryForObject(
                "insert into users (github_id,login) values (?,?) returning id",
                Long.class,
                System.nanoTime(),
                "other-" + System.nanoTime());
        settings.set(other, "openai", MODEL, "synthetic-other-key");

        http.delete()
                .uri("/api/ai/settings")
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isForbidden();
        assertThat(keyCount()).isEqualTo(1);
        change(HttpMethod.DELETE, null, HttpStatus.OK);
        assertThat(resolver.resolve(other).enabled()).isTrue();
        assertThat(settings.get(other).orElseThrow().state()).isEqualTo("ENABLED");
        http.get().uri("/api/ai/settings").exchange().expectStatus().isUnauthorized();
    }

    private long revision() {
        return jdbc.queryForObject("select revision from user_ai_preferences where user_id=?", Long.class, userId);
    }

    private long keyCount() {
        return jdbc.queryForObject("select count(*) from user_ai_settings where user_id=?", Long.class, userId);
    }

    private Map<String, Object> save(String key) {
        return change(HttpMethod.PUT, body(key), HttpStatus.OK);
    }

    private Map<String, String> body(String key) {
        return Map.of("provider", "openai", "model", MODEL, "apiKey", key);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> get(String uri) {
        byte[] bytes = http.get()
                .uri(uri)
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
        return json.readValue(bytes, Map.class);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> change(HttpMethod method, Object body, HttpStatus expected) {
        ResponseCookie csrf = csrf();
        var request = http.method(method)
                .uri("/api/ai/settings")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue());
        if (body != null) request.body(body);
        byte[] bytes = request.exchange()
                .expectStatus()
                .isEqualTo(expected)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
        return bytes == null || bytes.length == 0 ? null : json.readValue(bytes, Map.class);
    }

    private ResponseCookie csrf() {
        EntityExchangeResult<byte[]> result = http.get()
                .uri("/api/csrf")
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        return result.getResponseCookies().getFirst("XSRF-TOKEN");
    }

    private static void invoke(AIProvider provider, String operation) {
        switch (operation) {
            case "chat" -> provider.chat(new AIProvider.ChatRequest("test", "test", true));
            case "embed" -> provider.embed("test");
            case "stream" -> provider.stream(new AIProvider.ChatRequest("test", "test", true), ignored -> {});
            case "testConnection" -> provider.testConnection();
            default -> throw new AssertionError(operation);
        }
    }

    static final class Block {
        final String key;
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);

        Block(String key) {
            this.key = key;
        }

        void await(String actualKey) {
            if (!key.equals(actualKey)) return;
            entered.countDown();
            try {
                if (!release.await(10, TimeUnit.SECONDS)) throw new AssertionError("fixture release timed out");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError("fixture interrupted", e);
            }
        }
    }

    static final class FakeFactory implements AIProviderFactory {
        final AtomicInteger created = new AtomicInteger();
        final AtomicInteger probes = new AtomicInteger();
        final AtomicInteger chats = new AtomicInteger();
        final AtomicInteger embeddings = new AtomicInteger();
        final AtomicInteger streams = new AtomicInteger();
        volatile Block probeBlock;
        volatile Block chatBlock;

        void reset() {
            created.set(0);
            probes.set(0);
            chats.set(0);
            embeddings.set(0);
            streams.set(0);
            probeBlock = null;
            chatBlock = null;
        }

        @Override
        public AIProvider create(String provider, String key, String model) {
            if (key == null || key.equals("ENV_ONLY_SENTINEL"))
                throw new AssertionError("environment fallback reached factory");
            created.incrementAndGet();
            return new AIProvider() {
                @Override
                public boolean enabled() {
                    return true;
                }

                @Override
                public String name() {
                    return provider;
                }

                @Override
                public String model() {
                    return model;
                }

                @Override
                public String embeddingModel() {
                    return "synthetic-embedding";
                }

                @Override
                public void testConnection() {
                    probes.incrementAndGet();
                    if (probeBlock != null) probeBlock.await(key);
                }

                @Override
                public ChatResponse chat(ChatRequest request) {
                    chats.incrementAndGet();
                    if (chatBlock != null) chatBlock.await(key);
                    return new ChatResponse("synthetic response", List.of(), "synthetic response", List.of(), 1, 1);
                }

                @Override
                public void stream(ChatRequest request, TokenConsumer consumer) {
                    streams.incrementAndGet();
                    consumer.accept("synthetic");
                }

                @Override
                public float[] embed(String text) {
                    embeddings.incrementAndGet();
                    return new float[1536];
                }
            };
        }
    }
}
