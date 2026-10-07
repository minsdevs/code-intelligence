package dev.codeintelligence.analysis.flow;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.ErrorResponseException;

@Service
public class FlowService {

    public record FlowSummary(long id, String name, String kind, Long entryNodeId) {}

    /**
     * entry marks the flow's anchor, which no relation produces. relationType and confidence describe the recorded
     * relation that produced the step; both are null when none was found, which is not a confirmation.
     */
    public record FlowStepView(
            int seq,
            Long nodeId,
            String nodeName,
            String nodeType,
            String filePath,
            Integer line,
            String description,
            boolean entry,
            String relationType,
            String confidence) {}

    public record FlowEvidenceView(String filePath, Integer lineStart, Integer lineEnd, String excerpt) {}

    public record FlowDetail(
            long id,
            String name,
            String kind,
            Long entryNodeId,
            List<FlowStepView> steps,
            List<FlowEvidenceView> evidences,
            long resolvedSnapshotId,
            boolean inferredStepIncluded) {}

    /** Relations the flow walk follows from an earlier step to a later one when it records no edge id. */
    private static final Set<String> FORWARD_RELATIONS =
            Set.of("CONSUMES", "CONTAINS", "DECLARES", "CALLS", "READS_WRITES", "DEPLOYED_IN");
    /** The walk reaches a controller from the endpoint it exposes. */
    private static final Set<String> REVERSE_RELATIONS = Set.of("EXPOSES");

    private static final Map<String, Integer> CONFIDENCE_RANK = Map.of("CONFIRMED", 3, "LIKELY", 2, "POSSIBLE", 1);

    private record StepRow(
            int seq,
            Long nodeId,
            String nodeName,
            String nodeType,
            String filePath,
            Integer line,
            String description,
            Long edgeId) {}

    private record Relation(long id, long sourceId, long targetId, String type, String confidence) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;

    public FlowService(ProjectRepository projectRepository, SnapshotRepository snapshotRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<FlowSummary> list(long projectId, long userId, Long snapshotId, String kind) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        return jdbc.sql("""
                        select fl.id, fl.name, fl.kind, n.id as entry_node_id
                        from flows fl
                        left join graph_nodes n on n.id = fl.entry_node_id and n.snapshot_id = fl.snapshot_id and n.node_type <> 'AMBIGUOUS'
                        where fl.snapshot_id = :snapshotId
                          and (:kind::text is null or fl.kind = :kind)
                        order by fl.kind, fl.name
                        """)
                .param("snapshotId", resolved)
                .param("kind", blankToNull(kind))
                .query((rs, rowNum) ->
                        new FlowSummary(rs.getLong("id"), rs.getString("name"), rs.getString("kind"), (Long)
                                rs.getObject("entry_node_id")))
                .list();
    }

    @Transactional(readOnly = true)
    public FlowDetail detail(long projectId, long userId, long flowId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        FlowSummary flow = jdbc.sql("""
                        select fl.id, fl.name, fl.kind, n.id as entry_node_id
                        from flows fl
                        left join graph_nodes n on n.id = fl.entry_node_id and n.snapshot_id = fl.snapshot_id and n.node_type <> 'AMBIGUOUS'
                        where fl.snapshot_id = :snapshotId and fl.id = :flowId
                        """)
                .param("snapshotId", resolved)
                .param("flowId", flowId)
                .query((rs, rowNum) ->
                        new FlowSummary(rs.getLong("id"), rs.getString("name"), rs.getString("kind"), (Long)
                                rs.getObject("entry_node_id")))
                .optional()
                .orElseThrow(FlowNotFoundException::new);
        List<StepRow> rows = jdbc.sql("""
                        select s.seq, n.id as node_id, n.name as node_name, n.node_type, f.path as file_path,
                               n.line_start, s.description, s.edge_id
                        from flow_steps s
                        left join graph_nodes n on n.id = s.node_id and n.snapshot_id = :snapshotId and n.node_type <> 'AMBIGUOUS'
                        left join files f on f.id = n.file_id and f.snapshot_id = :snapshotId
                        where s.flow_id = :flowId
                        order by s.seq
                        """)
                .param("flowId", flow.id())
                .param("snapshotId", resolved)
                .query((rs, rowNum) -> new StepRow(
                        rs.getInt("seq"),
                        (Long) rs.getObject("node_id"),
                        rs.getString("node_name"),
                        rs.getString("node_type"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        rs.getString("description"),
                        (Long) rs.getObject("edge_id")))
                .list();
        List<FlowStepView> steps = withVerdicts(rows, flow.entryNodeId(), relations(flow.id(), resolved));
        List<FlowEvidenceView> evidences = jdbc.sql("""
                        select e.file_path, e.line_start, e.line_end, e.excerpt
                        from evidence_links l
                        join evidences e on e.id = l.evidence_id
                        where l.subject_type = 'FLOW' and l.subject_id = :flowId and e.project_id = :projectId
                        order by e.id
                        """)
                .param("flowId", flow.id())
                .param("projectId", projectId)
                .query((rs, rowNum) -> new FlowEvidenceView(
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        (Integer) rs.getObject("line_end"),
                        rs.getString("excerpt")))
                .list();
        boolean inferredStepIncluded =
                steps.stream().anyMatch(step -> !step.entry() && !"CONFIRMED".equals(step.confidence()));
        return new FlowDetail(
                flow.id(),
                flow.name(),
                flow.kind(),
                flow.entryNodeId(),
                steps,
                evidences,
                resolved,
                inferredStepIncluded);
    }

    private List<Relation> relations(long flowId, long snapshotId) {
        return jdbc.sql("""
                        select e.id, e.source_node_id, e.target_node_id, e.edge_type, e.confidence
                        from graph_edges e
                        where e.snapshot_id = :snapshotId
                          and (e.id in (select s.edge_id from flow_steps s where s.flow_id = :flowId)
                               or (e.source_node_id in (select s.node_id from flow_steps s where s.flow_id = :flowId)
                                   and e.target_node_id in (select s.node_id from flow_steps s where s.flow_id = :flowId)))
                        order by e.id
                        """)
                .param("flowId", flowId)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new Relation(
                        rs.getLong("id"),
                        rs.getLong("source_node_id"),
                        rs.getLong("target_node_id"),
                        rs.getString("edge_type"),
                        rs.getString("confidence")))
                .list();
    }

    /**
     * A step takes the verdict of its recorded edge. A step stored without one takes the strongest relation the flow
     * walk follows from any earlier step to it; the first entry-node step is the anchor and has none.
     */
    private static List<FlowStepView> withVerdicts(List<StepRow> rows, Long entryNodeId, List<Relation> relations) {
        Map<Long, Relation> byId = new HashMap<>();
        relations.forEach(relation -> byId.put(relation.id(), relation));
        List<FlowStepView> steps = new ArrayList<>();
        List<Long> earlier = new ArrayList<>();
        boolean anchored = false;
        for (StepRow row : rows) {
            Relation produced = row.edgeId() == null ? null : byId.get(row.edgeId());
            boolean entry = false;
            if (row.edgeId() == null
                    && !anchored
                    && row.nodeId() != null
                    && row.nodeId().equals(entryNodeId)) {
                entry = true;
                anchored = true;
            } else if (produced == null && row.nodeId() != null) {
                produced = strongestFrom(earlier, row.nodeId(), relations);
            }
            steps.add(new FlowStepView(
                    row.seq(),
                    row.nodeId(),
                    row.nodeName(),
                    row.nodeType(),
                    row.filePath(),
                    row.line(),
                    row.description(),
                    entry,
                    produced == null ? null : produced.type(),
                    produced == null ? null : produced.confidence()));
            if (row.nodeId() != null) {
                earlier.add(row.nodeId());
            }
        }
        return steps;
    }

    private static Relation strongestFrom(List<Long> earlier, long nodeId, List<Relation> relations) {
        Relation best = null;
        for (Relation relation : relations) {
            boolean forward = FORWARD_RELATIONS.contains(relation.type())
                    && relation.targetId() == nodeId
                    && earlier.contains(relation.sourceId());
            boolean reverse = REVERSE_RELATIONS.contains(relation.type())
                    && relation.sourceId() == nodeId
                    && earlier.contains(relation.targetId());
            if ((forward || reverse) && (best == null || rank(relation.confidence()) > rank(best.confidence()))) {
                best = relation;
            }
        }
        return best;
    }

    private static int rank(String confidence) {
        return CONFIDENCE_RANK.getOrDefault(confidence, 0);
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private long requireSnapshot(Project project, Long snapshotId) {
        Long id = snapshotId != null ? snapshotId : project.getCurrentSnapshotId();
        if (id == null) {
            throw new SnapshotNotFoundException();
        }
        snapshotRepository.findByIdAndProjectId(id, project.getId()).orElseThrow(SnapshotNotFoundException::new);
        return id;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    public static final class FlowNotFoundException extends ErrorResponseException {
        public FlowNotFoundException() {
            super(
                    HttpStatus.NOT_FOUND,
                    ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Flow not found."),
                    null);
        }
    }
}
