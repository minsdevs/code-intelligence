package dev.codeintelligence.ai;

import dev.codeintelligence.analysis.core.RetainedSnapshotReader;
import dev.codeintelligence.analysis.core.SafeRelativePath;
import dev.codeintelligence.analysis.core.SnapshotBlobReader;
import dev.codeintelligence.evidence.SecretMask;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

@Service
public class ContextRetrievalService {

    private static final int MAX_PREVIEW_SOURCE_BYTES = 1024 * 1024;
    private static final int MAX_PREVIEW_CONTEXT_CHARS = 128 * 1024;

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
    public record ContextBlock(String id, String type, String label, String content, List<String> fileRefs) {
        public ContextBlock {
            fileRefs = List.copyOf(fileRefs);
        }

        public ContextBlock(String id, String type, String label, String content) {
            this(id, type, label, content, List.of());
        }
    }

    public record Retrieved(String text, List<String> fileRefs) {}

    public record StructuredRetrieved(String text, List<String> fileRefs, List<ContextBlock> blocks) {}

    private final JdbcClient jdbc;
    private final AiProperties aiProperties;
    private final SummaryService summaryService;
    private final RetainedSnapshotReader retainedSource;
    private final SnapshotBlobReader legacySource;

    public ContextRetrievalService(
            JdbcClient jdbc,
            AiProperties aiProperties,
            SummaryService summaryService,
            RetainedSnapshotReader retainedSource,
            SnapshotBlobReader legacySource) {
        this.jdbc = jdbc;
        this.aiProperties = aiProperties;
        this.summaryService = summaryService;
        this.retainedSource = retainedSource;
        this.legacySource = legacySource;
    }

    public Retrieved retrieve(
            long userId, long projectId, long snapshotId, String clonePath, AskContext context, String question) {
        StructuredRetrieved structured =
                retrieveStructured(userId, projectId, snapshotId, clonePath, context, question);
        return new Retrieved(structured.text(), structured.fileRefs());
    }

    /**
     * Filter locally assembled preview blocks before any provider request. Generating summaries or
     * embedding before filtering would disclose excluded content in helper requests. A changed or
     * missing excluded block requires a fresh preview instead of silently losing the exclusion.
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
                retrievePreviewStructured(userId, projectId, snapshotId, clonePath, context, question);
        StructuredRetrieved filtered = filterExclusions(structured, excludedIds);
        return new Retrieved(filtered.text(), filtered.fileRefs());
    }

    static StructuredRetrieved filterExclusions(StructuredRetrieved structured, Set<String> excludedIds) {
        if (excludedIds == null || excludedIds.isEmpty()) return structured;
        Set<String> availableIds =
                structured.blocks().stream().map(ContextBlock::id).collect(java.util.stream.Collectors.toSet());
        if (!availableIds.containsAll(excludedIds)) {
            throw new AiContextChangedException();
        }
        StringBuilder out = new StringBuilder();
        List<String> fileRefs = new ArrayList<>();
        List<ContextBlock> blocks = new ArrayList<>();
        for (ContextBlock block : structured.blocks()) {
            if (excludedIds.contains(block.id())) {
                continue;
            }
            blocks.add(block);
            if (!out.isEmpty()) {
                out.append('\n');
            }
            out.append(block.content());
            // Only structured provenance of included blocks is a source reference. User-authored
            // text containing "file:path:line" is not evidence that the source was retrieved.
            fileRefs.addAll(block.fileRefs());
        }
        return new StructuredRetrieved(out.toString(), List.copyOf(fileRefs), List.copyOf(blocks));
    }

    /**
     * Returns structured context blocks with deterministic IDs,
     * enabling stable identification for exclusion across preview and ask flows.
     */
    public StructuredRetrieved retrieveStructured(
            long userId, long projectId, long snapshotId, String clonePath, AskContext context, String question) {
        return retrieveStructured(userId, projectId, snapshotId, clonePath, context, question, false);
    }

    /** Local reads only: no summary generation, embedding refresh, or provider-backed search. */
    public StructuredRetrieved retrievePreviewStructured(
            long userId, long projectId, long snapshotId, String clonePath, AskContext context, String question) {
        return retrieveStructured(userId, projectId, snapshotId, clonePath, context, question, true);
    }

    private StructuredRetrieved retrieveStructured(
            long userId,
            long projectId,
            long snapshotId,
            String clonePath,
            AskContext context,
            String question,
            boolean previewOnly) {
        List<ContextBlock> blocks = new ArrayList<>();
        int budget = previewOnly
                ? (int) Math.min(MAX_PREVIEW_CONTEXT_CHARS, (long) aiProperties.maxContextTokens() * 4)
                : aiProperties.maxContextTokens() * 4;
        int[] used = {0};

        addBlock(blocks, used, budget, "VIEW", nullToDash(context.view()), "VIEW: " + nullToDash(context.view()));
        if (context.selectedAreas() != null && !context.selectedAreas().isEmpty()) {
            String areasLine = "AREAS: " + String.join(",", context.selectedAreas());
            addBlock(blocks, used, budget, "AREAS", String.join(",", context.selectedAreas()), areasLine);
        }
        if (context.focusedFile() != null && !context.focusedFile().isBlank()) {
            String path = context.focusedFile();
            addBlock(blocks, used, budget, "FILE", path, "FOCUS_FILE: " + path);
            String source = readSourceWindow(userId, projectId, snapshotId, path, previewOnly);
            if (!source.isBlank()) {
                String redacted = SecretMask.redact(source);
                addBlock(blocks, used, budget, "SOURCE", path, "SOURCE:\n" + redacted, List.of("file:" + path + ":1"));
            }
            if (previewOnly) {
                cachedFileSummary(userId, projectId, snapshotId, path, budget)
                        .ifPresent(summary -> addBlock(
                                blocks, used, budget, "SUMMARY", path, "FILE_SUMMARY: " + SecretMask.redact(summary)));
            } else {
                summaryService
                        .ensureFileSummary(userId, snapshotId, path, source)
                        .ifPresent(
                                summary -> addBlock(blocks, used, budget, "SUMMARY", path, "FILE_SUMMARY: " + summary));
            }
            appendCommitsStructured(blocks, used, budget, projectId, path);
        }
        if (context.focusedNodeId() != null) {
            appendNodeStructured(blocks, used, budget, snapshotId, context.focusedNodeId());
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
        if (!previewOnly) {
            summaryService
                    .similar(userId, snapshotId, question, 5)
                    .forEach(summary -> addBlock(
                            blocks,
                            used,
                            budget,
                            "SUMMARY",
                            summary.length() > 40 ? summary.substring(0, 40) : summary,
                            "RELATED_SUMMARY: " + summary));
        }

        // Build final text from blocks
        StringBuilder out = new StringBuilder();
        List<String> fileRefs = new ArrayList<>();
        for (ContextBlock block : blocks) {
            if (!out.isEmpty()) {
                out.append('\n');
            }
            out.append(block.content());
            fileRefs.addAll(block.fileRefs());
        }
        return new StructuredRetrieved(out.toString(), List.copyOf(fileRefs), List.copyOf(blocks));
    }

    private java.util.Optional<String> cachedFileSummary(
            long userId, long projectId, long snapshotId, String path, int maxChars) {
        return jdbc.sql("""
                        select left(sm.content, :maxChars) from summaries sm
                        join files f on f.id = sm.subject_id and f.snapshot_id = sm.snapshot_id
                        join snapshots s on s.id = f.snapshot_id
                        join projects p on p.id = s.project_id
                        where p.id = :projectId and p.user_id = :userId
                          and s.id = :snapshotId and f.path = :path
                          and sm.subject_type = 'FILE' and sm.level = 'FILE'
                          and sm.content_hash = f.content_hash
                        """)
                .param("projectId", projectId)
                .param("userId", userId)
                .param("snapshotId", snapshotId)
                .param("path", path)
                .param("maxChars", maxChars)
                .query(String.class)
                .optional();
    }

    private record SourceIdentity(String path, String oid, long size, String clonePath) {}

    /** Context uses the same authenticated snapshot bytes as source viewing, never a live file. */
    private String readSourceWindow(
            long userId, long projectId, long snapshotId, String relative, boolean previewOnly) {
        try {
            String path = SafeRelativePath.normalize(relative);
            SourceIdentity source = jdbc.sql("select f.path,f.content_hash,f.size,p.clone_path "
                            + "from files f join snapshots s on s.id=f.snapshot_id join projects p on p.id=s.project_id "
                            + "where p.user_id=:user and p.id=:project and s.id=:snapshot and f.path=:path")
                    .param("user", userId)
                    .param("project", projectId)
                    .param("snapshot", snapshotId)
                    .param("path", path)
                    .query((rs, row) -> new SourceIdentity(
                            rs.getString("path"),
                            rs.getString("content_hash"),
                            rs.getLong("size"),
                            rs.getString("clone_path")))
                    .optional()
                    .orElse(null);
            if (source == null || previewOnly && source.size() > MAX_PREVIEW_SOURCE_BYTES) return "";
            var retained = retainedSource.read(projectId, snapshotId, source.path(), source.oid(), source.size());
            String text = retained.orElseGet(
                    () -> legacySource.read(source.clonePath(), source.path(), source.oid(), source.size()));
            StringBuilder snippet = new StringBuilder();
            List<String> lines =
                    text.lines().limit(aiProperties.focusLineWindow() + 1L).toList();
            for (int index = 0; index < lines.size(); index++)
                snippet.append(index + 1).append('|').append(lines.get(index)).append('\n');
            return snippet.toString();
        } catch (RuntimeException unavailable) {
            // Do not substitute live source or include broker/path error details in a prompt.
            return "";
        }
    }

    private void appendNodeStructured(List<ContextBlock> blocks, int[] used, int budget, long snapshotId, long nodeId) {
        boolean found = jdbc.sql("""
                        select n.id, n.node_type, n.name, n.line_start, f.path
                        from graph_nodes n
                        left join files f on f.id = n.file_id and f.snapshot_id = n.snapshot_id
                        where n.snapshot_id = :snapshotId and n.id = :id
                        """)
                .param("snapshotId", snapshotId)
                .param("id", nodeId)
                .query((rs, rowNum) -> {
                    String path = rs.getString("path");
                    Integer line = (Integer) rs.getObject("line_start");
                    String content = "FOCUS_NODE: %s %s id=%d path=%s line=%s"
                            .formatted(rs.getString("node_type"), rs.getString("name"), rs.getLong("id"), path, line);
                    List<String> refs =
                            path == null ? List.of() : List.of("file:" + path + ":" + (line == null ? 1 : line));
                    addBlock(blocks, used, budget, "NODE", rs.getString("name"), content, refs);
                    return 0;
                })
                .optional()
                .isPresent();
        if (!found) {
            return;
        }
        jdbc.sql("""
                        select e.edge_type, e.confidence, n.node_type, n.name, f.path, n.line_start,
                               case when e.source_node_id = :id then 'out' else 'in' end as direction
                        from graph_edges e
                        join graph_nodes n on n.id = case when e.source_node_id = :id then e.target_node_id else e.source_node_id end
                          and n.snapshot_id = e.snapshot_id
                        left join files f on f.id = n.file_id and f.snapshot_id = n.snapshot_id
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
        jdbc.sql("""
                        select g.content from task_goals g
                        join tasks t on t.id = g.task_id
                        where t.project_id = :projectId and t.id = :id
                        order by g.seq limit 8
                        """)
                .param("projectId", projectId)
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

    /** Add a block if it fits in the budget. Generates a deterministic ID from type + content hash. */
    private static void addBlock(
            List<ContextBlock> blocks, int[] used, int budget, String type, String label, String content) {
        addBlock(blocks, used, budget, type, label, content, List.of());
    }

    private static void addBlock(
            List<ContextBlock> blocks,
            int[] used,
            int budget,
            String type,
            String label,
            String content,
            List<String> fileRefs) {
        if (used[0] + content.length() + 1 > budget) {
            return;
        }
        used[0] += content.length() + 1;
        String id = deterministicId(type, content);
        blocks.add(new ContextBlock(id, type, label, content, fileRefs));
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
