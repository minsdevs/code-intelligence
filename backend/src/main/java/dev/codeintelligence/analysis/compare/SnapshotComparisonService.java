package dev.codeintelligence.analysis.compare;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.analysis.coverage.CoverageReport;
import dev.codeintelligence.analysis.coverage.CoverageService;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.Snapshot;
import dev.codeintelligence.project.SnapshotRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SnapshotComparisonService {

    public record SnapshotOption(long id, String commitSha, String status, Instant analyzedAt) {}

    public record ItemChange(String type, String key, String beforeName, String afterName) {}

    public record CategoryChanges(List<ItemChange> added, List<ItemChange> removed, List<ItemChange> changed) {
        static CategoryChanges empty() {
            return new CategoryChanges(List.of(), List.of(), List.of());
        }
    }

    public record StructureChanges(CategoryChanges nodes, CategoryChanges relationships) {}

    public record CoverageChange(CoverageReport before, CoverageReport after) {}

    public record SnapshotComparison(
            long baseSnapshotId,
            long targetSnapshotId,
            CategoryChanges features,
            CategoryChanges flows,
            CategoryChanges findings,
            StructureChanges structure,
            CoverageChange coverage,
            List<ItemChange> renameCandidates,
            List<String> regressionWarnings) {}

    private record Item(String key, String name, String fingerprint, String renameFingerprint) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final CoverageService coverageService;
    private final JdbcClient jdbc;

    public SnapshotComparisonService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            CoverageService coverageService,
            JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.coverageService = coverageService;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<SnapshotOption> list(long projectId, long userId) {
        requireOwned(projectId, userId);
        return jdbc.sql("""
                        select id, commit_sha, status, analyzed_at
                        from snapshots where project_id = :projectId
                        order by id desc
                        """)
                .param("projectId", projectId)
                .query((rs, rowNum) -> new SnapshotOption(
                        rs.getLong("id"),
                        rs.getString("commit_sha"),
                        rs.getString("status"),
                        rs.getObject("analyzed_at", java.time.OffsetDateTime.class) == null
                                ? null
                                : rs.getObject("analyzed_at", java.time.OffsetDateTime.class)
                                        .toInstant()))
                .list();
    }

    @Transactional(readOnly = true)
    public SnapshotComparison compare(long projectId, long userId, long baseId, long targetId) {
        requireOwned(projectId, userId);
        requireSnapshot(projectId, baseId);
        requireSnapshot(projectId, targetId);
        CoverageReport beforeCoverage = coverageService.buildReport(projectId, baseId);
        if (baseId == targetId) {
            return new SnapshotComparison(
                    baseId,
                    targetId,
                    CategoryChanges.empty(),
                    CategoryChanges.empty(),
                    CategoryChanges.empty(),
                    new StructureChanges(CategoryChanges.empty(), CategoryChanges.empty()),
                    new CoverageChange(beforeCoverage, beforeCoverage),
                    List.of(),
                    List.of());
        }

        Map<String, Item> beforeFeatures = features(baseId);
        Map<String, Item> afterFeatures = features(targetId);
        Map<String, Item> beforeFlows = flows(baseId);
        Map<String, Item> afterFlows = flows(targetId);
        Map<String, Item> beforeNodes = nodes(baseId);
        Map<String, Item> afterNodes = nodes(targetId);
        CategoryChanges featureChanges = changes(beforeFeatures, afterFeatures);
        CategoryChanges flowChanges = changes(beforeFlows, afterFlows);
        CategoryChanges findingChanges = changes(findings(baseId), findings(targetId));
        CategoryChanges nodeChanges = changes(beforeNodes, afterNodes);
        CategoryChanges edgeChanges = changes(edges(baseId), edges(targetId));
        CoverageReport afterCoverage = coverageService.buildReport(projectId, targetId);

        return new SnapshotComparison(
                baseId,
                targetId,
                featureChanges,
                flowChanges,
                findingChanges,
                new StructureChanges(nodeChanges, edgeChanges),
                new CoverageChange(beforeCoverage, afterCoverage),
                renameCandidates(featureChanges, beforeFeatures, afterFeatures),
                regressionWarnings(
                        beforeFeatures.size(),
                        afterFeatures.size(),
                        flows(baseId).size(),
                        flows(targetId).size(),
                        nodes(baseId).size(),
                        nodes(targetId).size(),
                        afterCoverage));
    }

    private Map<String, Item> features(long snapshotId) {
        return queryItems("""
                select f.name as item_key, f.name,
                       concat_ws('|', coalesce(f.description, ''), f.detection, f.confidence::text,
                           coalesce(string_agg(concat(fl.role, ':', n.natural_key), ',' order by fl.role, n.natural_key), '')) as fingerprint,
                       coalesce(string_agg(n.natural_key, ',' order by n.natural_key), '') as rename_fingerprint
                from features f
                left join feature_links fl on fl.feature_id = f.id
                left join graph_nodes n on n.id = fl.node_id
                where f.snapshot_id = :snapshotId
                group by f.id, f.name, f.description, f.detection, f.confidence
                order by f.name
                """, snapshotId);
    }

    private Map<String, Item> flows(long snapshotId) {
        return queryItems("""
                select concat(f.kind, ':', f.name) as item_key, f.name,
                       concat_ws('|', f.kind,
                           coalesce(string_agg(concat(s.seq, ':', coalesce(n.natural_key, ''), ':', coalesce(s.description, '')),
                               ',' order by s.seq), '')) as fingerprint,
                       '' as rename_fingerprint
                from flows f
                left join flow_steps s on s.flow_id = f.id
                left join graph_nodes n on n.id = s.node_id
                where f.snapshot_id = :snapshotId
                group by f.id, f.kind, f.name
                order by f.kind, f.name
                """, snapshotId);
    }

    private Map<String, Item> findings(long snapshotId) {
        return queryItems("""
                select concat_ws('|', f.category, coalesce(n.natural_key, ''), f.title) as item_key, f.title,
                       concat_ws('|', f.severity, coalesce(f.detail, ''),
                           coalesce(string_agg(concat(e.file_path, ':', e.line_start, ':', coalesce(e.excerpt, '')),
                               ',' order by e.file_path, e.line_start, e.id), '')) as fingerprint,
                       '' as rename_fingerprint
                from analysis_findings f
                left join graph_nodes n on n.id = f.node_id
                left join evidence_links el on el.subject_type = 'FINDING' and el.subject_id = f.id
                left join evidences e on e.id = el.evidence_id
                where f.snapshot_id = :snapshotId
                group by f.id, f.category, n.natural_key, f.title, f.severity, f.detail
                order by item_key
                """, snapshotId);
    }

    private Map<String, Item> nodes(long snapshotId) {
        return queryItems("""
                select n.natural_key as item_key, n.name,
                       concat_ws('|', n.node_type, n.name, coalesce(f.path, ''), coalesce(n.line_start::text, ''),
                           coalesce(n.line_end::text, ''), coalesce(n.area_type, ''), n.metadata::text) as fingerprint,
                       '' as rename_fingerprint
                from graph_nodes n left join files f on f.id = n.file_id
                where n.snapshot_id = :snapshotId order by n.natural_key
                """, snapshotId);
    }

    private Map<String, Item> edges(long snapshotId) {
        return queryItems("""
                select concat(s.natural_key, '|', e.edge_type, '|', t.natural_key) as item_key,
                       concat(s.name, ' ', e.edge_type, ' ', t.name) as name,
                       concat_ws('|', e.confidence, e.metadata::text) as fingerprint,
                       '' as rename_fingerprint
                from graph_edges e
                join graph_nodes s on s.id = e.source_node_id
                join graph_nodes t on t.id = e.target_node_id
                where e.snapshot_id = :snapshotId
                order by s.natural_key, e.edge_type, t.natural_key
                """, snapshotId);
    }

    private Map<String, Item> queryItems(String sql, long snapshotId) {
        Map<String, Item> result = new TreeMap<>();
        jdbc.sql(sql)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> {
                    Item item = new Item(
                            rs.getString("item_key"),
                            rs.getString("name"),
                            rs.getString("fingerprint"),
                            rs.getString("rename_fingerprint"));
                    result.put(item.key(), item);
                    return 0;
                })
                .list();
        return result;
    }

    private static CategoryChanges changes(Map<String, Item> before, Map<String, Item> after) {
        List<ItemChange> added = new ArrayList<>();
        List<ItemChange> removed = new ArrayList<>();
        List<ItemChange> changed = new ArrayList<>();
        for (Item item : after.values()) {
            Item previous = before.get(item.key());
            if (previous == null) {
                added.add(new ItemChange("ADDED", item.key(), null, item.name()));
            } else if (!previous.fingerprint().equals(item.fingerprint())) {
                changed.add(new ItemChange("CHANGED", item.key(), previous.name(), item.name()));
            }
        }
        for (Item item : before.values()) {
            if (!after.containsKey(item.key())) {
                removed.add(new ItemChange("REMOVED", item.key(), item.name(), null));
            }
        }
        return new CategoryChanges(List.copyOf(added), List.copyOf(removed), List.copyOf(changed));
    }

    private static List<ItemChange> renameCandidates(
            CategoryChanges changes, Map<String, Item> before, Map<String, Item> after) {
        List<ItemChange> result = new ArrayList<>();
        for (ItemChange removed : changes.removed()) {
            Item oldItem = before.get(removed.key());
            if (oldItem.renameFingerprint().isBlank()) continue;
            for (ItemChange added : changes.added()) {
                Item newItem = after.get(added.key());
                if (oldItem.renameFingerprint().equals(newItem.renameFingerprint())) {
                    result.add(new ItemChange("RENAME_CANDIDATE", oldItem.key(), oldItem.name(), newItem.name()));
                }
            }
        }
        return List.copyOf(result);
    }

    private static List<String> regressionWarnings(
            int oldFeatures,
            int newFeatures,
            int oldFlows,
            int newFlows,
            int oldNodes,
            int newNodes,
            CoverageReport coverage) {
        Map<String, int[]> counts = new LinkedHashMap<>();
        counts.put("features", new int[] {oldFeatures, newFeatures});
        counts.put("flows", new int[] {oldFlows, newFlows});
        counts.put("structure nodes", new int[] {oldNodes, newNodes});
        List<String> warnings = new ArrayList<>();
        counts.forEach((label, values) -> {
            if (values[0] >= 3 && values[1] < values[0] * 0.7) {
                warnings.add(label + " decreased by more than 30% (" + values[0] + " → " + values[1] + ").");
            }
        });
        if (coverage.analyzerStatuses().stream().anyMatch(status -> "failed".equals(status.status()))) {
            warnings.add(
                    "The target snapshot has a recorded analyzer step failure; per-file coverage remains unknown.");
        }
        return List.copyOf(warnings);
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private Snapshot requireSnapshot(long projectId, long snapshotId) {
        return snapshotRepository
                .findByIdAndProjectId(snapshotId, projectId)
                .orElseThrow(SnapshotNotFoundException::new);
    }
}
