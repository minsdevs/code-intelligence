import dev.codeintelligence.job.JobDetailResponse;
import dev.codeintelligence.job.JobSseBroadcaster;
import dev.codeintelligence.job.JobStatus;
import dev.codeintelligence.job.JobType;
import io.lettuce.core.ClientOptions;
import io.lettuce.core.SslOptions;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.apache.catalina.startup.Tomcat;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.session.Session;
import org.springframework.session.SessionRepository;
import org.springframework.session.data.redis.config.annotation.web.http.EnableRedisHttpSession;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.databind.json.JsonMapper;

// Hosted-only caller supplies fresh synthetic secrets by a protected file, never argv/env.
public class WindowsCacheProbe {
    static Properties settings;
    static JobDetailResponse state(JobStatus status) {
        return new JobDetailResponse(2718L, 1L, null, JobType.values()[0], status, null,
                Instant.parse("2026-01-01T00:00:00Z"), null, null, List.of(), null);
    }
    static void require(boolean condition, String code) { if (!condition) throw new AssertionError(code); }
    @Configuration(proxyBeanMethods = false)
    @EnableWebMvc
    @EnableRedisHttpSession(redisNamespace = "acceptance:session")
    static class Config {
        @Bean LettuceConnectionFactory redisConnectionFactory() throws Exception {
            var server = new RedisStandaloneConfiguration("127.0.0.1", Integer.parseInt(settings.getProperty("port")));
            server.setPassword(settings.getProperty("password"));
            var ssl = SslOptions.builder().jdkSslProvider().trustManager(Path.of(settings.getProperty("certificate")).toFile()).build();
            var client = LettuceClientConfiguration.builder().clientOptions(ClientOptions.builder().sslOptions(ssl).build())
                    .commandTimeout(Duration.ofSeconds(10)).useSsl().and().build();
            return new LettuceConnectionFactory(server, client);
        }
        @Bean StringRedisTemplate redisTemplate(RedisConnectionFactory connection) { return new StringRedisTemplate(connection); }
        @Bean RedisMessageListenerContainer messages(RedisConnectionFactory connection) {
            var result = new RedisMessageListenerContainer(); result.setConnectionFactory(connection); return result;
        }
        @Bean JsonMapper mapper() { return JsonMapper.builder().findAndAddModules().build(); }
        @Bean JobSseBroadcaster broadcaster(RedisMessageListenerContainer messages, JsonMapper mapper) { return new JobSseBroadcaster(messages, mapper); }
        @Bean Events events(JobSseBroadcaster broadcaster) { return new Events(broadcaster); }
    }
    @RestController
    static class Events {
        final JobSseBroadcaster broadcaster;
        Events(JobSseBroadcaster broadcaster) { this.broadcaster = broadcaster; }
        @GetMapping(value = "/probe/events", produces = "text/event-stream")
        SseEmitter events() { return broadcaster.subscribe(2718L, state(JobStatus.RUNNING)); }
    }
    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        require(args.length == 2, "PROBE_ARGUMENTS");
        settings = new Properties();
        try (var reader = Files.newBufferedReader(Path.of(args[0]))) { settings.load(reader); }
        var tomcat = new Tomcat(); tomcat.setBaseDir(args[1]); tomcat.setPort(0);
        tomcat.getConnector().setProperty("address", "127.0.0.1");
        var servlet = tomcat.addContext("", args[1]);
        var application = new AnnotationConfigWebApplicationContext(); application.register(Config.class);
        var dispatcher = Tomcat.addServlet(servlet, "dispatcher", new DispatcherServlet(application));
        dispatcher.setLoadOnStartup(1); dispatcher.setAsyncSupported(true); servlet.addServletMappingDecoded("/", "dispatcher");
        try {
            tomcat.start();
            var repository = (SessionRepository<Session>) application.getBean(SessionRepository.class);
            require(repository.getClass().getSimpleName().equals("RedisSessionRepository"), "UNEXPECTED_INDEXED_SESSION_REPOSITORY");
            // No ConfigureRedisAction.NO_OP and no disabled keyspace listener. This application's
            // default repository does not publish SessionExpiredEvent/SessionDeletedEvent.
            var session = repository.createSession(); session.setMaxInactiveInterval(Duration.ofSeconds(2));
            session.setAttribute("acceptance", "synthetic"); repository.save(session);
            require("synthetic".equals(repository.findById(session.getId()).getAttribute("acceptance")), "SESSION_ROUNDTRIP");
            var oldId = session.getId(); session.changeSessionId(); repository.save(session);
            require(repository.findById(oldId) == null && repository.findById(session.getId()) != null, "SESSION_ROTATION");
            Thread.sleep(2500); require(repository.findById(session.getId()) == null, "SESSION_EXPIRY");
            var deleted = repository.createSession(); repository.save(deleted); repository.deleteById(deleted.getId());
            require(repository.findById(deleted.getId()) == null, "SESSION_DELETE");
            var redis = application.getBean(StringRedisTemplate.class);
            var script = new DefaultRedisScript<Long>("redis.call('set', KEYS[1], ARGV[1]); return redis.call('incr', KEYS[1])", Long.class);
            require(Long.valueOf(42).equals(redis.execute(script, List.of("acceptance:lua"), "41")), "LUA_EVALSHA_FALLBACK");
            require(Long.valueOf(42).equals(redis.execute(script, List.of("acceptance:lua"), "41")), "LUA_EVALSHA_CACHED");
            redis.delete("acceptance:lua");
            try (var client = HttpClient.newHttpClient(); var executor = Executors.newSingleThreadExecutor()) {
                var response = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + tomcat.getConnector().getLocalPort() + "/probe/events"))
                        .timeout(Duration.ofSeconds(15)).GET().build(), HttpResponse.BodyHandlers.ofInputStream());
                require(response.statusCode() == 200, "SSE_STATUS");
                try (var input = response.body()) {
                    var read = executor.submit(() -> {
                        var lines = new BufferedReader(new InputStreamReader(input)); boolean snapshot = false, update = false;
                        for (String line; (line = lines.readLine()) != null;) {
                            snapshot |= line.equals("event:snapshot"); update |= line.equals("event:update");
                            if (snapshot && update) return true;
                        }
                        return false;
                    });
                    long recipients = redis.convertAndSend("job-progress:2718", application.getBean(JsonMapper.class).writeValueAsString(state(JobStatus.DONE)));
                    require(recipients > 0, "PATTERN_SUBSCRIBER");
                    require(read.get(15, TimeUnit.SECONDS), "REAL_JOB_SSE_UPDATE");
                }
            }
            System.out.println("WINDOWS_GARNET_SPRING_SESSION_LETTUCE_LUA_SSE_PASS");
        } finally { tomcat.stop(); tomcat.destroy(); application.close(); }
    }
}
