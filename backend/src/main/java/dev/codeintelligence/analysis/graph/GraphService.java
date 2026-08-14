package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.analysis.area.AreaType;
import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import tools.jackson.databind.json.JsonMapper;

@Service
public class GraphService {

    static final int DEFAULT_PAGE_SIZE = 50;
    static final int MAX_PAGE_SIZE = 100;

    public record GraphNodeSummary(
            long id,
            String nodeType,
            String naturalKey,
            String name,
            String filePath,
            Integer lineStart,
            Integer lineEnd,
            String areaType) {}

    public record GraphEvidenceView(String filePath, Integer lineStart, Integer lineEnd, String excerpt) {}

    public record GraphNodeDetail(
            long id,
            String nodeType,
            String naturalKey,
            String name,
            String filePath,
            Integer lineStart,
            Integer lineEnd,
            String areaType,
            Map<String, Object> metadata,
            List<GraphEvidenceView> evidences) {}

    public record GraphNodePage(List<GraphNodeSummary> items, int page, int size, long total) {}

    public record GraphRelation(
            int depth, String direction, String edgeType, String confidence, GraphNodeSummary node) {}

    public record GraphRelationsResponse(long nodeId, String direction, int depth, List<GraphRelation> relations) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;
    private final JsonMapper jsonMapper;

    public GraphService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            JdbcClient jdbc,
            JsonMapper jsonMapper) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
        this.jsonMapper = jsonMapper;
    }

    @Transactional(readOnly = true)
    public GraphNodePage listNodes(
            long projectId,
            long userId,
            Long snapshotId,
            String type,
            String area,
            String q,
            String path,
            Integer page,
            Integer size) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        if (StringUtils.hasText(area)) {
            parseArea(area);
        }
        int resolvedPage = page == null || page < 1 ? 1 : page;
        int resolvedSize = size == null || size < 1 ? DEFAULT_PAGE_SIZE : Math.min(size, MAX_PAGE_SIZE);
        int offset = (resolvedPage - 1) * resolvedSize;
        String like = likePattern(q);
        Long total = jdbc.sql("""
                        select count(*) from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and (:type::text is null or n.node_type = :type)
                          and (:area::text is null or n.area_type = :area)
                          and (:path::text is null or f.path = :path or n.natural_key = 'file:' || :path)
                          and (:q::text is null or n.name ilike :q escape '\\' or n.natural_key ilike :q escape '\\')
                        """)
                .param("snapshotId", resolved)
                .param("type", blankToNull(type))
                .param("area", blankToNull(area))
                .param("path", blankToNull(path))
                .param("q", like)
                .query(Long.class)
                .single();
        List<GraphNodeSummary> items = jdbc.sql("""
                        select n.id, n.node_type, n.natural_key, n.name, n.line_start, n.line_end, n.area_type,
                               f.path as file_path
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and (:type::text is null or n.node_type = :type)
                          and (:area::text is null or n.area_type = :area)
                          and (:path::text is null or f.path = :path or n.natural_key = 'file:' || :path)
                          and (:q::text is null or n.name ilike :q escape '\\' or n.natural_key ilike :q escape '\\')
                        order by n.natural_key
                        limit :limit offset :offset
                        """)
                .param("snapshotId", resolved)
                .param("type", blankToNull(type))
                .param("area", blankToNull(area))
                .param("path", blankToNull(path))
                .param("q", like)
                .param("limit", resolvedSize)
                .param("offset", offset)
                .query((rs, rowNum) -> new GraphNodeSummary(
                        rs.getLong("id"),
                        rs.getString("node_type"),
                        rs.getString("natural_key"),
                        rs.getString("name"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        (Integer) rs.getObject("line_end"),
                        rs.getString("area_type")))
                .list();
        return new GraphNodePage(items, resolvedPage, resolvedSize, total);
    }

    @Transactional(readOnly = true)
    public GraphNodeDetail nodeDetail(long projectId, long userId, long nodeId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        GraphNodeDetail base = jdbc.sql("""
                        select n.id, n.node_type, n.natural_key, n.name, n.line_start, n.line_end, n.area_type,
                               n.metadata::text as metadata, f.path as file_path
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId and n.id = :nodeId
                        """)
                .param("snapshotId", resolved)
                .param("nodeId", nodeId)
                .query((rs, rowNum) -> new GraphNodeDetail(
                        rs.getLong("id"),
                        rs.getString("node_type"),
                        rs.getString("natural_key"),
                        rs.getString("name"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        (Integer) rs.getObject("line_end"),
                        rs.getString("area_type"),
                        readMetadata(rs.getString("metadata")),
                        new ArrayList<>()))
                .optional()
                .orElseThrow(GraphNodeNotFoundException::new);
        List<GraphEvidenceView> evidences = jdbc.sql("""
                        select e.file_path, e.line_start, e.line_end, e.excerpt
                        from evidence_links l
                        join evidences e on e.id = l.evidence_id
                        where l.subject_type = 'GRAPH_NODE' and l.subject_id = :nodeId
                        order by e.id
                        """)
                .param("nodeId", nodeId)
                .query((rs, rowNum) -> new GraphEvidenceView(
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        (Integer) rs.getObject("line_end"),
                        rs.getString("excerpt")))
                .list();
        return new GraphNodeDetail(
                base.id(),
                base.nodeType(),
                base.naturalKey(),
                base.name(),
                base.filePath(),
                base.lineStart(),
                base.lineEnd(),
                base.areaType(),
                base.metadata(),
                evidences);
    }

    @Transactional(readOnly = true)
    public GraphRelationsResponse relations(
            long projectId,
            long userId,
            long nodeId,
            Long snapshotId,
            String direction,
            String edgeType,
            Integer depth) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        requireNode(resolved, nodeId);
        String dir = direction == null || direction.isBlank() ? "out" : direction.toLowerCase(Locale.ROOT);
        if (!dir.equals("in") && !dir.equals("out")) {
            throw new InvalidGraphQueryException("direction must be in or out.");
        }
        int resolvedDepth = depth == null ? 1 : depth;
        if (resolvedDepth < 1 || resolvedDepth > 2) {
            throw new InvalidGraphQueryException("depth must be 1 or 2.");
        }
        String sql = dir.equals("out") ? outRelationsSql() : inRelationsSql();
        List<GraphRelation> relations = jdbc.sql(sql)
                .param("snapshotId", resolved)
                .param("nodeId", nodeId)
                .param("edgeType", blankToNull(edgeType))
                .param("depth", resolvedDepth)
                .query((rs, rowNum) -> new GraphRelation(
                        rs.getInt("depth"),
                        dir,
                        rs.getString("edge_type"),
                        rs.getString("confidence"),
                        new GraphNodeSummary(
                                rs.getLong("id"),
                                rs.getString("node_type"),
                                rs.getString("natural_key"),
                                rs.getString("name"),
                                rs.getString("file_path"),
                                (Integer) rs.getObject("line_start"),
                                (Integer) rs.getObject("line_end"),
                                rs.getString("area_type"))))
                .list();
        return new GraphRelationsResponse(nodeId, dir, resolvedDepth, relations);
    }

    private String outRelationsSql() {
        return """
                with recursive walk as (
                    select e.source_node_id, e.target_node_id, e.edge_type, e.confidence,
                           1 as depth, array[e.source_node_id, e.target_node_id]::bigint[] as seen
                    from graph_edges e
                    where e.snapshot_id = :snapshotId
                      and e.source_node_id = :nodeId
                      and (:edgeType::text is null or e.edge_type = :edgeType)
                    union all
                    select e.source_node_id, e.target_node_id, e.edge_type, e.confidence,
                           w.depth + 1, w.seen || e.target_node_id
                    from graph_edges e
                    join walk w on e.source_node_id = w.target_node_id
                    where e.snapshot_id = :snapshotId
                      and w.depth < :depth
                      and not e.target_node_id = any (w.seen)
                      and (:edgeType::text is null or e.edge_type = :edgeType)
                )
                select w.depth, w.edge_type, w.confidence,
                       n.id, n.node_type, n.natural_key, n.name, n.line_start, n.line_end, n.area_type,
                       f.path as file_path
                from walk w
                join graph_nodes n on n.id = w.target_node_id
                left join files f on f.id = n.file_id
                order by w.depth, n.natural_key
                """;
    }

    private String inRelationsSql() {
        return """
                with recursive walk as (
                    select e.source_node_id, e.target_node_id, e.edge_type, e.confidence,
                           1 as depth, array[e.target_node_id, e.source_node_id]::bigint[] as seen
                    from graph_edges e
                    where e.snapshot_id = :snapshotId
                      and e.target_node_id = :nodeId
                      and (:edgeType::text is null or e.edge_type = :edgeType)
                    union all
                    select e.source_node_id, e.target_node_id, e.edge_type, e.confidence,
                           w.depth + 1, w.seen || e.source_node_id
                    from graph_edges e
                    join walk w on e.target_node_id = w.source_node_id
                    where e.snapshot_id = :snapshotId
                      and w.depth < :depth
                      and not e.source_node_id = any (w.seen)
                      and (:edgeType::text is null or e.edge_type = :edgeType)
                )
                select w.depth, w.edge_type, w.confidence,
                       n.id, n.node_type, n.natural_key, n.name, n.line_start, n.line_end, n.area_type,
                       f.path as file_path
                from walk w
                join graph_nodes n on n.id = w.source_node_id
                left join files f on f.id = n.file_id
                order by w.depth, n.natural_key
                """;
    }

    private void requireNode(long snapshotId, long nodeId) {
        Boolean exists = jdbc.sql("""
                        select exists(select 1 from graph_nodes where snapshot_id = :snapshotId and id = :nodeId)
                        """)
                .param("snapshotId", snapshotId)
                .param("nodeId", nodeId)
                .query(Boolean.class)
                .single();
        if (!Boolean.TRUE.equals(exists)) {
            throw new GraphNodeNotFoundException();
        }
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

    private void parseArea(String area) {
        try {
            AreaType.valueOf(area.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new InvalidGraphQueryException("Invalid area type.");
        }
    }

    private String likePattern(String q) {
        if (!StringUtils.hasText(q)) {
            return null;
        }
        String escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        return "%" + escaped + "%";
    }

    private String blankToNull(String value) {
        return StringUtils.hasText(value) ? value : null;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readMetadata(String raw) {
        if (!StringUtils.hasText(raw) || "{}".equals(raw.strip())) {
            return Map.of();
        }
        try {
            return jsonMapper.readValue(raw, LinkedHashMap.class);
        } catch (RuntimeException e) {
            return Map.of();
        }
    }
}
