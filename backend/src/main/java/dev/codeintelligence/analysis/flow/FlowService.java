package dev.codeintelligence.analysis.flow;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.ErrorResponseException;

@Service
public class FlowService {

    public record FlowSummary(long id, String name, String kind, Long entryNodeId) {}

    public record FlowStepView(
            int seq,
            Long nodeId,
            String nodeName,
            String nodeType,
            String filePath,
            Integer line,
            String description) {}

    public record FlowEvidenceView(String filePath, Integer lineStart, Integer lineEnd, String excerpt) {}

    public record FlowDetail(
            long id,
            String name,
            String kind,
            Long entryNodeId,
            List<FlowStepView> steps,
            List<FlowEvidenceView> evidences,
            long resolvedSnapshotId) {}

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
        List<FlowStepView> steps = jdbc.sql("""
                        select s.seq, n.id as node_id, n.name as node_name, n.node_type, f.path as file_path,
                               n.line_start, s.description
                        from flow_steps s
                        left join graph_nodes n on n.id = s.node_id and n.snapshot_id = :snapshotId and n.node_type <> 'AMBIGUOUS'
                        left join files f on f.id = n.file_id and f.snapshot_id = :snapshotId
                        where s.flow_id = :flowId
                        order by s.seq
                        """)
                .param("flowId", flow.id())
                .param("snapshotId", resolved)
                .query((rs, rowNum) -> new FlowStepView(
                        rs.getInt("seq"),
                        (Long) rs.getObject("node_id"),
                        rs.getString("node_name"),
                        rs.getString("node_type"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        rs.getString("description")))
                .list();
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
        return new FlowDetail(flow.id(), flow.name(), flow.kind(), flow.entryNodeId(), steps, evidences, resolved);
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
