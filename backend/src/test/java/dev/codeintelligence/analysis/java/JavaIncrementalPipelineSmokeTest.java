package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.graph.GraphBuildStep;
import dev.codeintelligence.analysis.graph.GraphPersistenceService;
import dev.codeintelligence.analysis.graph.SourceParsingStep;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import(TestcontainersConfiguration.class)
class JavaIncrementalPipelineSmokeTest {
    @TempDir
    static Path data;

    @DynamicPropertySource
    static void dataDir(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> data.toString());
    }

    @Autowired
    FileInventoryStep inventory;

    @Autowired
    SourceParsingStep source;

    @Autowired
    GraphBuildStep graph;

    @Autowired
    JavaAnalyzer java;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    JdbcClient client;

    @Autowired
    GraphPersistenceService persistence;

    @Autowired
    EvidenceService evidence;

    @Autowired
    dev.codeintelligence.job.FinalizeStep finalizeStep;

    @Test
    void moderateSyntheticRefresh() throws Exception {
        smoke(96);
    }

    @Test
    void largeSyntheticRefresh() throws Exception {
        smoke(512);
    }

    private void smoke(int files) throws Exception {
        long identity = System.nanoTime();
        long user = jdbc.queryForObject(
                "insert into users(github_id,login) values (?,?) returning id",
                Long.class,
                identity,
                "synthetic-" + identity);
        long project = jdbc.queryForObject(
                "insert into projects(user_id,name,repo_owner,repo_name) values (?,'synthetic','local',?) returning id",
                Long.class,
                user,
                "synthetic-" + identity);
        Path first =
                Files.createDirectories(data.resolve("synthetic-" + identity).resolve("job-one"));
        Path second = Files.createDirectories(first.getParent().resolve("job-two"));
        long bytes = 0;
        for (int index = 0; index < files; index++) {
            StringBuilder text = new StringBuilder(
                    "package smoke;\nimport org.springframework.stereotype.Service;\n@Service public class C" + index
                            + " {\n");
            text.append("int value(){ return new C")
                    .append((index + 1) % files)
                    .append("().other(); }\nint other(){ return 1; }\n");
            for (int method = 0; method < 24; method++)
                text.append("int m")
                        .append(method)
                        .append("(){ String label = \"")
                        .append("synthetic source payload ".repeat(8))
                        .append("\"; return value(); }\n");
            text.append("}\n");
            String path = "src/main/java/smoke/C" + index + ".java";
            JavaIncrementalTest.write(first, path, text.toString());
            JavaIncrementalTest.write(second, path, text.toString());
            bytes += text.toString().getBytes(StandardCharsets.UTF_8).length;
        }
        for (Path workspace : List.of(first, second)) {
            JavaIncrementalTest.write(workspace, "web/client.ts", "export const marker = 1;\n");
            JavaIncrementalTest.write(workspace, "README.md", "# Mixed Java fixture\n");
        }
        initializeRepository(first);
        initializeRepository(second);
        Run cold = run(project, first, source);
        assertThat(java.cacheStats().parserInvocations()).isEqualTo(files * 3);
        assertThat(canonical(cold.snapshot).get("outcomes"))
                .anySatisfy(row -> assertThat(row).containsEntry("path", "web/client.ts"));
        Run unchanged = run(project, second, source);
        JavaAnalyzer.CacheStats unchangedStats = java.cacheStats();
        assertThat(unchangedStats.parserInvocations()).isZero();
        assertThat(canonical(unchanged.snapshot)).isEqualTo(canonical(cold.snapshot));
        Path changedFile = second.resolve("src/main/java/smoke/C0.java");
        Files.writeString(
                changedFile, Files.readString(changedFile).replaceFirst("return value\\(\\);", "return other();"));
        JavaIncrementalTest.write(second, "web/client.ts", "export const marker = 2;\n");
        initializeRepository(second);
        Run changed = run(project, second, source);
        JavaAnalyzer.CacheStats changedStats = java.cacheStats();
        assertThat(changedStats.parserInvocations()).isEqualTo(3);
        assertThat(changedStats.reusedPhases()).isEqualTo((files - 1) * 3);
        SourceParsingStep independent = new SourceParsingStep(
                List.of(new JavaAnalyzer(0), new JavaFrameworkAnalyzer()), client, persistence, evidence);
        Run full = run(project, second, independent);
        assertThat(canonical(changed.snapshot)).isEqualTo(canonical(full.snapshot));
        assertThat(changedStats.retainedBytes()).isLessThanOrEqualTo(JavaAnalyzer.MAX_CACHE_BYTES);
        System.out.printf(
                "JAVA_PIPELINE_SMOKE files=%d bytes=%d coldMs=%d unchangedMs=%d changedMs=%d independentFullMs=%d unchangedParses=%d changedParses=%d reusedPhases=%d retainedBytes=%d equality=true%n",
                files,
                bytes,
                cold.millis,
                unchanged.millis,
                changed.millis,
                full.millis,
                unchangedStats.parserInvocations(),
                changedStats.parserInvocations(),
                changedStats.reusedPhases(),
                changedStats.retainedBytes());
    }

    private static void initializeRepository(Path path) throws Exception {
        try (var git = org.eclipse.jgit.api.Git.init()
                .setInitialBranch("main")
                .setDirectory(path.toFile())
                .call()) {
            git.add().addFilepattern(".").call();
            var author = new org.eclipse.jgit.lib.PersonIdent("fixture", "fixture@test.local");
            git.commit()
                    .setMessage("[skip ci] synthetic sources")
                    .setAuthor(author)
                    .setCommitter(author)
                    .setSign(false)
                    .call();
        }
    }

    private record Run(long snapshot, long millis) {}

    private Run run(long project, Path workspace, SourceParsingStep step) throws Exception {
        long snapshot = jdbc.queryForObject(
                "insert into snapshots(project_id,commit_sha,status) values (?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','ANALYZING') returning id",
                Long.class,
                project);
        TestJobContext context = TestJobContext.running(jdbc, project, snapshot, workspace);
        inventory.run(context);
        long start = System.nanoTime();
        step.run(context);
        long elapsed = (System.nanoTime() - start) / 1_000_000;
        graph.run(context);
        finalizeStep.run(context);
        return new Run(snapshot, elapsed);
    }

    private Map<String, List<Map<String, Object>>> canonical(long snapshot) {
        return Map.of(
                "nodes",
                        jdbc.queryForList(
                                "select n.node_type,n.natural_key,n.name,f.path,n.line_start,n.line_end,n.area_type,n.metadata::text from graph_nodes n left join files f on f.id=n.file_id where n.snapshot_id=? order by n.natural_key",
                                snapshot),
                "edges",
                        jdbc.queryForList(
                                "select s.natural_key source,t.natural_key target,e.edge_type,e.confidence,e.metadata::text from graph_edges e join graph_nodes s on s.id=e.source_node_id join graph_nodes t on t.id=e.target_node_id where e.snapshot_id=? order by 1,2,3,4,5",
                                snapshot),
                "evidence",
                        jdbc.queryForList(
                                "select n.natural_key,e.kind,e.file_path,e.line_start,e.line_end,e.excerpt from evidences e join evidence_links l on l.evidence_id=e.id and l.subject_type='GRAPH_NODE' join graph_nodes n on n.id=l.subject_id where n.snapshot_id=? order by 1,2,3,4,5,6",
                                snapshot),
                "outcomes",
                        jdbc.queryForList(
                                "select path,analysis_status,analysis_reason,analysis_targeted from files where snapshot_id=? order by path",
                                snapshot),
                "failures",
                        jdbc.queryForList(
                                "select e.kind,e.file_path,e.line_start,e.line_end,e.excerpt from evidences e join evidence_links l on l.evidence_id=e.id where l.subject_type='SOURCE_PARSING' and l.subject_id=? order by 1,2,3,4,5",
                                snapshot));
    }
}
