import dev.codeintelligence.analysis.graph.GraphPersistenceService;
import dev.codeintelligence.analysis.ts.*;
import dev.codeintelligence.common.*;
import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.web.ApiExceptionHandler;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.job.*;
import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;
import org.apache.catalina.startup.Tomcat;
import org.flywaydb.core.Flyway;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.context.annotation.*;
import org.springframework.core.MethodParameter;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.client.RestClient;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.method.support.*;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.config.annotation.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Standalone synthetic integration runner. Never included in the application artifact.
 * Uses the production parser client, parsing step, repository, worker, retry, HTTP controllers,
 * exception handler and Redis/SSE bridge. Only identity resolution and the pre-inventoried
 * workspace fixture are test adapters; this does not validate OAuth or local import approvals.
 */
public final class ParserFlowIntegration {
    static final JsonMapper JSON = JsonMapper.builder().build();
    static final List<Map<String,Object>> results = new ArrayList<>();
    static final Map<Long,Path> workspaces = new ConcurrentHashMap<>();
    static final Map<Long,CountDownLatch> gates = new ConcurrentHashMap<>();
    static final Set<Long> transientOnce = ConcurrentHashMap.newKeySet();
    static JobRepository repository;
    static JobWorker worker;
    static JobService service;
    static JobSseBroadcaster broadcaster;
    static JdbcClient jdbc;
    static Path root;
    static String api;
    static long owner;
    static HttpClient http;

    @Configuration
    @EnableWebMvc
    @Import({JobController.class, JobEventsController.class, ApiExceptionHandler.class})
    public static class WebConfig implements WebMvcConfigurer {
        @Bean JobService jobService() { return service; }
        @Bean JobWorker jobWorker() { return worker; }
        @Bean JobSseBroadcaster jobBroadcaster() { return broadcaster; }
        @Override public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
            resolvers.add(new HandlerMethodArgumentResolver() {
                public boolean supportsParameter(MethodParameter p) {
                    return p.getParameterType() == AuthenticatedUser.class;
                }
                public Object resolveArgument(MethodParameter p, ModelAndViewContainer m,
                        NativeWebRequest request, WebDataBinderFactory b) {
                    long user = "other".equals(request.getHeader("X-Synthetic-Identity")) ? owner + 9999 : owner;
                    return new AuthenticatedUser(user, null, "synthetic", null, null, null);
                }
            });
        }
    }

    public static void main(String[] args) throws Exception {
        root = Path.of(args[0]).toRealPath();
        var settings = JSON.readTree(Files.readString(root.resolve("connection.json")));
        var dataSource = new PGSimpleDataSource();
        dataSource.setServerNames(new String[]{"127.0.0.1"});
        dataSource.setPortNumbers(new int[]{settings.get("postgresPort").intValue()});
        dataSource.setDatabaseName("ci_audit"); dataSource.setUser("ci_audit");
        dataSource.setPassword(settings.get("password").stringValue());
        dataSource.setConnectTimeout(5); dataSource.setSocketTimeout(15);
        LettuceConnectionFactory redis = null;
        RedisMessageListenerContainer listener = null;
        AnnotationConfigWebApplicationContext context = null;
        Tomcat tomcat = null;
        boolean passed = false;
        try (HttpClient ownedHttp = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()) {
            http = ownedHttp;
            var migrated = Flyway.configure().dataSource(dataSource)
                    .locations("filesystem:" + root.resolve("sources/backend/src/main/resources/db/migration"))
                    .load().migrate();
            check(migrated.migrationsExecuted == 25, "fresh database applies all 25 migrations");
            jdbc = JdbcClient.create(dataSource);
            owner = jdbc.sql("insert into users(login,local_key,identity_type) values ('synthetic','synthetic','LOCAL') returning id")
                    .query(Long.class).single();
            var redisConfig = new RedisStandaloneConfiguration("127.0.0.1", settings.get("redisPort").intValue());
            redisConfig.setPassword(settings.get("password").stringValue());
            redis = new LettuceConnectionFactory(redisConfig); redis.afterPropertiesSet(); redis.start();
            var template = new StringRedisTemplate(redis);
            listener = new RedisMessageListenerContainer(); listener.setConnectionFactory(redis);
            listener.afterPropertiesSet();
            repository = new JobRepository(jdbc);
            var publisher = new JobProgressPublisher(repository, template, JSON);
            broadcaster = new JobSseBroadcaster(listener, JSON);
            listener.start();
            var tx = new TransactionTemplate(new JdbcTransactionManager(dataSource));
            var app = new AppProperties(root.resolve("data").toString(), 2);
            var analysis = new AnalysisProperties(20000,1048576,10000,0,1000,0.5);
            var client = new TsAnalyzerClient(new TsAnalyzerProperties(settings.get("analyzerUrl").stringValue(),10), RestClient.builder());
            var parsing = new TsParsingStep(client,jdbc,new GraphPersistenceService(jdbc,tx,new EvidenceService(jdbc),JSON),analysis);
            var step = new JobStep() {
                public String key() { return TsParsingStep.KEY; }
                public void run(JobContext ctx) throws Exception {
                    if (transientOnce.remove(ctx.jobId())) throw new TsAnalyzerException("synthetic transient service failure",null);
                    var gate = gates.get(ctx.jobId());
                    if(gate != null && !gate.await(15,TimeUnit.SECONDS)) throw new IllegalStateException("synthetic gate timed out");
                    parsing.run(ctx);
                }
            };
            var pipeline = new Pipeline(List.of(step));
            JobWorkspaceProvider inputs = job -> JobWorkspaceProvider.unmanaged(workspaces.get(job.id()));
            worker = new JobWorker(repository,pipeline,publisher,app,inputs);
            service = new JobService(repository,pipeline,worker,publisher,tx,new RetrySourceGuard(repository,app,analysis,inputs));
            context = new AnnotationConfigWebApplicationContext(); context.register(WebConfig.class);
            tomcat = new Tomcat(); tomcat.setBaseDir(root.resolve("tomcat").toString()); tomcat.setPort(0);
            tomcat.getConnector().setProperty("address","127.0.0.1");
            var web = tomcat.addContext("",root.resolve("web").toString());
            var servlet = Tomcat.addServlet(web,"api",new DispatcherServlet(context));
            servlet.setAsyncSupported(true); servlet.setLoadOnStartup(1); web.addServletMappingDecoded("/","api");
            tomcat.start(); api = "http://127.0.0.1:" + tomcat.getConnector().getLocalPort();

            var broken = seed("broken.mts","export const value = ;");
            try (Stream events = stream(broken.job())) {
                events.awaitStatus("QUEUED"); worker.dispatch(broken.job());
                events.awaitStatus("FAILED"); events.awaitClosed();
                var db = repository.findJob(broken.job()).orElseThrow();
                check("TS_SYNTAX_ERROR".equals(db.failureCode()) && db.error().contains("src/broken.mts:1:22 (TS1109)"),
                        "real analyzer HTTP 400 persists a bounded syntax code and location");
                var get = json(get("/api/jobs/"+broken.job(),false));
                check(get.get("failureCode").stringValue().equals(db.failureCode()) && get.get("error").stringValue().equals(db.error())
                        && events.last().get("failureCode").stringValue().equals(db.failureCode())
                        && events.last().get("error").stringValue().equals(db.error()),
                        "database, GET and live Redis SSE agree on syntax failure");
                check(count("graph_nodes",broken.snapshot())==0,"invalid syntax publishes no partial graph");
            }
            var before = repository.findSteps(broken.job());
            var retry = post("/api/jobs/"+broken.job()+"/retry",false);
            check(retry.statusCode()==409 && json(retry).get("code").stringValue().equals("TS_SYNTAX_ERROR")
                    && repository.findSteps(broken.job()).equals(before)
                    && repository.findJob(broken.job()).orElseThrow().status()==JobStatus.FAILED,
                    "HTTP retry returns coded 409 without requeueing or resetting the checkpoint");
            check(get("/api/jobs/"+broken.job(),true).statusCode()==404
                    && get("/api/jobs/"+broken.job()+"/events",true).statusCode()==404
                    && post("/api/jobs/"+broken.job()+"/retry",true).statusCode()==404,
                    "production job ownership rejects other synthetic principal for GET SSE and retry");
            try (Stream events = stream(broken.job())) {
                events.awaitStatus("FAILED"); events.awaitClosed();
                check(events.last().get("failureCode").stringValue().equals("TS_SYNTAX_ERROR"),
                        "SSE reconnect restores terminal failure from database and closes");
            }
            for(String extension : List.of("mts","cts")) {
                var repaired = seed("fixed."+extension,"export function service() { return 42; }\nexport function api() { return service(); }");
                run(repaired,"DONE");
                check(count("graph_nodes",repaired.snapshot())>0 && count("graph_edges",repaired.snapshot())>0
                        && repository.findJob(broken.job()).orElseThrow().status()==JobStatus.FAILED,
                        "new repaired ."+extension+" job stores graph while prior failure remains unchanged");
            }
            var nullableFixture = JSON.readTree(Files.readString(root.resolve(
                    "sources/backend/src/test/resources/fixtures/ts-nullable-metadata.json")));
            var nullableInput = nullableFixture.get("input").get("files").get(0);
            var nullable = seed("audit.controller.ts", nullableInput.get("content").stringValue());
            try (Stream events = stream(nullable.job())) {
                events.awaitStatus("QUEUED"); worker.dispatch(nullable.job());
                events.awaitStatus("DONE"); events.awaitClosed();
                check(repository.findJob(nullable.job()).orElseThrow().status() == JobStatus.DONE
                        && json(get("/api/jobs/" + nullable.job(), false)).get("status").stringValue().equals("DONE")
                        && events.last().get("status").stringValue().equals("DONE"),
                        "Nest controller with unknown return type completes through HTTP database and SSE");
            }
            var endpoint = JSON.readTree(jdbc.sql("select metadata::text from graph_nodes where snapshot_id=:snapshot and node_type='API_ENDPOINT'")
                    .param("snapshot", nullable.snapshot()).query(String.class).single());
            check(!endpoint.has("responseType") && endpoint.get("parameterTypes").size() == 1
                    && endpoint.get("parameterTypes").get(0).isNull(),
                    "persisted endpoint omits unknown response type and preserves unknown parameter position");
            var method = JSON.readTree(jdbc.sql("select metadata::text from graph_nodes where snapshot_id=:snapshot and node_type='METHOD'")
                    .param("snapshot", nullable.snapshot()).query(String.class).single());
            check(!method.has("returnType") && method.get("parameters").get(0).get("type").isNull(),
                    "persisted method preserves nested unknown parameter type without DTO failure");
            check(jdbc.sql("""
                    select count(*) from evidence_links el join evidences e on e.id=el.evidence_id
                    join graph_nodes n on n.id=el.subject_id and el.subject_type='GRAPH_NODE'
                    where n.snapshot_id=:snapshot and n.node_type='API_ENDPOINT'
                      and e.file_path='src/audit.controller.ts' and e.line_start=2
                    """).param("snapshot", nullable.snapshot()).query(Long.class).single() > 0,
                    "nullable Nest endpoint retains linked source evidence");

            var transientJob = seed("retry.mts","export function value() { return 42; }");
            transientOnce.add(transientJob.job()); run(transientJob,"FAILED");
            check(post("/api/jobs/"+transientJob.job()+"/retry",false).statusCode()==202,"ordinary failure still accepts HTTP retry");
            await(()->repository.findJobStatus(transientJob.job()).orElseThrow()==JobStatus.DONE);
            check(repository.findSteps(transientJob.job()).getFirst().attempt()==2,"ordinary retry completes on its second attempt");

            var cancelled = seed("cancel.mts","export const broken = ;");
            var gate = new CountDownLatch(1); gates.put(cancelled.job(),gate);
            try (Stream events = stream(cancelled.job())) {
                events.awaitStatus("QUEUED"); worker.dispatch(cancelled.job()); events.awaitStatus("RUNNING");
                check(post("/api/jobs/"+cancelled.job()+"/cancel",false).statusCode()==202,"running job accepts HTTP cancellation");
                events.awaitStatus("CANCELLING");
                check(repository.hasActiveJob(cancelled.project()),"cancellation retains active-project exclusivity until worker returns");
                gate.countDown(); events.awaitStatus("CANCELLED"); events.awaitClosed();
                var row=repository.findJob(cancelled.job()).orElseThrow();
                check(row.failureCode()==null && row.error()==null && !repository.hasActiveJob(cancelled.project()),
                        "late syntax failure cannot replace cancellation or leave active job behind");
            }
            passed = true;
        } finally {
            gates.values().forEach(CountDownLatch::countDown);
            if(tomcat!=null) { try { tomcat.stop(); } finally { tomcat.destroy(); } }
            if(context!=null) context.close();
            if(listener!=null) listener.destroy();
            if(redis!=null) redis.destroy();
            Files.writeString(root.resolve("reports/integration.json"),JSON.writeValueAsString(Map.of("passed",passed,"checks",results)));
        }
    }

    record Seed(long project,long snapshot,long job) {}
    static Seed seed(String name,String source) throws Exception {
        long project=jdbc.sql("insert into projects(user_id,name,repo_owner,repo_name) values (:user,:name,'synthetic',:name) returning id")
                .param("user",owner).param("name",name).query(Long.class).single();
        long snapshot=jdbc.sql("insert into snapshots(project_id,commit_sha,status) values (:project,:sha,'ANALYZING') returning id")
                .param("project",project).param("sha","0".repeat(40)).query(Long.class).single();
        Path directory=root.resolve("fixtures").resolve(Long.toString(project)); Files.createDirectories(directory.resolve("src"));
        Files.writeString(directory.resolve("src").resolve(name),source);
        jdbc.sql("insert into files(snapshot_id,path,language,size,line_count,content_hash) values (:snapshot,:path,null,:size,2,:hash)")
                .param("snapshot",snapshot).param("path","src/"+name).param("size",(long)source.getBytes(java.nio.charset.StandardCharsets.UTF_8).length)
                .param("hash","0".repeat(64)).update();
        long job=repository.insertJob(project,JobType.IMPORT); repository.attachSnapshot(job,snapshot);
        repository.insertStep(job,TsParsingStep.KEY,1); workspaces.put(job,directory);
        return new Seed(project,snapshot,job);
    }
    static long count(String table,long snapshot) {
        return jdbc.sql("select count(*) from "+table+" where snapshot_id=:snapshot").param("snapshot",snapshot).query(Long.class).single();
    }
    static void run(Seed seed,String terminal) throws Exception {
        try(Stream s=stream(seed.job())) { s.awaitStatus("QUEUED");worker.dispatch(seed.job());s.awaitStatus(terminal);s.awaitClosed(); }
    }
    static HttpRequest.Builder request(String path,boolean other) {
        return HttpRequest.newBuilder(URI.create(api+path)).timeout(Duration.ofSeconds(20)).header("X-Synthetic-Identity",other?"other":"owner");
    }
    static HttpResponse<String> get(String path,boolean other) throws Exception {
        return http.send(request(path,other).GET().build(),HttpResponse.BodyHandlers.ofString());
    }
    static HttpResponse<String> post(String path,boolean other) throws Exception {
        return http.send(request(path,other).POST(HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofString());
    }
    static JsonNode json(HttpResponse<String> response) { return JSON.readTree(response.body()); }
    static Stream stream(long job) throws Exception {
        var response=http.send(request("/api/jobs/"+job+"/events",false).GET().build(),HttpResponse.BodyHandlers.ofInputStream());
        if(response.statusCode()!=200) { response.body().close(); throw new AssertionError("SSE HTTP "+response.statusCode()); }
        return new Stream(response.body());
    }
    static final class Stream implements AutoCloseable {
        final InputStream input; final List<JsonNode> states=new CopyOnWriteArrayList<>(); final CompletableFuture<Void> ended=new CompletableFuture<>();
        Stream(InputStream input) {
            this.input=input;
            Thread.ofVirtual().start(()->{
                try(var reader=new BufferedReader(new InputStreamReader(input,java.nio.charset.StandardCharsets.UTF_8))) {
                    String line; while((line=reader.readLine())!=null) if(line.startsWith("data:")) states.add(JSON.readTree(line.substring(5)));
                    ended.complete(null);
                } catch(Exception error) { ended.completeExceptionally(error); }
            });
        }
        void awaitStatus(String value) throws Exception { await(()->states.stream().anyMatch(s->s.get("status").stringValue().equals(value))); }
        void awaitClosed() throws Exception { ended.get(20,TimeUnit.SECONDS); }
        JsonNode last() { return states.getLast(); }
        public void close() throws IOException { input.close(); }
    }
    static void await(BooleanSupplier condition) throws Exception {
        long end=System.nanoTime()+Duration.ofSeconds(20).toNanos();
        while(!condition.getAsBoolean()) { if(System.nanoTime()>end) throw new AssertionError("Timed out waiting for integration state"); Thread.sleep(10); }
    }
    static void check(boolean condition,String name) {
        results.add(Map.of("name",name,"passed",condition));
        System.out.println((condition?"PASS ":"FAIL ")+name);
        if(!condition) throw new AssertionError(name);
    }
}
