package dev.codeintelligence.analysis.impact;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** G-UX F6: one row per dependent, verdict per row, no score inflation by duplicate paths, outside-analysis area. */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.ai.provider=none",
            "app.github.base-url=http://127.0.0.1:1"
        })
@Import(TestcontainersConfiguration.class)
class ImpactVerdictIntegrationTest {

    @TempDir
    static Path root;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> root.resolve("data").toString());
    }

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private JsonMapper jsonMapper;

    @Autowired
    private ImpactService impactService;

    @Test
    void returnsOneRowPerDependentWithShortestDepthAndStrongestPathVerdict() {
        Fixture fixture = seed(true);

        JsonNode view = json(impactService.impact(fixture.projectId, fixture.userId, fixture.target, null, 5));
        JsonNode dependents = view.get("dependents");

        // The walk reaches H twice and P twice; each node must appear exactly once.
        assertThat(dependents).hasSize(3);
        Map<String, JsonNode> byName = byName(dependents);
        assertThat(byName.keySet()).containsExactlyInAnyOrder("OrderController.cancel", "RetryJob.run", "OrderPage");

        JsonNode controller = byName.get("OrderController.cancel");
        assertThat(controller.get("depth").asInt()).isEqualTo(1);
        assertThat(controller.get("confidence").asText()).isEqualTo("CONFIRMED");
        assertThat(controller.get("pathCount").asInt()).isEqualTo(1);
        assertThat(controller.get("group").asText()).isEqualTo("CONFIRMED_DEPENDENCY");

        // Direct LIKELY call at depth 1, but a fully CONFIRMED path via the controller at depth 2.
        JsonNode retry = byName.get("RetryJob.run");
        assertThat(retry.get("depth").asInt()).isEqualTo(1);
        assertThat(retry.get("edgeType").asText()).isEqualTo("CALLS");
        assertThat(retry.get("confidence").asText()).isEqualTo("CONFIRMED");
        assertThat(retry.get("pathCount").asInt()).isEqualTo(2);
        assertThat(retry.get("group").asText()).isEqualTo("CONFIRMED_DEPENDENCY");

        // Every path to the page crosses the POSSIBLE edge, so the page is a candidate only.
        JsonNode page = byName.get("OrderPage");
        assertThat(page.get("depth").asInt()).isEqualTo(2);
        assertThat(page.get("confidence").asText()).isEqualTo("POSSIBLE");
        assertThat(page.get("pathCount").asInt()).isEqualTo(2);
        assertThat(page.get("group").asText()).isEqualTo("CANDIDATE_IMPACT");
    }

    @Test
    void riskScoreCountsEachDependentOnceRegardlessOfPathCount() {
        Fixture fixture = seed(true);

        JsonNode before = json(impactService.impact(fixture.projectId, fixture.userId, fixture.target, null, 5));
        // METHOD 1 + METHOD 1 + COMPONENT 2, each counted once.
        assertThat(before.get("riskScore").asInt()).isEqualTo(4);
        assertThat(before.get("riskLevel").asText()).isEqualTo("LOW");
        assertThat(before.get("scoreVersion").asText()).isEqualTo("unique-node-weight-v2");

        // Another path to an existing dependent must not move the score.
        insertEdge(fixture.snapshotId, fixture.page, fixture.controller, "CALLS", "CONFIRMED");
        JsonNode after = json(impactService.impact(fixture.projectId, fixture.userId, fixture.target, null, 5));
        assertThat(after.get("dependents")).hasSize(3);
        assertThat(after.get("riskScore").asInt()).isEqualTo(4);
        assertThat(byName(after.get("dependents"))
                        .get("OrderPage")
                        .get("confidence")
                        .asText())
                .isEqualTo("CONFIRMED");
    }

    @Test
    void reportsRecordedOutsideAnalysisAreas() {
        Fixture fixture = seed(true);

        JsonNode outside = json(impactService.impact(fixture.projectId, fixture.userId, fixture.target, null, 5))
                .get("outsideAnalysis");

        assertThat(outside.get("measurementStatus").asText()).isEqualTo("PER_FILE_RECORDED");
        assertThat(outside.get("unsupportedFiles").asInt()).isEqualTo(2);
        assertThat(outside.get("failedFiles").asInt()).isEqualTo(1);
        assertThat(outside.get("excludedFiles").asInt()).isEqualTo(3);
        JsonNode first = outside.get("areas").get(0);
        assertThat(first.get("status").asText()).isEqualTo("UNSUPPORTED");
        assertThat(first.get("language").asText()).isEqualTo("Kotlin");
        assertThat(first.get("files").asInt()).isEqualTo(2);
        assertThat(first.get("samplePath").asText()).isEqualTo("jobs/A.kt");
        List<String> statuses = new ArrayList<>();
        outside.get("areas").forEach(area -> statuses.add(area.get("status").asText()));
        assertThat(statuses).containsExactly("UNSUPPORTED", "FAILED");
    }

    @Test
    void legacySnapshotReportsOutsideAnalysisAsUnmeasured() {
        Fixture fixture = seed(false);

        JsonNode outside = json(impactService.impact(fixture.projectId, fixture.userId, fixture.target, null, 5))
                .get("outsideAnalysis");

        assertThat(outside.get("measurementStatus").asText()).isEqualTo("LEGACY_UNMEASURED");
        assertThat(outside.get("unsupportedFiles").isNull()).isTrue();
        assertThat(outside.get("areas")).isEmpty();
    }

    @Test
    void keepsExistingJsonFields() {
        Fixture fixture = seed(true);

        JsonNode view = json(impactService.impact(fixture.projectId, fixture.userId, fixture.target, null, 5));

        assertThat(view.has("nodeId")).isTrue();
        assertThat(view.has("depth")).isTrue();
        assertThat(view.has("riskScore")).isTrue();
        assertThat(view.has("riskLevel")).isTrue();
        assertThat(view.has("resolvedSnapshotId")).isTrue();
        JsonNode row = view.get("dependents").get(0);
        for (String key : List.of("depth", "edgeType", "nodeType", "nodeId", "name", "filePath", "line")) {
            assertThat(row.has(key)).as(key).isTrue();
        }
    }

    private JsonNode json(Object view) {
        return jsonMapper.valueToTree(view);
    }

    private static Map<String, JsonNode> byName(JsonNode dependents) {
        Map<String, JsonNode> byName = new HashMap<>();
        dependents.forEach(row -> byName.put(row.get("name").asText(), row));
        return byName;
    }

    private Fixture seed(boolean measured) {
        long userId = jdbc.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "impact-" + System.nanoTime());
        long projectId = jdbc.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'order-desk', 'fixture', ?) returning id
                """, Long.class, userId, "impact-" + System.nanoTime());
        long snapshotId = jdbc.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'READY', now()) returning id
                """, Long.class, projectId);
        jdbc.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        long target = insertNode(snapshotId, "METHOD", "java:OrderService#cancel()", "OrderService.cancel");
        long controller = insertNode(snapshotId, "METHOD", "java:OrderController#cancel()", "OrderController.cancel");
        long retry = insertNode(snapshotId, "METHOD", "java:RetryJob#run()", "RetryJob.run");
        long page = insertNode(snapshotId, "COMPONENT", "ts:web/OrderPage", "OrderPage");
        insertEdge(snapshotId, controller, target, "CALLS", "CONFIRMED");
        insertEdge(snapshotId, retry, target, "CALLS", "LIKELY");
        insertEdge(snapshotId, retry, controller, "CALLS", "CONFIRMED");
        insertEdge(snapshotId, page, retry, "CALLS", "POSSIBLE");
        if (measured) {
            jdbc.update("""
                    insert into snapshot_inventory_measurements
                        (snapshot_id, discovered_files, excluded_for_count, excluded_for_size, excluded_binary, excluded_submodules)
                    values (?, 9, 1, 1, 1, 0)
                    """, snapshotId);
            insertFile(snapshotId, "api/OrderService.java", "Java", "SUCCESS");
            insertFile(snapshotId, "jobs/B.kt", "Kotlin", "UNSUPPORTED");
            insertFile(snapshotId, "jobs/A.kt", "Kotlin", "UNSUPPORTED");
            insertFile(snapshotId, "web/broken.ts", "TypeScript", "FAILED");
        } else {
            insertFile(snapshotId, "api/OrderService.java", "Java", "LEGACY_UNMEASURED");
        }
        return new Fixture(userId, projectId, snapshotId, target, controller, retry, page);
    }

    private long insertNode(long snapshotId, String type, String naturalKey, String name) {
        return jdbc.queryForObject("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, metadata)
                values (?, ?, ?, ?, '{}'::jsonb) returning id
                """, Long.class, snapshotId, type, naturalKey, name);
    }

    private void insertEdge(long snapshotId, long source, long target, String type, String confidence) {
        jdbc.update("""
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence, metadata)
                values (?, ?, ?, ?, ?, '{}'::jsonb)
                """, snapshotId, source, target, type, confidence);
    }

    private void insertFile(long snapshotId, String path, String language, String status) {
        jdbc.update("""
                insert into files (snapshot_id, path, language, size, content_hash, analysis_status)
                values (?, ?, ?, 10, 'h', ?)
                """, snapshotId, path, language, status);
    }

    private record Fixture(
            long userId, long projectId, long snapshotId, long target, long controller, long retry, long page) {}
}
