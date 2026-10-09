package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.tree.TreeAnalyzeDtos;
import dev.codeintelligence.analysis.tree.TreeAnalyzerClient;
import dev.codeintelligence.analysis.tree.TreeAnalyzerProperties;
import dev.codeintelligence.analysis.ts.TsAnalyzeDtos;
import dev.codeintelligence.analysis.ts.TsAnalyzerClient;
import dev.codeintelligence.analysis.ts.TsAnalyzerProperties;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.RestClient;

/** Real HTTP failures through JobWorker and PostgreSQL, without a user project or analyzer process. */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import(TestcontainersConfiguration.class)
class JobAnalyzerFailureIntegrationTest {
    private static final AtomicLong UNIQUE = new AtomicLong(90_000);

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void isolatedDataDir(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    static final class AnalyzerStep implements JobStep {
        volatile Runnable request;

        @Override
        public String key() {
            return "ANALYZER_REQUEST";
        }

        @Override
        public void run(JobContext ctx) {
            request.run();
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class Config {
        @Bean
        AnalyzerStep analyzerStep() {
            return new AnalyzerStep();
        }

        @Bean
        @Primary
        Pipeline pipeline(AnalyzerStep step) {
            return new Pipeline(List.of(step));
        }
    }

    @Autowired
    JobService jobs;

    @Autowired
    JobRepository repository;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    AnalyzerStep step;

    @ParameterizedTest
    @CsvSource({
        "TS, timeout, TS_ANALYZER_TIMEOUT",
        "TREE, timeout, TREE_ANALYZER_TIMEOUT",
        "TS, disconnect, TS_ANALYZER_TRANSPORT_ERROR",
        "TREE, disconnect, TREE_ANALYZER_TRANSPORT_ERROR",
        "TS, rejected, TS_ANALYZER_REJECTED",
        "TREE, rejected, TREE_ANALYZER_REJECTED",
        "TS, syntax, TS_SYNTAX_ERROR",
        "TS, limit, ANALYSIS_LIMIT"
    })
    void storesTheClientFailureCodeThroughTheJobPath(String analyzer, String response, String expected)
            throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        CountDownLatch release = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            server.setExecutor(executor);
            server.createContext("/analyze", exchange -> {
                try (exchange) {
                    exchange.getRequestBody().readAllBytes();
                    if (response.equals("timeout")) {
                        try {
                            release.await();
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        return;
                    }
                    if (response.equals("disconnect")) return;
                    String body =
                            switch (response) {
                                case "syntax" -> """
                                {"code":"TS_SYNTAX_ERROR","retryable":false,"totalDiagnostics":1,
                                 "diagnostics":[{"filePath":"src/broken.ts","code":1109,"lineStart":1,"columnStart":22}]}
                                """;
                                case "limit" -> "{\"code\":\"ANALYSIS_LIMIT\",\"retryable\":false}";
                                default -> "{\"code\":\"SESSION_UNKNOWN\",\"retryable\":false}";
                            };
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(400, bytes.length);
                    exchange.getResponseBody().write(bytes);
                }
            });
            server.start();
            String url = "http://127.0.0.1:" + server.getAddress().getPort();
            if (analyzer.equals("TS")) {
                var client = new TsAnalyzerClient(new TsAnalyzerProperties(url, 1), RestClient.builder());
                step.request = () -> client.analyze(new TsAnalyzeDtos.Request(List.of()));
            } else {
                var client = new TreeAnalyzerClient(new TreeAnalyzerProperties(url, 1), RestClient.builder());
                step.request = () -> client.analyze(new TreeAnalyzeDtos.Request(List.of()));
            }
            try {
                assertFailedJob(expected);
            } finally {
                release.countDown();
                server.stop(0);
            }
        }
    }

    @ParameterizedTest
    @CsvSource({
        "timeout, TS_ANALYZER_TIMEOUT",
        "disconnect, TS_ANALYZER_TRANSPORT_ERROR",
        "isolation, ADAPTER_ISOLATION_UNAVAILABLE",
        "limit, ANALYSIS_LIMIT"
    })
    void storesControlSocketFailureCodesThroughTheJobPath(String response, String expected) throws Exception {
        Path directory = java.nio.file.Files.createTempDirectory(Path.of("/tmp"), "ci-job-");
        Path socket = directory.resolve("c.sock");
        CountDownLatch release = new CountDownLatch(1);
        try (var server = java.nio.channels.ServerSocketChannel.open(java.net.StandardProtocolFamily.UNIX);
                var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            server.bind(java.net.UnixDomainSocketAddress.of(socket));
            var reply = executor.submit(() -> {
                try (var connection = server.accept()) {
                    var input = java.nio.channels.Channels.newInputStream(connection);
                    var framed = new java.io.DataInputStream(input);
                    framed.readNBytes(framed.readInt());
                    if (response.equals("timeout")) {
                        release.await();
                    } else if (!response.equals("disconnect")) {
                        String body = response.equals("isolation")
                                ? "{\"ok\":false,\"code\":\"ADAPTER_ISOLATION_UNAVAILABLE\",\"reason\":\"ADAPTER_CLOSED\"}"
                                : "{\"ok\":false,\"code\":\"ANALYSIS_LIMIT\"}";
                        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                        var output =
                                new java.io.DataOutputStream(java.nio.channels.Channels.newOutputStream(connection));
                        output.writeInt(bytes.length);
                        output.write(bytes);
                    }
                }
                return null;
            });
            var client = new TsAnalyzerClient(
                    new TsAnalyzerProperties("", 1, "", "", socket.toString(), "c3".repeat(32)), RestClient.builder());
            step.request = () -> client.analyze(new TsAnalyzeDtos.Request(List.of()));
            try {
                assertFailedJob(expected);
            } finally {
                release.countDown();
            }
            reply.get(5, java.util.concurrent.TimeUnit.SECONDS);
        } finally {
            java.nio.file.Files.deleteIfExists(socket);
            java.nio.file.Files.deleteIfExists(directory);
        }
    }

    private void assertFailedJob(String expected) {
        long unique = UNIQUE.incrementAndGet();
        Long user = jdbc.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                unique,
                "transport-" + unique);
        Long project = jdbc.queryForObject(
                "insert into projects (user_id, name, repo_owner, repo_name) values (?, ?, ?, ?) returning id",
                Long.class,
                user,
                "transport-" + unique,
                "fixture",
                "transport-" + unique);
        long jobId = jobs.enqueue(project, JobType.IMPORT);
        Awaitility.await()
                .atMost(Duration.ofSeconds(20))
                .until(() -> repository.findJob(jobId).orElseThrow().status().terminal());
        JobRecord job = repository.findJob(jobId).orElseThrow();
        assertThat(job.status()).isEqualTo(JobStatus.FAILED);
        assertThat(job.failureCode()).isEqualTo(expected);
        assertThat(jdbc.queryForObject("select failure_code from analysis_jobs where id=?", String.class, jobId))
                .isEqualTo(expected);
        assertThat(JobDetailResponse.of(job, repository.findSteps(jobId)).failureCode())
                .isEqualTo(expected);
        assertThat(repository.findSteps(jobId)).singleElement().satisfies(failed -> {
            assertThat(failed.status()).isEqualTo(StepStatus.FAILED);
            assertThat(failed.attempt()).isEqualTo(1);
        });
        assertThat(jobs.hasActiveJob(project)).isFalse();
    }
}
