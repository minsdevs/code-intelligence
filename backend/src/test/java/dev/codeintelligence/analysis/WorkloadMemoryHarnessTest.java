package dev.codeintelligence.analysis;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.job.JobStep;
import dev.codeintelligence.job.JobType;
import dev.codeintelligence.job.Pipeline;
import dev.codeintelligence.project.ImportStep;
import dev.codeintelligence.testsupport.TestJobContext;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.PersonIdent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * G-PERF memory harness below the packaged app: every analysis step after IMPORT runs on a
 * generated workload tree (validation/pre-release/workload-fixture.cjs) against Testcontainers
 * PostgreSQL and the real local TS analyzer, in a test JVM with the desktop backend's heap options.
 * Prints step boundaries with wall time, peak heap and the live set after the last full GC.
 * Opt-in through the {@code workloadMemoryTest} task (validation/pre-release/workload-backend-memory.cjs).
 */
@EnabledIfSystemProperty(named = "workload.fixture", matches = ".+")
@SpringBootTest(
        properties = {"app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", "logging.level.root=WARN"})
@Import(TestcontainersConfiguration.class)
class WorkloadMemoryHarnessTest {

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
        registry.add("app.ts-analyzer.base-url", () -> System.getProperty("workload.ts-url"));
        // Optional: plans of statements slower than this go to the PostgreSQL log (auto_explain).
        String explainMs = System.getProperty("workload.explain-ms");
        if (explainMs != null && explainMs.matches("[0-9]+"))
            registry.add(
                    "spring.datasource.hikari.connection-init-sql",
                    () -> "load 'auto_explain'; set auto_explain.log_min_duration = '" + explainMs + "ms'");
    }

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    Pipeline pipeline;

    @Autowired
    PostgreSQLContainer postgres;

    @Test
    void analyzesTheWorkloadFixtureWithinTheBackendHeap() throws Exception {
        Path fixture = Path.of(System.getProperty("workload.fixture")).toRealPath();
        assertThat(Files.isDirectory(fixture)).isTrue();
        System.out.println("[workload-memory] pid=" + ProcessHandle.current().pid());
        commit(fixture);
        TestJobContext ctx = seed(fixture);
        List<Map<String, Object>> rows = new ArrayList<>();
        try (HeapSampler sampler = new HeapSampler()) {
            for (JobStep step : pipeline.stepsFor(JobType.IMPORT)) {
                if (step.key().equals(ImportStep.KEY)) continue;
                sampler.reset();
                long started = System.nanoTime();
                System.out.printf("[workload-memory] start %s heapUsedMiB=%d%n", step.key(), mib(sampler.used()));
                step.run(ctx);
                long ms = (System.nanoTime() - started) / 1_000_000;
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("step", step.key());
                row.put("ms", ms);
                row.put("peakHeapMiB", mib(sampler.peak()));
                row.put("peakLiveAfterGcMiB", mib(sampler.peakLive()));
                row.put("committedHeapMiB", mib(sampler.committed()));
                row.put("fullGcs", sampler.fullGcs());
                rows.add(row);
                System.out.println("[workload-memory] done " + row);
            }
        }
        System.out.println("[workload-memory] steps " + rows);
        System.out.println("[workload-memory] digest " + digest(ctx.snapshotId().orElseThrow()));
        String explainLog = System.getProperty("workload.explain-log");
        if (explainLog != null) Files.writeString(Path.of(explainLog), postgres.getLogs());
        assertThat(jdbc.queryForObject(
                        "select status from snapshots where id = ?",
                        String.class,
                        ctx.snapshotId().orElseThrow()))
                .isEqualTo("READY");
    }

    /**
     * Order-independent digests of the analysis output (no generated ids), so two runs of the same
     * tree can be compared for identical results.
     */
    private Map<String, Object> digest(long snapshot) {
        Map<String, String> rows = new LinkedHashMap<>();
        rows.put("nodes", """
                select concat_ws('|', n.node_type, n.natural_key, n.name, f.path, n.line_start, n.line_end,
                                 n.area_type, n.metadata::text)
                from graph_nodes n left join files f on f.id = n.file_id where n.snapshot_id = ?
                """);
        rows.put("edges", """
                select concat_ws('|', s.natural_key, t.natural_key, e.edge_type, e.confidence, e.metadata::text)
                from graph_edges e join graph_nodes s on s.id = e.source_node_id
                join graph_nodes t on t.id = e.target_node_id where e.snapshot_id = ?
                """);
        rows.put("nodeEvidence", """
                select concat_ws('|', n.natural_key, v.kind, v.file_path, v.line_start, v.line_end, v.excerpt)
                from evidence_links l join graph_nodes n on n.id = l.subject_id
                join evidences v on v.id = l.evidence_id
                where l.subject_type = 'GRAPH_NODE' and n.snapshot_id = ?
                """);
        rows.put("files", """
                select concat_ws('|', path, analysis_status, analysis_reason, analysis_targeted)
                from files where snapshot_id = ?
                """);
        rows.put("featureLinks", """
                select concat_ws('|', f.name, f.description, f.confidence, n.natural_key, l.role)
                from features f left join feature_links l on l.feature_id = f.id
                left join graph_nodes n on n.id = l.node_id where f.snapshot_id = ?
                """);
        rows.put("flowSteps", """
                select concat_ws('|', f.kind, f.name, e.natural_key, s.seq, n.natural_key, s.description)
                from flows f left join graph_nodes e on e.id = f.entry_node_id
                left join flow_steps s on s.flow_id = f.id left join graph_nodes n on n.id = s.node_id
                where f.snapshot_id = ?
                """);
        rows.put("findings", """
                select concat_ws('|', a.area_type, a.category, a.severity, a.title, a.detail, n.natural_key)
                from analysis_findings a left join graph_nodes n on n.id = a.node_id where a.snapshot_id = ?
                """);
        Map<String, Object> digests = new LinkedHashMap<>();
        rows.forEach((name, sql) -> digests.put(
                name,
                jdbc.queryForObject(
                        "select count(*) || ':' || coalesce(md5(string_agg(r, E'\\n' order by r)), '-') from (" + sql
                                + ") d(r)",
                        String.class,
                        snapshot)));
        return digests;
    }

    /** The desktop analyzes a synthetic single-commit repository (RetainedRunWorkspace); so does the harness. */
    private static void commit(Path tree) throws Exception {
        try (Git git = Git.init()
                .setInitialBranch("snapshot")
                .setDirectory(tree.toFile())
                .call()) {
            git.add().addFilepattern(".").call();
            PersonIdent ident = new PersonIdent("workload", "workload@test.local");
            git.commit()
                    .setMessage("workload")
                    .setAuthor(ident)
                    .setCommitter(ident)
                    .setSign(false)
                    .call();
        }
    }

    private TestJobContext seed(Path clone) {
        long user = jdbc.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "workload-" + System.nanoTime());
        long project = jdbc.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name, clone_path)
                values (?, 'workload', 'fixture', ?, ?) returning id
                """, Long.class, user, "workload-" + System.nanoTime(), clone.toString());
        long snapshot = jdbc.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, project);
        return TestJobContext.running(jdbc, project, snapshot, clone);
    }

    private static long mib(long bytes) {
        return bytes / (1024 * 1024);
    }

    /** Samples heap occupancy every 50 ms and the old generation's usage after each collection. */
    private static final class HeapSampler implements AutoCloseable {
        private final AtomicLong peak = new AtomicLong();
        private final AtomicLong peakLive = new AtomicLong();
        private final List<MemoryPoolMXBean> heapPools = ManagementFactory.getMemoryPoolMXBeans().stream()
                .filter(pool -> pool.getType() == MemoryType.HEAP)
                .toList();
        private final MemoryPoolMXBean oldGen = heapPools.stream()
                .filter(pool ->
                        pool.getName().contains("Tenured") || pool.getName().contains("Old"))
                .findFirst()
                .orElseThrow();
        private final Thread thread;
        private volatile boolean running = true;
        private long gcBase;

        HeapSampler() {
            thread = Thread.ofPlatform().daemon().name("workload-heap-sampler").start(() -> {
                while (running) {
                    sample();
                    try {
                        Thread.sleep(50);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            });
        }

        long used() {
            return heapPools.stream()
                    .mapToLong(pool -> pool.getUsage().getUsed())
                    .sum();
        }

        void sample() {
            peak.accumulateAndGet(used(), Math::max);
            var afterGc = oldGen.getCollectionUsage();
            if (afterGc != null) peakLive.accumulateAndGet(afterGc.getUsed(), Math::max);
        }

        void reset() {
            sample();
            peak.set(used());
            peakLive.set(0);
            gcBase = fullGcCount();
        }

        long peak() {
            sample();
            return peak.get();
        }

        long peakLive() {
            return peakLive.get();
        }

        long committed() {
            return heapPools.stream()
                    .mapToLong(pool -> pool.getUsage().getCommitted())
                    .sum();
        }

        long fullGcs() {
            return fullGcCount() - gcBase;
        }

        private static long fullGcCount() {
            return ManagementFactory.getGarbageCollectorMXBeans().stream()
                    .filter(gc ->
                            gc.getName().contains("MarkSweep") || gc.getName().contains("Old"))
                    .mapToLong(GarbageCollectorMXBean::getCollectionCount)
                    .sum();
        }

        @Override
        public void close() throws InterruptedException {
            running = false;
            thread.interrupt();
            thread.join();
        }
    }
}
