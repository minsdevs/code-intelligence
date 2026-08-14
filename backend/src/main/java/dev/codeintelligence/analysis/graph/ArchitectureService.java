package dev.codeintelligence.analysis.graph;

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

@Service
public class ArchitectureService {

    private static final List<String> BACKEND_LAYERS = List.of("CONTROLLER", "SERVICE", "REPOSITORY", "ENTITY");

    public record EndpointView(
            String httpMethod, String path, String handlerKey, long nodeId, String filePath, Integer line) {}

    public record EntityView(String entityName, String tableName, long nodeId) {}

    public record ArchitectureNodeView(long id, String name, String nodeType, String filePath, Integer line) {}

    public record ArchitectureGroupView(String layer, List<ArchitectureNodeView> nodes) {}

    public record ArchitectureEdgeView(
            String sourceGroup, String targetGroup, Long sourceNodeId, Long targetNodeId, int count) {}

    public record ArchitectureView(String area, List<ArchitectureGroupView> groups, List<ArchitectureEdgeView> edges) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;

    public ArchitectureService(
            ProjectRepository projectRepository, SnapshotRepository snapshotRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<EndpointView> endpoints(long projectId, long userId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        return jdbc.sql("""
                        select e.http_method, e.path, e.handler_key, e.node_id, f.path as file_path, n.line_start
                        from api_endpoints e
                        join graph_nodes n on n.id = e.node_id
                        left join files f on f.id = n.file_id
                        where e.snapshot_id = :snapshotId
                        order by e.path, e.http_method
                        """)
                .param("snapshotId", resolved)
                .query((rs, rowNum) -> new EndpointView(
                        rs.getString("http_method"),
                        rs.getString("path"),
                        rs.getString("handler_key"),
                        rs.getLong("node_id"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start")))
                .list();
    }

    @Transactional(readOnly = true)
    public List<EntityView> entities(long projectId, long userId, Long snapshotId) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        return jdbc.sql("""
                        select entity_name, table_name, node_id
                        from db_entities
                        where snapshot_id = :snapshotId
                        order by entity_name
                        """)
                .param("snapshotId", resolved)
                .query((rs, rowNum) ->
                        new EntityView(rs.getString("entity_name"), rs.getString("table_name"), rs.getLong("node_id")))
                .list();
    }

    @Transactional(readOnly = true)
    public ArchitectureView architecture(long projectId, long userId, Long snapshotId, String area) {
        long resolved = requireSnapshot(requireOwned(projectId, userId), snapshotId);
        String normalized = area == null ? "" : area.trim().toUpperCase(Locale.ROOT);
        if ("BACKEND".equals(normalized)) {
            return backend(resolved);
        }
        if ("FRONTEND".equals(normalized)) {
            return frontend(resolved);
        }
        if ("SYSTEM".equals(normalized)) {
            return system(resolved);
        }
        throw new InvalidGraphQueryException("area must be BACKEND, FRONTEND, or SYSTEM.");
    }

    private ArchitectureView backend(long snapshotId) {
        List<NodeRow> rows = jdbc.sql("""
                        select n.id, n.name, n.node_type, f.path as file_path, n.line_start,
                               n.metadata->>'layer' as layer
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and n.metadata->>'layer' in ('CONTROLLER', 'SERVICE', 'REPOSITORY', 'ENTITY')
                          and coalesce(n.metadata->>'external', 'false') <> 'true'
                        order by n.metadata->>'layer', n.name
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new NodeRow(
                        rs.getLong("id"),
                        rs.getString("name"),
                        rs.getString("node_type"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        rs.getString("layer")))
                .list();
        Map<String, List<ArchitectureNodeView>> grouped = new LinkedHashMap<>();
        for (String layer : BACKEND_LAYERS) {
            grouped.put(layer, new ArrayList<>());
        }
        for (NodeRow row : rows) {
            grouped.computeIfAbsent(row.layer(), key -> new ArrayList<>())
                    .add(new ArchitectureNodeView(row.id(), row.name(), row.nodeType(), row.filePath(), row.line()));
        }
        List<ArchitectureGroupView> groups = new ArrayList<>();
        for (String layer : BACKEND_LAYERS) {
            List<ArchitectureNodeView> nodes = grouped.getOrDefault(layer, List.of());
            if (!nodes.isEmpty()) {
                groups.add(new ArchitectureGroupView(layer, List.copyOf(nodes)));
            }
        }
        List<ArchitectureEdgeView> edges = jdbc.sql("""
                        select src.metadata->>'layer' as source_group,
                               tgt.metadata->>'layer' as target_group,
                               count(*)::int as cnt
                        from graph_edges e
                        join graph_nodes sm on sm.id = e.source_node_id
                        join graph_nodes tm on tm.id = e.target_node_id
                        join graph_edges ds on ds.target_node_id = sm.id and ds.edge_type = 'DECLARES'
                        join graph_nodes src on src.id = ds.source_node_id
                        join graph_edges dt on dt.target_node_id = tm.id and dt.edge_type = 'DECLARES'
                        join graph_nodes tgt on tgt.id = dt.source_node_id
                        where e.snapshot_id = :snapshotId
                          and e.edge_type = 'CALLS'
                          and src.metadata->>'layer' in ('CONTROLLER', 'SERVICE', 'REPOSITORY', 'ENTITY')
                          and tgt.metadata->>'layer' in ('CONTROLLER', 'SERVICE', 'REPOSITORY', 'ENTITY')
                        group by src.metadata->>'layer', tgt.metadata->>'layer'
                        order by source_group, target_group
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new ArchitectureEdgeView(
                        rs.getString("source_group"), rs.getString("target_group"), null, null, rs.getInt("cnt")))
                .list();
        return new ArchitectureView("BACKEND", groups, edges);
    }

    private ArchitectureView frontend(long snapshotId) {
        List<NodeRow> rows = jdbc.sql("""
                        select n.id, n.name, n.node_type, f.path as file_path, n.line_start,
                               case
                                   when n.node_type = 'FE_ROUTE' then 'PAGE'
                                   when n.node_type = 'STORE' then 'STATE'
                                   when n.node_type = 'HOOK' then 'STATE'
                                   when jsonb_exists(n.metadata, 'apiCalls') then 'API_CLIENT'
                                   else 'COMPONENT'
                               end as layer
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and n.node_type in ('FE_ROUTE', 'COMPONENT', 'HOOK', 'STORE')
                        order by layer, n.name
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new NodeRow(
                        rs.getLong("id"),
                        rs.getString("name"),
                        rs.getString("node_type"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        rs.getString("layer")))
                .list();
        List<String> layers = List.of("PAGE", "COMPONENT", "STATE", "API_CLIENT");
        Map<String, List<ArchitectureNodeView>> grouped = new LinkedHashMap<>();
        for (String layer : layers) {
            grouped.put(layer, new ArrayList<>());
        }
        for (NodeRow row : rows) {
            grouped.computeIfAbsent(row.layer(), key -> new ArrayList<>())
                    .add(new ArchitectureNodeView(row.id(), row.name(), row.nodeType(), row.filePath(), row.line()));
        }
        List<ArchitectureGroupView> groups = new ArrayList<>();
        for (String layer : layers) {
            List<ArchitectureNodeView> nodes = grouped.getOrDefault(layer, List.of());
            if (!nodes.isEmpty()) {
                groups.add(new ArchitectureGroupView(layer, List.copyOf(nodes)));
            }
        }
        List<ArchitectureEdgeView> edges = jdbc.sql("""
                        select
                            case s.node_type when 'FE_ROUTE' then 'PAGE' when 'STORE' then 'STATE' when 'HOOK' then 'STATE'
                                 else case when jsonb_exists(s.metadata, 'apiCalls') then 'API_CLIENT' else 'COMPONENT' end end
                                as source_group,
                            case t.node_type when 'FE_ROUTE' then 'PAGE' when 'STORE' then 'STATE' when 'HOOK' then 'STATE'
                                 else case when jsonb_exists(t.metadata, 'apiCalls') then 'API_CLIENT' else 'COMPONENT' end end
                                as target_group,
                            e.source_node_id, e.target_node_id, 1 as cnt
                        from graph_edges e
                        join graph_nodes s on s.id = e.source_node_id
                        join graph_nodes t on t.id = e.target_node_id
                        where e.snapshot_id = :snapshotId
                          and e.edge_type in ('CONTAINS', 'CONSUMES', 'IMPORTS')
                          and s.node_type in ('FE_ROUTE', 'COMPONENT', 'HOOK', 'STORE')
                          and t.node_type in ('FE_ROUTE', 'COMPONENT', 'HOOK', 'STORE', 'API_ENDPOINT')
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new ArchitectureEdgeView(
                        rs.getString("source_group"),
                        rs.getString("target_group"),
                        rs.getLong("source_node_id"),
                        rs.getLong("target_node_id"),
                        rs.getInt("cnt")))
                .list();
        return new ArchitectureView("FRONTEND", groups, edges);
    }

    private ArchitectureView system(long snapshotId) {
        List<NodeRow> rows = jdbc.sql("""
                        select n.id, n.name, n.node_type, f.path as file_path, n.line_start,
                               case n.node_type
                                   when 'CI_PIPELINE' then 'CI'
                                   when 'CLOUD_RESOURCE' then 'CLOUD'
                                   when 'FE_ROUTE' then 'FRONTEND'
                                   when 'API_ENDPOINT' then 'BACKEND'
                                   when 'DB_TABLE' then 'DATABASE'
                                   else n.node_type
                               end as layer
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId
                          and n.node_type in (
                              'CONTAINER', 'CI_PIPELINE', 'CLOUD_RESOURCE',
                              'FE_ROUTE', 'API_ENDPOINT', 'DB_TABLE')
                        order by layer, n.name
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new NodeRow(
                        rs.getLong("id"),
                        rs.getString("name"),
                        rs.getString("node_type"),
                        rs.getString("file_path"),
                        (Integer) rs.getObject("line_start"),
                        rs.getString("layer")))
                .list();
        Map<String, List<ArchitectureNodeView>> grouped = new LinkedHashMap<>();
        List<String> layers = List.of("FRONTEND", "BACKEND", "DATABASE", "CONTAINER", "CLOUD", "CI");
        for (String layer : layers) {
            grouped.put(layer, new ArrayList<>());
        }
        for (NodeRow row : rows) {
            grouped.computeIfAbsent(row.layer(), key -> new ArrayList<>())
                    .add(new ArchitectureNodeView(row.id(), row.name(), row.nodeType(), row.filePath(), row.line()));
        }
        List<ArchitectureGroupView> groups = new ArrayList<>();
        for (String layer : layers) {
            List<ArchitectureNodeView> nodes = grouped.getOrDefault(layer, List.of());
            if (!nodes.isEmpty()) {
                groups.add(new ArchitectureGroupView(layer, List.copyOf(nodes)));
            }
        }
        List<ArchitectureEdgeView> edges = jdbc.sql("""
                        select src_layer.layer as source_group,
                               tgt_layer.layer as target_group,
                               e.source_node_id,
                               e.target_node_id,
                               1 as cnt
                        from graph_edges e
                        join graph_nodes s on s.id = e.source_node_id
                        join graph_nodes t on t.id = e.target_node_id
                        join lateral (
                            select case s.node_type
                                when 'CI_PIPELINE' then 'CI'
                                when 'CLOUD_RESOURCE' then 'CLOUD'
                                when 'FE_ROUTE' then 'FRONTEND'
                                when 'API_ENDPOINT' then 'BACKEND'
                                when 'DB_TABLE' then 'DATABASE'
                                else s.node_type end as layer
                        ) src_layer on true
                        join lateral (
                            select case t.node_type
                                when 'CI_PIPELINE' then 'CI'
                                when 'CLOUD_RESOURCE' then 'CLOUD'
                                when 'FE_ROUTE' then 'FRONTEND'
                                when 'API_ENDPOINT' then 'BACKEND'
                                when 'DB_TABLE' then 'DATABASE'
                                else t.node_type end as layer
                        ) tgt_layer on true
                        where e.snapshot_id = :snapshotId
                          and e.edge_type in ('DEPLOYED_IN', 'CONSUMES', 'MAPS_TO', 'CONFIGURED_BY')
                        order by e.source_node_id, e.target_node_id
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new ArchitectureEdgeView(
                        rs.getString("source_group"),
                        rs.getString("target_group"),
                        rs.getLong("source_node_id"),
                        rs.getLong("target_node_id"),
                        rs.getInt("cnt")))
                .list();
        return new ArchitectureView("SYSTEM", groups, edges);
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

    private record NodeRow(long id, String name, String nodeType, String filePath, Integer line, String layer) {}
}
