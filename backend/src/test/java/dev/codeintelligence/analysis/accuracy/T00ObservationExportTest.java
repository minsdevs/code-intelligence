package dev.codeintelligence.analysis.accuracy;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.java.JavaAnalyzer;
import dev.codeintelligence.job.JobInputFailure;
import dev.codeintelligence.job.JobStep;
import dev.codeintelligence.job.JobType;
import dev.codeintelligence.job.Pipeline;
import dev.codeintelligence.project.ImportStep;
import dev.codeintelligence.testsupport.TestJobContext;
import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
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
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Opt-in G-ACCURACY product observation exporter (validation/pre-release/accuracy-export.cjs).
 *
 * <p>It runs the real job pipeline steps after IMPORT (source acquisition is replaced by a byte-verified
 * copy of the T00 fixture roster) against Testcontainers PostgreSQL and the real local TS sidecar, then
 * dumps the persisted product rows. It reads only fixture manifests and roster sources: never gold,
 * negatives or review files, and it writes nothing back into the corpus. Mapping to T00 observations
 * happens in validation/pre-release/accuracy-observations.cjs so the packaged-app path shares it.
 */
@SpringBootTest(
        properties = {"app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", "logging.level.root=WARN"})
@Import(TestcontainersConfiguration.class)
@EnabledIfSystemProperty(named = "accuracy.t00.corpus", matches = ".+")
class T00ObservationExportTest {
    static final String FORMAT = "code-intelligence-accuracy-product-dump/1";
    private static final PersonIdent IDENT = new PersonIdent("t00-fixture", "t00-fixture@test.local");

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
        // No fake fallback: an export without the real sidecar is not a product observation.
        registry.add("app.ts-analyzer.base-url", () -> required("accuracy.ts-url"));
    }

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    Pipeline pipeline;

    @Autowired
    JsonMapper json;

    @Test
    void exportsPersistedProductFactsForEveryCorpusFixture() throws Exception {
        Path corpusFile = Path.of(required("accuracy.t00.corpus")).toRealPath();
        Path output = Path.of(required("accuracy.t00.output"));
        assertThat(output.isAbsolute()).isTrue();
        assertThat(Files.exists(output, LinkOption.NOFOLLOW_LINKS)).isFalse();
        Files.createDirectory(output);
        JsonNode corpus = json.readTree(Files.readAllBytes(corpusFile));
        List<String> fixtures = new ArrayList<>();
        for (JsonNode reference : corpus.path("fixtures")) {
            Path manifestFile =
                    regular(corpusFile.getParent(), reference.path("path").asString());
            assertThat(sha256(Files.readAllBytes(manifestFile)))
                    .isEqualTo(reference.path("sha256").asString());
            JsonNode manifest = json.readTree(Files.readAllBytes(manifestFile));
            String fixtureId = manifest.path("fixtureId").asString();
            assertThat(fixtureId).matches("[A-Za-z0-9][A-Za-z0-9_.-]{0,95}");
            Map<String, Object> dump = export(fixtureId, manifestFile.getParent(), manifest);
            Files.write(
                    output.resolve(fixtureId + ".dump.json"),
                    json.writerWithDefaultPrettyPrinter().writeValueAsBytes(dump),
                    StandardOpenOption.CREATE_NEW);
            fixtures.add(fixtureId);
        }
        assertThat(fixtures).isNotEmpty();
        Map<String, Object> build = new LinkedHashMap<>();
        build.put("format", FORMAT);
        build.put("path", "BACKEND_PIPELINE_HARNESS");
        // Digest the classes/resources this JVM actually loaded, not a declared jar name.
        build.put("backendClassesTree", treeDigest(codeSource(JavaAnalyzer.class)));
        build.put("backendResourcesTree", treeDigest(resourceRoot()));
        build.put("javaVersion", System.getProperty("java.version"));
        build.put("fixtures", fixtures);
        Files.write(
                output.resolve("build.json"),
                json.writerWithDefaultPrettyPrinter().writeValueAsBytes(build),
                StandardOpenOption.CREATE_NEW);
    }

    private Map<String, Object> export(String fixtureId, Path fixtureRoot, JsonNode manifest) throws Exception {
        long user = jdbc.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "t00-" + System.nanoTime());
        long project = jdbc.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, ?, 't00', ?) returning id
                """, Long.class, user, fixtureId, fixtureId + "-" + System.nanoTime());
        Path clone = dataDir.resolve("repos").resolve(String.valueOf(project));
        Files.createDirectories(clone);
        List<Map<String, Object>> consumed = new ArrayList<>();
        for (JsonNode source : manifest.path("source")) {
            String relative = source.path("path").asString();
            byte[] bytes = Files.readAllBytes(regular(fixtureRoot, relative));
            assertThat(bytes.length).isEqualTo(source.path("bytes").asLong());
            String digest = sha256(bytes);
            assertThat(digest).isEqualTo(source.path("sha256").asString());
            Path target = clone.resolve(relative).normalize();
            assertThat(target.startsWith(clone)).isTrue();
            Files.createDirectories(target.getParent());
            Files.write(target, bytes, StandardOpenOption.CREATE_NEW);
            consumed.add(Map.of("path", relative, "sha256", digest, "bytes", bytes.length));
        }
        commit(clone, fixtureId);
        jdbc.update("update projects set clone_path = ? where id = ?", clone.toString(), project);
        long snapshot = jdbc.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, project);
        TestJobContext ctx = TestJobContext.running(jdbc, project, snapshot, clone);
        List<Map<String, Object>> steps = new ArrayList<>();
        String executionState = "COMPLETED";
        String failureCode = null;
        for (JobStep step : pipeline.stepsFor(JobType.IMPORT)) {
            if (step.key().equals(ImportStep.KEY)) {
                steps.add(Map.of("key", step.key(), "status", "REPLACED_BY_VERIFIED_FIXTURE_COPY"));
                continue;
            }
            Map<String, Object> record = new LinkedHashMap<>();
            record.put("key", step.key());
            try {
                step.run(ctx);
                record.put("status", "COMPLETED");
            } catch (Exception failure) {
                // The real worker fails the job at the first failing step; later steps never run.
                record.put("status", "FAILED");
                record.put("failureClass", failure.getClass().getSimpleName());
                failureCode = failure instanceof JobInputFailure input ? input.failureCode() : "STEP_FAILED";
                record.put("failureCode", failureCode);
                executionState = "FAILED";
            }
            steps.add(record);
            if ("FAILED".equals(executionState)) break;
        }
        Map<String, Object> dump = new LinkedHashMap<>();
        dump.put("format", FORMAT);
        dump.put("path", "BACKEND_PIPELINE_HARNESS");
        dump.put("fixtureId", fixtureId);
        dump.put("executionState", executionState);
        dump.put("failureCode", failureCode);
        dump.put("steps", steps);
        dump.put("consumedSources", consumed);
        dump.put("files", rows("""
                select path, language, size, content_hash as "contentHash", analysis_status as "analysisStatus",
                       analysis_reason as "analysisReason", analysis_targeted as "analysisTargeted"
                from files where snapshot_id = ? order by path
                """, snapshot));
        dump.put("nodes", rows("""
                select n.node_type as "type", n.natural_key as "key", n.name, f.path, n.line_start as "lineStart",
                       n.line_end as "lineEnd", n.area_type as "area", n.metadata::text as "metadataJson"
                from graph_nodes n left join files f on f.id = n.file_id
                where n.snapshot_id = ? order by n.natural_key
                """, snapshot));
        dump.put("edges", rows("""
                select e.edge_type as "type", s.natural_key as "source", t.natural_key as "target", e.confidence,
                       e.metadata::text as "metadataJson"
                from graph_edges e join graph_nodes s on s.id = e.source_node_id
                join graph_nodes t on t.id = e.target_node_id
                where e.snapshot_id = ? order by s.natural_key, e.edge_type, t.natural_key
                """, snapshot));
        dump.put("endpoints", rows("""
                select n.natural_key as "nodeKey", e.http_method as "method", e.path, e.handler_key as "handlerKey"
                from api_endpoints e join graph_nodes n on n.id = e.node_id where e.snapshot_id = ? order by n.natural_key
                """, snapshot));
        dump.put("entities", rows("""
                select n.natural_key as "nodeKey", e.entity_name as "entityName", e.table_name as "tableName", e.source
                from db_entities e join graph_nodes n on n.id = e.node_id where e.snapshot_id = ? order by n.natural_key
                """, snapshot));
        dump.put("routes", rows("""
                select n.natural_key as "nodeKey", r.path, r.component_key as "componentKey"
                from frontend_routes r join graph_nodes n on n.id = r.node_id where r.snapshot_id = ? order by n.natural_key
                """, snapshot));
        return dump;
    }

    private List<Map<String, Object>> rows(String sql, long snapshot) {
        return jdbc.queryForList(sql, snapshot).stream()
                .map(row -> {
                    Map<String, Object> copy = new LinkedHashMap<>();
                    row.forEach((key, value) -> {
                        if (key.equals("metadataJson")) {
                            copy.put("metadata", value == null ? Map.of() : json.readValue((String) value, Map.class));
                        } else {
                            copy.put(key, value);
                        }
                    });
                    return copy;
                })
                .toList();
    }

    private static void commit(Path clone, String fixtureId) throws Exception {
        try (Git git =
                Git.init().setInitialBranch("main").setDirectory(clone.toFile()).call()) {
            git.add().addFilepattern(".").call();
            git.commit()
                    .setMessage("t00 fixture " + fixtureId)
                    .setAuthor(IDENT)
                    .setCommitter(IDENT)
                    .setSign(false)
                    .call();
        }
    }

    private static Path regular(Path root, String relative) throws IOException {
        assertThat(relative).matches("[A-Za-z0-9._@+-]+(/[A-Za-z0-9._@+-]+)*");
        assertThat(relative.split("/")).doesNotContain(".", "..");
        Path file = root.resolve(relative);
        assertThat(Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)).isTrue();
        assertThat(file.toRealPath()).isEqualTo(file.toAbsolutePath().normalize());
        return file;
    }

    private static Path codeSource(Class<?> type) throws URISyntaxException {
        return Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI());
    }

    private static Path resourceRoot() throws URISyntaxException {
        Path migration = Path.of(T00ObservationExportTest.class
                .getResource("/db/migration/V1__init.sql")
                .toURI());
        return migration.getParent().getParent().getParent();
    }

    static Map<String, Object> treeDigest(Path root) throws IOException, NoSuchAlgorithmException {
        Map<String, Object> result = new LinkedHashMap<>();
        StringBuilder lines = new StringBuilder();
        int count = 0;
        if (Files.isRegularFile(root)) {
            lines.append(root.getFileName())
                    .append('\t')
                    .append(sha256(Files.readAllBytes(root)))
                    .append('\n');
            count = 1;
        } else {
            List<Path> files;
            try (Stream<Path> walk = Files.walk(root)) {
                files = walk.filter(Files::isRegularFile)
                        .sorted((a, b) -> root.relativize(a)
                                .toString()
                                .compareTo(root.relativize(b).toString()))
                        .toList();
            }
            for (Path file : files) {
                lines.append(root.relativize(file).toString().replace('\\', '/'))
                        .append('\t')
                        .append(sha256(Files.readAllBytes(file)))
                        .append('\n');
                count++;
            }
        }
        result.put("kind", Files.isRegularFile(root) ? "FILE" : "DIRECTORY_TREE");
        result.put("files", count);
        result.put("sha256", sha256(lines.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        return result;
    }

    static String sha256(byte[] bytes) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) throw new IllegalStateException("Missing system property " + name);
        return value;
    }
}
