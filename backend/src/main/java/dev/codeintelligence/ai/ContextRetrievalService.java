package dev.codeintelligence.ai;

import dev.codeintelligence.analysis.core.SafeRelativePath;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.evidence.SecretMask;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

@Service
public class ContextRetrievalService {

    public record AskContext(
            String view,
            String focusedFile,
            Long focusedNodeId,
            String focusedCommitSha,
            Long focusedFindingId,
            List<String> selectedAreas) {}

    public record Retrieved(String text, List<String> fileRefs) {}

    private final JdbcClient jdbc;
    private final AiProperties aiProperties;
    private final AppProperties appProperties;
    private final SummaryService summaryService;

    public ContextRetrievalService(
            JdbcClient jdbc, AiProperties aiProperties, AppProperties appProperties, SummaryService summaryService) {
        this.jdbc = jdbc;
        this.aiProperties = aiProperties;
        this.appProperties = appProperties;
        this.summaryService = summaryService;
    }

    public Retrieved retrieve(long projectId, long snapshotId, String clonePath, AskContext context, String question) {
        StringBuilder out = new StringBuilder();
        List<String> fileRefs = new ArrayList<>();
        int budget = aiProperties.maxContextTokens() * 4;
        append(out, budget, "VIEW: " + nullToDash(context.view()));
        if (context.selectedAreas() != null && !context.selectedAreas().isEmpty()) {
            append(out, budget, "AREAS: " + String.join(",", context.selectedAreas()));
        }
        if (context.focusedFile() != null && !context.focusedFile().isBlank()) {
            String path = context.focusedFile();
            append(out, budget, "FOCUS_FILE: " + path);
            String source = readWindow(clonePath, path, null);
            if (!source.isBlank()) {
                append(out, budget, "SOURCE:\n" + SecretMask.redact(source));
                fileRefs.add("file:" + path + ":1");
            }
            summaryService
                    .ensureFileSummary(snapshotId, path, source)
                    .ifPresent(summary -> append(out, budget, "FILE_SUMMARY: " + summary));
            appendCommits(out, budget, projectId, path);
        }
        if (context.focusedNodeId() != null) {
            appendNode(out, budget, snapshotId, context.focusedNodeId(), fileRefs);
        }
        if (context.focusedFindingId() != null) {
            appendFinding(out, budget, snapshotId, context.focusedFindingId());
        }
        if (context.focusedCommitSha() != null) {
            append(out, budget, "FOCUS_COMMIT: " + context.focusedCommitSha());
        }
        summaryService
                .similar(snapshotId, question, 5)
                .forEach(summary -> append(out, budget, "RELATED_SUMMARY: " + summary));
        return new Retrieved(out.toString(), List.copyOf(fileRefs));
    }

    private void appendNode(StringBuilder out, int budget, long snapshotId, long nodeId, List<String> fileRefs) {
        jdbc.sql("""
                        select n.id, n.node_type, n.name, n.line_start, f.path
                        from graph_nodes n
                        left join files f on f.id = n.file_id
                        where n.snapshot_id = :snapshotId and n.id = :id
                        """)
                .param("snapshotId", snapshotId)
                .param("id", nodeId)
                .query((rs, rowNum) -> {
                    String path = rs.getString("path");
                    Integer line = (Integer) rs.getObject("line_start");
                    append(
                            out,
                            budget,
                            "FOCUS_NODE: %s %s id=%d path=%s line=%s"
                                    .formatted(
                                            rs.getString("node_type"),
                                            rs.getString("name"),
                                            rs.getLong("id"),
                                            path,
                                            line));
                    if (path != null) {
                        int loc = line == null ? 1 : line;
                        fileRefs.add("file:" + path + ":" + loc);
                    }
                    return 0;
                })
                .optional();
        jdbc.sql("""
                        select e.edge_type, e.confidence, n.node_type, n.name, f.path, n.line_start,
                               case when e.source_node_id = :id then 'out' else 'in' end as direction
                        from graph_edges e
                        join graph_nodes n on n.id = case when e.source_node_id = :id then e.target_node_id else e.source_node_id end
                        left join files f on f.id = n.file_id
                        where e.snapshot_id = :snapshotId
                          and (e.source_node_id = :id or e.target_node_id = :id)
                        order by e.edge_type, n.natural_key
                        limit 24
                        """)
                .param("snapshotId", snapshotId)
                .param("id", nodeId)
                .query((rs, rowNum) -> {
                    append(
                            out,
                            budget,
                            "NEIGHBOR %s %s: %s %s %s:%s"
                                    .formatted(
                                            rs.getString("direction"),
                                            rs.getString("edge_type"),
                                            rs.getString("node_type"),
                                            rs.getString("name"),
                                            rs.getString("path"),
                                            rs.getObject("line_start")));
                    return 0;
                })
                .list();
    }

    private void appendFinding(StringBuilder out, int budget, long snapshotId, long findingId) {
        jdbc.sql("""
                        select category, severity, title, detail
                        from analysis_findings
                        where snapshot_id = :snapshotId and id = :id
                        """)
                .param("snapshotId", snapshotId)
                .param("id", findingId)
                .query((rs, rowNum) -> {
                    append(
                            out,
                            budget,
                            "FINDING: %s %s %s — %s"
                                    .formatted(
                                            rs.getString("severity"),
                                            rs.getString("category"),
                                            rs.getString("title"),
                                            rs.getString("detail")));
                    return 0;
                })
                .optional();
    }

    private void appendCommits(StringBuilder out, int budget, long projectId, String path) {
        jdbc.sql("""
                        select c.sha, c.message
                        from commit_files cf
                        join commits c on c.id = cf.commit_id
                        where c.project_id = :projectId and cf.path = :path
                        order by c.committed_at desc nulls last
                        limit 5
                        """)
                .param("projectId", projectId)
                .param("path", path)
                .query((rs, rowNum) -> {
                    String sha = rs.getString("sha");
                    String message = rs.getString("message");
                    String first = message == null ? "" : message.split("\n", 2)[0];
                    append(out, budget, "COMMIT " + sha.substring(0, Math.min(10, sha.length())) + ": " + first);
                    return 0;
                })
                .list();
    }

    private String readWindow(String clonePath, String relative, Integer line) {
        if (clonePath == null || clonePath.isBlank()) {
            return "";
        }
        try {
            Path root = Path.of(clonePath).toAbsolutePath().normalize();
            if (!root.startsWith(appProperties.reposRoot())) {
                return "";
            }
            Path file = SafeRelativePath.resolve(root, relative);
            if (!Files.isRegularFile(file)) {
                return "";
            }
            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            int focus = line == null ? 1 : line;
            int window = aiProperties.focusLineWindow();
            int from = Math.max(0, focus - window - 1);
            int to = Math.min(lines.size(), focus + window);
            StringBuilder snippet = new StringBuilder();
            for (int i = from; i < to; i++) {
                snippet.append(i + 1).append('|').append(lines.get(i)).append('\n');
            }
            return snippet.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static void append(StringBuilder out, int budget, String chunk) {
        if (out.length() + chunk.length() + 1 > budget) {
            return;
        }
        if (!out.isEmpty()) {
            out.append('\n');
        }
        out.append(chunk);
    }

    private static String nullToDash(String value) {
        return value == null || value.isBlank() ? "-" : value;
    }
}
