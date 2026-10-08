package dev.codeintelligence.analysis.flow;

import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
@Order(FlowDetectionStep.ORDER)
public class FlowDetectionStep implements JobStep {

    public static final String KEY = "FLOW_DETECTION";
    public static final int ORDER = 920;
    static final int CALLS_DEPTH = 5;
    /** Flows and flow steps per JDBC batch: one round trip each instead of one per row. */
    private static final int BATCH = 500;

    private final JdbcClient jdbc;
    private final NamedParameterJdbcTemplate batches;
    private final TransactionTemplate transactionTemplate;
    private final EvidenceService evidenceService;

    public FlowDetectionStep(
            JdbcClient jdbc,
            NamedParameterJdbcTemplate batches,
            TransactionTemplate transactionTemplate,
            EvidenceService evidenceService) {
        this.jdbc = jdbc;
        this.batches = batches;
        this.transactionTemplate = transactionTemplate;
        this.evidenceService = evidenceService;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        ctx.updateProgress(10);
        Graph graph = load(snapshotId);
        transactionTemplate.executeWithoutResult(tx -> {
            jdbc.sql("""
                            delete from evidences e
                            where e.id in (
                                select el.evidence_id from evidence_links el
                                join flows f on f.id = el.subject_id
                                where el.subject_type = 'FLOW' and f.snapshot_id = :snapshotId
                            )
                            """).param("snapshotId", snapshotId).update();
            jdbc.sql("delete from flows where snapshot_id = :snapshotId")
                    .param("snapshotId", snapshotId)
                    .update();
            List<PendingFlow> flows = new ArrayList<>();
            persistBackend(flows, graph);
            persistFeBe(flows, graph);
            persistInfra(flows, graph);
            persistEvent(flows, graph);
            insertFlows(ctx.projectId(), snapshotId, flows);
        });
        ctx.updateProgress(100);
    }

    private void persistBackend(List<PendingFlow> flows, Graph graph) {
        for (Node endpoint : graph.nodesByType.getOrDefault("API_ENDPOINT", List.of())) {
            List<Step> steps = backendSteps(graph, endpoint);
            flows.add(new PendingFlow(endpoint.name(), "BACKEND", endpoint.id, steps, endpoint.filePath));
        }
    }

    private void persistFeBe(List<PendingFlow> flows, Graph graph) {
        for (Node route : graph.nodesByType.getOrDefault("FE_ROUTE", List.of())) {
            List<Step> steps = new ArrayList<>();
            steps.add(new Step(route.id, null, "Route " + route.name));
            Set<Long> seen = new HashSet<>();
            seen.add(route.id);
            for (Edge edge : graph.out.getOrDefault(route.id, List.of())) {
                if ("CONSUMES".equals(edge.type)) {
                    Node endpoint = graph.byId.get(edge.targetId);
                    if (endpoint != null && seen.add(endpoint.id)) {
                        steps.add(new Step(endpoint.id, edge.id, "CONSUMES " + endpoint.name));
                        steps.addAll(backendSteps(graph, endpoint));
                    }
                }
                if ("CONTAINS".equals(edge.type)) {
                    Node child = graph.byId.get(edge.targetId);
                    if (child != null && "COMPONENT".equals(child.type) && seen.add(child.id)) {
                        steps.add(1, new Step(child.id, edge.id, child.name));
                    }
                }
            }
            if (steps.size() < 2) {
                continue;
            }
            flows.add(new PendingFlow(route.name(), "FE_BE", route.id, steps, route.filePath));
        }
    }

    private void persistInfra(List<PendingFlow> flows, Graph graph) {
        for (Node container : graph.nodesByType.getOrDefault("CONTAINER", List.of())) {
            List<Step> steps = new ArrayList<>();
            steps.add(new Step(container.id, null, container.name));
            for (Edge edge : graph.out.getOrDefault(container.id, List.of())) {
                if ("DEPLOYED_IN".equals(edge.type)) {
                    Node target = graph.byId.get(edge.targetId);
                    if (target != null) {
                        steps.add(new Step(target.id, edge.id, "DEPLOYED_IN " + target.name));
                    }
                }
            }
            if (steps.size() < 2) {
                continue;
            }
            flows.add(new PendingFlow(container.name(), "INFRA", container.id, steps, container.filePath));
        }
    }

    private void persistEvent(List<PendingFlow> flows, Graph graph) {
        for (Node topic : graph.nodesByType.getOrDefault("QUEUE_TOPIC", List.of())) {
            List<Step> steps = new ArrayList<>();
            for (Edge edge : graph.in.getOrDefault(topic.id, List.of())) {
                if ("PUBLISHES".equals(edge.type) || "SUBSCRIBES".equals(edge.type)) {
                    Node source = graph.byId.get(edge.sourceId);
                    if (source != null) {
                        steps.add(new Step(source.id, edge.id, edge.type + " " + source.name));
                    }
                }
            }
            if (steps.isEmpty()) {
                continue;
            }
            steps.add(new Step(topic.id, null, topic.name));
            flows.add(new PendingFlow(topic.name(), "EVENT", topic.id, steps, topic.filePath));
        }
    }

    private List<Step> backendSteps(Graph graph, Node endpoint) {
        List<Step> steps = new ArrayList<>();
        steps.add(new Step(endpoint.id, null, endpoint.name));
        LinkedHashSet<Long> ordered = new LinkedHashSet<>();
        for (Edge edge : graph.in.getOrDefault(endpoint.id, List.of())) {
            if (!"EXPOSES".equals(edge.type)) {
                continue;
            }
            Node controller = graph.byId.get(edge.sourceId);
            if (controller == null) {
                continue;
            }
            ordered.add(controller.id);
            ArrayDeque<long[]> queue = new ArrayDeque<>();
            for (Edge declared : graph.out.getOrDefault(controller.id, List.of())) {
                if (!"DECLARES".equals(declared.type)) {
                    continue;
                }
                Node method = graph.byId.get(declared.targetId);
                if (method != null
                        && "METHOD".equals(method.type)
                        && endpoint.handlerKey != null
                        && endpoint.handlerKey.equals(method.naturalKey)) {
                    queue.add(new long[] {method.id, 0});
                }
            }
            Set<Long> visited = new HashSet<>();
            while (!queue.isEmpty()) {
                long[] item = queue.removeFirst();
                long id = item[0];
                int depth = (int) item[1];
                if (!visited.add(id) || depth > CALLS_DEPTH) {
                    continue;
                }
                ordered.add(id);
                Node node = graph.byId.get(id);
                if (node != null && ("REPOSITORY".equals(node.layer) || "DB_ENTITY".equals(node.type))) {
                    continue;
                }
                for (Edge call : graph.out.getOrDefault(id, List.of())) {
                    if ("CALLS".equals(call.type) || "READS_WRITES".equals(call.type)) {
                        queue.add(new long[] {call.targetId, depth + 1});
                    }
                }
            }
        }
        int seqHint = 0;
        for (Long id : ordered) {
            Node node = graph.byId.get(id);
            if (node != null) {
                steps.add(new Step(id, null, node.name));
                seqHint++;
                if (seqHint > 24) {
                    break;
                }
            }
        }
        return steps;
    }

    /** Inserts the flows in order with their steps and evidence, a batch of rows per round trip. */
    private void insertFlows(long projectId, long snapshotId, List<PendingFlow> flows) {
        List<Long> flowIds = new ArrayList<>(flows.size());
        for (int start = 0; start < flows.size(); start += BATCH) {
            List<PendingFlow> chunk = flows.subList(start, Math.min(start + BATCH, flows.size()));
            GeneratedKeyHolder keys = new GeneratedKeyHolder();
            batches.batchUpdate(
                    """
                            insert into flows (snapshot_id, name, kind, entry_node_id)
                            values (:snapshotId, :name, :kind, :entryNodeId)
                            """,
                    chunk.stream()
                            .map(flow -> new MapSqlParameterSource()
                                    .addValue("snapshotId", snapshotId)
                                    .addValue("name", flow.name())
                                    .addValue("kind", flow.kind())
                                    .addValue("entryNodeId", flow.entryNodeId()))
                            .toArray(SqlParameterSource[]::new),
                    keys,
                    new String[] {"id"});
            List<Map<String, Object>> returned = keys.getKeyList();
            if (returned.size() != chunk.size()) {
                throw new IllegalStateException(
                        "flow insert returned " + returned.size() + " ids for " + chunk.size() + " rows");
            }
            for (Map<String, Object> key : returned) flowIds.add(((Number) key.get("id")).longValue());
        }
        List<SqlParameterSource> stepRows = new ArrayList<>();
        Map<Long, List<NewEvidence>> evidence = new LinkedHashMap<>();
        for (int index = 0; index < flows.size(); index++) {
            PendingFlow flow = flows.get(index);
            long flowId = flowIds.get(index);
            int seq = 0;
            for (Step step : flow.steps()) {
                seq++;
                stepRows.add(new MapSqlParameterSource()
                        .addValue("flowId", flowId)
                        .addValue("seq", seq)
                        .addValue("nodeId", step.nodeId())
                        .addValue("edgeId", step.edgeId())
                        .addValue("description", step.description()));
            }
            if (flow.filePath() != null) {
                evidence.put(
                        flowId,
                        List.of(new NewEvidence(
                                EvidenceKind.FILE_LINE, flow.filePath(), 1, 1, flow.kind() + " " + flow.name())));
            }
        }
        for (int start = 0; start < stepRows.size(); start += BATCH) {
            batches.batchUpdate(
                    """
                            insert into flow_steps (flow_id, seq, node_id, edge_id, description)
                            values (:flowId, :seq, :nodeId, :edgeId, :description)
                            """,
                    stepRows.subList(start, Math.min(start + BATCH, stepRows.size()))
                            .toArray(SqlParameterSource[]::new));
        }
        evidenceService.replaceLinkedAll(projectId, EvidenceSubjects.FLOW, evidence);
    }

    private Graph load(long snapshotId) {
        Graph graph = new Graph();
        jdbc.sql("""
                        select n.id, n.node_type, n.natural_key, n.name, f.path as file_path,
                               n.metadata->>'layer' as layer, n.metadata->>'handlerKey' as handler_key
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> {
                    Node node = new Node(
                            rs.getLong("id"),
                            rs.getString("node_type"),
                            rs.getString("natural_key"),
                            rs.getString("name"),
                            rs.getString("file_path"),
                            rs.getString("layer"),
                            rs.getString("handler_key"));
                    graph.byId.put(node.id, node);
                    graph.nodesByType
                            .computeIfAbsent(node.type, key -> new ArrayList<>())
                            .add(node);
                    return 0;
                })
                .list();
        jdbc.sql("""
                        select id, source_node_id, target_node_id, edge_type
                        from graph_edges where snapshot_id = :snapshotId
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> {
                    Edge edge = new Edge(
                            rs.getLong("id"),
                            rs.getLong("source_node_id"),
                            rs.getLong("target_node_id"),
                            rs.getString("edge_type"));
                    graph.out
                            .computeIfAbsent(edge.sourceId, key -> new ArrayList<>())
                            .add(edge);
                    graph.in
                            .computeIfAbsent(edge.targetId, key -> new ArrayList<>())
                            .add(edge);
                    return 0;
                })
                .list();
        return graph;
    }

    private static final class Graph {
        private final Map<Long, Node> byId = new HashMap<>();
        private final Map<String, List<Node>> nodesByType = new HashMap<>();
        private final Map<Long, List<Edge>> out = new HashMap<>();
        private final Map<Long, List<Edge>> in = new HashMap<>();
    }

    private record Node(
            long id, String type, String naturalKey, String name, String filePath, String layer, String handlerKey) {}

    private record Edge(long id, long sourceId, long targetId, String type) {}

    private record Step(long nodeId, Long edgeId, String description) {}

    private record PendingFlow(String name, String kind, long entryNodeId, List<Step> steps, String filePath) {}
}
