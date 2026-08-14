package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphEdgeType;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

@Component
@Order(GraphBuildStep.ORDER)
public class GraphBuildStep implements JobStep {

    public static final String KEY = "GRAPH_BUILD";
    public static final int ORDER = 700;

    private final JdbcClient jdbc;
    private final GraphPersistenceService persistence;

    public GraphBuildStep(JdbcClient jdbc, GraphPersistenceService persistence) {
        this.jdbc = jdbc;
        this.persistence = persistence;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        ctx.updateProgress(15);
        List<InventoriedFile> files = jdbc.sql("""
                        select path, language, size, line_count, content_hash
                        from files where snapshot_id = :snapshotId order by path
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new InventoriedFile(
                        rs.getString("path"),
                        rs.getString("language"),
                        rs.getLong("size"),
                        (Integer) rs.getObject("line_count"),
                        rs.getString("content_hash")))
                .list();
        List<GraphNodeDraft> nodes = new ArrayList<>();
        List<GraphEdgeDraft> edges = new ArrayList<>();
        Set<String> directories = new LinkedHashSet<>();
        for (InventoriedFile file : files) {
            String path = file.path().replace('\\', '/');
            addAncestors(directories, path);
            String area = AreaPathTagger.tag(path);
            nodes.add(GraphNodeDraft.of(
                            GraphNodeType.FILE, NaturalKeys.file(path), fileName(path), path, 1, file.lineCount())
                    .withAreaType(area));
            String parent = parentPath(path);
            if (parent != null) {
                edges.add(GraphEdgeDraft.of(
                        NaturalKeys.file(parent),
                        NaturalKeys.file(path),
                        GraphEdgeType.CONTAINS,
                        EdgeConfidence.CONFIRMED));
            }
        }
        for (String dir : directories) {
            nodes.add(GraphNodeDraft.of(GraphNodeType.DIRECTORY, NaturalKeys.file(dir), fileName(dir), null, null, null)
                    .withAreaType(AreaPathTagger.tag(dir)));
            String parent = parentPath(dir);
            if (parent != null) {
                edges.add(GraphEdgeDraft.of(
                        NaturalKeys.file(parent),
                        NaturalKeys.file(dir),
                        GraphEdgeType.CONTAINS,
                        EdgeConfidence.CONFIRMED));
            }
        }
        ctx.updateProgress(55);
        persistence.persist(ctx.projectId(), snapshotId, new AnalysisResult(nodes, edges, List.of()));
        tagFromFilePath(snapshotId);
        linkFileContainsTypes(snapshotId);
        ctx.updateProgress(100);
    }

    private void tagFromFilePath(long snapshotId) {
        jdbc.sql("""
                        update graph_nodes n
                        set area_type = case
                            when f.path like '%src/test%' then 'TESTING'
                            when f.path like '%src/main/java%' or f.path like '%.java' then 'BACKEND'
                            when f.path like '%db/migration%' or f.path like '%.sql' then 'DATABASE'
                            when f.path like '%.github/workflows%' then 'DEVOPS'
                            when f.path ilike '%dockerfile%' or f.path ilike '%docker-compose%' or f.path like '%.tf'
                                then 'INFRASTRUCTURE'
                            when f.path like '%.md' or f.path like 'docs/%' then 'DOCUMENTATION'
                            when f.path like '%.gradle' or f.path like '%.gradle.kts' or f.path like '%pom.xml'
                                or f.path like '%package.json' then 'BUILD_TOOLING'
                            else n.area_type
                        end
                        from files f
                        where n.snapshot_id = :snapshotId
                          and n.file_id = f.id
                          and n.area_type is null
                        """).param("snapshotId", snapshotId).update();
    }

    private void linkFileContainsTypes(long snapshotId) {
        jdbc.sql("""
                        insert into graph_edges (
                            snapshot_id, source_node_id, target_node_id, edge_type, confidence, metadata)
                        select :snapshotId, fnode.id, tnode.id, 'CONTAINS', 'CONFIRMED', '{}'::jsonb
                        from graph_nodes tnode
                        join files f on f.id = tnode.file_id
                        join graph_nodes fnode
                          on fnode.snapshot_id = tnode.snapshot_id
                         and fnode.node_type = 'FILE'
                         and fnode.natural_key = 'file:' || f.path
                        where tnode.snapshot_id = :snapshotId
                          and tnode.node_type in ('CLASS', 'INTERFACE', 'ENUM', 'ANNOTATION', 'PACKAGE')
                        on conflict (snapshot_id, source_node_id, target_node_id, edge_type) do nothing
                        """).param("snapshotId", snapshotId).update();
    }

    private static void addAncestors(Set<String> directories, String path) {
        String parent = parentPath(path);
        while (parent != null) {
            directories.add(parent);
            parent = parentPath(parent);
        }
    }

    private static String parentPath(String path) {
        int slash = path.lastIndexOf('/');
        if (slash <= 0) {
            return slash == 0 ? null : null;
        }
        return path.substring(0, slash);
    }

    private static String fileName(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? path : path.substring(slash + 1);
    }
}
