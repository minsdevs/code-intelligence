package dev.codeintelligence.ai;

import dev.codeintelligence.analysis.core.SafeRelativePath;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.evidence.SecretMask;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
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
            Long focusedNoteId,
            Long focusedTaskId,
            List<String> selectedAreas) {}

    /** A single context block with a deterministic ID for stable exclusion across preview/ask. */
    public record ContextBlock(String id, String type, String label, String content) {}

    public record Retrieved(String text, List<String> fileRefs) {}

    public record StructuredRetrieved(String text, List<String> fileRefs, List<ContextBlock> blocks) {}

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

    public Retrieved retrieve(
            long userId, long projectId, long snapshotId, String clonePath, AskContext context, String question) {
        StructuredRetrieved structured =
                retrieveStructured(userId, projectId, snapshotId, clonePath, context, question);
        return new Retrieved(structured.text(), structured.fileRefs());
    }

    /**
     * Retrieve with exclusion: filters out context blocks whose IDs appear in excludedIds.
     * Produces the same text as retrieve() minus the excluded blocks.
     */
    public Retrieved retrieveWithExclusions(
            long userId,
            long projectId,
            long snapshotId,
            String clonePath,
            AskContext context,
            String question,
            Set<String> excludedIds) {
        if (excludedIds == null || excludedIds.isEmpty()) {
            return retrieve(userId, projectId, snapshotId, clonePath, context, question);
        }
        StructuredRetrieved structured =
                retrieveStructured(userId, projectId, snapshotId, clonePath, context, question);
        StringBuilder out = new StringBuilder();
        List<String> fileRefs = new ArrayList<>();
        for (ContextBlock block : structured.blocks()) {
            if (excludedIds.contains(block.id())) {
                continue;
            }
            if (!out.isEmpty()) {
                out.append('\n');
            }
            out.append(block.content());
            // Collect file refs from non-excluded blocks
            extractFileRefs(block.content(), fileRefs);
        }
        return new Retrieved(out.toString(), List.copyOf(fileRefs));
    }

    /**
     * Returns structured context blocks with deterministic IDs,
     * enabling stable identification for exclusion across preview and ask flows.
     */
    public StructuredRetrieved retrieveStructured(
            long userId, long projectId, long snapshotId, String clonePath, AskContext context, String question) {
        List<ContextBlock> blocks = new ArrayList<>();
        List<String> fileRefs = new ArrayList<>();
        int budget = aiProperties.maxContextTokens() * 4;
        int[] used = {0};

        addBlock(blocks, used, budget, "VIEW", nullToDash(context.view()), "VIEW: " + nullToDash(context.view()));
        if (context.selectedAreas() != null && !context.selectedAreas().isEmpty()) {
            String areasLine = "AREAS: " + String.join(",", context.selectedAreas());
            addBlock(blocks, used, budget, "AREAS", String.join(",", context.selectedAreas()), areasLine);
        }
        if (context.focusedFile() != null && !context.focusedFile().isBlank()) {
            String path = context.focusedFile();
            addBlock(blocks, used, budget, "FILE", path, "FOCUS_FILE: " + path);
            String source = readWindow(clonePath, path, null);
            if (!source.isBlank()) {
                String redacted = SecretMask.redact(source);
                addBlock(blocks, used, budget, "SOURCE", path, "SOURCE:\n" + redacted);
                fileRefs.add("file:" + path + ":1");
            }
            summaryService
                    .ensureFileSummary(userId, snapshotId, path, source)
                    .ifPresent(summary -> addBlock(blocks, used, budget, "SUMMARY", path, "FILE_SUMMARY: " + summary));
            appendCommitsStructured(blocks, used, budget, projectId, path);
        }
        if (context.focusedNodeId() != null) {
            appendNodeStructured(blocks, used, budget, snapshotId, context.focusedNodeId(), fileRefs);
        }
        if (context.focusedFindingId() != null) {
            appendFindingStructured(blocks, used, budget, snapshotId, context.focusedFindingId());
        }
        if (context.focusedCommitSha() != null) {
            addBlock(
                    blocks,
                    used,
                    budget,
                    "COMMIT",
                    context.focusedCommitSha(),
                    "FOCUS_COMMIT: " + context.focusedCommitSha());
        }
        if (context.focusedNoteId() != null) {
            appendNoteStructured(blocks, used, budget, projectId, context.focusedNoteId());
        }
        if (context.focusedTaskId() != null) {
            appendTaskStructured(blocks, used, budget, projectId, context.focusedTaskId());
        }
        if (context.focusedFile() != null && !context.focusedFile().isBlank()) {
            appendRelatedNotesStructured(blocks, used, budget, projectId, context.focusedFile());
        }
        summaryService
                .similar(userId, snapshotId, question, 5)
                .forEach(summary -> addBlock(
                        blocks,
                        used,
                        budget,
                        "SUMMARY",
                        summary.length() > 40 ? summary.substring(0, 40) : summary,
                        "RELATED_SUMMARY: " + summary));

        // Build final text from blocks
        StringBuilder out = new StringBuilder();
        for (ContextBlock block : blocks) {
            if (!out.isEmpty()) {
                out.append('\n');
            }
            out.append(block.content());
        }
        return new StructuredRetrieved(out.toString(), List.copyOf(fileRefs), List.copyOf(blocks));
    }

    private void appendNode(StringBuilder out, int budget, long snapshotId, long nodeId, List<String> fileRefs) {
        appendNodeStructured(new ArrayList<>(), new int[] {out.length()}, budget, snapshotId, nodeId, fileRefs);
    }

    private void appendNodeStructured(
            List<ContextBlock> blocks, int[] used, int budget, long snapshotId, long nodeId, List<String> fileRefs) {
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
                    String content = "FOCUS_NODE: %s %s id=%d path=%s line=%s"
                            .formatted(rs.getString("node_type"), rs.getString("name"), rs.getLong("id"), path, line);
                    addBlock(blocks, used, budget, "NODE", rs.getString("name"), content);
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
                    String content = "NEIGHBOR %s %s: %s %s %s:%s"
                            .formatted(
                                    rs.getString("direction"),
                                    rs.getString("edge_type"),
                                    rs.getString("node_type"),
                                    rs.getString("name"),
                                    rs.getString("path"),
                                    rs.getObject("line_start"));
                    addBlock(blocks, used, budget, "NODE", rs.getString("name"), content);
                    return 0;
                })
                .list();
    }

    private void appendFindingStructured(
            List<ContextBlock> blocks, int[] used, int budget, long snapshotId, long findingId) {
        jdbc.sql("""
                        select category, severity, title, detail
                        from analysis_findings
                        where snapshot_id = :snapshotId and id = :id
                        """)
                .param("snapshotId", snapshotId)
                .param("id", findingId)
                .query((rs, rowNum) -> {
                    String content = "FINDING: %s %s %s — %s"
                            .formatted(
                                    rs.getString("severity"),
                                    rs.getString("category"),
                                    rs.getString("title"),
                                    rs.getString("detail"));
                    addBlock(blocks, used, budget, "FINDING", rs.getString("title"), content);
                    return 0;
                })
                .optional();
    }

    private void appendNoteStructured(List<ContextBlock> blocks, int[] used, int budget, long projectId, long noteId) {
        jdbc.sql("""
                        select title, content_md from notes
                        where project_id = :projectId and id = :id
                        """)
                .param("projectId", projectId)
                .param("id", noteId)
                .query((rs, rowNum) -> {
                    String body = rs.getString("content_md");
                    if (body != null && body.length() > 800) {
                        body = body.substring(0, 800);
                    }
                    String content = "FOCUS_NOTE: " + rs.getString("title") + "\n" + SecretMask.redact(body);
                    addBlock(blocks, used, budget, "NOTE", rs.getString("title"), content);
                    return 0;
                })
                .optional();
    }

    private void appendTaskStructured(List<ContextBlock> blocks, int[] used, int budget, long projectId, long taskId) {
        jdbc.sql("""
                        select type, title, description, status from tasks
                        where project_id = :projectId and id = :id
                        """)
                .param("projectId", projectId)
                .param("id", taskId)
                .query((rs, rowNum) -> {
                    String content = "FOCUS_TASK: %s %s %s — %s"
                            .formatted(
                                    rs.getString("status"),
                                    rs.getString("type"),
                                    rs.getString("title"),
                                    SecretMask.redact(rs.getString("description")));
                    addBlock(blocks, used, budget, "TASK", rs.getString("title"), content);
                    return 0;
                })
                .optional();
        jdbc.sql("select content from task_goals where task_id = :id order by seq limit 8")
                .param("id", taskId)
                .query((rs, rowNum) -> {
                    String content = "TASK_GOAL: " + SecretMask.redact(rs.getString("content"));
                    addBlock(blocks, used, budget, "TASK", "goal", content);
                    return 0;
                })
                .list();
    }

    private void appendRelatedNotesStructured(
            List<ContextBlock> blocks, int[] used, int budget, long projectId, String path) {
        jdbc.sql("""
                        select n.title
                        from notes n
                        left join note_references r on r.note_id = n.id
                        where n.project_id = :projectId
                          and (n.content_md ilike :like escape '\\'
                               or (r.subject_type = 'FILE' and r.raw_target = :path))
                        group by n.id, n.title
                        order by n.updated_at desc
                        limit 5
                        """)
                .param("projectId", projectId)
                .param("path", path)
                .param(
                        "like",
                        "%" + path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
                .query((rs, rowNum) -> {
                    String content = "RELATED_NOTE: " + rs.getString("title");
                    addBlock(blocks, used, budget, "NOTE", rs.getString("title"), content);
                    return 0;
                })
                .list();
    }

    private void appendCommitsStructured(
            List<ContextBlock> blocks, int[] used, int budget, long projectId, String path) {
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
                    String content = "COMMIT " + sha.substring(0, Math.min(10, sha.length())) + ": " + first;
                    addBlock(blocks, used, budget, "COMMIT", sha.substring(0, Math.min(10, sha.length())), content);
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

    /** Add a block if it fits in the budget. Generates a deterministic ID from type + content hash. */
    private static void addBlock(
            List<ContextBlock> blocks, int[] used, int budget, String type, String label, String content) {
        if (used[0] + content.length() + 1 > budget) {
            return;
        }
        used[0] += content.length() + 1;
        String id = deterministicId(type, content);
        blocks.add(new ContextBlock(id, type, label, content));
    }

    /** Generates a deterministic, content-based ID: type:sha256(content)[:12] */
    static String deterministicId(String type, String content) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(content.getBytes(StandardCharsets.UTF_8));
            String hash = HexFormat.of().formatHex(md.digest()).substring(0, 12);
            return type + ":" + hash;
        } catch (Exception e) {
            // Fallback: use content hashCode
            return type + ":" + Integer.toHexString(content.hashCode());
        }
    }

    private static void extractFileRefs(String content, List<String> fileRefs) {
        // Extract file:path:line patterns from content
        java.util.regex.Matcher m =
                java.util.regex.Pattern.compile("file:([^\\s:]+):(\\d+)").matcher(content);
        while (m.find()) {
            fileRefs.add("file:" + m.group(1) + ":" + m.group(2));
        }
        // Also handle FOCUS_FILE pattern for fileRefs
        if (content.startsWith("SOURCE:")) {
            // fileRef already added by caller
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
