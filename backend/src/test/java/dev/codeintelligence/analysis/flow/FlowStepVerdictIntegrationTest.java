package dev.codeintelligence.analysis.flow;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import java.nio.file.Path;
import java.util.List;
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

/** G-UX F5: each flow step carries the verdict of the recorded relation that produced it. */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.ai.provider=none",
            "app.github.base-url=http://127.0.0.1:1"
        })
@Import(TestcontainersConfiguration.class)
class FlowStepVerdictIntegrationTest {

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
    private FlowService flowService;

    @Test
    void feBeFlowStepsCarryTheVerdictOfTheirProducingRelation() {
        Seeded seeded = seed();
        long route = node(seeded, "FE_ROUTE", "route:/orders/:orderId", "/orders/:orderId");
        long endpoint =
                node(seeded, "API_ENDPOINT", "http:POST /api/orders/{id}/cancel", "POST /api/orders/{id}/cancel");
        long controller = node(seeded, "CLASS", "java:OrderController", "OrderController");
        long handler = node(seeded, "METHOD", "java:OrderController#cancel()", "OrderController.cancel");
        long service = node(seeded, "METHOD", "java:OrderService#cancel()", "OrderService.cancel");
        long orphan = node(seeded, "METHOD", "java:Audit#log()", "Audit.log");
        long consumes = edge(seeded, route, endpoint, "CONSUMES", "LIKELY");
        edge(seeded, controller, endpoint, "EXPOSES", "CONFIRMED");
        edge(seeded, controller, handler, "DECLARES", "CONFIRMED");
        edge(seeded, handler, service, "CALLS", "POSSIBLE");
        // A relation type the flow walk never follows must not lend its verdict to a step.
        edge(seeded, route, orphan, "IMPORTS", "CONFIRMED");
        long flowId = flow(seeded, "FE_BE", "/orders/:orderId", route);
        step(flowId, 1, route, null, "Route /orders/:orderId");
        step(flowId, 2, endpoint, consumes, "CONSUMES POST /api/orders/{id}/cancel");
        step(flowId, 3, endpoint, null, "POST /api/orders/{id}/cancel");
        step(flowId, 4, controller, null, "OrderController");
        step(flowId, 5, handler, null, "OrderController.cancel");
        step(flowId, 6, service, null, "OrderService.cancel");
        step(flowId, 7, orphan, null, "Audit.log");

        JsonNode detail = jsonMapper.valueToTree(flowService.detail(seeded.projectId, seeded.userId, flowId, null));
        JsonNode steps = detail.get("steps");

        assertThat(steps.get(0).get("entry").asBoolean()).isTrue();
        assertThat(steps.get(0).get("confidence").isNull()).isTrue();
        assertVerdict(steps.get(1), "CONSUMES", "LIKELY");
        assertVerdict(steps.get(2), "CONSUMES", "LIKELY");
        assertVerdict(steps.get(3), "EXPOSES", "CONFIRMED");
        assertVerdict(steps.get(4), "DECLARES", "CONFIRMED");
        assertVerdict(steps.get(5), "CALLS", "POSSIBLE");
        assertThat(steps.get(6).get("entry").asBoolean()).isFalse();
        assertThat(steps.get(6).get("confidence").isNull()).isTrue();
        assertThat(steps.get(6).get("relationType").isNull()).isTrue();
        assertThat(detail.get("inferredStepIncluded").asBoolean()).isTrue();
        for (String key : List.of("seq", "nodeId", "nodeName", "nodeType", "filePath", "line", "description")) {
            assertThat(steps.get(0).has(key)).as(key).isTrue();
        }
    }

    @Test
    void confirmedOnlyFlowHasNoInferredStep() {
        Seeded seeded = seed();
        long container = node(seeded, "CONTAINER", "docker:api", "api");
        long service = node(seeded, "SERVICE", "service:orders", "orders");
        long deployed = edge(seeded, container, service, "DEPLOYED_IN", "CONFIRMED");
        long flowId = flow(seeded, "INFRA", "api", container);
        step(flowId, 1, container, null, "api");
        step(flowId, 2, service, deployed, "DEPLOYED_IN orders");

        JsonNode detail = jsonMapper.valueToTree(flowService.detail(seeded.projectId, seeded.userId, flowId, null));

        assertVerdict(detail.get("steps").get(1), "DEPLOYED_IN", "CONFIRMED");
        assertThat(detail.get("inferredStepIncluded").asBoolean()).isFalse();
    }

    private static void assertVerdict(JsonNode step, String relationType, String confidence) {
        assertThat(step.get("entry").asBoolean())
                .as("entry of step %s", step.get("seq"))
                .isFalse();
        assertThat(step.get("relationType").asText())
                .as("relation of step %s", step.get("seq"))
                .isEqualTo(relationType);
        assertThat(step.get("confidence").asText())
                .as("verdict of step %s", step.get("seq"))
                .isEqualTo(confidence);
    }

    private Seeded seed() {
        long userId = jdbc.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "flow-" + System.nanoTime());
        long projectId = jdbc.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'order-desk', 'fixture', ?) returning id
                """, Long.class, userId, "flow-" + System.nanoTime());
        long snapshotId = jdbc.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'READY', now()) returning id
                """, Long.class, projectId);
        jdbc.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        return new Seeded(userId, projectId, snapshotId);
    }

    private long node(Seeded seeded, String type, String naturalKey, String name) {
        return jdbc.queryForObject("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, metadata)
                values (?, ?, ?, ?, '{}'::jsonb) returning id
                """, Long.class, seeded.snapshotId, type, naturalKey, name);
    }

    private long edge(Seeded seeded, long source, long target, String type, String confidence) {
        return jdbc.queryForObject("""
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence, metadata)
                values (?, ?, ?, ?, ?, '{}'::jsonb) returning id
                """, Long.class, seeded.snapshotId, source, target, type, confidence);
    }

    private long flow(Seeded seeded, String kind, String name, long entryNodeId) {
        return jdbc.queryForObject("""
                insert into flows (snapshot_id, name, kind, entry_node_id) values (?, ?, ?, ?) returning id
                """, Long.class, seeded.snapshotId, name, kind, entryNodeId);
    }

    private void step(long flowId, int seq, long nodeId, Long edgeId, String description) {
        jdbc.update("""
                insert into flow_steps (flow_id, seq, node_id, edge_id, description) values (?, ?, ?, ?, ?)
                """, flowId, seq, nodeId, edgeId, description);
    }

    private record Seeded(long userId, long projectId, long snapshotId) {}
}
